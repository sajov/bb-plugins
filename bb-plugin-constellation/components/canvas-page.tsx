// The Canvas nav page (BBP-189): every thread BB lists, chat threads
// included, under Agents → its project. Reads the SDK directly — no crew or
// Graph Studio RPC — so it works with neither installed. A thread's turns
// load only when it is opened (the newest `turnsPerThread` of them);
// `thread:changed` keeps status and loaded turns current. The same page is
// the thread panel's "Canvas" tab, focused on that thread (BBP-277).
import { useEffect, useMemo, useRef, useState } from "react";
import { useBbNavigate, useRpc, useSdk, useSettings } from "@get-bb/plugin-sdk/app";
import type { extensionContract, ExtensionLayer } from "../lib/extensions";
import { mergeExtensions } from "../lib/merge-extensions";
import { filterActive } from "../vendor/bb-canvas/lib/active-filter";
import { CanvasView } from "../vendor/bb-canvas/components/CanvasView";
import { FocusUnavailable } from "../vendor/bb-canvas/components/FocusUnavailable";
import { loadProjectFilter, saveProjectFilter } from "../vendor/bb-canvas/lib/project-filter";
import type { ColorMode } from "../vendor/bb-canvas/lib/kind-colors";
import { missingFocusIds, visibleFocusIds } from "../vendor/bb-canvas/lib/focus-filter";
import { overviewSettings, overviewTree, type OverviewSettings } from "../vendor/bb-canvas/lib/overview";
import type { ProjectLike, ThreadListItem } from "../vendor/bb-canvas/lib/thread-tree";
import { DEFAULT_THREAD_FILTER, limitTurns, type ThreadFilter } from "../vendor/bb-canvas/lib/thread-filter";
import {
  enrichTurnNodes,
  threadNodeId,
  timelineToCanvas,
  turnDetailsToCanvas,
  type TimelineRowLike,
  type TurnFirstLinePort,
} from "../vendor/bb-canvas/lib/canvas-threads";
import type { CanvasEdge, CanvasNode } from "../vendor/bb-canvas/lib/types";
import { ActivitySection } from "./activity-section";
import { loadThreadSteps, StepLog } from "./step-log";
import { NeedsPanel, needsOf } from "./needs-panel";
import { Overview } from "./overview";
import { ChatComposer, ChatHistory, type ChatMessage } from "./chat";
import { ToolCallTerminal } from "./terminal";
import { ProjectDashboard } from "./project-dashboard";

type State = { projects: ProjectLike[]; threads: readonly ThreadListItem[] } | { error: string } | null;
type Sdk = ReturnType<typeof useSdk>;

async function turnDetails(sdk: Sdk, threadId: string, turnId: string, sourceSeqStart: number, sourceSeqEnd: number) {
  const response = await sdk.threads.timelineTurnSummaryDetails({
    threadId,
    turnId,
    sourceSeqStart: String(sourceSeqStart),
    sourceSeqEnd: String(sourceSeqEnd),
  });
  return { rows: response.rows as unknown as readonly TimelineRowLike[] };
}

function turnFirstLinePort(sdk: Sdk): TurnFirstLinePort {
  return { turnDetails: (turnId, threadId, start, end) => turnDetails(sdk, threadId, turnId, start, end) };
}

/** A turn of the thread, not a request or reply row drawn as one. */
const isRealTurn = (node: CanvasNode): boolean =>
  node.kind === "turn" && (typeof node.meta?.summaryCount === "number" || node.meta?.live === true);

/** Keeps only the newest `limit` turn nodes, plus the `pinned` ones (and the
 *  edges among what is left). */
function limitTurnNodes<R extends { nodes: CanvasNode[]; edges?: CanvasEdge[] }>(
  result: R,
  limit: number | null,
  pinned: ReadonlySet<string> = new Set(),
): R {
  // Only real turns count — a request or reply row is drawn as a turn card
  // too, and counting those dropped the turn that holds the tool calls,
  // and its tool calls with it (BBP-298).
  const turns = result.nodes.filter(isRealTurn);
  const kept = new Set(limitTurns(turns, limit).map((node) => node.id));
  for (const id of pinned) kept.add(id);
  // A dropped turn takes its steps with it — they would lay out as loose
  // roots otherwise (BBP-298). Children follow their parent in the list.
  const dropped = new Set(turns.filter((node) => !kept.has(node.id)).map((node) => node.id));
  for (const node of result.nodes) if (node.parentId !== null && dropped.has(node.parentId)) dropped.add(node.id);
  // The newest turn opens by itself, as in agent-graph: its tool calls show
  // as soon as the thread is opened (BBP-298).
  const newest = turns.filter((node) => kept.has(node.id)).at(-1)?.id;
  const nodes = result.nodes
    .filter((node) => !dropped.has(node.id))
    .map((node) => (node.id === newest ? { ...node, meta: { ...node.meta, newest: true } } : node));
  const ids = new Set(nodes.map((node) => node.id));
  const edges = result.edges?.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  return { ...result, nodes, ...(edges ? { edges } : {}) };
}

/** Every step of a turn: the canvas draws them as one scrolling stream
 *  (BBP-320), so the "+N earlier" cut-off is no longer needed. */
const STEPS_PER_TURN = null;

/** `pinned`: turn node ids the Activity list brought into view past the limit. */
export async function loadChildren(
  sdk: Sdk,
  node: CanvasNode,
  turnsPerThread: number | null = DEFAULT_THREAD_FILTER.turnsPerThread,
  pinned: ReadonlySet<string> = new Set(),
) {
  const { threadId, turnId, sourceSeqStart, sourceSeqEnd } = node.meta ?? {};
  if (typeof threadId !== "string") return { nodes: [] };
  if (node.kind === "thread") {
    const response = await sdk.threads.timeline({ threadId });
    const result = limitTurnNodes(timelineToCanvas(threadId, { rows: response.rows as unknown as readonly TimelineRowLike[] }, STEPS_PER_TURN), turnsPerThread, pinned);
    return { ...result, nodes: await enrichTurnNodes(result.nodes, turnFirstLinePort(sdk)) };
  }
  if (node.kind === "turn" && typeof turnId === "string" && typeof sourceSeqStart === "number" && typeof sourceSeqEnd === "number") {
    return turnDetailsToCanvas(node.id, await turnDetails(sdk, threadId, turnId, sourceSeqStart, sourceSeqEnd), threadId, STEPS_PER_TURN);
  }
  return { nodes: [] };
}

/** The runtime status a `thread:changed` event carries, if any. */
function eventStatus(event: { metadata?: unknown }): string | null {
  const status = (event.metadata as { statusChange?: { runtime?: { displayStatus?: unknown } } } | undefined)?.statusChange?.runtime?.displayStatus;
  return typeof status === "string" ? status : null;
}

/** The nav page's deep link `thread/<id>`, the thread panel's own thread otherwise. */
function focusFromSubPath(subPath: string | undefined): string | null {
  const match = /^thread\/([^/]+)$/.exec(subPath ?? "");
  return match ? decodeURIComponent(match[1]!) : null;
}

/**
 * `overview` overrides the window and limit from the plugin settings;
 * `activeOnly` is the toggle's default until the user flips it (then stored).
 * The page is the graph alone, as in agent-graph (BBP-298): window, limit and
 * turns per thread live in the plugin settings, not on the surface, and a
 * thread's chat opens in BB's own thread view on double-click.
 */
export type CanvasPageProps = {
  subPath?: string;
  focusThreadId?: string;
  overview?: Partial<OverviewSettings>;
  activeOnly?: boolean;
};

const ACTIVE_ONLY_KEY = "bb-canvas:active-only";
/** How often the canvas re-reads the extensions' layers (crew does not push). */
const EXTENSION_POLL_MS = 10_000;
/** How long "Active only" keeps a thread after it last ran (BBP-298). */
export const ACTIVE_GRACE_MS = 60_000;
const RUNNING_STATES = new Set(["active", "pending", "starting"]);
const COLOR_BY_KEY = "bb-canvas:color-by";
const TERMINAL_KEY = "bb-canvas:terminal-open";
/** With nothing selected the terminal reads this many newest turns per thread on the canvas. */
export const TERMINAL_TURNS = 3;

function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function saveFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Storage blocked: the toggle still works for this page.
  }
}

function loadColorBy(): ColorMode {
  try {
    return localStorage.getItem(COLOR_BY_KEY) === "status" ? "status" : "type";
  } catch {
    return "type";
  }
}

function saveColorBy(value: ColorMode) {
  try {
    localStorage.setItem(COLOR_BY_KEY, value);
  } catch {
    // Storage blocked: the toggle still works for this page.
  }
}

/** Under "Active only", running threads and turns open by themselves, down
 *  to their tool calls (BBP-298). Stable, so the canvas does not re-run it on
 *  every render. */
const openWhileActive = (node: CanvasNode): boolean =>
  ((node.kind === "thread" || node.kind === "turn" || node.kind === "subagent") && node.status === "running") || openNewestTurn(node);

/** Always: a thread's newest turn opens as soon as the thread is opened. */
const openNewestTurn = (node: CanvasNode): boolean => node.kind === "turn" && node.meta?.newest === true;

function loadActiveOnly(): boolean | null {
  try {
    const raw = localStorage.getItem(ACTIVE_ONLY_KEY);
    return raw === null ? null : raw === "true";
  } catch {
    return null;
  }
}

function saveActiveOnly(value: boolean) {
  try {
    localStorage.setItem(ACTIVE_ONLY_KEY, String(value));
  } catch {
    // Storage blocked: the toggle still works for this page.
  }
}

export function CanvasPage({ subPath, focusThreadId, overview, activeOnly: activeOnlyDefault = false }: CanvasPageProps) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const [state, setState] = useState<State>(null);
  // Bumped to reload the thread list; `known` holds the ids it returned.
  const [listVersion, setListVersion] = useState(0);
  const known = useRef(new Set<string>());
  const refetch = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [focus, setFocus] = useState<string | null>(() => focusThreadId ?? focusFromSubPath(subPath));
  // The overview window comes from the plugin settings (BBP-287), which may
  // arrive after the first render.
  const settings = useSettings().values;
  const defaults = useMemo<ThreadFilter>(
    () => ({ ...DEFAULT_THREAD_FILTER, ...overviewSettings(settings), ...overview }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(settings), JSON.stringify(overview)],
  );
  // The project pick is shared with the Activity Canvas pages through the
  // same stored key; window, limit and turns come from the settings.
  const [projectIds, setProjectIds] = useState<string[]>(() => loadProjectFilter());
  const changeProjects = (ids: string[]) => {
    saveProjectFilter(ids);
    setProjectIds(ids);
  };
  // The time window: the settings give the default, the toolbar picks per
  // page (BBP-298: hiding it made a day-old crew look missing).
  const [windowPick, setWindowPick] = useState<number | null | undefined>(undefined);
  const windowMs = windowPick === undefined ? defaults.windowMs : windowPick;
  const filter: ThreadFilter = useMemo(
    () => ({ ...defaults, projectIds, windowMs, ...(windowMs === null ? { limit: null } : {}) }),
    [defaults, projectIds, windowMs],
  );
  // Threads picked in the "Focus" dropdown: only they and their path show.
  const [picked, setPicked] = useState<string[]>([]);
  const [activeOnly, setActiveOnlyState] = useState(() => loadActiveOnly() ?? activeOnlyDefault);
  const setActiveOnly = (value: boolean) => {
    saveActiveOnly(value);
    setActiveOnlyState(value);
  };
  const [colorBy, setColorByState] = useState<ColorMode>(loadColorBy);
  const setColorBy = (value: ColorMode) => {
    saveColorBy(value);
    setColorByState(value);
  };
  const [terminalOpen, setTerminalOpenState] = useState(() => loadFlag(TERMINAL_KEY));
  const setTerminalOpen = (value: boolean) => {
    saveFlag(TERMINAL_KEY, value);
    setTerminalOpenState(value);
  };
  const viewRef = useRef<HTMLDivElement | null>(null);
  const needsCursor = useRef(0);
  const turnsPerThread = useRef(filter.turnsPerThread);
  turnsPerThread.current = filter.turnsPerThread;
  // Per thread node: bumped on every `thread:changed`; CanvasView reloads
  // only the threads whose turns are already loaded.
  const [reloads, setReloads] = useState<ReadonlyMap<string, number>>(new Map());
  const reloadThread = (id: string) => setReloads((prev) => new Map(prev).set(id, (prev.get(id) ?? 0) + 1));
  // Turns the Activity list brought into view past the turn limit (BBP-291).
  const pinned = useRef(new Set<string>());
  const [reveal, setReveal] = useState<{ id: string; seq: number } | null>(null);
  // Messages sent from the panel, per thread, until the timeline has them (BBP-317).
  const [sent, setSent] = useState<ReadonlyMap<string, readonly ChatMessage[]>>(new Map());
  const revealEntry = (threadId: string, nodeId: string, inCanvas: boolean) => {
    if (!inCanvas && !pinned.current.has(nodeId)) {
      pinned.current.add(nodeId);
      reloadThread(threadNodeId(threadId));
    }
    setReveal((prev) => ({ id: nodeId, seq: (prev?.seq ?? 0) + 1 }));
  };

  useEffect(() => {
    let cancelled = false;
    // An unreadable project list only costs the project names: the tree then
    // names each project by its id.
    const projects = sdk.projects.list().then(
      (list) => list.map((project): ProjectLike => ({ id: project.id, name: project.name ?? project.id, gitRemoteUrl: project.gitRemoteUrl ?? null })),
      () => [] as ProjectLike[],
    );
    Promise.all([projects, sdk.threads.list()]).then(
      ([projectList, threads]) => {
        if (cancelled) return;
        setState({ projects: projectList, threads: threads as unknown as readonly ThreadListItem[] });
        known.current = new Set(threads.map((thread) => thread.id));
      },
      (cause: unknown) => {
        if (!cancelled) setState({ error: cause instanceof Error ? cause.message : String(cause) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sdk, listVersion]);

  // When each thread was last seen running; "Active only" keeps it for
  // ACTIVE_GRACE_MS after that, so the blink of idle between two turns
  // neither drops its card nor its edges.
  const lastRunning = useRef(new Map<string, number>());
  const [graceTick, setGraceTick] = useState(0);
  const recentlyActive = useMemo(() => {
    const now = Date.now();
    if (state !== null && "threads" in state)
      for (const thread of state.threads) if (RUNNING_STATES.has(thread.status)) lastRunning.current.set(thread.id, now);
    return new Set([...lastRunning.current].filter(([, at]) => now - at < ACTIVE_GRACE_MS).map(([id]) => id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, graceTick]);
  useEffect(() => {
    if (!activeOnly || recentlyActive.size === 0) return;
    const timer = setTimeout(() => setGraceTick((tick) => tick + 1), ACTIVE_GRACE_MS);
    return () => clearTimeout(timer);
  }, [activeOnly, recentlyActive]);
  const threadTree = useMemo(() => {
    if (state === null || !("threads" in state)) return null;
    return overviewTree({ projects: state.projects, threads: state.threads, filter, focusThreadId: focus, now: Date.now(), activeOnly, recentlyActive });
  }, [state, filter, focus, activeOnly, recentlyActive]);

  // BBP-190: crews from the crew plugin (and later graph runs), for the
  // projects in view; re-read every EXTENSION_POLL_MS — crew does not push.
  // Through a ref: a fresh `rpc` object per render must not restart the
  // fetch — that looped forever (BBP-190).
  const rpc = useRpc<typeof extensionContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const [extension, setExtension] = useState<ExtensionLayer | null>(null);
  const [extensionTick, setExtensionTick] = useState(0);
  const projectKey = useMemo(
    () => (threadTree === null ? "" : threadTree.nodes.filter((node) => node.kind === "project").map((node) => node.id.slice("project:".length)).sort().join(",")),
    [threadTree],
  );
  useEffect(() => {
    if (projectKey === "") return;
    let cancelled = false;
    Promise.resolve()
      .then(() =>
        rpcRef.current.call("extensionLayers", {
          projectIds: projectKey.split(","),
          ...(windowMs !== null ? { sinceMs: Date.now() - windowMs } : {}),
        }),
      )
      .then(
        (answer) => {
          if (!cancelled) setExtension(answer);
        },
        () => {},
      );
    const timer = setTimeout(() => setExtensionTick((tick) => tick + 1), EXTENSION_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectKey, extensionTick, listVersion, windowMs]);
  const layer = useMemo(() => {
    if (threadTree === null) return null;
    const facts = new Map(state !== null && "threads" in state ? state.threads.map((thread) => [thread.id, thread]) : []);
    const merged = mergeExtensions(threadTree, extension, facts);
    if (!activeOnly) return merged;
    const keep = new Set([...recentlyActive].map(threadNodeId));
    if (focus !== null) keep.add(threadNodeId(focus));
    const nodes = filterActive(merged.nodes, keep);
    const ids = new Set(nodes.map((node) => node.id));
    return { ...merged, nodes, edges: merged.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)), expanded: merged.expanded.filter((id) => ids.has(id)) };
  }, [threadTree, extension, activeOnly, recentlyActive, focus, state]);
  // An extension's open crews arrive after the canvas mounted: they open once
  // as they appear, like the newest turn does (BBP-190).
  const extensionOpen = useMemo(() => new Set(layer?.expanded ?? []), [layer?.expanded.join(",")]);
  const autoExpand = useMemo(() => {
    const base = activeOnly ? openWhileActive : openNewestTurn;
    return (node: CanvasNode) => base(node) || (node.kind === "crew" && extensionOpen.has(node.id));
  }, [activeOnly, extensionOpen]);
  const focusIds = useMemo(() => (focus === null ? picked : [...new Set([threadNodeId(focus), ...picked])]), [focus, picked]);

  useEffect(
    () =>
      sdk.subscribe({
        event: "thread:changed",
        callback: (event) => {
          const threadId = event.id;
          if (!threadId) return;
          // A thread the list does not know yet was just started: reload the
          // list (once per burst), or it never shows up (BBP-298).
          if (!known.current.has(threadId)) {
            known.current.add(threadId);
            if (refetch.current === null)
              refetch.current = setTimeout(() => {
                refetch.current = null;
                setListVersion((version) => version + 1);
              }, 400);
          }
          const status = eventStatus(event);
          if (status)
            setState((prev) =>
              prev && "threads" in prev
                ? { ...prev, threads: prev.threads.map((thread) => (thread.id === threadId ? { ...thread, status } : thread)) }
                : prev,
            );
          const id = threadNodeId(threadId);
          reloadThread(id);
        },
      }),
    [sdk],
  );

  // Every tool call of the threads on the canvas, for the terminal while
  // nothing is selected — read only while it is open, and again when one of
  // those threads changes.
  const terminalThreads = useMemo(
    () =>
      terminalOpen && layer !== null
        ? layer.nodes.flatMap((node) => (node.kind === "thread" && typeof node.meta?.threadId === "string" ? [node.meta.threadId] : []))
        : [],
    [terminalOpen, layer],
  );
  const terminalKey = terminalThreads.map((id) => `${id}:${reloads.get(threadNodeId(id)) ?? 0}`).join(",");
  const [allCalls, setAllCalls] = useState<readonly CanvasNode[]>([]);
  useEffect(() => {
    if (terminalKey === "") {
      setAllCalls([]);
      return;
    }
    let cancelled = false;
    // One thread that cannot be read costs only its own calls.
    Promise.all(terminalThreads.map((id) => Promise.resolve().then(() => loadThreadSteps(sdk, id, TERMINAL_TURNS)).catch(() => [] as CanvasNode[]))).then((perThread) => {
      if (!cancelled) setAllCalls(perThread.flat());
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdk, terminalKey]);

  if (state === null) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  if ("error" in state) return <div className="p-4 text-sm text-destructive">Canvas not available: {state.error}</div>;
  // Before the empty states: a focus on a thread that is gone is the answer
  // the user needs, whether or not anything else is left to show.
  if (layer !== null && focusIds.length > 0 && missingFocusIds(layer.nodes, focusIds).length === focusIds.length)
    return (
      <FocusUnavailable
        onShowAll={() => {
          setFocus(null);
          setPicked([]);
        }}
      />
    );
  if (state.threads.length === 0) return <div className="p-4 text-sm text-muted-foreground">No threads yet.</div>;
  const link =
    "rounded px-1 text-primary underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary";
  // An empty canvas keeps its panel (BBP-313): the filters that emptied it
  // stay one click away, and the hint sits on the canvas itself.
  const empty =
    layer !== null && layer.nodes.length > 0 ? null : activeOnly ? (
      <>
        Nothing is running right now.
        <button type="button" onClick={() => setActiveOnly(false)} className={link}>
          Show everything
        </button>
      </>
    ) : (
      <>
        No threads match the projects and window. Widen the window in the plugin settings.
        <button
          type="button"
          onClick={() => {
            changeProjects([]);
            setPicked([]);
            setWindowPick(null);
          }}
          className={link}
        >
          Reset filters
        </button>
      </>
    );
  const shown = layer ?? { nodes: [] as CanvasNode[], edges: [] as CanvasEdge[], frames: [], expanded: [] as string[] };
  const visible = visibleFocusIds(shown.nodes, focusIds);
  const running = shown.nodes.filter((node) => node.status === "running").length;
  // BBP-303: what waits for the human; the button cycles through it.
  const needing = shown.nodes.filter((node) => node.meta?.needsYou).map((node) => node.id);
  const jumpToNeeds = () => {
    if (needing.length === 0) return;
    const at = needsCursor.current % needing.length;
    needsCursor.current = at + 1;
    setReveal((prev) => ({ id: needing[at]!, seq: (prev?.seq ?? 0) + 1 }));
  };
  const threadLabel = (threadId: string) => shown.nodes.find((node) => node.id === threadNodeId(threadId))?.label ?? "thread";
  // What J does: the canvas cycles through running work.
  const jumpToRunning = () => viewRef.current?.querySelector<HTMLElement>("[data-canvas-view]")?.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
  const resetFilters = () => {
    changeProjects([]);
    setPicked([]);
    setWindowPick(undefined);
    setActiveOnly(false);
  };
  return (
    <div ref={viewRef} className="relative flex h-full min-h-0 flex-col">
        {empty ? <div className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground shadow-sm">{empty}</div> : null}
        <CanvasView
          nodes={shown.nodes.filter((node) => visible.has(node.id))}
          edges={shown.edges}
          frames={shown.frames}
          initialExpanded={new Set(shown.expanded)}
          halo
          colorBy={colorBy}
          stepsAsLog
          relationsByDefault
          autoExpand={autoExpand}
          controlsPosition="bottom-left"
          overviewBadge={
            running > 0 || needing.length > 0 ? (
              <span className="flex items-center gap-1.5 text-[11px]">
                {needing.length > 0 ? (
                  <button
                    type="button"
                    onClick={jumpToNeeds}
                    title="Jump to what needs you"
                    aria-label={`${needing.length} need${needing.length === 1 ? "s" : ""} you`}
                    className="flex items-center gap-1 rounded-full border px-2 py-0.5 hover:bg-amber-500/10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary"
                    style={{ borderColor: "#f59e0b80", color: "#f59e0b" }}
                  >
                    ◷ {needing.length}
                  </button>
                ) : null}
                {running > 0 ? (
                  <button
                    type="button"
                    onClick={jumpToRunning}
                    title="Jump to running work (J)"
                    className="flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-foreground hover:bg-primary/20 focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary"
                  >
                    <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
                    {running} running
                  </button>
                ) : null}
              </span>
            ) : null
          }
          shortcuts={{ t: () => setTerminalOpen(!terminalOpen), T: () => setTerminalOpen(!terminalOpen) }}
          renderCanvasLayer={({ nodes, selectedId, select }) =>
            terminalOpen ? (
              <ToolCallTerminal
                nodes={nodes}
                extraCalls={allCalls}
                threadLabel={threadLabel}
                selectedId={selectedId}
                // A call not on the canvas (its turn closed) selects its thread.
                onSelect={(id) => {
                  if (nodes.some((node) => node.id === id)) return select(id);
                  const threadId = allCalls.find((call) => call.id === id)?.meta?.threadId;
                  if (typeof threadId === "string") select(threadNodeId(threadId));
                }}
                onClose={() => setTerminalOpen(false)}
              />
            ) : null
          }
          renderOverview={(context) => (
            <Overview
              context={context}
              projects={state.projects}
              projectIds={projectIds}
              onProjects={changeProjects}
              windowMs={windowMs}
              defaultWindowMs={defaults.windowMs}
              onWindow={setWindowPick}
              focusNodes={shown.nodes}
              picked={picked}
              onPicked={setPicked}
              activeOnly={activeOnly}
              onActiveOnly={setActiveOnly}
              colorBy={colorBy}
              onColorBy={setColorBy}
              onJumpToNeeds={jumpToNeeds}
              terminalOpen={terminalOpen}
              onTerminal={setTerminalOpen}
              onReset={resetFilters}
            />
          )}
          surface="canvas"
          focusSelected={focusIds}
          // A thread always has turns to fetch; a turn only if it has steps.
          canLoadChildren={(node) =>
            (node.kind === "thread" && typeof node.meta?.threadId === "string") ||
            (node.kind === "turn" && typeof node.meta?.summaryCount === "number" && node.meta.summaryCount > 0)
          }
          loadChildren={(node) => loadChildren(sdk, node, turnsPerThread.current, pinned.current)}
          reveal={reveal}
          renderNodeFooter={(node) => {
            const chatThread = node.meta?.threadId;
            if (typeof chatThread !== "string") return null;
            return (
              <ChatComposer
                sdk={sdk}
                threadId={chatThread}
                threadLabel={threadLabel(chatThread)}
                onSent={(message) => setSent((prev) => new Map(prev).set(chatThread, [...(prev.get(chatThread) ?? []), message]))}
                onOpenThread={() => navigate.toThread(chatThread)}
              />
            );
          }}
          renderSidebarExtra={(node) => {
            const threadId = node.kind === "thread" ? node.meta?.threadId : undefined;
            const chatThread = node.meta?.threadId;
            const needs = needsOf(node.meta);
            if (node.kind === "project") {
              const projectId = node.id.slice("project:".length);
              return (
                <ProjectDashboard
                  projectId={projectId}
                  threads={state.threads}
                  remote={state.projects.find((project) => project.id === projectId)?.gitRemoteUrl}
                  now={Date.now()}
                  onSelectThread={(threadId) => setReveal((prev) => ({ id: threadNodeId(threadId), seq: (prev?.seq ?? 0) + 1 }))}
                />
              );
            }
            return (
              <>
                {needs ? <NeedsPanel key={node.id} needs={needs} answer={(target, answer) => rpcRef.current.call("answerNeeds", { needs: target, answer })} /> : null}
                {typeof threadId === "string" ? (
                  <>
                    <ActivitySection
                      sdk={sdk}
                      threadId={threadId}
                      turnsPerThread={filter.turnsPerThread}
                      version={reloads.get(node.id) ?? 0}
                      onReveal={(nodeId, inCanvas) => revealEntry(threadId, nodeId, inCanvas)}
                    />
                    <StepLog sdk={sdk} threadId={threadId} version={reloads.get(node.id) ?? 0} onReveal={(nodeId) => revealEntry(threadId, nodeId, true)} />
                  </>
                ) : null}
                {typeof chatThread === "string" ? (
                  <ChatHistory
                    sdk={sdk}
                    threadId={chatThread}
                    threadLabel={threadLabel(chatThread)}
                    version={reloads.get(threadNodeId(chatThread)) ?? 0}
                    working={RUNNING_STATES.has(state.threads.find((thread) => thread.id === chatThread)?.status ?? "")}
                    pending={sent.get(chatThread) ?? []}
                  />
                ) : null}
              </>
            );
          }}
          reloadChildren={reloads}
          onOpenThread={(threadId) => navigate.toThread(threadId)}
          className="h-full"
        />
    </div>
  );
}

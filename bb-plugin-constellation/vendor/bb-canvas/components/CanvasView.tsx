// WI2: the interactive shell around `CanvasShell` — pan/zoom at the pointer
// (CanvasShell already has that), keyboard navigation, breadcrumb, search and
// the detail sidebar. Works against whatever `nodes`/`edges` it is given —
// fixtures here, RPC data once the owning plugin wires it up (WI3/WI4).
import type { ColorMode } from "../lib/kind-colors";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { CanvasShell, type CanvasShellHandle } from "./CanvasShell";
import { Breadcrumb } from "./Breadcrumb";
import { IconButton, Sidebar } from "./Sidebar";
import { SidePanel } from "./SidePanel";
import { SearchBox } from "./SearchBox";
import { layoutTree } from "../lib/layout";
import {
  loadExpandedState,
  restoreExpanded,
  saveExpandedState,
  withToggle,
  type ExpandedState,
} from "../lib/expanded-state";
import { loadRelations, outgoingRelations, relationsView, saveRelations } from "../lib/relations";
import { nextRunningId } from "../lib/running-cycle";
import type { CanvasEdge, CanvasFrame, CanvasNode } from "../lib/types";

const TOOLBAR_BUTTON = {
  padding: "2px 8px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--card)",
  color: "var(--foreground)",
  fontSize: 11,
  cursor: "pointer",
} as const;
// Without a visible pressed state the toggle looked the same on and off —
// the user could only tell from the canvas whether it had taken.
const RELATIONS_OFF = { ...TOOLBAR_BUTTON, display: "flex" as const, alignItems: "center" as const, gap: 6 };
const RELATIONS_ON = {
  ...RELATIONS_OFF,
  borderColor: "var(--primary)",
  background: "color-mix(in srgb, var(--primary) 16%, var(--card))",
};
const EMPTY_DIMMED: ReadonlySet<string> = new Set();
/** Floor height so the canvas stays usable even with no sized ancestor
 *  (BBP-173). Tall enough to show a handful of cards, short enough to not
 *  force scroll in a host that does size its container normally. */
const MIN_HEIGHT = 320;

const PANEL_COLLAPSED_KEY = "bb-canvas:panel-collapsed";
/** The zoom a search match is shown at: readable, whatever the view was. */
const SEARCH_ZOOM = 1;

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(PANEL_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function saveCollapsed(value: boolean): void {
  try {
    localStorage.setItem(PANEL_COLLAPSED_KEY, String(value));
  } catch {
    // Not persisted; the panel still folds for this page.
  }
}

/** What the overview in the side panel can read and do (BBP-313). */
export type OverviewContext = {
  /** Every node on the canvas, loaded children included. */
  nodes: readonly CanvasNode[];
  /** True while every card with known children is open. */
  allExpanded: boolean;
  expandAll: () => void;
  collapseAll: () => void;
  select: (nodeId: string) => void;
  /** What J does: the next running node, centred. */
  jumpToRunning: () => void;
  /** Finds, never selects (BBP-310): the canvas zooms to the current match
   *  and marks it with the halo; the panel stays on the overview. */
  search: {
    query: string;
    setQuery: (query: string) => void;
    matches: number;
    /** 1-based position of the match in view; 0 when there is none. */
    current: number;
    next: () => void;
    previous: () => void;
  };
  relations: { available: boolean; shown: boolean; toggle: () => void };
};

/** What loading a node's children hands back — a thread's turns, typically. */
export type LoadedChildren = { nodes: readonly CanvasNode[]; edges?: readonly CanvasEdge[] };


export type CanvasViewProps = {
  nodes: readonly CanvasNode[];
  edges?: readonly CanvasEdge[];
  frames?: readonly CanvasFrame[];
  /** Frames the current selection may enter edit mode on; a frame absent
   *  here never responds to `E` (BBP-166 negative criterion 2). */
  editableFrameIds?: ReadonlySet<string>;
  /** What to show in the side panel while a frame is being edited, in place
   *  of the generic `Sidebar` — e.g. a provider's own edit-action panel
   *  (BBP-170). Absent: edit mode simply shows no side panel. */
  renderFrameEditor?: (frameId: string) => ReactNode;
  /** Expanded by default — e.g. every node up to the member level. */
  initialExpanded?: ReadonlySet<string>;
  /**
   * Loads a node's children the first time it is expanded — a thread's turns
   * from the SDK timeline, say. Called at most once per node id; its own
   * provider never needs to know this ran, since the result just joins
   * `nodes`/`edges` for layout purposes. Nodes that come with their children
   * already in `nodes` (crew, graph-run, …) need none of this.
   */
  loadChildren?: (node: CanvasNode) => Promise<LoadedChildren>;
  /** Which nodes `loadChildren` can actually fill — those get a chevron
   *  before their children arrive; every other node without children is a
   *  leaf. Absent: any node may load, as long as a loader is given. */
  canLoadChildren?: (node: CanvasNode) => boolean;
  /** Raising a node's number re-runs `loadChildren` for it, replacing its
   *  children once the new ones arrive — but only if they were loaded
   *  already: a node nobody opened stays unloaded (BBP-189, live updates). */
  reloadChildren?: ReadonlyMap<string, number>;
  /** Fetches extra sidebar fields for a node the first time it is selected —
   *  a thread's provider, model, times and turn count from the SDK (BBP-179).
   *  The result is merged over the node's own `meta` for the sidebar only.
   *  Called at most once per node id; `null` or a failure leaves the node's
   *  own `meta` in place. */
  loadDetails?: (node: CanvasNode) => Promise<Record<string, unknown> | null>;
  /** Persists expand/collapse under `bb-canvas:expanded:<surface>` (BBP-183).
   *  Absent: nothing is stored, `initialExpanded` applies on every mount. */
  surface?: string;
  /** Identifies the current node/edge set — a new project filter selection,
   *  say. A change resets expansion, selection, loaded children and the edit
   *  mode back to a fresh view (BBP-215), without remounting `CanvasView`
   *  itself: a caller-supplied `toolbar` (the project filter) keeps its own
   *  open/search state across the change instead of being torn down with it. */
  resetKey?: string | null;
  /** Page-owned controls shown in the toolbar beside the colour toggle —
   *  the project filter, say (BBP-181). */
  toolbar?: ReactNode;
  /** Passed straight through to the `Sidebar`'s own action buttons (BBP-185) —
   *  absent here means absent there, so no dead link ever renders. */
  onOpenThread?: (threadId: string) => void;
  onOpenRun?: (runId: string) => void;
  onOpenCrew?: (crew: string) => void;
  onOpenAtRow?: (threadId: string, seq: number) => void;
  /** Passed straight through to the Sidebar's "Focus this" action (BBP-242). */
  onFocusThis?: (id: string) => void;
  /** A Ctrl/Cmd-click on a crew/graph-run/thread card toggles it into or out
   *  of the focus instead of selecting it (BBP-241). Absent, or the card's
   *  kind is none of those three: the modifier is ignored, a plain select. */
  onToggleFocus?: (id: string) => void;
  /** The focused selection's path to the root (BBP-240's `focusPathIds`),
   *  dimmed the same way an edit mode's out-of-frame nodes are. */
  focusPathIds?: ReadonlySet<string>;
  /** Watched only to decide whether to re-fit the view (BBP-241): every
   *  focus change — the dropdown, a Ctrl/Cmd-click, "Focus this", "Show
   *  all" — goes through this prop, so a plain live-update refresh that
   *  leaves the selection untouched never re-triggers `fitView`. */
  focusSelected?: readonly string[];
  /** Told the selected node (or null) whenever the selection changes — the
   *  Canvas plugin's Chat tab follows it (BBP-277). */
  onSelectionChange?: (node: CanvasNode | null) => void;
  /** Opens a node's ancestors and selects it (BBP-291: a click in the
   *  thread panel's Activity list). A new `seq` repeats the request. A node
   *  not (yet) in `nodes` waits until it arrives; one that never does
   *  changes nothing. */
  reveal?: { id: string; seq: number } | null;
  /** A page-owned section in the selected node's sidebar, after its relations. */
  renderSidebarExtra?: (node: CanvasNode) => ReactNode;
  /** BBP-290: J cycles through the running nodes, pans to the one it lands
   *  on and gives it a halo. Off: J selects the first running node, as the
   *  Activity Canvas always did. */
  halo?: boolean;
  /** Colour cards by type or by state, as agent-graph (BBP-298). */
  colorBy?: ColorMode;
  /** Nodes opened on their own as they appear — "Active only" opens every
   *  running thread and turn down to its tool calls (BBP-298). Each node is
   *  opened once; one the user closes stays closed. Not persisted. */
  autoExpand?: (node: CanvasNode) => boolean;
  /** Tool calls and subagents as log lines with a duration bar (BBP-298). */
  stepsAsLog?: boolean;
  /** Relations shown until the user turns them off (BBP-191: a crew's
   *  communication lines belong to its picture, also while it is idle). */
  relationsByDefault?: boolean;
  /** The breadcrumb sits atop the detail sidebar instead of beside the
   *  toolbar, so the toolbar never moves when a card is picked (BBP-298). */
  breadcrumbInSidebar?: boolean;
  /** Where the zoom controls sit (agent-graph: bottom right). */
  controlsPosition?: "bottom-left" | "bottom-right";
  /** Drawn over the canvas's bottom-left corner — agent-graph's legend. A
   *  function gets every node on the canvas, loaded children included. */
  overlay?: ReactNode | ((nodes: readonly CanvasNode[]) => ReactNode);
  /** Drawn left of the zoom controls in the bottom-right corner. */
  cornerAction?: ReactNode;
  /** The always-open side panel (BBP-313): with this, the toolbar row is gone
   *  and the panel shows this overview while nothing is selected, a node's
   *  view otherwise. Absent: the toolbar row and a sidebar per selection. */
  renderOverview?: (context: OverviewContext) => ReactNode;
  /** The overview panel's title row, right of "Overview" (a running count). */
  overviewBadge?: ReactNode;
  /** Pinned at the foot of a node's view — a chat composer (BBP-317). */
  renderNodeFooter?: (node: CanvasNode) => ReactNode;
  /** A layer over the whole canvas area — the tool-call terminal (BBP-312).
   *  It gets every node on the canvas and the selection. */
  renderCanvasLayer?: (context: { nodes: readonly CanvasNode[]; selectedId: string | null; select: (nodeId: string) => void }) => ReactNode;
  /** Page-owned single-key shortcuts, by `event.key`; the canvas's own keys
   *  win over these. */
  shortcuts?: Readonly<Record<string, () => void>>;
  className?: string;
};

function parentOf(byId: Map<string, CanvasNode>, node: CanvasNode): string | null {
  return node.parentId !== null && byId.has(node.parentId) ? node.parentId : null;
}

export function CanvasView({
  nodes,
  edges = [],
  frames = [],
  editableFrameIds,
  renderFrameEditor,
  initialExpanded,
  loadChildren,
  canLoadChildren,
  reloadChildren,
  loadDetails,
  surface,
  resetKey,
  toolbar,
  onOpenThread,
  onOpenRun,
  onOpenCrew,
  onOpenAtRow,
  onFocusThis,
  onToggleFocus,
  focusPathIds,
  focusSelected,
  reveal,
  renderSidebarExtra,
  onSelectionChange,
  halo = false,
  colorBy,
  autoExpand,
  breadcrumbInSidebar = false,
  stepsAsLog,
  relationsByDefault = false,
  controlsPosition,
  overlay,
  cornerAction,
  renderOverview,
  overviewBadge,
  renderNodeFooter,
  renderCanvasLayer,
  shortcuts,
  className,
}: CanvasViewProps) {
  const panelMode = renderOverview !== undefined;
  const [panelCollapsed, setPanelCollapsedState] = useState(loadCollapsed);
  const setPanelCollapsed = (value: boolean) => {
    saveCollapsed(value);
    setPanelCollapsedState(value);
  };
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    restoreExpanded(initialExpanded ?? [], surface === undefined ? null : loadExpandedState(surface)),
  );
  const persisted = useRef<ExpandedState>(
    (surface === undefined ? null : loadExpandedState(surface)) ?? { open: [], closed: [] },
  );
  const [fitRequest, setFitRequest] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The halo marks where J landed; any other selection drops it.
  const [haloId, setHaloId] = useState<string | null>(null);
  const [details, setDetails] = useState<ReadonlyMap<string, Record<string, unknown>>>(() => new Map());
  const detailsRequested = useRef(new Set<string>());
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [loaded, setLoaded] = useState<ReadonlyMap<string, LoadedChildren>>(new Map());
  // BBP-179: a thread whose `loadChildren` rejected — cleared the moment a
  // retry (clicking the card again) resolves, so the error never outlives
  // the state that caused it.
  const [failedLoads, setFailedLoads] = useState<ReadonlySet<string>>(new Set());
  const [showRelations, setShowRelations] = useState(() => loadRelations(surface, relationsByDefault));
  // Only one frame editable at a time (BBP-166): entering a second frame's
  // edit mode without an `Escape` first is a no-op, not a silent switch.
  const [editingFrameId, setEditingFrameId] = useState<string | null>(null);
  const loading = useRef<Set<string>>(new Set());
  const shellRef = useRef<CanvasShellHandle>(null);
  const lastResetKey = useRef(resetKey);

  // A changed `resetKey` is a new node/edge set (e.g. the project filter),
  // and gets the same fresh view a remount used to give it — but by
  // resetting this state in place, `toolbar` is never unmounted with it.
  // Skipped on the first render: the initial `useState` calls above already
  // computed the right starting values for the initial `resetKey`.
  useEffect(() => {
    if (lastResetKey.current === resetKey) return;
    lastResetKey.current = resetKey;
    setExpanded(restoreExpanded(initialExpanded ?? [], surface === undefined ? null : loadExpandedState(surface)));
    setSelectedId(null);
    setHaloId(null);
    setDetails(new Map());
    detailsRequested.current = new Set();
    setLoaded(new Map());
    setFailedLoads(new Set());
    setEditingFrameId(null);
    setFitRequest((count) => count + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const focusKey = focusSelected?.join("\n") ?? null;
  const lastFocusKey = useRef(focusKey);
  // A focus change re-fits the view the same way expandAll/collapseAll does
  // (BBP-241); a plain live-update poll leaves `focusKey` unchanged, so it
  // never fires this. Skipped on the first render for the same reason the
  // `resetKey` effect above is.
  useEffect(() => {
    if (lastFocusKey.current === focusKey) return;
    lastFocusKey.current = focusKey;
    setFitRequest((count) => count + 1);
  }, [focusKey]);

  // Loaded children count only while the node they were loaded for is
  // itself in the tree: a thread that "Active only" or the overview window
  // drops must take its turns with it, or they would lay out as loose roots
  // (BBP-298). Nested loads (a turn's tool calls) follow the same rule.
  const attached = useMemo(() => {
    const present = new Set(nodes.map((node) => node.id));
    const kept: LoadedChildren[] = [];
    let pending = [...loaded];
    for (let grew = true; grew; ) {
      grew = false;
      const rest: typeof pending = [];
      for (const [parentId, result] of pending) {
        if (!present.has(parentId)) {
          rest.push([parentId, result]);
          continue;
        }
        // Only the nodes that hang off something present: a node whose own
        // parent is missing would lay out as a loose root (BBP-298).
        const nodes: CanvasNode[] = [];
        let pendingNodes = [...result.nodes];
        for (let more = true; more; ) {
          more = false;
          const rest: CanvasNode[] = [];
          for (const node of pendingNodes) {
            if (node.parentId !== null && present.has(node.parentId)) {
              nodes.push(node);
              present.add(node.id);
              more = true;
            } else rest.push(node);
          }
          pendingNodes = rest;
        }
        kept.push(nodes.length === result.nodes.length ? result : { ...result, nodes });
        grew = true;
      }
      pending = rest;
    }
    return kept;
  }, [nodes, loaded]);
  const allNodes = useMemo(() => [...nodes, ...attached.flatMap((result) => result.nodes)], [nodes, attached]);
  const allEdges = useMemo(() => [...edges, ...attached.flatMap((result) => result.edges ?? [])], [edges, attached]);

  const hasRelations = useMemo(() => allEdges.some((edge) => edge.relation), [allEdges]);
  const shownEdges = useMemo(
    () => (hasRelations ? relationsView(allEdges, showRelations, selectedId) : allEdges),
    [hasRelations, allEdges, showRelations, selectedId],
  );

  function toggleRelations() {
    setShowRelations((prev) => {
      saveRelations(surface, !prev);
      return !prev;
    });
  }

  const byId = useMemo(() => new Map(allNodes.map((node) => [node.id, node])), [allNodes]);
  const visible = useMemo(
    () => layoutTree(allNodes, expanded, allEdges).positions.map((placed) => byId.get(placed.id)!),
    [allNodes, expanded, allEdges, byId],
  );
  const visibleIds = useMemo(() => new Set(visible.map((node) => node.id)), [visible]);
  // The panel's search (BBP-310): every visible card whose label matches;
  // the rest fade, and the canvas moves from match to match without
  // selecting any — a selection would turn the panel into a node's view.
  const matchIds = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!panelMode || query === "") return null;
    return visible.filter((node) => node.label.toLowerCase().includes(query)).map((node) => node.id);
  }, [panelMode, searchQuery, visible]);
  const [matchAt, setMatchAt] = useState(0);
  const showMatch = (index: number) => {
    if (matchIds === null || matchIds.length === 0) return;
    const at = ((index % matchIds.length) + matchIds.length) % matchIds.length;
    setMatchAt(at);
    setHaloId(matchIds[at]!);
    shellRef.current?.centerOn(matchIds[at]!, SEARCH_ZOOM);
  };
  // A new set of matches (the query changed) goes to its first one at once.
  const matchKey = matchIds?.join("\n") ?? null;
  useEffect(() => {
    if (matchIds === null || matchIds.length === 0) {
      setMatchAt(0);
      if (matchKey !== null || searchQuery === "") setHaloId(null);
      return;
    }
    showMatch(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey]);

  const hasChildren = useMemo(() => {
    const parents = new Set<string>();
    for (const node of allNodes) {
      const parent = parentOf(byId, node);
      if (parent !== null) parents.add(parent);
    }
    return parents;
  }, [allNodes, byId]);

  /** Cards that can open: known children, or a loader that has not run yet
   *  for them. A load that came back empty turns the card into a leaf. */
  const expandable = useMemo(() => {
    const ids = new Set(hasChildren);
    if (loadChildren) {
      for (const node of allNodes) {
        if (loaded.has(node.id) || ids.has(node.id)) continue;
        if (canLoadChildren ? canLoadChildren(node) : true) ids.add(node.id);
      }
    }
    return ids;
  }, [hasChildren, allNodes, loaded, loadChildren, canLoadChildren]);

  // A restored or initially open lazy card has to fetch its children too —
  // `expand` only covers the ones opened during this session.
  useEffect(() => {
    for (const id of expanded) if (!hasChildren.has(id)) startLoad(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  function remember(next: ExpandedState) {
    persisted.current = next;
    if (surface !== undefined) saveExpandedState(surface, next);
  }

  const selected = selectedId !== null ? (byId.get(selectedId) ?? null) : null;
  useEffect(() => {
    onSelectionChange?.(selected);
    // Keyed on the id: a live refresh that swaps in an equal node object
    // must not re-announce an unchanged selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);
  // BBP-200: a poll can drop the selected node. Forgetting the id, not just
  // hiding the sidebar, keeps it from coming back selected on a later poll.
  useEffect(() => {
    if (selectedId !== null && !byId.has(selectedId)) setSelectedId(null);
  }, [byId, selectedId]);
  const selectedDetails = selected ? details.get(selected.id) : undefined;
  const sidebarNode = useMemo(
    () => (selected && selectedDetails ? { ...selected, meta: { ...selected.meta, ...selectedDetails } } : selected),
    [selected, selectedDetails],
  );

  useEffect(() => {
    if (!selected || !loadDetails || detailsRequested.current.has(selected.id)) return;
    const id = selected.id;
    detailsRequested.current.add(id);
    void loadDetails(selected).then(
      (loadedDetails) => {
        if (loadedDetails) setDetails((previous) => new Map(previous).set(id, loadedDetails));
      },
      () => {
        // The sidebar keeps the node's own meta; a reselect does not retry,
        // so a dead endpoint is not hammered on every click.
      },
    );
  }, [selected, loadDetails]);

  const dimmedIds = useMemo(() => {
    if (editingFrameId === null && matchIds !== null) {
      const hits = new Set(matchIds);
      const ids = new Set<string>(focusPathIds ?? []);
      for (const node of visible) if (!hits.has(node.id)) ids.add(node.id);
      return ids;
    }
    if (editingFrameId === null) return focusPathIds ?? EMPTY_DIMMED;
    const ids = new Set<string>(focusPathIds ?? []);
    for (const node of visible) if (node.frameId !== editingFrameId) ids.add(node.id);
    for (const frame of frames) if (frame.id !== editingFrameId) ids.add(frame.id);
    return ids;
  }, [editingFrameId, visible, frames, focusPathIds, matchIds]);

  function enterEditMode() {
    if (editingFrameId !== null) return; // nested edit attempt: ignored, not switched.
    if (selectedId === null) return;
    const frameId = byId.get(selectedId)?.frameId;
    if (frameId === undefined || !editableFrameIds?.has(frameId)) return;
    setEditingFrameId(frameId);
  }

  function exitEditMode(): boolean {
    if (editingFrameId === null) return false;
    setEditingFrameId(null);
    return true;
  }

  function select(id: string | null) {
    setSelectedId(id);
    setHaloId(null);
  }

  const FOCUSABLE_KINDS = new Set(["crew", "graph-run", "thread"]);

  /** A plain click selects, same as always; Ctrl/Cmd on a crew, graph-run or
   *  thread card toggles the focus instead (BBP-241) — any other kind, or no
   *  `onToggleFocus` given, falls through to the plain select so the
   *  modifier never leaves the click silently doing nothing. */
  function handleSelect(id: string, event?: ReactMouseEvent) {
    const modifier = event !== undefined && (event.metaKey || event.ctrlKey);
    const node = byId.get(id);
    if (modifier && onToggleFocus && node && FOCUSABLE_KINDS.has(node.kind)) {
      onToggleFocus(id);
      return;
    }
    // A double-click on a card that names a thread opens that thread's chat,
    // as in agent-graph; the first click of the pair has already selected it.
    const threadId = node?.meta?.threadId;
    if (event !== undefined && event.detail >= 2 && onOpenThread && typeof threadId === "string") {
      onOpenThread(threadId);
      return;
    }
    select(id);
  }

  /** Opens a node, and — the first time, if a loader was given — fetches its
   *  children. A leaf (no children, nothing to load) stays as it was. */
  function expand(id: string) {
    if (!expandable.has(id)) return;
    remember(withToggle(persisted.current, id, true));
    setExpanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    startLoad(id);
  }

  const autoOpened = useRef(new Set<string>());
  useEffect(() => {
    if (!autoExpand) return;
    const open: string[] = [];
    for (const node of allNodes) {
      if (autoOpened.current.has(node.id) || !expandable.has(node.id) || !autoExpand(node)) continue;
      autoOpened.current.add(node.id);
      // An ancestor the user has closed keeps the node out of view anyway.
      if (!expanded.has(node.id)) open.push(node.id);
    }
    if (open.length === 0) return;
    setExpanded((prev) => new Set([...prev, ...open]));
    for (const id of open) startLoad(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoExpand, allNodes, expandable]);

  const pendingReveal = useRef<string | null>(null);
  useEffect(() => {
    if (reveal) pendingReveal.current = reveal.id;
  }, [reveal?.id, reveal?.seq]);
  useEffect(() => {
    const id = pendingReveal.current;
    if (id === null) return;
    const node = byId.get(id);
    if (!node) return;
    pendingReveal.current = null;
    const ancestors: string[] = [];
    for (let parent = parentOf(byId, node); parent !== null; parent = parentOf(byId, byId.get(parent)!)) ancestors.push(parent);
    if (ancestors.some((ancestor) => !expanded.has(ancestor))) setExpanded((prev) => new Set([...prev, ...ancestors]));
    select(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.id, reveal?.seq, byId]);

  const seenReloads = useRef(new Map<string, number>());
  useEffect(() => {
    if (!reloadChildren) return;
    for (const [id, version] of reloadChildren) {
      if (seenReloads.current.get(id) === version) continue;
      seenReloads.current.set(id, version);
      if (loaded.has(id)) startLoad(id, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadChildren]);

  function startLoad(id: string, reload = false) {
    const node = byId.get(id);
    if (node && canLoadChildren && !canLoadChildren(node)) return;
    if (!node || !loadChildren || (loaded.has(id) && !reload) || loading.current.has(id)) return;
    loading.current.add(id);
    void loadChildren(node).then(
      (result) => {
        loading.current.delete(id);
        setLoaded((prev) => new Map(prev).set(id, result));
        setFailedLoads((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      },
      (error: unknown) => {
        loading.current.delete(id);
        // BBP-179: a rejected load used to vanish — the card just stayed
        // empty, indistinguishable from "this thread genuinely has no
        // turns". Surfacing it here, and as a visible error on the card
        // itself (NodeCard's `loadFailed`), makes a real failure
        // diagnosable instead of silently uncountable.
        console.error(`bb-canvas: failed to load children for node "${id}"`, error);
        setFailedLoads((prev) => new Set(prev).add(id));
      },
    );
  }

  function collapse(id: string) {
    remember(withToggle(persisted.current, id, false));
    setExpanded((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function toggle(id: string) {
    // A failed load already left the node "expanded" with nothing to show;
    // toggling it again must retry, not collapse it right back to looking
    // like a leaf with no error.
    if (failedLoads.has(id)) {
      startLoad(id);
      return;
    }
    if (expanded.has(id)) collapse(id);
    else expand(id);
  }

  /** Only cards whose children are already known: a lazy card stays shut,
   *  so this never fires a burst of timeline fetches. */
  function expandAll() {
    const ids = [...hasChildren];
    remember({ open: ids, closed: [] });
    setExpanded(new Set(ids));
    setFitRequest((count) => count + 1);
  }

  function collapseAll() {
    remember({ open: [], closed: [...new Set([...expandable, ...expanded])] });
    setExpanded(new Set());
    setFitRequest((count) => count + 1);
  }

  function siblingsOf(id: string): CanvasNode[] {
    const node = byId.get(id);
    if (!node) return [];
    const parent = parentOf(byId, node);
    return visible.filter((candidate) => parentOf(byId, candidate) === parent);
  }

  function moveSibling(direction: 1 | -1) {
    if (selectedId === null) {
      if (visible[0]) select(visible[0].id);
      return;
    }
    const siblings = siblingsOf(selectedId);
    const index = siblings.findIndex((node) => node.id === selectedId);
    const next = siblings[index + direction];
    if (next) select(next.id);
  }

  function moveToParent() {
    if (selectedId === null) return;
    const parent = byId.get(selectedId)?.parentId ?? null;
    if (parent !== null && visibleIds.has(parent)) select(parent);
  }

  function moveToFirstChild() {
    if (selectedId === null) return;
    const firstChild = visible.find((node) => parentOf(byId, node) === selectedId);
    if (firstChild) select(firstChild.id);
  }

  function jumpToActive() {
    if (!halo) {
      const active = visible.find((node) => node.status === "running");
      if (active) select(active.id);
      return;
    }
    const next = nextRunningId(visible, selectedId);
    if (next === null) return;
    setSelectedId(next);
    setHaloId(next);
    shellRef.current?.centerOn(next);
  }

  /** Jumps to the first visible node whose label contains `query`, and says
   *  whether it found one — `SearchBox` shows "no match" when it did not. */
  function jumpToFirstMatch(query: string): boolean {
    if (query.trim() === "") return false;
    const match = visible.find((node) => node.label.toLowerCase().includes(query.toLowerCase()));
    if (!match) return false;
    select(match.id);
    return true;
  }

  function closeSearch() {
    setSearchOpen(false);
    setSearchQuery("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (searchOpen) return; // SearchBox handles its own keys and stops propagation.
    // A key typed into a toolbar field (a limit, a filter search) is text,
    // not a shortcut — "0" must reach the number field, not reset the view.
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true']")) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveSibling(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveSibling(-1);
        break;
      case "ArrowRight":
        event.preventDefault();
        if (selectedId === null) break;
        // The tree-view pattern: a closed card opens, an open one steps
        // into its first child.
        if (!expanded.has(selectedId)) expand(selectedId);
        else moveToFirstChild();
        break;
      case "Enter":
        event.preventDefault();
        if (selectedId !== null && expandable.has(selectedId)) toggle(selectedId);
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (selectedId !== null && expanded.has(selectedId) && expandable.has(selectedId)) collapse(selectedId);
        else moveToParent();
        break;
      case "j":
      case "J":
        event.preventDefault();
        jumpToActive();
        break;
      case "0":
        event.preventDefault();
        shellRef.current?.resetView();
        break;
      case "+":
      case "=":
        event.preventDefault();
        shellRef.current?.zoomIn();
        break;
      case "-":
        event.preventDefault();
        shellRef.current?.zoomOut();
        break;
      case "/":
        event.preventDefault();
        if (panelMode) {
          setPanelCollapsed(false);
          // A frame later: an unfolded panel has to render its field first.
          requestAnimationFrame(() => document.querySelector<HTMLInputElement>("[data-canvas-search]")?.focus());
        } else setSearchOpen(true);
        break;
      case "]":
        if (!panelMode) break;
        event.preventDefault();
        setPanelCollapsed(!panelCollapsed);
        break;
      case "e":
      case "E":
        event.preventDefault();
        enterEditMode();
        break;
      case "Escape":
        // Leaving edit mode wins over the plain deselect below — with both
        // active, one Escape must not do both at once.
        if (exitEditMode()) break;
        if (selected) select(null);
        break;
      default: {
        const shortcut = !event.metaKey && !event.ctrlKey && !event.altKey ? shortcuts?.[event.key] : undefined;
        if (shortcut) {
          event.preventDefault();
          shortcut();
        }
        break;
      }
    }
  }

  const collapseButton = (
    <IconButton label="Hide panel (])" onClick={() => setPanelCollapsed(true)}>
      <path d="M6 3H3V13H6M9 5L12 8L9 11M12 8H5" />
    </IconButton>
  );

  return (
    <div
      className={className}
      data-canvas-view
      // The container is where arrow/J/0/+-//  land; a click into the canvas
      // or the sidebar must not steal focus away from it.
      tabIndex={0}
      onKeyDown={handleKeyDown}
      // `height: "100%"` alone collapses to 0 the moment an ancestor has no
      // explicit height of its own — the nav-panel route's container, for
      // one (BBP-173). `minHeight` is the floor that keeps the canvas usable
      // either way; a sized ancestor still wins, since 100% there is taller.
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: MIN_HEIGHT, outline: "none" }}
    >
      {/* Wraps rather than overflows: in BB's slim panel (370px) the
          controls would otherwise run past the right edge (BBP-179). */}
      {panelMode ? null : <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: breadcrumbInSidebar ? "flex-start" : "space-between", gap: 8 }}>
        {breadcrumbInSidebar ? null : <Breadcrumb nodes={allNodes} selectedId={selectedId} onSelect={select} />}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "4px 8px" }}>
          {toolbar}
          <button type="button" onClick={collapseAll} style={TOOLBAR_BUTTON}>
            Collapse all
          </button>
          <button type="button" onClick={expandAll} style={TOOLBAR_BUTTON}>
            Expand all
          </button>
          {hasRelations ? (
            <button
              type="button"
              onClick={toggleRelations}
              aria-pressed={showRelations}
              title="Show every member's assigns_to / escalates_to links"
              style={showRelations ? RELATIONS_ON : RELATIONS_OFF}
            >
              <svg
                aria-hidden
                width={12}
                height={12}
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="4" cy="4" r="2" />
                <circle cx="12" cy="12" r="2" />
                <path d="M6 4h2.5a3.5 3.5 0 0 1 3.5 3.5V10" strokeDasharray="2 2" />
              </svg>
              Relations
            </button>
          ) : null}
        </div>
      </div>}
      {searchOpen ? (
        <SearchBox
          value={searchQuery}
          onChange={setSearchQuery}
          onSubmit={() => jumpToFirstMatch(searchQuery)}
          onClose={closeSearch}
        />
      ) : null}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          {overlay ? <div style={{ position: "absolute", left: 12, bottom: 12, zIndex: 5, maxWidth: "calc(100% - 200px)" }}>{typeof overlay === "function" ? overlay(visible) : overlay}</div> : null}
          {cornerAction ? <div style={{ position: "absolute", right: 64, bottom: 14, zIndex: 5 }}>{cornerAction}</div> : null}
          {renderCanvasLayer ? renderCanvasLayer({ nodes: visible, selectedId, select }) : null}
          {panelMode && panelCollapsed ? (
            <div
              style={{
                position: "absolute",
                right: 12,
                top: 12,
                zIndex: 5,
                display: "flex",
                alignItems: "center",
                gap: 6,
                height: 32,
                padding: "0 4px 0 10px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--card)",
                boxShadow: "0 1px 3px rgb(0 0 0 / 0.12)",
              }}
            >
              {overviewBadge}
              <IconButton label="Show panel (])" onClick={() => setPanelCollapsed(false)}>
                <path d="M10 3H13V13H10M7 5L4 8L7 11M4 8H11" />
              </IconButton>
            </div>
          ) : null}
          <CanvasShell
            ref={shellRef}
            nodes={allNodes}
            expanded={expanded}
            expandable={expandable}
            onToggle={toggle}
            fitRequest={fitRequest}
            edges={shownEdges}
            frames={frames}
            selectedId={selectedId}
            haloId={halo ? haloId : null}
            onSelect={handleSelect}
            onBackgroundClick={() => select(null)}
            colorBy={colorBy}
            stepsAsLog={stepsAsLog}
            controlsPosition={controlsPosition}
            dimmedIds={dimmedIds}
            failedLoads={failedLoads}
          />
        </div>
        {editingFrameId !== null
          ? (renderFrameEditor?.(editingFrameId) ?? null)
          : panelMode && panelCollapsed
            ? null
            : selected
              ? (
                  <Sidebar
                    node={sidebarNode ?? selected}
                    onClose={() => select(null)}
                    onBack={panelMode ? () => select(null) : undefined}
                    headerActions={panelMode ? collapseButton : undefined}
                    onOpenThread={onOpenThread}
                    onOpenRun={onOpenRun}
                    onOpenCrew={onOpenCrew}
                    onOpenAtRow={onOpenAtRow}
                    onFocusThis={onFocusThis}
                    relations={hasRelations ? outgoingRelations(allEdges, selected.id, byId) : undefined}
                    onSelect={select}
                    extra={renderSidebarExtra?.(sidebarNode ?? selected)}
                    footer={renderNodeFooter?.(sidebarNode ?? selected)}
                    header={breadcrumbInSidebar && !panelMode ? <Breadcrumb nodes={allNodes} selectedId={selectedId} onSelect={select} /> : undefined}
                  />
                )
              : panelMode
                ? (
                    <SidePanel
                      label="Overview"
                      header={
                        <>
                          <span style={{ fontSize: 13, fontWeight: 600 }}>Overview</span>
                          <span style={{ flex: 1 }} />
                          {overviewBadge}
                          {collapseButton}
                        </>
                      }
                    >
                      {renderOverview({
                        nodes: visible,
                        allExpanded: [...hasChildren].every((id) => expanded.has(id)),
                        expandAll,
                        collapseAll,
                        select,
                        jumpToRunning: jumpToActive,
                        search: {
                          query: searchQuery,
                          setQuery: setSearchQuery,
                          matches: matchIds?.length ?? 0,
                          current: matchIds && matchIds.length > 0 ? matchAt + 1 : 0,
                          next: () => showMatch(matchAt + 1),
                          previous: () => showMatch(matchAt - 1),
                        },
                        relations: { available: hasRelations, shown: showRelations, toggle: toggleRelations },
                      })}
                    </SidePanel>
                  )
                : null}
      </div>
    </div>
  );
}

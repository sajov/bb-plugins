// bb-plugin-recall — frontend entry.
//
// Two surfaces over one search hook:
// - a palette command ("Recall: search everything", Mod+S) that opens an
//   overlay styled like BB's own command palette, with a result list and a
//   preview pane, and
// - a "Recall" tab in the thread's right panel for longer research.
// BB's native palette cannot be switched into a plugin mode, so the overlay
// is the plugin's own window that only borrows the palette's look.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { Hit, RecallStatus, rpcContract, SearchResult } from "./server";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type Mode = "fast" | "smart";
type KindFilter = "all" | Hit["kind"];

const OPEN_EVENT = "recall:open";

/**
 * What the palette command knew when it ran. The overlay is mounted outside
 * the thread view, so its own navigate.openThreadPanel has no side panel to
 * open into; the command's openPanel is bound to the thread that was in view.
 */
interface OpenContext {
  threadId: string | null;
  openPanel: ((options: { actionId: string; title?: string; params?: { query: string; mode: Mode } }) => boolean) | null;
}
const PANEL_ACTION_ID = "recall-panel";
const DEBOUNCE_MS = { fast: 150, smart: 400 } as const;
const RECENT_KEY = "recall:recent-queries";
const MAX_RECENT = 6;

const KIND_ICONS: Record<Hit["kind"], string> = {
  thread: "MessageSquare",
  task: "SquareCheck",
  file: "FileText",
};

const GROUPS: [Hit["kind"], string][] = [
  ["thread", "Threads"],
  ["task", "Tasks"],
  ["file", "Files"],
];

// ---------------------------------------------------------------- data hooks

/**
 * Debounced search over every source. Kind filters apply on the client so the
 * chips can show how many hits each kind has.
 */
function useRecallSearch(query: string, mode: Mode) {
  const rpc = useRpc<typeof rpcContract>();
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    const trimmed = query.trim();
    if (trimmed === "") {
      setResult(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      rpc
        .call("search", { query: trimmed, mode, limit: 30 })
        .then(
          (next) => {
            if (current !== generation.current) return;
            setResult(next);
            setError(null);
          },
          (cause: unknown) => {
            if (current !== generation.current) return;
            setError(cause instanceof Error ? cause.message : String(cause));
          },
        )
        .finally(() => {
          if (current === generation.current) setLoading(false);
        });
    }, DEBOUNCE_MS[mode]);
    return () => clearTimeout(timer);
  }, [rpc, query, mode]);

  return { result, loading, error };
}

function useRecallStatus() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<RecallStatus | null>(null);
  useEffect(() => {
    rpc.call("status").then(setStatus, () => setStatus(null));
  }, [rpc]);
  useRealtime("status-changed", (payload) => setStatus(payload as RecallStatus));
  const reindex = useCallback(() => {
    void rpc.call("reindex");
  }, [rpc]);
  return { status, reindex };
}

/** The indexed text of one hit, for the preview pane. */
function useDocument(hit: Hit | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [content, setContent] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setContent(undefined);
    if (!hit) return;
    let live = true;
    rpc.call("get", { kind: hit.kind, id: hit.id }).then(
      (doc) => live && setContent(doc.content),
      () => live && setContent(null),
    );
    return () => {
      live = false;
    };
  }, [rpc, hit?.key]);
  return content;
}

function readRecent(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function rememberQuery(query: string) {
  const trimmed = query.trim();
  if (trimmed.length < 2) return;
  const next = [trimmed, ...readRecent().filter((entry) => entry !== trimmed)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage can be full or disabled; recent queries are a convenience only.
  }
}

/**
 * Opens a hit: threads navigate, files open in BB's file preview, tasks copy
 * their key (BB offers plugins no route to a task).
 */
function useOpenHit(hostId: string | null) {
  const navigate = useBbNavigate();
  return useCallback(
    (hit: Hit): { outcome: "opened" | "copied" | "failed"; message: string } => {
      try {
        if (hit.kind === "thread") {
          navigate.toThread(hit.id);
          return { outcome: "opened", message: "Opening thread…" };
        }
        if (hit.kind === "file" && hostId) {
          const opened = navigate.experimental_openFilePreview({
            target: { kind: "host", hostId, path: hit.id },
            location: null,
          });
          if (opened) return { outcome: "opened", message: "Opening file…" };
        }
      } catch (error) {
        console.warn("[recall] open failed", error);
        return { outcome: "failed", message: "Could not open this result." };
      }
      const reference = referenceOf(hit);
      void navigator.clipboard?.writeText(reference);
      return { outcome: "copied", message: `Copied ${reference}` };
    },
    [navigate, hostId],
  );
}

function referenceOf(hit: Hit): string {
  if (hit.kind === "thread") return `@thread:${hit.id}`;
  if (hit.kind === "task") return hit.context?.split(" · ")[0] ?? hit.id;
  return hit.id;
}

// ---------------------------------------------------------------- helpers

function relativeTime(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 60 ? `${days}d` : `${Math.round(days / 30)}mo`;
}

function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter((term) => term.length >= 2))];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wraps every occurrence of a query term in <mark>; case-insensitive, prefix-friendly. */
function Highlight({ text, terms }: { text: string; terms: readonly string[] }) {
  if (terms.length === 0 || text === "") return <>{text}</>;
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  const parts = text.split(pattern);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <mark key={index} className="rounded-[3px] bg-primary/20 px-px text-foreground">
            {part}
          </mark>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/** The paragraph around the first query term, so the preview opens where the hit is. */
function excerptAround(content: string, terms: readonly string[], radius = 700): string {
  const body = content.replace(/^# .*\n+/, "");
  const lower = body.toLowerCase();
  const first = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0];
  if (first === undefined) return body.slice(0, radius * 2);
  const start = Math.max(0, first - radius);
  const end = Math.min(body.length, first + radius);
  return `${start > 0 ? "… " : ""}${body.slice(start, end)}${end < body.length ? " …" : ""}`;
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border bg-muted/60 px-1 font-sans text-[10px] text-muted-foreground">
      {children}
    </kbd>
  );
}

// ---------------------------------------------------------------- pieces

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  return (
    <div className="flex shrink-0 rounded-md bg-muted/60 p-0.5 text-xs">
      {(["fast", "smart"] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={cn(
            "rounded px-2.5 py-1 capitalize transition-colors",
            mode === option ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
          title={option === "fast" ? "Keywords only · instant" : "Keywords and meaning, reranked · a few seconds"}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function KindChips({ kind, onChange, hits }: {
  kind: KindFilter;
  onChange: (kind: KindFilter) => void;
  hits: readonly Hit[] | null;
}) {
  const count = (value: KindFilter) =>
    hits ? (value === "all" ? hits.length : hits.filter((hit) => hit.kind === value).length) : null;
  const options: [KindFilter, string][] = [["all", "All"], ...GROUPS];
  return (
    <div className="flex gap-1">
      {options.map(([value, label]) => {
        const n = count(value);
        const empty = n === 0 && value !== "all";
        return (
          <button
            key={value}
            type="button"
            onClick={() => onChange(value)}
            disabled={empty && kind !== value}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
              kind === value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
              empty && kind !== value && "opacity-40",
            )}
          >
            {value !== "all" && <Icon name={KIND_ICONS[value]} className="size-3.5" />}
            {label}
            {n !== null && <span className="tabular-nums text-muted-foreground">{n}</span>}
          </button>
        );
      })}
    </div>
  );
}

function ResultRow({ hit, terms, selected, onSelect, onOpen }: {
  hit: Hit;
  terms: readonly string[];
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return (
    <button
      ref={ref}
      type="button"
      onMouseMove={onSelect}
      onClick={onOpen}
      className={cn(
        "group relative flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors",
        selected ? "bg-muted" : "hover:bg-muted/40",
      )}
    >
      <Icon
        name={KIND_ICONS[hit.kind]}
        className={cn("mt-[3px] size-4 shrink-0", selected ? "text-foreground" : "text-muted-foreground")}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
            <Highlight text={hit.title || hit.id} terms={terms} />
          </span>
          {hit.via.length === 2 && (
            <span
              className="size-1.5 shrink-0 self-center rounded-full bg-primary/70"
              title="Found by keyword and by meaning"
            />
          )}
          {hit.updatedAt !== null && (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{relativeTime(hit.updatedAt)}</span>
          )}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          {hit.kind === "file" && <span className="shrink-0 font-medium">{hit.source}</span>}
          {hit.context && <span className="truncate">{hit.context}</span>}
        </span>
        {hit.snippet && (
          <span
            className={cn(
              "mt-1 text-xs leading-relaxed text-muted-foreground/90",
              selected ? "line-clamp-2" : "line-clamp-1",
            )}
          >
            <Highlight text={hit.snippet} terms={terms} />
          </span>
        )}
      </span>
    </button>
  );
}

function ResultList({ hits, terms, selected, setSelected, onOpen }: {
  hits: readonly Hit[];
  terms: readonly string[];
  selected: number;
  setSelected: (index: number) => void;
  onOpen: (hit: Hit) => void;
}) {
  let index = -1;
  return (
    <div className="space-y-1 p-1.5">
      {GROUPS.map(([kind, label]) => {
        const list = hits.filter((hit) => hit.kind === kind);
        if (list.length === 0) return null;
        return (
          <div key={kind}>
            <div className="sticky top-0 z-10 bg-popover/95 px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground backdrop-blur">
              {label}
            </div>
            {list.map((hit) => {
              index += 1;
              const position = index;
              return (
                <ResultRow
                  key={hit.key}
                  hit={hit}
                  terms={terms}
                  selected={position === selected}
                  onSelect={() => setSelected(position)}
                  onOpen={() => onOpen(hit)}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function Preview({ hit, terms, onOpen, canSidePanel, onSidePanel, notice }: {
  hit: Hit | null;
  terms: readonly string[];
  onOpen: (hit: Hit) => void;
  canSidePanel: boolean;
  onSidePanel: () => void;
  /** Feedback from the last action, so a button never fails silently. */
  notice?: string | null;
}) {
  const content = useDocument(hit);
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [hit?.key]);
  if (!hit) {
    return <div className="flex h-full items-center justify-center p-6 text-xs text-muted-foreground">No selection</div>;
  }
  const meta = [hit.kind === "file" ? hit.source : hit.kind === "task" ? "Task" : "Thread", hit.context]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start gap-2">
          <Icon name={KIND_ICONS[hit.kind]} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="text-sm font-medium leading-snug">{hit.title || hit.id}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {meta}
              {hit.updatedAt !== null ? ` · ${relativeTime(hit.updatedAt)} ago` : ""}
            </div>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {content === undefined ? (
          <div className="space-y-2">
            {[90, 75, 82, 60].map((width) => (
              <div key={width} className="h-2.5 animate-pulse rounded bg-muted" style={{ width: `${width}%` }} />
            ))}
          </div>
        ) : content === null ? (
          <p className="text-xs text-muted-foreground">Not indexed yet.</p>
        ) : (
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/85">
            <Highlight text={excerptAround(content, terms)} terms={terms} />
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5 border-t border-border px-4 py-2.5">
        <button
          type="button"
          onClick={() => onOpen(hit)}
          className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          {hit.kind === "task" ? "Copy key" : "Open"} <Kbd>↵</Kbd>
        </button>
        {canSidePanel && (
          <button
            type="button"
            onClick={onSidePanel}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
          >
            Side panel <Kbd>⌘↵</Kbd>
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(referenceOf(hit));
            setCopied(true);
          }}
          className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
        >
          {copied ? "Copied" : "Copy reference"}
        </button>
        {notice && <span className="self-center text-[11px] text-muted-foreground">{notice}</span>}
      </div>
    </div>
  );
}

function StatusLine({ status, onReindex }: { status: RecallStatus | null; onReindex: () => void }) {
  if (!status) return <span>Index status unavailable</span>;
  if (status.phase === "inactive") return <span>Recall is inactive · choose sources in plugin settings</span>;
  if (!status.qmdAvailable) return <span>qmd not installed · keyword search only</span>;
  if (status.phase === "error") return <span className="text-destructive">Index error: {status.error}</span>;
  if (status.phase !== "idle" && status.phase !== "starting") {
    const progress = status.progress ? ` ${status.progress.done}/${status.progress.total}` : "";
    return (
      <span className="flex items-center gap-1.5">
        <span className="size-1.5 animate-pulse rounded-full bg-primary" />
        Indexing · {status.phase}
        {progress}
      </span>
    );
  }
  const { threads, tasks, files } = status.counts;
  const parts = [`${threads.toLocaleString()} threads`, `${tasks.toLocaleString()} tasks`];
  if (files > 0) parts.push(`${files.toLocaleString()} files`);
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-1.5 rounded-full bg-emerald-500/80" />
      {parts.join(" · ")}
      {status.lastIndexedAt ? ` · ${relativeTime(status.lastIndexedAt)}` : ""}
      <button type="button" className="ml-1 hover:text-foreground" onClick={onReindex} title="Reindex now">
        <Icon name="RefreshCw" className="size-3" />
      </button>
    </span>
  );
}

function EmptyState({ onPick }: { onPick: (query: string) => void }) {
  const recent = readRecent();
  const examples = ["where did we decide on crew merges?", "qmd performance", "marketplace release"];
  return (
    <div className="px-4 py-5">
      {recent.length > 0 && (
        <>
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Recent</div>
          <div className="mb-4 space-y-0.5">
            {recent.map((query) => (
              <button
                key={query}
                type="button"
                onClick={() => onPick(query)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/50"
              >
                <Icon name="History" className="size-3.5 text-muted-foreground" />
                {query}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Try</div>
      <div className="flex flex-wrap gap-1.5">
        {examples.map((query) => (
          <button
            key={query}
            type="button"
            onClick={() => onPick(query)}
            className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {query}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- search surface

/** Shared state and keyboard handling for the overlay and the panel tab. */
function useSearchSurface(initialQuery: string, initialMode: Mode | null, active: boolean) {
  const [query, setQuery] = useState(initialQuery);
  const [modeChoice, setMode] = useState<Mode | null>(initialMode);
  const [kind, setKind] = useState<KindFilter>("all");
  const [selected, setSelected] = useState(0);
  const { status, reindex } = useRecallStatus();
  // Until the user picks a mode, the one chosen in settings applies.
  const mode = modeChoice ?? status?.defaultMode ?? "smart";
  const { result, loading, error } = useRecallSearch(active ? query : "", mode);
  const all = result?.hits ?? null;
  const visible = useMemo(() => {
    const filtered = (all ?? []).filter((hit) => kind === "all" || hit.kind === kind);
    // Flatten in display order so arrow keys walk the list as it is shown.
    return GROUPS.flatMap(([group]) => filtered.filter((hit) => hit.kind === group));
  }, [all, kind]);
  const terms = useMemo(() => queryTerms(query), [query]);
  useEffect(() => setSelected(0), [result, kind]);
  return {
    query, setQuery, mode, setMode, kind, setKind, selected, setSelected,
    status, reindex, result, loading, error, all, visible, terms,
    current: visible[selected] ?? null,
  };
}

function LoadingBar({ active }: { active: boolean }) {
  return (
    <div className="relative h-px overflow-hidden bg-border">
      {active && <div className="absolute inset-y-0 left-0 w-1/3 animate-pulse bg-primary" />}
    </div>
  );
}

function RecallOverlay() {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const openContext = useRef<OpenContext>({ threadId: null, openPanel: null });
  const surface = useSearchSurface("", null, open);
  const inputRef = useRef<HTMLInputElement>(null);
  const openHit = useOpenHit(surface.status?.hostId ?? null);
  const navigate = useBbNavigate();
  const context = useBbContext();

  useEffect(() => {
    const show = (event: Event) => {
      const detail = (event as CustomEvent<OpenContext | undefined>).detail;
      openContext.current = detail ?? { threadId: null, openPanel: null };
      setNotice(null);
      setOpen(true);
      requestAnimationFrame(() => inputRef.current?.select());
    };
    window.addEventListener(OPEN_EVENT, show);
    return () => window.removeEventListener(OPEN_EVENT, show);
  }, []);

  if (!open) return null;

  const close = () => setOpen(false);
  const threadInView = openContext.current.threadId ?? context.threadId;
  const activate = (hit: Hit) => {
    rememberQuery(surface.query);
    const result = openHit(hit);
    setNotice(result.message);
    if (result.outcome === "opened") close();
  };
  const toSidePanel = () => {
    rememberQuery(surface.query);
    const options = {
      actionId: PANEL_ACTION_ID,
      title: `Recall: ${surface.query}`,
      params: { query: surface.query, mode: surface.mode },
    };
    // Prefer the command's opener: it is bound to the thread that was in view.
    const accepted =
      openContext.current.openPanel?.(options) || navigate.openThreadPanel(options);
    if (accepted) close();
    else setNotice("Open a thread first: the side panel belongs to a thread view.");
  };

  function onKeyDown(event: ReactKeyboardEvent) {
    const { visible, selected, setSelected } = surface;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected(Math.min(selected + 1, Math.max(0, visible.length - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected(Math.max(selected - 1, 0));
    } else if (event.key === "Tab") {
      // Tab cycles the kind filters, like switching scopes in a palette.
      event.preventDefault();
      const order: KindFilter[] = ["all", "thread", "task", "file"];
      const next = order[(order.indexOf(surface.kind) + (event.shiftKey ? order.length - 1 : 1)) % order.length];
      surface.setKind(next);
    } else if (event.key === "Enter" && visible[selected]) {
      event.preventDefault();
      if ((event.metaKey || event.ctrlKey) && threadInView) toSidePanel();
      else activate(visible[selected]);
    }
  }

  const hasQuery = surface.query.trim() !== "";
  const showResults = hasQuery && surface.result && surface.visible.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[10vh] backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className="flex h-[min(620px,78vh)] w-[min(1040px,94vw)] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-3 px-4 py-3">
          <Icon name="Search" className="size-[18px] shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={surface.query}
            onChange={(event) => surface.setQuery(event.target.value)}
            placeholder="Search threads, tasks and files…"
            className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
            autoFocus
          />
          {surface.result && (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {surface.result.fallback ? "keyword only · " : ""}
              {(surface.result.tookMs / 1000).toFixed(1)}s
            </span>
          )}
          <ModeToggle mode={surface.mode} onChange={surface.setMode} />
        </div>
        <LoadingBar active={surface.loading} />
        <div className="flex items-center border-b border-border px-3 py-1.5">
          <KindChips kind={surface.kind} onChange={surface.setKind} hits={hasQuery ? surface.all : null} />
        </div>

        <div className="flex min-h-0 flex-1">
          <div className={cn("min-h-0 overflow-y-auto", showResults ? "w-[56%] border-r border-border" : "w-full")}>
            {surface.error ? (
              <div className="px-4 py-8 text-center text-sm text-destructive">{surface.error}</div>
            ) : !hasQuery ? (
              <EmptyState onPick={surface.setQuery} />
            ) : !surface.result ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">Searching…</div>
            ) : surface.visible.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No matches{surface.mode === "fast" ? " · try Smart to search by meaning" : ""}.
              </div>
            ) : (
              <ResultList
                hits={surface.visible}
                terms={surface.terms}
                selected={surface.selected}
                setSelected={surface.setSelected}
                onOpen={activate}
              />
            )}
          </div>
          {showResults && (
            <div className="min-h-0 w-[44%]">
              <Preview
                hit={surface.current}
                terms={surface.terms}
                onOpen={activate}
                canSidePanel={threadInView !== null}
                onSidePanel={toSidePanel}
                notice={notice}
              />
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
            <span className="flex items-center gap-1"><Kbd>↵</Kbd> open</span>
            <span className="flex items-center gap-1"><Kbd>tab</Kbd> filter</span>
            <span className="flex items-center gap-1"><Kbd>esc</Kbd> close</span>
          </span>
          <StatusLine status={surface.status} onReindex={surface.reindex} />
        </div>
      </div>
    </div>
  );
}

function RecallPanel({ params }: { threadId: string; params: unknown }) {
  const initial = (params ?? {}) as { query?: unknown; mode?: unknown };
  const surface = useSearchSurface(
    typeof initial.query === "string" ? initial.query : "",
    initial.mode === "fast" || initial.mode === "smart" ? initial.mode : null,
    true,
  );
  const openHit = useOpenHit(surface.status?.hostId ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => setNotice(null), [surface.current?.key]);
  const hasQuery = surface.query.trim() !== "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <Icon name="Search" className="size-4 shrink-0 text-muted-foreground" />
        <input
          value={surface.query}
          onChange={(event) => surface.setQuery(event.target.value)}
          placeholder="Search threads, tasks and files…"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <ModeToggle mode={surface.mode} onChange={surface.setMode} />
      </div>
      <LoadingBar active={surface.loading} />
      <div className="border-b border-border px-2 py-1.5">
        <KindChips kind={surface.kind} onChange={surface.setKind} hits={hasQuery ? surface.all : null} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {surface.error ? (
          <div className="px-4 py-6 text-center text-sm text-destructive">{surface.error}</div>
        ) : !hasQuery ? (
          <EmptyState onPick={surface.setQuery} />
        ) : surface.visible.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            {surface.result ? "No matches." : "Searching…"}
          </div>
        ) : (
          <ResultList
            hits={surface.visible}
            terms={surface.terms}
            selected={surface.selected}
            setSelected={surface.setSelected}
            onOpen={(hit) => {
              surface.setSelected(surface.visible.indexOf(hit));
              rememberQuery(surface.query);
              setNotice(openHit(hit).message);
            }}
          />
        )}
      </div>
      {surface.current && (
        <div className="h-[42%] min-h-0 border-t border-border">
          <Preview
            hit={surface.current}
            terms={surface.terms}
            onOpen={(hit) => setNotice(openHit(hit).message)}
            canSidePanel={false}
            onSidePanel={() => undefined}
            notice={notice}
          />
        </div>
      )}
      <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <StatusLine status={surface.status} onReindex={surface.reindex} />
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.commands.register({
    id: "search-everything",
    title: "Recall: search everything",
    defaultShortcut: { key: "s", mod: true },
    run: ({ threadId, openPanel }) => {
      const detail: OpenContext = { threadId, openPanel };
      window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail }));
    },
  });
  app.slots.experimental_appOverlay({ id: "recall-overlay", component: RecallOverlay });
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Recall",
    icon: "Search",
    layout: "flush",
    component: RecallPanel,
  });
});

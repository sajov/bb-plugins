// The side panel's overview (BBP-310/311): what the toolbar, the legend and
// the "Running"/"Needs you" buttons used to be, as four sections — search and
// filters, view options, a live status board and the legend.
import type { ReactNode } from "react";
import { Accordion } from "../vendor/bb-canvas/components/Accordion";
import type { OverviewContext } from "../vendor/bb-canvas/components/CanvasView";
import { FocusFilter } from "../vendor/bb-canvas/components/FocusFilter";
import { ProjectFilter } from "../vendor/bb-canvas/components/ProjectFilter";
import { STATUS_COLORS, statusKey, TYPE_COLORS, TYPE_LABELS, type ColorMode, type TypeColorKey } from "../vendor/bb-canvas/lib/kind-colors";
import type { ProjectLike } from "../vendor/bb-canvas/lib/thread-tree";
import type { CanvasNode } from "../vendor/bb-canvas/lib/types";

const HOUR = 3_600_000;
/** The amber of "Needs you", as on the cards (BBP-303). */
const NEEDS_COLOR = "#f59e0b";
/** The status board lists this many running or waiting threads, then "+ n more". */
const LIST_LIMIT = 5;

export type OverviewProps = {
  context: OverviewContext;
  projects: readonly ProjectLike[];
  projectIds: string[];
  onProjects: (ids: string[]) => void;
  windowMs: number | null;
  /** The window the plugin settings give; a pick away from it counts as a filter. */
  defaultWindowMs: number | null;
  onWindow: (ms: number | null) => void;
  /** The nodes the Focus dropdown picks from — the whole layer, not just what shows. */
  focusNodes: readonly CanvasNode[];
  picked: string[];
  onPicked: (ids: string[]) => void;
  activeOnly: boolean;
  onActiveOnly: (value: boolean) => void;
  colorBy: ColorMode;
  onColorBy: (value: ColorMode) => void;
  onJumpToNeeds: () => void;
  onReset: () => void;
  terminalOpen: boolean;
  onTerminal: (open: boolean) => void;
};

export function windowLabel(ms: number | null): string {
  if (ms === null) return "All";
  // Hours up to a day and a half, days beyond: "24 h" reads better than "1 d".
  if (ms >= HOUR * 48 && ms % (HOUR * 24) === 0) return `${ms / (HOUR * 24)} d`;
  return `${ms / HOUR} h`;
}

/** How many filters stand away from their default. */
export function activeFilterCount(props: Pick<OverviewProps, "projectIds" | "windowMs" | "defaultWindowMs" | "picked" | "activeOnly"> & { query: string }): number {
  return (
    (props.projectIds.length > 0 ? 1 : 0) +
    (props.windowMs !== props.defaultWindowMs ? 1 : 0) +
    (props.picked.length > 0 ? 1 : 0) +
    (props.activeOnly ? 1 : 0) +
    (props.query.trim() !== "" ? 1 : 0)
  );
}

/** What the status board counts: every card but the Agents and project roots. */
export function statusCounts(nodes: readonly CanvasNode[]) {
  const counts = { running: 0, needs: 0, failed: 0, done: 0 };
  for (const node of nodes) {
    if (node.kind === "agents" || node.kind === "project") continue;
    if (node.meta?.needsYou) counts.needs += 1;
    const key = statusKey(node.status);
    if (key === "running" || key === "failed" || key === "done") counts[key] += 1;
  }
  return counts;
}

function Label({ children }: { children: ReactNode }) {
  return <div className="text-[11px] text-muted-foreground">{children}</div>;
}

const CHIP = "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary";

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={`${CHIP} ${on ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`}>
      {children}
    </button>
  );
}

export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (value: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex overflow-hidden rounded-md border border-border">
      {options.map(([id, text]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          onClick={() => onChange(id)}
          className={`px-2.5 py-1 text-[11px] transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary ${value === id ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span>{label}</span>
      {children}
    </div>
  );
}

function Dot({ color }: { color: string }) {
  return <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />;
}

export function Overview(props: OverviewProps) {
  const { context, colorBy } = props;
  const { search } = context;
  const filters = activeFilterCount({ ...props, query: search.query });
  const windows = [...new Set([HOUR * 12, HOUR * 24, HOUR * 24 * 7, ...(props.defaultWindowMs !== null ? [props.defaultWindowMs] : [])])].sort((a, b) => a - b);
  const counts = statusCounts(context.nodes);
  const listed = context.nodes.filter((node) => node.kind === "thread" && (node.status === "running" || node.meta?.needsYou));
  const tiles: { key: string; label: string; value: number; color: string; onClick?: () => void }[] = [
    { key: "running", label: "Running", value: counts.running, color: STATUS_COLORS.running, onClick: counts.running > 0 ? context.jumpToRunning : undefined },
    { key: "needs", label: "Needs you", value: counts.needs, color: NEEDS_COLOR, onClick: counts.needs > 0 ? props.onJumpToNeeds : undefined },
    { key: "failed", label: "Failed", value: counts.failed, color: STATUS_COLORS.failed },
    { key: "done", label: "Done", value: counts.done, color: "var(--foreground)" },
  ];

  return (
    <>
      <Accordion title="Search & filter" summary={filters > 0 ? `${filters} active` : "—"} storageKey="overview:filter">
        <div className="flex h-8 items-center gap-2 rounded-md border border-border bg-card px-2">
          <svg aria-hidden width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} className="shrink-0 text-muted-foreground">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" strokeLinecap="round" />
          </svg>
          <input
            data-canvas-search
            aria-label="Search nodes"
            value={search.query}
            placeholder="Search threads, turns, commands…"
            onChange={(event) => search.setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (event.shiftKey) search.previous();
                else search.next();
              }
              if (event.key === "Escape") {
                event.stopPropagation();
                search.setQuery("");
                (event.target as HTMLInputElement).blur();
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
          {search.query.trim() !== "" ? (
            <>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" aria-live="polite">
                {search.matches === 0 ? "no match" : `${search.current} / ${search.matches}`}
              </span>
              {search.matches > 1 ? (
                <>
                  <button type="button" aria-label="Previous match (Shift+Enter)" onClick={search.previous} className="shrink-0 rounded px-0.5 text-muted-foreground hover:text-foreground">
                    ↑
                  </button>
                  <button type="button" aria-label="Next match (Enter)" onClick={search.next} className="shrink-0 rounded px-0.5 text-muted-foreground hover:text-foreground">
                    ↓
                  </button>
                </>
              ) : null}
            </>
          ) : (
            <kbd className="shrink-0 rounded border border-border px-1 font-mono text-[10px] text-muted-foreground">/</kbd>
          )}
        </div>
        <Label>Projects</Label>
        <div>
          <ProjectFilter projects={[...props.projects]} selected={props.projectIds} onChange={props.onProjects} />
        </div>
        <Label>Time window</Label>
        <div>
          <Segmented
            label="Time window"
            value={props.windowMs === null ? "all" : String(props.windowMs)}
            options={[...windows.map((ms): [string, string] => [String(ms), windowLabel(ms)]), ["all", "All"]]}
            onChange={(value) => props.onWindow(value === "all" ? null : Number(value))}
          />
        </div>
        <Label>Focus</Label>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip on={props.activeOnly} onClick={() => props.onActiveOnly(!props.activeOnly)}>
            Active only
          </Chip>
          <FocusFilter nodes={props.focusNodes} selected={props.picked} onChange={props.onPicked} />
        </div>
        {filters > 0 ? (
          <div className="flex justify-end">
            <button type="button" onClick={props.onReset} className="rounded px-1 text-[11px] text-primary underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary">
              Reset
            </button>
          </div>
        ) : null}
      </Accordion>

      <Accordion title="View" storageKey="overview:view">
        <Row label="Color by">
          <Segmented<ColorMode> label="Color by" value={colorBy} options={[["type", "Type"], ["status", "Status"]]} onChange={props.onColorBy} />
        </Row>
        <Row label="Cards">
          <Segmented
            label="Cards"
            value={context.allExpanded ? "all" : "compact"}
            options={[["compact", "Compact"], ["all", "All open"]]}
            onChange={(value) => (value === "all" ? context.expandAll() : context.collapseAll())}
          />
        </Row>
        <Row label="Tool-call terminal">
          <Segmented label="Tool-call terminal" value={props.terminalOpen ? "on" : "off"} options={[["off", "Off"], ["on", "On · T"]]} onChange={(value) => props.onTerminal(value === "on")} />
        </Row>
        {context.relations.available ? (
          <Row label="Relations">
            <Segmented label="Relations" value={context.relations.shown ? "on" : "off"} options={[["off", "Off"], ["on", "On"]]} onChange={(value) => value === "on" !== context.relations.shown && context.relations.toggle()} />
          </Row>
        ) : null}
      </Accordion>

      <Accordion title="Status" summary="live" storageKey="overview:status">
        <div className="grid grid-cols-4 gap-1.5">
          {tiles.map((tile) => (
            <button
              key={tile.key}
              type="button"
              disabled={tile.onClick === undefined}
              onClick={tile.onClick}
              title={tile.onClick ? `Jump to ${tile.label.toLowerCase()} work` : undefined}
              className={`flex flex-col items-start rounded-md border px-2 py-1.5 text-left transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary ${tile.onClick ? "border-border hover:bg-muted" : "cursor-default border-border/60"}`}
            >
              <span className="text-base font-semibold tabular-nums" style={{ color: tile.value > 0 ? tile.color : "var(--muted-foreground)" }}>
                {tile.value}
              </span>
              <span className="text-[10px] text-muted-foreground">{tile.label}</span>
            </button>
          ))}
        </div>
        {listed.length > 0 ? (
          <ul className="flex flex-col">
            {listed.slice(0, LIST_LIMIT).map((node) => (
              <li key={node.id}>
                <button
                  type="button"
                  onClick={() => context.select(node.id)}
                  className="flex h-7 w-full items-center gap-2 rounded px-1 text-left text-xs hover:bg-muted focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary"
                >
                  <Dot color={node.meta?.needsYou ? NEEDS_COLOR : STATUS_COLORS.running} />
                  <span className="min-w-0 flex-1 truncate">{node.label}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{node.meta?.needsYou ? "needs you" : "running"}</span>
                </button>
              </li>
            ))}
            {listed.length > LIST_LIMIT ? <li className="px-1 text-[11px] text-muted-foreground">+ {listed.length - LIST_LIMIT} more</li> : null}
          </ul>
        ) : (
          <div className="text-[11px] text-muted-foreground">No running work.</div>
        )}
      </Accordion>

      <Accordion title="Legend" defaultOpen={false} storageKey="overview:legend">
        {colorBy === "type" ? (
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            {(Object.keys(TYPE_COLORS) as TypeColorKey[]).map((key) => (
              <span key={key} className="flex items-center gap-1.5">
                <Dot color={TYPE_COLORS[key]} />
                {TYPE_LABELS[key]}
              </span>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            {(["running", "failed", "done", "idle"] as const).map((key) => (
              <span key={key} className="flex items-center gap-1.5">
                <Dot color={STATUS_COLORS[key]} />
                {key[0]!.toUpperCase() + key.slice(1)}
              </span>
            ))}
            <span className="flex items-center gap-1.5">
              <Dot color={NEEDS_COLOR} />
              Needs you
            </span>
          </div>
        )}
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span>┄ dashed: running path</span>
          <span>━ solid: selected</span>
        </div>
        <div className="text-[11px] text-muted-foreground">
          Click a card for its view · double-click a thread to open its chat · <kbd>/</kbd> search · <kbd>J</kbd> next running · <kbd>]</kbd> panel · <kbd>Esc</kbd> back
        </div>
      </Accordion>
    </>
  );
}

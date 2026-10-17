// The Canvas overview (BBP-283) as one pure pipeline from `threads.list` to
// the visible tree: project/focus → window → limit → active only. Every
// narrowing step runs before the limit, so "20 threads of project X" means
// 20 of X. The thread the canvas was opened for stays in view even when the
// archived flag, the window or the limit would drop it.
import { filterActive } from "./active-filter";
import { threadNodeId } from "./canvas-threads";
import { DEFAULT_THREAD_FILTER, filterThreads, narrowThreads, type ThreadFilter } from "./thread-filter";
import { threadTree, type ProjectLike, type ThreadListItem } from "./thread-tree";

export type OverviewInput = {
  projects: readonly ProjectLike[];
  threads: readonly ThreadListItem[];
  filter: ThreadFilter;
  /** The thread the canvas is focused on, if any. */
  focusThreadId: string | null;
  now: number;
  /** Last step: only active threads and the path to them (BBP-288). */
  activeOnly?: boolean;
  /** Threads "Active only" keeps although they are idle right now: they ran
   *  a moment ago. A thread goes idle between two turns for a blink, and
   *  dropping it each time makes cards and edges flicker (BBP-298). */
  recentlyActive?: ReadonlySet<string>;
};

export type Overview = ReturnType<typeof threadTree> & {
  /** Threads the window and limit let through (the focused extra not counted). */
  shown: number;
  /** Threads the project, status and archived filters let through. */
  total: number;
};

export function overviewTree({ projects, threads, filter, focusThreadId, now, activeOnly = false, recentlyActive = new Set() }: OverviewInput): Overview {
  const shown = filterThreads(threads, filter, now);
  const shownIds = new Set(shown.map((thread) => thread.id));
  // The focused thread, and under "Active only" every thread that ran a
  // moment ago, stay even when the window or the limit would drop them.
  const extraIds = new Set(activeOnly ? recentlyActive : []);
  if (focusThreadId !== null) extraIds.add(focusThreadId);
  const extra = threads.filter((thread) => extraIds.has(thread.id) && !shownIds.has(thread.id));
  const counts = { shown: shown.length, total: narrowThreads(threads, filter).length };
  const tree = threadTree(projects, [...shown, ...extra]);
  if (!activeOnly) return { ...tree, ...counts };
  const keep = new Set([...recentlyActive].map(threadNodeId));
  if (focusThreadId !== null) keep.add(threadNodeId(focusThreadId));
  const nodes = filterActive(tree.nodes, keep);
  const ids = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    edges: tree.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
    expanded: tree.expanded.filter((id) => ids.has(id)),
    ...counts,
  };
}

const HOUR = 3_600_000;

/** The toolbar's hint, e.g. "Last 12 h · 20 of 73". */
export function overviewSummary(filter: Pick<ThreadFilter, "windowMs">, shown: number, total: number): string {
  const count = `${shown} of ${total}`;
  return filter.windowMs === null ? count : `Last ${Math.round(filter.windowMs / HOUR)} h · ${count}`;
}

export type OverviewSettings = Pick<ThreadFilter, "windowMs" | "limit" | "turnsPerThread">;

/** An integer inside [min, max], or the fallback. */
function inRange(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/**
 * The plugin settings (windowHours 1–720, maxThreads 1–100, overviewTurns
 * 0–10, as agent-graph) as overview filter values; anything missing or out
 * of range falls back to the default.
 */
export function overviewSettings(values: Readonly<Record<string, unknown>> | undefined): OverviewSettings {
  const fallback = DEFAULT_THREAD_FILTER;
  return {
    windowMs: inRange(values?.windowHours, 1, 720, fallback.windowMs! / HOUR) * HOUR,
    limit: inRange(values?.maxThreads, 1, 100, fallback.limit!),
    turnsPerThread: inRange(values?.overviewTurns, 0, 10, fallback.turnsPerThread!),
  };
}

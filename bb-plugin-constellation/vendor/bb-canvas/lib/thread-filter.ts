// The Canvas toolbar filters (BBP-189 AK 4) as one pure step between
// `threads.list` and `threadTree`. Every narrowing filter runs before the
// thread limit, so "50 threads of project X" means 50 of X, not the X-share
// of the newest 50 overall.
import { threadStatus, type ThreadListItem } from "./thread-tree";
import type { CanvasStatus } from "./types";

export type ThreadFilter = {
  /** Only threads updated within this many ms of now; null = any age. */
  windowMs: number | null;
  /** At most this many threads, newest first; null = all. */
  limit: number | null;
  /** At most this many turns under an opened thread, newest kept; null = all. */
  turnsPerThread: number | null;
  hideArchived: boolean;
  /** Empty means every project — never an empty canvas waiting for a pick. */
  projectIds: readonly string[];
  /** Empty means every status. */
  statuses: readonly CanvasStatus[];
};

const HOUR = 3_600_000;

export const DEFAULT_THREAD_FILTER: ThreadFilter = {
  windowMs: 12 * HOUR,
  limit: 20,
  turnsPerThread: 1,
  hideArchived: true,
  projectIds: [],
  statuses: [],
};

/** Statuses that need attention: never dropped by the window or the limit (BBP-225). */
const LIVE: ReadonlySet<CanvasStatus> = new Set(["running", "waiting", "failed", "escalated"]);

const isLive = (thread: ThreadListItem) => LIVE.has(threadStatus(thread.status));

/** The project, status and archived filters: what the window and limit then count against. */
export function narrowThreads(threads: readonly ThreadListItem[], filter: ThreadFilter): ThreadListItem[] {
  const projects = new Set(filter.projectIds);
  const statuses = new Set(filter.statuses);
  return threads
    .filter((thread) => !(filter.hideArchived && thread.archivedAt !== null))
    .filter((thread) => projects.size === 0 || projects.has(thread.projectId))
    .filter((thread) => statuses.size === 0 || statuses.has(threadStatus(thread.status)));
}

export function filterThreads(threads: readonly ThreadListItem[], filter: ThreadFilter, now: number): ThreadListItem[] {
  const sorted = narrowThreads(threads, filter).sort((a, b) => b.updatedAt - a.updatedAt);
  const quiet = sorted.filter((thread) => !isLive(thread) && (filter.windowMs === null || now - thread.updatedAt <= filter.windowMs));
  const kept = new Set(filter.limit === null ? quiet : quiet.slice(0, filter.limit));
  return sorted.filter((thread) => kept.has(thread) || isLive(thread));
}

/** The newest `limit` turns, still in timeline order. */
export function limitTurns<T>(turns: readonly T[], limit: number | null): T[] {
  return limit === null || turns.length <= limit ? [...turns] : turns.slice(turns.length - limit);
}

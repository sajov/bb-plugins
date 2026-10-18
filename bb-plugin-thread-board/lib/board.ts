import type { Purpose } from "./purpose";

export type Column = "working" | "waiting" | "stale" | "done";

export const COLUMNS: readonly { id: Column; title: string }[] = [
  { id: "working", title: "In progress" },
  { id: "waiting", title: "Waiting for you" },
  { id: "stale", title: "Stale" },
  { id: "done", title: "Done" },
];

export interface BoardThread {
  id: string;
  status: string;
  hasPendingInteraction: boolean;
  updatedAt: number;
}

const BUSY = new Set(["starting", "active", "stopping", "pending"]);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Where a thread sits. Live host state comes first: a running agent is in
 * progress, a pending approval waits for the user. A manual "done" wins over
 * everything except a running agent. Then the model: "done" and — for an idle
 * thread with work left but no question — "working". An idle thread nobody
 * has assessed has handed the turn back, so it waits for the user. Stale
 * catches whatever has been quiet too long and is not done.
 */
export function columnFor(
  thread: BoardThread,
  purpose: Pick<Purpose, "state"> | undefined,
  options: { now: number; staleDays: number; markedDone: boolean },
): Column {
  if (isRunning(thread)) return "working";
  if (options.markedDone) return "done";
  if (thread.hasPendingInteraction) return "waiting";
  if (purpose?.state === "done") return "done";
  if (options.now - thread.updatedAt > options.staleDays * DAY_MS) return "stale";
  if (purpose?.state === "working") return "working";
  return "waiting";
}

export function isRunning(thread: Pick<BoardThread, "status">): boolean {
  return BUSY.has(thread.status);
}

export function groupByColumn<T extends BoardThread>(
  threads: readonly T[],
  columnOf: (thread: T) => Column,
): Record<Column, T[]> {
  const groups: Record<Column, T[]> = { working: [], waiting: [], stale: [], done: [] };
  for (const thread of threads) groups[columnOf(thread)].push(thread);
  for (const list of Object.values(groups)) list.sort((a, b) => b.updatedAt - a.updatedAt);
  return groups;
}

export function relativeTime(then: number, now: number): string {
  const minutes = Math.round((now - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

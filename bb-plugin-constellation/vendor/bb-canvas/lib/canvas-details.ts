// What the canvas sidebar shows for a thread beyond its id (BBP-179
// acceptance): BB's status, provider and model, times, and turn count,
// loaded once when the node is selected. Identical in crew and graph-studio;
// the SDK sits behind `ThreadDetailsPort` so the mapping is testable.
import { formatTimestamp } from "./format";
import type { CanvasNode } from "./types";

/** The slice of the SDK's `ThreadResponse` this reads. */
export type ThreadLike = {
  title: string | null;
  titleFallback?: string | null;
  status: string;
  displayStatus?: string;
  providerId: string;
  createdAt: number;
  updatedAt: number;
};

export type ThreadDetailsPort = {
  get: (threadId: string) => Promise<ThreadLike>;
  /** `threads.defaultExecutionOptions().model` — `ThreadResponse` has no model. */
  model: (threadId: string) => Promise<string | null>;
  timelineRows: (threadId: string) => Promise<readonly { kind: string }[]>;
};

/** `null`/missing inputs are left out, so `curateMeta` shows no empty row and
 *  a timeline that failed to load is not mistaken for zero turns. */
export function threadDetails(
  thread: ThreadLike,
  model: string | null,
  rows: readonly { kind: string }[] | null,
): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  const title = thread.title || thread.titleFallback;
  if (title) details.title = title;
  details.state = thread.displayStatus ?? thread.status;
  details.provider = thread.providerId;
  if (model) details.model = model;
  if (rows) details.turns = rows.filter((row) => row.kind === "turn").length;
  const created = formatTimestamp(thread.createdAt);
  if (created) details.created = created;
  const updated = formatTimestamp(thread.updatedAt);
  if (updated) details.updated = updated;
  return details;
}

/** Details for a `thread` node; `null` for any other kind or when the thread
 *  itself cannot be read. Model and timeline are extras: either failing
 *  still shows the rest. */
export async function loadNodeDetails(port: ThreadDetailsPort, node: CanvasNode): Promise<Record<string, unknown> | null> {
  const threadId = node.meta?.threadId;
  if (node.kind !== "thread" || typeof threadId !== "string" || threadId === "") return null;
  const [thread, model, rows] = await Promise.allSettled([port.get(threadId), port.model(threadId), port.timelineRows(threadId)]);
  if (thread.status === "rejected") return null;
  return threadDetails(
    thread.value,
    model.status === "fulfilled" ? model.value : null,
    rows.status === "fulfilled" ? rows.value : null,
  );
}

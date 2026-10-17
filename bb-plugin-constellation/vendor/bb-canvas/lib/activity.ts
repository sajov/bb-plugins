// The thread panel's Activity list (BBP-291, see BBP-264): every row of a
// thread's timeline — turns, tool calls, thoughts, subagents — in order,
// marked by whether the canvas shows it under its turn limit. Pure, on the
// nodes `timelineToCanvas` makes from the thread's full timeline.
import { limitTurns } from "./thread-filter";
import type { CanvasNode, CanvasNodeKind, CanvasStatus } from "./types";

export type ActivityEntry = {
  id: string;
  label: string;
  kind: CanvasNodeKind;
  status?: CanvasStatus;
  inCanvas: boolean;
  /** A turn's "5 steps · 2m 10s" (BBP-298). */
  detail?: string;
};

function turnDetail(node: CanvasNode): string | undefined {
  const steps = node.meta?.summaryCount;
  const facts = [
    typeof steps === "number" ? `${steps} ${steps === 1 ? "step" : "steps"}` : undefined,
    typeof node.meta?.duration === "string" ? node.meta.duration : undefined,
  ].filter((fact): fact is string => fact !== undefined);
  return facts.length > 0 ? facts.join(" · ") : undefined;
}

export type ActivityList = { entries: ActivityEntry[]; header: string };

/** The rows directly under `threadNodeId`. The canvas keeps only the newest
 *  `turnsPerThread` turns (null: all), every other row stays. */
export function activityList(nodes: readonly CanvasNode[], threadNodeId: string, turnsPerThread: number | null): ActivityList {
  const rows = nodes.filter((node) => node.parentId === threadNodeId);
  const keptTurns = new Set(limitTurns(rows.filter((node) => node.kind === "turn"), turnsPerThread).map((node) => node.id));
  const entries = rows.map((node) => ({
    id: node.id,
    label: node.label,
    kind: node.kind,
    ...(node.status ? { status: node.status } : {}),
    inCanvas: node.kind !== "turn" || keptTurns.has(node.id),
    ...(node.kind === "turn" && turnDetail(node) ? { detail: turnDetail(node) } : {}),
  }));
  const shown = entries.filter((entry) => entry.inCanvas).length;
  return { entries, header: `${shown} of ${entries.length} in canvas` };
}

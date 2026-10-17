// J on the canvas (BBP-290, see BBP-237): cycles through the running nodes
// in on-screen order, wrapping around. Pure, so the order is testable
// without a canvas.
import type { CanvasNode } from "./types";

/** The running node after `currentId` (the first one when nothing or a
 *  node past the last running one is current); null when nothing runs. */
export function nextRunningId(nodes: readonly CanvasNode[], currentId: string | null): string | null {
  const running = nodes.filter((node) => node.status === "running");
  if (running.length === 0) return null;
  const from = currentId === null ? -1 : nodes.findIndex((node) => node.id === currentId);
  const after = running.find((node) => nodes.indexOf(node) > from);
  return (after ?? running[0]!).id;
}

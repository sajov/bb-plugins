// "Active only" (BBP-288, see BBP-226): every running or waiting node plus
// the chain of its ancestors, so the path to the active work stays as
// context; idle siblings and finished work drop out. Pure, on any layer.
import type { CanvasNode, CanvasStatus } from "./types";

const ACTIVE: ReadonlySet<CanvasStatus> = new Set(["running", "waiting"]);

/** A crew is active only through a working member (BBP-214): its own
 *  "running" status does not count on its own. */
const countsOnItsOwn = (node: CanvasNode): boolean => node.kind !== "crew" && node.status !== undefined && ACTIVE.has(node.status);

/** `alsoKeep` ids count as active too (the thread the canvas is focused on). */
export function filterActive(nodes: readonly CanvasNode[], alsoKeep: ReadonlySet<string> = new Set()): CanvasNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const keep = new Set<string>();
  for (const node of nodes) {
    if (!countsOnItsOwn(node) && !alsoKeep.has(node.id)) continue;
    for (let current: CanvasNode | undefined = node; current && !keep.has(current.id); current = current.parentId ? byId.get(current.parentId) : undefined) {
      keep.add(current.id);
    }
  }
  return nodes.filter((node) => keep.has(node.id));
}

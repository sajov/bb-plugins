// Relation edges (BBP-202): a crew's declared links, drawn on demand. Hidden
// unless the "Relations" toggle is on; a selected node always shows its own,
// highlighted — with the toggle on, the rest stay but dim.
import type { CanvasEdge, CanvasNode } from "./types";

/** One kind of a node's own relations, as the sidebar lists it (BBP-203). */
export type RelationGroup = { kind: string; targets: { id: string; label: string }[] };

/** `assigns_to` → "Assigns to". */
const kindLabel = (kind: string): string => {
  const words = kind.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The links that start at `nodeId`, grouped by kind in first-seen order;
 *  incoming links and targets not on the canvas are left out. */
export function outgoingRelations(
  edges: readonly CanvasEdge[],
  nodeId: string,
  byId: ReadonlyMap<string, CanvasNode>,
): RelationGroup[] {
  const groups = new Map<string, RelationGroup>();
  for (const edge of edges) {
    if (!edge.relation) continue;
    for (const link of edge.links ?? []) {
      const target = byId.get(link.to);
      if (link.from !== nodeId || !target) continue;
      const group = groups.get(link.kind) ?? { kind: kindLabel(link.kind), targets: [] };
      if (!group.targets.some((other) => other.id === target.id)) group.targets.push({ id: target.id, label: target.label });
      groups.set(link.kind, group);
    }
  }
  return [...groups.values()];
}

export const relationsStorageKey = (surface: string): string => `bb-canvas:relations:${surface}`;

export function relationsView(
  edges: readonly CanvasEdge[],
  showRelations: boolean,
  selectedId: string | null,
): CanvasEdge[] {
  const touches = (edge: CanvasEdge) => edge.relation === true && (edge.from === selectedId || edge.to === selectedId);
  const focused = selectedId !== null && edges.some(touches);
  return edges.flatMap((edge) => {
    if (!edge.relation) return [edge];
    if (!focused) return showRelations ? [edge] : [];
    if (touches(edge)) return [{ ...edge, emphasis: "highlight" as const }];
    return showRelations ? [{ ...edge, emphasis: "dim" as const }] : [];
  });
}

/** The stored choice, else `fallback` (off unless a page asks for on, BBP-191); never throws (see `loadExpandedState`). */
export function loadRelations(surface: string | undefined, fallback = false): boolean {
  if (surface === undefined) return fallback;
  try {
    const stored = localStorage.getItem(relationsStorageKey(surface));
    return stored === null ? fallback : stored === "on";
  } catch {
    return fallback;
  }
}

export function saveRelations(surface: string | undefined, on: boolean): void {
  if (surface === undefined) return;
  try {
    localStorage.setItem(relationsStorageKey(surface), on ? "on" : "off");
  } catch {
    // Not persisted this time; the toggle still works for the session.
  }
}

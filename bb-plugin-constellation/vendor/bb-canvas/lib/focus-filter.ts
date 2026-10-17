// Which nodes the canvas shows when one or more crews, graph runs or threads
// are focused (BBP-204/238): the selected nodes, their whole subtree, and the
// path to the root as dimmed context. An empty selection means everything —
// the same "no picked state waits for input" convention as project-filter.ts.

import type { CanvasNode } from "./types";

export const FOCUS_FILTER_KEY = "bb-canvas:focus";

/** Never throws: a missing, blocked or hand-edited entry reads as "all". */
export function loadFocusFilter(): string[] {
  try {
    const raw = localStorage.getItem(FOCUS_FILTER_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function saveFocusFilter(ids: readonly string[]): void {
  try {
    localStorage.setItem(FOCUS_FILTER_KEY, JSON.stringify(ids));
  } catch {
    // Not persisted this time; the focus still works for the rest of the session.
  }
}

function parentIdMap(nodes: readonly CanvasNode[]): ReadonlyMap<string, string | null> {
  const byId = new Set(nodes.map((node) => node.id));
  const map = new Map<string, string | null>();
  for (const node of nodes) {
    map.set(node.id, node.parentId !== null && byId.has(node.parentId) ? node.parentId : null);
  }
  return map;
}

function childrenOfMap(nodes: readonly CanvasNode[], parentIdOf: ReadonlyMap<string, string | null>) {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    const parentId = parentIdOf.get(node.id)!;
    if (parentId === null) continue;
    const list = children.get(parentId) ?? [];
    list.push(node.id);
    children.set(parentId, list);
  }
  return children;
}

/** Every id in the selected node's subtree, the selected node included. */
function subtreeIds(id: string, children: ReadonlyMap<string, string[]>): string[] {
  const ids: string[] = [id];
  for (const childId of children.get(id) ?? []) ids.push(...subtreeIds(childId, children));
  return ids;
}

/** The ancestors of `id`, root first, excluding `id` itself. */
function ancestorIds(id: string, parentIdOf: ReadonlyMap<string, string | null>): string[] {
  const ancestors: string[] = [];
  let current = parentIdOf.get(id) ?? null;
  while (current !== null) {
    ancestors.push(current);
    current = parentIdOf.get(current) ?? null;
  }
  return ancestors;
}

/** The ids to render: selected nodes still present in `nodes`, their whole
 *  subtree, and the path to the root. An empty selection shows everything;
 *  a selection made entirely of vanished ids shows nothing — the page then
 *  renders the "no longer available" notice instead. */
export function visibleFocusIds(nodes: readonly CanvasNode[], selected: readonly string[]): Set<string> {
  if (selected.length === 0) return new Set(nodes.map((node) => node.id));
  const byId = new Set(nodes.map((node) => node.id));
  const parentIdOf = parentIdMap(nodes);
  const children = childrenOfMap(nodes, parentIdOf);
  const visible = new Set<string>();
  for (const id of selected) {
    if (!byId.has(id)) continue;
    for (const subId of subtreeIds(id, children)) visible.add(subId);
    for (const ancestorId of ancestorIds(id, parentIdOf)) visible.add(ancestorId);
  }
  return visible;
}

/** Only the path nodes (root down to each selected node's parent), for
 *  dimming — excludes the selected nodes and their subtrees. */
export function focusPathIds(nodes: readonly CanvasNode[], selected: readonly string[]): Set<string> {
  const byId = new Set(nodes.map((node) => node.id));
  const parentIdOf = parentIdMap(nodes);
  const path = new Set<string>();
  for (const id of selected) {
    if (!byId.has(id)) continue;
    for (const ancestorId of ancestorIds(id, parentIdOf)) path.add(ancestorId);
  }
  return path;
}

/** Selected ids no longer present in `nodes` — what drives the "Focused
 *  items are no longer available" notice. */
export function missingFocusIds(nodes: readonly CanvasNode[], selected: readonly string[]): string[] {
  const byId = new Set(nodes.map((node) => node.id));
  return selected.filter((id) => !byId.has(id));
}

// BBP-220: the set of nodes whose edge to their parent lies on the path from
// the tree's root down to the current selection — pure and DOM-free so
// `layoutTree` can enrich its flow edges without re-walking the tree itself.

/**
 * Walks `parentIdOf` from `selectedId` up to its root and returns every node
 * on that walk (the selection and each of its ancestors except the root,
 * which has no incoming edge of its own). `null` or an id missing from
 * `parentIdOf` yields an empty set — no selection, no highlighted path.
 */
export function selectedPathEdges(
  selectedId: string | null,
  parentIdOf: ReadonlyMap<string, string | null>,
): ReadonlySet<string> {
  const onPath = new Set<string>();
  let current = selectedId;
  while (current !== null && parentIdOf.has(current)) {
    const parent = parentIdOf.get(current)!;
    if (parent === null) break; // the root has no incoming edge of its own
    onPath.add(current);
    current = parent;
  }
  return onPath;
}

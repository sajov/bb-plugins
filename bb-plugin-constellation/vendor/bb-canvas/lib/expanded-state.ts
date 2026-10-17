// Which cards a reader opened or closed on a surface (BBP-183). Stored as
// explicit opens and closes on top of the page's `initialExpanded`, not as a
// full set: a node that appears later (a new crew, another project in the
// filter) still starts the way its page wants it to.

export type ExpandedState = { open: string[]; closed: string[] };

export const expandedStorageKey = (surface: string): string => `bb-canvas:expanded:${surface}`;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** `null` when nothing (readable) is stored — never throws. */
export function loadExpandedState(surface: string): ExpandedState | null {
  try {
    const raw = localStorage.getItem(expandedStorageKey(surface));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { open, closed } = parsed as Record<string, unknown>;
    return isStringArray(open) && isStringArray(closed) ? { open, closed } : null;
  } catch {
    return null;
  }
}

export function saveExpandedState(surface: string, state: ExpandedState): void {
  try {
    localStorage.setItem(expandedStorageKey(surface), JSON.stringify(state));
  } catch {
    // Not persisted this time; expand/collapse still works for the session.
  }
}

export function restoreExpanded(initial: Iterable<string>, stored: ExpandedState | null): Set<string> {
  const expanded = new Set(initial);
  if (stored === null) return expanded;
  for (const id of stored.closed) expanded.delete(id);
  for (const id of stored.open) expanded.add(id);
  return expanded;
}

export function withToggle(state: ExpandedState, id: string, open: boolean): ExpandedState {
  const without = (ids: string[]) => ids.filter((other) => other !== id);
  return open
    ? { open: [...without(state.open), id], closed: without(state.closed) }
    : { open: without(state.open), closed: [...without(state.closed), id] };
}

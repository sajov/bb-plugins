// Which projects the canvas shows as roots (BBP-181). An empty selection
// means every project — there is no state in which the page shows nothing
// and waits for a pick.

export const PROJECT_FILTER_KEY = "bb-canvas:project-filter";

export type ProjectOption = { id: string; name: string };

/** Never throws: a missing, blocked or hand-edited entry reads as "all". */
export function loadProjectFilter(): string[] {
  try {
    const raw = localStorage.getItem(PROJECT_FILTER_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function saveProjectFilter(ids: readonly string[]): void {
  try {
    localStorage.setItem(PROJECT_FILTER_KEY, JSON.stringify(ids));
  } catch {
    // Not persisted this time; the filter still works for the rest of the session.
  }
}

/** A project named in the URL is what the user came for, so it wins over
 *  whatever was stored last time. */
export function initialProjectFilter(stored: readonly string[], urlProjectId: string | null): string[] {
  return urlProjectId !== null ? [urlProjectId] : [...stored];
}

/** The projects to render, in list order. Deleted or unknown ids drop out;
 *  if that leaves nothing, show everything rather than an empty canvas. */
export function visibleProjectIds(selected: readonly string[], projects: readonly ProjectOption[]): string[] {
  const wanted = new Set(selected);
  const known = projects.filter((project) => wanted.has(project.id)).map((project) => project.id);
  return known.length > 0 ? known : projects.map((project) => project.id);
}

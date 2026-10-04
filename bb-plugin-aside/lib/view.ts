// The state of the header menus, the collapsed rows and the tag filter.
//
// Pure data handling: parse, check, write. The value lives in the server's
// plugin database (host-wide, across devices) and may contain anything — a
// foreign or outdated format falls back to the defaults instead of taking the
// sidenav apart.
import { normalizeTags } from "./tags";

export const PROJECT_SORTS = ["manual", "activity", "name"] as const;
export const THREAD_SORTS = ["newest", "state"] as const;

export type ProjectSort = (typeof PROJECT_SORTS)[number];
export type ThreadSort = (typeof THREAD_SORTS)[number];

export interface ViewState {
  projectSort: ProjectSort;
  threadSort: ThreadSort;
  /** Condense quiet families into a single row. */
  foldQuiet: boolean;
  /**
   * Focus follows the active thread: opening a thread collapses every other
   * project. Replaces the old "One project open at a time" switch, which was
   * stored but never applied.
   */
  focusFollows: boolean;
  /** The group of pinned threads across all projects at the top of the list. */
  pinnedGroup: boolean;
  /** The pinned group is folded to its heading. */
  pinnedCollapsed: boolean;
  /** Show archived threads too — the only switch that adds. */
  archived: boolean;
  /** Single-line cards without the branch row. */
  compact: boolean;
  /** Show projects without a thread. Default: off. */
  emptyProjects: boolean;
  /**
   * Position of the personal project: after this project, `null` = at the top.
   * The host does not sort it, so we keep the position ourselves.
   */
  personalAfter: string | null;
  /**
   * Root thread ids in the order they were dragged. The host keeps an order
   * only for pinned threads, so we keep the rest ourselves.
   */
  threadOrder: string[];
  /**
   * Section ids in the order they were dragged. A section belongs to no
   * project, so this order is the same everywhere it appears.
   */
  sectionOrder: string[];
  /** Collapsed projects, as project ids. */
  collapsedProjects: string[];
  /** Collapsed sections, as `projectId:sectionId`. */
  collapsedSections: string[];
  /** Projects whose condensed quiet block is open. */
  openQuiet: string[];
  /**
   * Tags the list is narrowed to. Empty = everything, which is the default and
   * the state the filter button returns to.
   *
   * The one thing in here that actually removes rows. It is picked in the
   * search slot and stands as a chip in the scope bar for that reason, and it
   * narrows whole projects, never the threads inside one. A project you did not
   * ask for is gone with everything in it; no thread ever disappears out from
   * under a project that stayed.
   */
  tagFilter: string[];
  /**
   * Projects picked directly, by id — the "Projects" entries under the tags
   * in the same filter. Joins the tag filter as a union: a project picked
   * here stays visible whether or not it carries a picked tag. Ids rather
   * than names so a rename does not silently drop the pick.
   */
  projectFilter: string[];
}

export const DEFAULT_VIEW: ViewState = {
  projectSort: "manual",
  threadSort: "newest",
  foldQuiet: false,
  focusFollows: false,
  pinnedGroup: true,
  pinnedCollapsed: false,
  archived: false,
  compact: false,
  emptyProjects: false,
  personalAfter: null,
  threadOrder: [],
  sectionOrder: [],
  collapsedProjects: [],
  collapsedSections: [],
  openQuiet: [],
  tagFilter: [],
  projectFilter: [],
};

/** How many ids we keep at most — a list that only grows is a leak. */
export const MAX_IDS = 500;

function readOption<const T extends readonly string[]>(
  value: unknown,
  options: T,
  fallback: T[number],
): T[number] {
  return typeof value === "string" &&
    (options as readonly string[]).includes(value)
    ? (value as T[number])
    : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    if (entry.length === 0 || entry.length > 200) continue;
    if (ids.includes(entry)) continue;
    ids.push(entry);
    if (ids.length >= MAX_IDS) break;
  }
  return ids;
}

export function parseViewState(value: unknown): ViewState {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_VIEW };
  const raw = value as Record<string, unknown>;
  return {
    projectSort: readOption(
      raw.projectSort,
      PROJECT_SORTS,
      DEFAULT_VIEW.projectSort,
    ),
    threadSort: readOption(raw.threadSort, THREAD_SORTS, DEFAULT_VIEW.threadSort),
    foldQuiet: readBoolean(raw.foldQuiet, DEFAULT_VIEW.foldQuiet),
    // `accordion` is the stored name of the switch this one replaced.
    focusFollows: readBoolean(
      raw.focusFollows,
      readBoolean(raw.accordion, DEFAULT_VIEW.focusFollows),
    ),
    pinnedGroup: readBoolean(raw.pinnedGroup, DEFAULT_VIEW.pinnedGroup),
    pinnedCollapsed: readBoolean(raw.pinnedCollapsed, DEFAULT_VIEW.pinnedCollapsed),
    archived: readBoolean(raw.archived, DEFAULT_VIEW.archived),
    compact: readBoolean(raw.compact, DEFAULT_VIEW.compact),
    emptyProjects: readBoolean(raw.emptyProjects, DEFAULT_VIEW.emptyProjects),
    personalAfter:
      typeof raw.personalAfter === "string" &&
      raw.personalAfter.length > 0 &&
      raw.personalAfter.length <= 200
        ? raw.personalAfter
        : null,
    threadOrder: readIds(raw.threadOrder),
    sectionOrder: readIds(raw.sectionOrder),
    collapsedProjects: readIds(raw.collapsedProjects),
    collapsedSections: readIds(raw.collapsedSections),
    openQuiet: readIds(raw.openQuiet),
    tagFilter: normalizeTags(raw.tagFilter),
    projectFilter: readIds(raw.projectFilter),
  };
}

export function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id)
    ? ids.filter((entry) => entry !== id)
    : [...ids, id].slice(-MAX_IDS);
}

export function sectionKey(projectId: string, sectionId: string): string {
  return `${projectId}:${sectionId}`;
}

/**
 * Are all projects collapsed? This drives the fold toggle's direction, so it
 * decides what the button offers to do next.
 *
 * `false` for an empty list on purpose: with no projects nothing is collapsed,
 * and a button offering to expand nothing would be a lie.
 */
export function allCollapsed(
  projectIds: readonly string[],
  collapsedProjects: readonly string[],
): boolean {
  return (
    projectIds.length > 0 &&
    projectIds.every((id) => collapsedProjects.includes(id))
  );
}

/**
 * Accordion: exactly one project stays open. All others get collapsed — but
 * only while the switch is on.
 */
export function accordionCollapse(
  projectIds: readonly string[],
  openProjectId: string,
): string[] {
  return projectIds.filter((id) => id !== openProjectId).slice(-MAX_IDS);
}

/**
 * "Reset view to defaults": sort, display and the tag filter go back to the
 * defaults. What you arranged by hand — collapsed rows and the personal
 * project's position — stays, because a reset that also unfolds fifty projects
 * punishes you for asking.
 */
export function resetViewSettings(view: ViewState): ViewState {
  return {
    ...DEFAULT_VIEW,
    personalAfter: view.personalAfter,
    threadOrder: view.threadOrder,
    sectionOrder: view.sectionOrder,
    collapsedProjects: view.collapsedProjects,
    collapsedSections: view.collapsedSections,
  };
}

/** Is any sort or display setting away from its default? */
export function isDefaultView(view: ViewState): boolean {
  return (
    view.projectSort === DEFAULT_VIEW.projectSort &&
    view.threadSort === DEFAULT_VIEW.threadSort &&
    view.foldQuiet === DEFAULT_VIEW.foldQuiet &&
    view.focusFollows === DEFAULT_VIEW.focusFollows &&
    view.archived === DEFAULT_VIEW.archived &&
    view.compact === DEFAULT_VIEW.compact &&
    view.emptyProjects === DEFAULT_VIEW.emptyProjects &&
    view.pinnedGroup === DEFAULT_VIEW.pinnedGroup &&
    view.tagFilter.length === 0 &&
    view.projectFilter.length === 0
  );
}

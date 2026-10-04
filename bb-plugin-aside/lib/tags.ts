// Project tags.
//
// Tags belong to the plugin, not to the host: bb 0.43's project model has no
// tag field (`updateProjectRequestSchema` carries a name and nothing else), so
// they live in the same plugin database as the project colours.
//
// A tag is stored lower case. Case is the one difference nobody sees in a list
// of chips, and `Work` sitting next to `work` as two separate filters is a
// duplicate you cannot tell apart — so the normalisation removes the
// distinction rather than leaving two tags that look identical.
//
// Pure data handling: no chip is drawn here, and nothing in this file knows
// about the sidenav.

const CONTROL = /[\u0000-\u001F\u007F]/g;
const WHITESPACE = /\s+/g;

/** Long enough for "infrastructure", short enough to stay one chip. */
export const MAX_TAG_LENGTH = 24;
/** Per project. Beyond this a tag stops being a label and becomes a list. */
export const MAX_TAGS_PER_PROJECT = 12;
/** Projects we keep tags for at all — a store that only grows is a leak. */
export const MAX_TAGGED_PROJECTS = 500;

export function normalizeTag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(CONTROL, "")
    .replace(WHITESPACE, " ")
    .trim()
    .toLocaleLowerCase();
  if (normalized.length === 0) return null;
  return normalized.slice(0, MAX_TAG_LENGTH);
}

/** Normalise, drop the empty ones, dedupe, cap. Order is preserved. */
export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const entry of value) {
    const tag = normalizeTag(entry);
    if (tag === null || tags.includes(tag)) continue;
    tags.push(tag);
    if (tags.length >= MAX_TAGS_PER_PROJECT) break;
  }
  return tags;
}

export type TagMap = Record<string, string[]>;

/**
 * Read the stored map. Anything foreign or outdated is dropped rather than
 * taken as it is — the same contract `parseViewState` follows.
 *
 * `isProjectId` comes from the caller so this file does not have to repeat the
 * id rules that already live in lib/colors.ts.
 */
export function parseTagMap(
  value: unknown,
  isProjectId: (id: unknown) => boolean,
): TagMap {
  if (typeof value !== "object" || value === null) return {};
  const map: TagMap = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isProjectId(id)) continue;
    const tags = normalizeTags(entry);
    // A project with no tags left is not stored as an empty array: it is the
    // same state as never having been tagged, and two spellings of one state
    // is what makes stores drift.
    if (tags.length === 0) continue;
    map[id] = tags;
    if (Object.keys(map).length >= MAX_TAGGED_PROJECTS) break;
  }
  return map;
}

/**
 * How many projects carry each tag — what the filter list shows beside a name.
 *
 * Counted against the projects that actually exist, not against the stored map:
 * a deleted project can leave its entry behind, and a tag offering "2" where
 * one row appears is worse than no number at all.
 */
export function tagCounts(
  map: TagMap,
  projectIds: readonly string[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of projectIds) {
    for (const tag of map[id] ?? []) {
      counts[tag] = (counts[tag] ?? 0) + 1;
    }
  }
  return counts;
}

/** The tags in use, alphabetical — what the filter list and the editor offer. */
export function sortedTags(counts: Readonly<Record<string, number>>): string[] {
  return Object.keys(counts).sort((left, right) => left.localeCompare(right));
}

/**
 * Does a project survive the filter? An empty filter keeps everything, and
 * several tags are an OR: picking `api` and `web` asks for the projects that
 * carry either, which is what a list of checkboxes reads as. An AND would make
 * every second pick empty the list.
 *
 * A picked project is a second, independent OR branch: it joins the tag group
 * rather than narrowing it further, so a tag group plus one foreign project
 * shows the group's projects plus that one. `projectId`/`projectFilter`
 * default to nothing picked, so a two-argument call behaves exactly as
 * before.
 */
export function matchesTagFilter(
  tags: readonly string[],
  filter: readonly string[],
  projectId: string = "",
  projectFilter: readonly string[] = [],
): boolean {
  if (filter.length === 0 && projectFilter.length === 0) return true;
  return filter.some((tag) => tags.includes(tag)) || projectFilter.includes(projectId);
}

/**
 * Drop filter entries no project carries any more. Without this a tag removed
 * from its last project would keep filtering from a list that no longer offers
 * it — an empty sidenav with no visible cause.
 */
export function pruneTagFilter(
  filter: readonly string[],
  available: readonly string[],
): string[] {
  return filter.filter((tag) => available.includes(tag));
}

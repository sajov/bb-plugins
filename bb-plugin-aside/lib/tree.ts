// The tree the sidenav draws — as pure functions, without React and without
// SDK hooks. Everything here is testable without a running BB.
import type {
  PluginSidebarProject,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";

/** A root thread with all of its visible descendants, flat. */
export interface Family {
  root: PluginSidebarThread;
  children: PluginSidebarThread[];
}

/** A section heading inside a project, or the area before it. */
export interface SectionBlock {
  /** Null for the pinned families on top and for those without a section. */
  section: { id: string; name: string } | null;
  families: Family[];
}

export interface ProjectBlock {
  project: PluginSidebarProject;
  /** All families of the project, regardless of section and condensing. */
  families: Family[];
  blocks: SectionBlock[];
}

export type ThreadState =
  | "failed"
  | "needs-you"
  | "working"
  | "unread"
  | "quiet";

export const THREAD_STATE_RANK: Readonly<Record<ThreadState, number>> = {
  failed: 0,
  "needs-you": 1,
  working: 2,
  unread: 3,
  quiet: 4,
};

export function threadTitle(thread: PluginSidebarThread): string {
  const title = thread.title?.trim();
  if (title) return title;
  const fallback = thread.titleFallback?.trim();
  return fallback ? fallback : "Untitled";
}

/** Every live signal BB knows for a sidebar row. */
export function isWorking(thread: PluginSidebarThread): boolean {
  const { activity } = thread;
  return (
    activity.workflows > 0 ||
    activity.backgroundAgents > 0 ||
    activity.backgroundCommands > 0 ||
    activity.planMode > 0 ||
    activity.goals > 0 ||
    thread.indicator === "runtime" ||
    thread.indicator === "working-draft"
  );
}

export function needsUser(thread: PluginSidebarThread): boolean {
  return (
    thread.hasPendingInteraction || thread.indicator === "waiting-for-input"
  );
}

export function hasFailed(thread: PluginSidebarThread): boolean {
  return thread.indicator === "unread-error";
}

export function isUnread(thread: PluginSidebarThread): boolean {
  return thread.isUnread || thread.indicator === "unread-success";
}

/**
 * A row's state. The order of the checks is the ranking: a failed turn stays
 * failed, even when the thread next to it is already working again.
 */
export function threadState(thread: PluginSidebarThread): ThreadState {
  if (hasFailed(thread)) return "failed";
  if (needsUser(thread)) return "needs-you";
  if (isWorking(thread)) return "working";
  if (isUnread(thread)) return "unread";
  return "quiet";
}

/** A whole family's state: the most urgent one among its members. */
export function familyState(family: Family): ThreadState {
  return familyMembers(family)
    .map(threadState)
    .reduce<ThreadState>(
      (worst, state) =>
        THREAD_STATE_RANK[state] < THREAD_STATE_RANK[worst] ? state : worst,
      "quiet",
    );
}

/**
 * A project's state: the most urgent one among its families. This is the mark
 * next to the project name — especially while the project is collapsed.
 * Otherwise you would have to expand it to learn whether expanding is worth it.
 */
export function projectState(families: readonly Family[]): ThreadState {
  return families
    .map(familyState)
    .reduce<ThreadState>(
      (worst, state) =>
        THREAD_STATE_RANK[state] < THREAD_STATE_RANK[worst] ? state : worst,
      "quiet",
    );
}

export function familyMembers(family: Family): PluginSidebarThread[] {
  return [family.root, ...family.children];
}

export function familyWaits(family: Family): boolean {
  return familyMembers(family).some(needsUser);
}

/**
 * A thread's visible ancestor. If the real parent is not in the list — archived,
 * deleted, from another project — the thread becomes a root itself. Otherwise it
 * would no longer be reachable through the sidenav.
 */
function visibleRootOf(
  thread: PluginSidebarThread,
  byId: ReadonlyMap<string, PluginSidebarThread>,
): PluginSidebarThread {
  let current = thread;
  const seen = new Set([thread.id]);
  while (current.parentThreadId !== null) {
    const parent = byId.get(current.parentThreadId);
    if (
      parent === undefined ||
      parent.projectId !== thread.projectId ||
      seen.has(parent.id)
    ) {
      break;
    }
    seen.add(parent.id);
    current = parent;
  }
  return current;
}

export interface GroupOptions {
  /** Show archived threads too. */
  archived: boolean;
  /** The host's sections, in their order. */
  sections: readonly { id: string; name: string }[];
  /** What the families inside a block are sorted by. */
  threadSort: "newest" | "state";
  /** Root thread ids in the order the user dragged them. */
  threadOrder?: readonly string[];
  /** Section ids in the order the user dragged them. */
  sectionOrder?: readonly string[];
}

/**
 * Threads → projects → sections → families.
 *
 * Projects come in the host's order; since bb 0.43 the dragged order lives
 * there, and it applies across devices.
 */
export function groupThreads(
  threads: readonly PluginSidebarThread[],
  projects: readonly PluginSidebarProject[],
  options: GroupOptions,
): ProjectBlock[] {
  const visible = threads.filter(
    (thread) => options.archived || !thread.isArchived,
  );
  const byProject = new Map<string, PluginSidebarThread[]>();
  for (const thread of visible) {
    const bucket = byProject.get(thread.projectId) ?? [];
    bucket.push(thread);
    byProject.set(thread.projectId, bucket);
  }

  return projects.map((project) => {
    const own = byProject.get(project.id) ?? [];
    const byId = new Map(own.map((thread) => [thread.id, thread]));
    const familyByRoot = new Map<string, Family>();

    for (const thread of own) {
      const root = visibleRootOf(thread, byId);
      const family = familyByRoot.get(root.id) ?? { root, children: [] };
      if (thread.id !== root.id) family.children.push(thread);
      familyByRoot.set(root.id, family);
    }

    const families = [...familyByRoot.values()];
    for (const family of families) {
      family.children.sort(
        (left, right) =>
          left.createdAt - right.createdAt || left.id.localeCompare(right.id),
      );
    }

    const sorted = sortFamilies(families, options.threadSort, options.threadOrder);
    return {
      project,
      families: sorted,
      blocks: splitIntoSections(sorted, options.sections, options.sectionOrder),
    };
  });
}

/**
 * Pinned threads sit on top in every mode — that is what pinning means.
 *
 * In "newest" mode a dragged order wins: the host keeps an order only for
 * pinned threads, so aside keeps its own (`threadOrder`). Threads that were
 * never dragged come first, newest on top — a thread just started must be
 * visible without scrolling past the arranged ones. "state" ignores the
 * dragged order; it is a computed sort.
 */
export function sortFamilies(
  families: readonly Family[],
  mode: "newest" | "state",
  threadOrder: readonly string[] = [],
): Family[] {
  const pinned = families.filter((family) => family.root.isPinned);
  const rest = families.filter((family) => !family.root.isPinned);
  const byNewest = (left: Family, right: Family) =>
    right.root.createdAt - left.root.createdAt ||
    left.root.id.localeCompare(right.root.id);
  const rank = new Map(threadOrder.map((id, index) => [id, index]));
  const byDragged = (left: Family, right: Family) => {
    const a = rank.get(left.root.id) ?? -1;
    const b = rank.get(right.root.id) ?? -1;
    return a - b || byNewest(left, right);
  };
  const sortedRest =
    mode === "state"
      ? [...rest].sort(
          (left, right) =>
            THREAD_STATE_RANK[familyState(left)] -
              THREAD_STATE_RANK[familyState(right)] || byNewest(left, right),
        )
      : [...rest].sort(byDragged);
  const sortedPinned = [...pinned].sort(mode === "state" ? byNewest : byDragged);
  return sortedPinned.concat(sortedRest);
}

/**
 * The dragged order after dropping `draggedId` before or after `targetId`.
 *
 * `shown` is the project's root order as drawn; it replaces that project's
 * old entries in `order`, so every thread of the project counts as arranged
 * from now on. Ids of other projects keep their place.
 */
export function moveInOrder(
  order: readonly string[],
  shown: readonly string[],
  draggedId: string,
  targetId: string,
  where: "before" | "after",
): string[] {
  const local = shown.filter((id) => id !== draggedId);
  const target = local.indexOf(targetId);
  if (target < 0) return [...order];
  local.splice(where === "before" ? target : target + 1, 0, draggedId);
  const own = new Set(shown);
  return order.filter((id) => !own.has(id)).concat(local);
}

/**
 * Sections in dragged order. Stable sort: sections never dragged (rank -1)
 * keep their relative position among themselves — the caller hands them in
 * newest first, so that is what "not yet arranged" still looks like.
 */
export function sortSections<T extends { id: string }>(
  sections: readonly T[],
  sectionOrder: readonly string[] = [],
): T[] {
  const rank = new Map(sectionOrder.map((id, index) => [id, index]));
  return [...sections].sort(
    (left, right) => (rank.get(left.id) ?? -1) - (rank.get(right.id) ?? -1),
  );
}

/**
 * In the host a section belongs to no project: its schema is only
 * `{ id, name }`, and threads point at it through `sectionId`. It therefore
 * appears in every project where it has threads — and nowhere else.
 *
 * Pinned threads come first, above every section and out of their own one —
 * you pulled them up yourself. Sections follow, in the order the caller
 * supplies (newest first) unless `sectionOrder` places some of them
 * elsewhere — a section just dragged keeps its new spot across projects,
 * since a section belongs to no single one. Sections the user never dragged
 * keep coming first, newest first, as today. The threads without a section
 * follow below — with no invented "Other" heading.
 */
export function splitIntoSections(
  families: readonly Family[],
  sections: readonly { id: string; name: string }[],
  sectionOrder: readonly string[] = [],
): SectionBlock[] {
  const blocks: SectionBlock[] = [];
  const pinned = families.filter((family) => family.root.isPinned);
  if (pinned.length) blocks.push({ section: null, families: pinned });
  const unpinned = families.filter((family) => !family.root.isPinned);
  const ordered = sortSections(sections, sectionOrder);
  for (const section of ordered) {
    const own = unpinned.filter(
      (family) => family.root.sectionId === section.id,
    );
    if (own.length) blocks.push({ section, families: own });
  }
  const loose = unpinned.filter((family) => family.root.sectionId === null);
  if (loose.length) blocks.push({ section: null, families: loose });
  return blocks;
}

/**
 * The personal project has a synthetic id (`proj_personal`) the host does not
 * sort — `projects.reorder` answers 404 for it. We therefore keep its position
 * ourselves: as an anchor behind a real project, `null` meaning the very top.
 */
export function placePersonal(
  blocks: readonly ProjectBlock[],
  personalProjectId: string,
  afterProjectId: string | null,
): ProjectBlock[] {
  const personal = blocks.find((block) => block.project.id === personalProjectId);
  if (personal === undefined) return [...blocks];
  const rest = blocks.filter((block) => block.project.id !== personalProjectId);
  if (afterProjectId === null) return [personal, ...rest];
  const anchor = rest.findIndex((block) => block.project.id === afterProjectId);
  // An anchor that no longer exists (project deleted) leaves the personal
  // project at the bottom instead of making it disappear.
  if (anchor < 0) return [...rest, personal];
  return [...rest.slice(0, anchor + 1), personal, ...rest.slice(anchor + 1)];
}

/**
 * Condensing instead of filtering: what is quiet becomes a single row, but does
 * not disappear. Pinned threads always stay visible — you pulled them up
 * yourself.
 */
export function splitQuiet(families: readonly Family[]): {
  loud: Family[];
  quiet: Family[];
} {
  const loud: Family[] = [];
  const quiet: Family[] = [];
  for (const family of families) {
    const isQuiet = familyState(family) === "quiet" && !family.root.isPinned;
    (isQuiet ? quiet : loud).push(family);
  }
  return { loud, quiet };
}

/** Project order for the modes the user can choose. */
export function sortProjects(
  blocks: readonly ProjectBlock[],
  mode: "manual" | "activity" | "name",
): ProjectBlock[] {
  if (mode === "name") {
    return [...blocks].sort((left, right) =>
      left.project.name.localeCompare(right.project.name),
    );
  }
  if (mode === "activity") {
    const score = (block: ProjectBlock) =>
      block.families.reduce((sum, family) => {
        const state = familyState(family);
        if (state === "needs-you") return sum + 100;
        if (state === "failed") return sum + 50;
        if (state === "working") return sum + 10;
        if (state === "unread") return sum + 1;
        return sum;
      }, 0);
    return [...blocks].sort((left, right) => score(right) - score(left));
  }
  return [...blocks];
}

/**
 * Projects without a thread disappear.
 *
 * An empty project is a row that answers nothing — whoever created twenty
 * repositories would otherwise scroll past nineteen headings. Two exceptions:
 * the Display menu brings them back, and the project you are
 * currently in always stays — otherwise the place vanishes from under your feet
 * the moment you archive its last thread.
 */
export function withoutEmptyProjects(
  blocks: readonly ProjectBlock[],
  keepProjectId: string | null,
): ProjectBlock[] {
  return blocks.filter(
    (block) => block.families.length > 0 || block.project.id === keepProjectId,
  );
}

/**
 * The number in the header: how many root threads the list holds.
 *
 * Deliberately independent of what is collapsed right now. Collapsing is a
 * question of presentation; a number that drops to 0 along with it claims there
 * is nothing left.
 */
export function countFamilies(blocks: readonly ProjectBlock[]): number {
  return blocks.reduce((sum, block) => sum + block.families.length, 0);
}

/**
 * The newest activity across a set of families, children included.
 *
 * `null` means there is nothing to date — an empty project. Children count on
 * purpose: the mark beside this number summarises the whole family too, so a
 * project reading "3d" while an agent works inside it would contradict its own
 * mark.
 */
export function latestActivity(families: readonly Family[]): number | null {
  let latest: number | null = null;
  for (const family of families) {
    for (const member of familyMembers(family)) {
      if (latest === null || member.updatedAt > latest) latest = member.updatedAt;
    }
  }
  return latest;
}

/** Every open question, longest wait first. */
export function waitingThreads(
  threads: readonly PluginSidebarThread[],
): PluginSidebarThread[] {
  return threads
    .filter((thread) => !thread.isArchived && needsUser(thread))
    .sort(
      (left, right) =>
        left.latestAttentionAt - right.latestAttentionAt ||
        left.id.localeCompare(right.id),
    );
}

/** A pinned root with the project it lives in, for the pinned group. */
export interface PinnedEntry {
  family: Family;
  project: PluginSidebarProject;
}

/**
 * Every pinned root across the projects shown, for the group at the top.
 *
 * Taken from the blocks the list already shows, so the group obeys the same
 * search and tag filter as the list below it — a pin from a project you
 * filtered away would be a row that contradicts the filter chip above it.
 * The threads stay in their projects too: the group is a shortcut, not a move.
 */
export function pinnedFamilies(blocks: readonly ProjectBlock[]): PinnedEntry[] {
  const entries: PinnedEntry[] = [];
  for (const block of blocks) {
    for (const family of block.families) {
      if (family.root.isPinned) entries.push({ family, project: block.project });
    }
  }
  return entries;
}

/**
 * How far a section reaches. In the host a section belongs to no project, so a
 * rename or a dissolve changes every project that uses it — the menu says how
 * many before you press it.
 */
export function sectionReach(
  threads: readonly PluginSidebarThread[],
  sectionId: string,
): { projects: number; threads: number } {
  const own = threads.filter((thread) => thread.sectionId === sectionId);
  return {
    projects: new Set(own.map((thread) => thread.projectId)).size,
    threads: own.length,
  };
}

/** Every thread in the order the list draws it: projects, families, agents. */
export function displayOrder(blocks: readonly ProjectBlock[]): PluginSidebarThread[] {
  return blocks.flatMap((block) =>
    block.blocks.flatMap((section) => section.families.flatMap(familyMembers)),
  );
}

/**
 * The next thread that stops progress — waiting for you or failed — seen from
 * the current one, in list order and wrapping at the ends. `null` when there is
 * none other than the current thread.
 *
 * Collapsed projects count: jumping into one is the point, because a folded
 * project with an amber mark is exactly the row you cannot read from outside.
 */
export function nextAttention(
  ordered: readonly PluginSidebarThread[],
  currentThreadId: string | null,
  direction: 1 | -1,
): PluginSidebarThread | null {
  const urgent = (thread: PluginSidebarThread) =>
    !thread.isArchived && (needsUser(thread) || hasFailed(thread));
  const count = ordered.length;
  if (count === 0) return null;
  const start = ordered.findIndex((thread) => thread.id === currentThreadId);
  for (let step = 1; step <= count; step += 1) {
    const index =
      start < 0
        ? direction === 1
          ? step - 1
          : count - step
        : (((start + direction * step) % count) + count) % count;
    const candidate = ordered[index];
    if (candidate.id === currentThreadId) continue;
    if (urgent(candidate)) return candidate;
  }
  return null;
}

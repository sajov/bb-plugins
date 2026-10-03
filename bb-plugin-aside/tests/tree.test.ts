import { describe, expect, it } from "vitest";
import type {
  PluginSidebarProject,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import {
  countFamilies,
  displayOrder,
  latestActivity,
  moveInOrder,
  nextAttention,
  pinnedFamilies,
  sectionReach,
  placePersonal,
  withoutEmptyProjects,
  familyState,
  projectState,
  groupThreads,
  sortFamilies,
  sortProjects,
  splitIntoSections,
  splitQuiet,
  threadState,
  waitingThreads,
} from "@/lib/tree";

const project = (id: string, name = id): PluginSidebarProject => ({
  id,
  name,
  isPersonal: false,
});

let clock = 1_000;

function thread(
  overrides: Partial<PluginSidebarThread> & { id: string; projectId: string },
): PluginSidebarThread {
  clock += 1;
  return {
    title: overrides.id,
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "claude",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: clock,
    updatedAt: clock,
    lastReadAt: null,
    latestAttentionAt: clock,
    ...overrides,
  } as PluginSidebarThread;
}

const options = {
  archived: false,
  sections: [] as { id: string; name: string }[],
  threadSort: "newest" as const,
};

describe("a row's state", () => {
  it("recognises an open question", () => {
    expect(threadState(thread({ id: "a", projectId: "p", hasPendingInteraction: true })))
      .toBe("needs-you");
  });

  it("stays failed even when work has already resumed alongside", () => {
    const failedWhileWorking = thread({
      id: "a",
      projectId: "p",
      indicator: "unread-error",
      activity: {
        workflows: 1,
        backgroundAgents: 0,
        backgroundCommands: 0,
        planMode: 0,
        goals: 0,
      },
    });
    expect(threadState(failedWhileWorking)).toBe("failed");
  });

  it("calls a merely old thread quiet rather than done", () => {
    expect(threadState(thread({ id: "a", projectId: "p" }))).toBe("quiet");
  });
});

describe("families", () => {
  it("attaches a child to its parent", () => {
    const parent = thread({ id: "root", projectId: "p" });
    const child = thread({ id: "kid", projectId: "p", parentThreadId: "root" });
    const [block] = groupThreads([parent, child], [project("p")], options);
    expect(block.families).toHaveLength(1);
    expect(block.families[0].children.map((entry) => entry.id)).toEqual(["kid"]);
  });

  it("does NOT let a child disappear when the parent is hidden", () => {
    // The parent is archived and therefore not in the list. The child has to
    // become a root itself, or it is unreachable through the sidenav.
    const parent = thread({ id: "root", projectId: "p", isArchived: true });
    const child = thread({ id: "kid", projectId: "p", parentThreadId: "root" });
    const [block] = groupThreads([parent, child], [project("p")], options);
    expect(block.families.map((family) => family.root.id)).toEqual(["kid"]);
  });

  it("breaks a cycle instead of hanging", () => {
    const a = thread({ id: "a", projectId: "p", parentThreadId: "b" });
    const b = thread({ id: "b", projectId: "p", parentThreadId: "a" });
    const [block] = groupThreads([a, b], [project("p")], options);
    expect(block.families.length).toBeGreaterThan(0);
  });

  it("takes on the family's most urgent state", () => {
    const root = thread({ id: "root", projectId: "p" });
    const child = thread({
      id: "kid",
      projectId: "p",
      parentThreadId: "root",
      hasPendingInteraction: true,
    });
    const [block] = groupThreads([root, child], [project("p")], options);
    expect(familyState(block.families[0])).toBe("needs-you");
  });

  // The case the sidenav drew wrong for a long time: the child was working, the
  // project row was spinning, only the root row in between stayed silent. Its
  // mark hangs off familyState, not threadState.
  it("reports working children on an otherwise silent root", () => {
    const root = thread({ id: "root", projectId: "p" });
    const child = thread({
      id: "kid",
      projectId: "p",
      parentThreadId: "root",
      activity: {
        workflows: 0,
        backgroundAgents: 1,
        backgroundCommands: 0,
        planMode: 0,
        goals: 0,
      },
    });
    const [block] = groupThreads([root, child], [project("p")], options);
    expect(threadState(block.families[0].root)).toBe("quiet");
    expect(familyState(block.families[0])).toBe("working");
  });

  it("stays quiet when neither root nor child works — NO mark", () => {
    const root = thread({ id: "root", projectId: "p" });
    const child = thread({ id: "kid", projectId: "p", parentThreadId: "root" });
    const [block] = groupThreads([root, child], [project("p")], options);
    expect(familyState(block.families[0])).toBe("quiet");
  });

  it("shows archived threads only while the switch is on", () => {
    const archived = thread({ id: "old", projectId: "p", isArchived: true });
    const [hidden] = groupThreads([archived], [project("p")], options);
    expect(hidden.families).toHaveLength(0);
    const [shown] = groupThreads([archived], [project("p")], { ...options, archived: true });
    expect(shown.families).toHaveLength(1);
  });
});

describe("a project's state", () => {
  it("shows the open question even when something runs alongside", () => {
    const waiting = thread({ id: "w", projectId: "p", hasPendingInteraction: true });
    const working = thread({
      id: "r",
      projectId: "p",
      activity: {
        workflows: 1,
        backgroundAgents: 0,
        backgroundCommands: 0,
        planMode: 0,
        goals: 0,
      },
    });
    const [block] = groupThreads([waiting, working], [project("p")], options);
    expect(projectState(block.families)).toBe("needs-you");
  });

  it("shows running work when nobody waits", () => {
    const working = thread({
      id: "r",
      projectId: "p",
      activity: {
        workflows: 0,
        backgroundAgents: 1,
        backgroundCommands: 0,
        planMode: 0,
        goals: 0,
      },
    });
    const [block] = groupThreads([working], [project("p")], options);
    expect(projectState(block.families)).toBe("working");
  });

  it("inherits a child thread's state", () => {
    const root = thread({ id: "root", projectId: "p" });
    const kid = thread({
      id: "kid",
      projectId: "p",
      parentThreadId: "root",
      hasPendingInteraction: true,
    });
    const [block] = groupThreads([root, kid], [project("p")], options);
    expect(projectState(block.families)).toBe("needs-you");
  });

  it("stays quiet for a silent project — it gets NO mark", () => {
    const quiet = thread({ id: "q", projectId: "p" });
    const [block] = groupThreads([quiet], [project("p")], options);
    expect(projectState(block.families)).toBe("quiet");
  });

  it("is quiet without threads too", () => {
    expect(projectState([])).toBe("quiet");
  });
});

describe("empty projects", () => {
  const blocksFor = (threadList: ReturnType<typeof thread>[]) =>
    groupThreads(threadList, [project("p1"), project("p2")], options);

  it("hides a project without a thread", () => {
    const blocks = blocksFor([thread({ id: "a", projectId: "p1" })]);
    expect(withoutEmptyProjects(blocks, null).map((block) => block.project.id)).toEqual([
      "p1",
    ]);
  });

  it("keeps the project you are working in — even when it is empty", () => {
    const blocks = blocksFor([thread({ id: "a", projectId: "p1" })]);
    expect(withoutEmptyProjects(blocks, "p2").map((block) => block.project.id)).toEqual([
      "p1",
      "p2",
    ]);
  });

  it("does NOT hide a project whose only thread is merely archived once archived threads are visible", () => {
    const archived = thread({ id: "old", projectId: "p2", isArchived: true });
    const hidden = groupThreads([archived], [project("p2")], options);
    expect(withoutEmptyProjects(hidden, null)).toHaveLength(0);
    const shown = groupThreads([archived], [project("p2")], { ...options, archived: true });
    expect(withoutEmptyProjects(shown, null)).toHaveLength(1);
  });
});

describe("personal project", () => {
  const blocks = () =>
    groupThreads(
      [
        thread({ id: "a", projectId: "p1" }),
        thread({ id: "b", projectId: "p2" }),
        thread({ id: "c", projectId: "personal" }),
      ],
      [project("p1"), project("p2"), project("personal")],
      options,
    );

  it("sits at the very top without an anchor", () => {
    expect(placePersonal(blocks(), "personal", null).map((b) => b.project.id)).toEqual([
      "personal",
      "p1",
      "p2",
    ]);
  });

  it("sits behind its anchor", () => {
    expect(placePersonal(blocks(), "personal", "p1").map((b) => b.project.id)).toEqual([
      "p1",
      "personal",
      "p2",
    ]);
  });

  it("does NOT disappear when its anchor was deleted", () => {
    const placed = placePersonal(blocks(), "personal", "does-not-exist");
    expect(placed.map((b) => b.project.id)).toEqual(["p1", "p2", "personal"]);
  });

  it("leaves the list unchanged when there is no personal project at all", () => {
    const only = groupThreads(
      [thread({ id: "a", projectId: "p1" })],
      [project("p1")],
      options,
    );
    expect(placePersonal(only, "personal", null).map((b) => b.project.id)).toEqual(["p1"]);
  });
});

describe("the number in the header", () => {
  it("counts the root threads of all projects", () => {
    const one = thread({ id: "a", projectId: "p1" });
    const two = thread({ id: "b", projectId: "p2" });
    const kid = thread({ id: "kid", projectId: "p1", parentThreadId: "a" });
    const blocks = groupThreads([one, two, kid], [project("p1"), project("p2")], options);
    // The child does not count twice: families are counted, not rows.
    expect(countFamilies(blocks)).toBe(2);
  });

  it("does NOT drop to 0 just because everything is collapsed", () => {
    // Collapsing is presentation; the number does not know about it at all.
    const one = thread({ id: "a", projectId: "p1" });
    const blocks = groupThreads([one], [project("p1")], options);
    expect(countFamilies(blocks)).toBe(1);
  });

  it("is 0 when there really is nothing", () => {
    expect(countFamilies([])).toBe(0);
  });
});

describe("sorting", () => {
  it("keeps pinned threads on top — even when sorting by state", () => {
    const pinned = thread({ id: "pin", projectId: "p", isPinned: true });
    const waiting = thread({ id: "wait", projectId: "p", hasPendingInteraction: true });
    const families = [
      { root: waiting, children: [] },
      { root: pinned, children: [] },
    ];
    expect(sortFamilies(families, "state").map((family) => family.root.id)).toEqual([
      "pin",
      "wait",
    ]);
  });

  it("leaves the host's project order untouched in manual mode", () => {
    const blocks = [
      { project: project("b", "Beta"), families: [], blocks: [] },
      { project: project("a", "Alpha"), families: [], blocks: [] },
    ];
    expect(sortProjects(blocks, "manual").map((block) => block.project.id)).toEqual(["b", "a"]);
    expect(sortProjects(blocks, "name").map((block) => block.project.id)).toEqual(["a", "b"]);
  });
});

describe("condensing", () => {
  it("condenses quiet ones", () => {
    const quiet = thread({ id: "quiet", projectId: "p" });
    const { loud, quiet: folded } = splitQuiet([{ root: quiet, children: [] }]);
    expect(loud).toHaveLength(0);
    expect(folded).toHaveLength(1);
  });

  it("does NOT condense a family whose child is working", () => {
    const root = thread({ id: "root", projectId: "p" });
    const child = thread({
      id: "kid",
      projectId: "p",
      parentThreadId: "root",
      activity: {
        workflows: 0,
        backgroundAgents: 1,
        backgroundCommands: 0,
        planMode: 0,
        goals: 0,
      },
    });
    const { loud, quiet } = splitQuiet([{ root, children: [child] }]);
    expect(loud).toHaveLength(1);
    expect(quiet).toHaveLength(0);
  });

  it("does NOT condense pinned threads, even when they are quiet", () => {
    const pinned = thread({ id: "pin", projectId: "p", isPinned: true });
    const { loud, quiet } = splitQuiet([{ root: pinned, children: [] }]);
    expect(loud).toHaveLength(1);
    expect(quiet).toHaveLength(0);
  });
});

describe("sections", () => {
  const sections = [
    { id: "s1", name: "Release" },
    { id: "s2", name: "Wartung" },
  ];

  it("puts sections on top and the loose threads below", () => {
    const loose = thread({ id: "loose", projectId: "p" });
    const inSection = thread({ id: "in", projectId: "p", sectionId: "s1" });
    const blocks = splitIntoSections(
      [
        { root: loose, children: [] },
        { root: inSection, children: [] },
      ],
      sections,
    );
    // The loose block sits at the bottom and gets NO invented heading.
    expect(blocks.map((block) => block.section?.name ?? null)).toEqual(["Release", null]);
  });

  it("does NOT show a section that has no threads in this project", () => {
    const loose = thread({ id: "loose", projectId: "p" });
    const blocks = splitIntoSections([{ root: loose, children: [] }], sections);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].section).toBeNull();
  });

  it("creates no empty head area when every thread has a section", () => {
    const inSection = thread({ id: "in", projectId: "p", sectionId: "s2" });
    const blocks = splitIntoSections([{ root: inSection, children: [] }], sections);
    expect(blocks.map((block) => block.section?.name)).toEqual(["Wartung"]);
  });
});

describe("pins inside a project", () => {
  const sections = [{ id: "s1", name: "Release" }];

  it("puts the pinned threads above the sections", () => {
    const loose = thread({ id: "loose", projectId: "p" });
    const inSection = thread({ id: "in", projectId: "p", sectionId: "s1" });
    const pinned = thread({ id: "pin", projectId: "p", isPinned: true });
    const blocks = splitIntoSections(
      [
        { root: pinned, children: [] },
        { root: inSection, children: [] },
        { root: loose, children: [] },
      ],
      sections,
    );
    expect(
      blocks.map((block) => [
        block.section?.name ?? null,
        block.families.map((family) => family.root.id),
      ]),
    ).toEqual([
      [null, ["pin"]],
      ["Release", ["in"]],
      [null, ["loose"]],
    ]);
  });

  it("lifts a pinned thread out of its section", () => {
    const pinned = thread({ id: "pin", projectId: "p", sectionId: "s1", isPinned: true });
    const inSection = thread({ id: "in", projectId: "p", sectionId: "s1" });
    const blocks = splitIntoSections(
      [
        { root: pinned, children: [] },
        { root: inSection, children: [] },
      ],
      sections,
    );
    expect(blocks.map((block) => block.families.map((family) => family.root.id))).toEqual([
      ["pin"],
      ["in"],
    ]);
  });
});

describe("dragged thread order", () => {
  it("sorts by the dragged order and keeps new threads on top", () => {
    const older = thread({ id: "a", projectId: "p" });
    const middle = thread({ id: "b", projectId: "p" });
    const fresh = thread({ id: "new", projectId: "p" });
    const families = [older, middle, fresh].map((root) => ({ root, children: [] }));
    expect(
      sortFamilies(families, "newest", ["a", "b"]).map((family) => family.root.id),
    ).toEqual(["new", "a", "b"]);
  });

  it("orders pinned threads by the dragged order, still on top", () => {
    const pinA = thread({ id: "pa", projectId: "p", isPinned: true });
    const pinB = thread({ id: "pb", projectId: "p", isPinned: true });
    const rest = thread({ id: "r", projectId: "p" });
    const families = [pinA, pinB, rest].map((root) => ({ root, children: [] }));
    expect(
      sortFamilies(families, "newest", ["r", "pa", "pb"]).map((family) => family.root.id),
    ).toEqual(["pa", "pb", "r"]);
  });

  it("ignores the dragged order when sorting by state", () => {
    const quiet = thread({ id: "q", projectId: "p" });
    const waiting = thread({ id: "w", projectId: "p", hasPendingInteraction: true });
    const families = [quiet, waiting].map((root) => ({ root, children: [] }));
    expect(
      sortFamilies(families, "state", ["q", "w"]).map((family) => family.root.id),
    ).toEqual(["w", "q"]);
  });

  it("groupThreads applies the dragged order", () => {
    const first = thread({ id: "a", projectId: "p" });
    const second = thread({ id: "b", projectId: "p" });
    const [block] = groupThreads([first, second], [project("p")], {
      archived: false,
      sections: [],
      threadSort: "newest",
      threadOrder: ["a", "b"],
    });
    expect(block.families.map((family) => family.root.id)).toEqual(["a", "b"]);
  });

  it("moves a thread before or after its target within the shown order", () => {
    expect(moveInOrder(["x"], ["a", "b", "c"], "c", "a", "before")).toEqual([
      "x",
      "c",
      "a",
      "b",
    ]);
    expect(moveInOrder([], ["a", "b", "c"], "a", "b", "after")).toEqual(["b", "a", "c"]);
  });

  it("replaces the project's old entries instead of duplicating them", () => {
    expect(moveInOrder(["b", "y", "a"], ["a", "b"], "a", "b", "after")).toEqual([
      "y",
      "b",
      "a",
    ]);
  });
});

describe("open questions", () => {
  it("sorts the longest wait to the top", () => {
    const fresh = thread({
      id: "fresh",
      projectId: "p",
      hasPendingInteraction: true,
      latestAttentionAt: 2_000,
    });
    const old = thread({
      id: "old",
      projectId: "p",
      hasPendingInteraction: true,
      latestAttentionAt: 1_000,
    });
    expect(waitingThreads([fresh, old]).map((entry) => entry.id)).toEqual(["old", "fresh"]);
  });

  it("does NOT count an unread result as an open question", () => {
    const done = thread({ id: "done", projectId: "p", indicator: "unread-success" });
    expect(waitingThreads([done])).toHaveLength(0);
  });

  it("does NOT count an archived thread", () => {
    const archived = thread({
      id: "a",
      projectId: "p",
      hasPendingInteraction: true,
      isArchived: true,
    });
    expect(waitingThreads([archived])).toHaveLength(0);
  });
});

describe("latest activity", () => {
  it("takes the newest timestamp in the project", () => {
    const [block] = groupThreads(
      [
        thread({ id: "old", projectId: "p", updatedAt: 1_000 }),
        thread({ id: "new", projectId: "p", updatedAt: 9_000 }),
      ],
      [project("p")],
      { archived: false, sections: [], threadSort: "newest" },
    );
    expect(latestActivity(block.families)).toBe(9_000);
  });

  // A child working under an old root is what keeps a project current. Counting
  // roots only would let the row read "3d" while its mark spins.
  it("counts a child's activity, not just the root's", () => {
    const [block] = groupThreads(
      [
        thread({ id: "root", projectId: "p", updatedAt: 1_000 }),
        thread({ id: "kid", projectId: "p", parentThreadId: "root", updatedAt: 8_000 }),
      ],
      [project("p")],
      { archived: false, sections: [], threadSort: "newest" },
    );
    expect(latestActivity(block.families)).toBe(8_000);
  });

  it("is null when there is nothing to date", () => {
    expect(latestActivity([])).toBeNull();
  });
});

describe("pinned group", () => {
  const options = { archived: false, sections: [], threadSort: "newest" as const };

  it("collects the pinned roots of every shown project", () => {
    const blocks = groupThreads(
      [
        thread({ id: "a", projectId: "p1", isPinned: true }),
        thread({ id: "b", projectId: "p1" }),
        thread({ id: "c", projectId: "p2", isPinned: true }),
      ],
      [project("p1"), project("p2")],
      options,
    );
    expect(pinnedFamilies(blocks).map((entry) => [entry.family.root.id, entry.project.id])).toEqual([
      ["a", "p1"],
      ["c", "p2"],
    ]);
  });

  it("leaves out unpinned threads and projects the list does not show", () => {
    const blocks = groupThreads(
      [thread({ id: "a", projectId: "p1" }), thread({ id: "c", projectId: "p2", isPinned: true })],
      [project("p1"), project("p2")],
      options,
    ).filter((block) => block.project.id === "p1");
    expect(pinnedFamilies(blocks)).toEqual([]);
  });
});

describe("section reach", () => {
  it("counts the projects and threads that use a section", () => {
    const threads = [
      thread({ id: "a", projectId: "p1", sectionId: "s1" }),
      thread({ id: "b", projectId: "p2", sectionId: "s1" }),
      thread({ id: "c", projectId: "p2", sectionId: "s1" }),
      thread({ id: "d", projectId: "p3", sectionId: "s2" }),
    ];
    expect(sectionReach(threads, "s1")).toEqual({ projects: 2, threads: 3 });
  });

  it("is zero for a section nobody uses", () => {
    expect(sectionReach([thread({ id: "a", projectId: "p1" })], "s1")).toEqual({
      projects: 0,
      threads: 0,
    });
  });
});

describe("next attention", () => {
  const waiting = (id: string, projectId = "p1") =>
    thread({ id, projectId, hasPendingInteraction: true });

  it("finds the next waiting or failed thread after the current one", () => {
    const order = [
      thread({ id: "a", projectId: "p1" }),
      waiting("b"),
      thread({ id: "c", projectId: "p1" }),
      thread({ id: "d", projectId: "p2", indicator: "unread-error" }),
    ];
    expect(nextAttention(order, "b", 1)?.id).toBe("d");
    expect(nextAttention(order, "d", -1)?.id).toBe("b");
  });

  it("wraps around the ends", () => {
    const order = [waiting("a"), thread({ id: "b", projectId: "p1" })];
    expect(nextAttention(order, "b", 1)?.id).toBe("a");
  });

  it("starts at the top when no thread is active", () => {
    const order = [thread({ id: "a", projectId: "p1" }), waiting("b"), waiting("c")];
    expect(nextAttention(order, null, 1)?.id).toBe("b");
    expect(nextAttention(order, null, -1)?.id).toBe("c");
  });

  it("returns null when nothing but the current thread needs attention", () => {
    const order = [waiting("a"), thread({ id: "b", projectId: "p1" })];
    expect(nextAttention(order, "a", 1)).toBeNull();
    expect(nextAttention([thread({ id: "x", projectId: "p1" })], null, 1)).toBeNull();
  });

  it("skips archived threads", () => {
    const order = [thread({ id: "a", projectId: "p1", hasPendingInteraction: true, isArchived: true })];
    expect(nextAttention(order, null, 1)).toBeNull();
  });

  it("walks agents in list order, after their root", () => {
    const blocks = groupThreads(
      [
        thread({ id: "root", projectId: "p1" }),
        thread({ id: "kid", projectId: "p1", parentThreadId: "root" }),
      ],
      [project("p1")],
      { archived: false, sections: [], threadSort: "newest" },
    );
    expect(displayOrder(blocks).map((entry) => entry.id)).toEqual(["root", "kid"]);
  });
});

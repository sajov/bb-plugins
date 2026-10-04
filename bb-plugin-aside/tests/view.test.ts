import { describe, expect, it } from "vitest";
import {
  accordionCollapse,
  allCollapsed,
  allSectionsFolded,
  DEFAULT_VIEW,
  isDefaultView,
  MAX_IDS,
  resetViewSettings,
  parseViewState,
  sectionKey,
  toggleAllSections,
  toggleId,
} from "@/lib/view";

describe("reading view state", () => {
  it("accepts valid values", () => {
    const view = parseViewState({
      projectSort: "name",
      threadSort: "state",
      foldQuiet: true,
      collapsedProjects: ["p1"],
    });
    expect(view.projectSort).toBe("name");
    expect(view.threadSort).toBe("state");
    expect(view.foldQuiet).toBe(true);
    expect(view.collapsedProjects).toEqual(["p1"]);
  });

  it("hides empty projects by default", () => {
    expect(DEFAULT_VIEW.emptyProjects).toBe(false);
    expect(parseViewState({ emptyProjects: "ja" }).emptyProjects).toBe(false);
    expect(parseViewState({ emptyProjects: true }).emptyProjects).toBe(true);
  });

  it("falls back to the default on an unknown sort", () => {
    expect(parseViewState({ projectSort: "zufall" }).projectSort).toBe(
      DEFAULT_VIEW.projectSort,
    );
  });

  it("survives broken values from an older version", () => {
    expect(parseViewState("nein")).toEqual(DEFAULT_VIEW);
    expect(parseViewState(null)).toEqual(DEFAULT_VIEW);
    expect(parseViewState({ collapsedProjects: "p1" }).collapsedProjects).toEqual([]);
  });

  it("takes neither non-strings nor duplicates into the id lists", () => {
    const view = parseViewState({ collapsedProjects: ["p1", "p1", 7, "", null] });
    expect(view.collapsedProjects).toEqual(["p1"]);
  });

  it("does not let the id list grow without bound", () => {
    const many = Array.from({ length: MAX_IDS + 50 }, (_, index) => `p${index}`);
    expect(parseViewState({ collapsedProjects: many }).collapsedProjects).toHaveLength(
      MAX_IDS,
    );
  });
});

describe("collapsing", () => {
  it("toggles", () => {
    expect(toggleId([], "p1")).toEqual(["p1"]);
    expect(toggleId(["p1"], "p1")).toEqual([]);
  });

  it("collapses everything but the chosen project in accordion mode", () => {
    expect(accordionCollapse(["p1", "p2", "p3"], "p2")).toEqual(["p1", "p3"]);
  });

  it("does NOT leave the chosen project collapsed", () => {
    expect(accordionCollapse(["p1"], "p1")).toEqual([]);
  });

  it("keeps sections separate per project", () => {
    expect(sectionKey("p1", "s1")).not.toBe(sectionKey("p2", "s1"));
  });
});

describe("fold toggle", () => {
  it("reports all collapsed when every project is", () => {
    expect(allCollapsed(["a", "b"], ["a", "b"])).toBe(true);
  });

  it("reports NOT all collapsed while one project is still open", () => {
    expect(allCollapsed(["a", "b"], ["a"])).toBe(false);
  });

  // Without projects there is nothing collapsed, so the button must offer to
  // collapse — offering to expand nothing would be a lie.
  it("is false without any projects", () => {
    expect(allCollapsed([], [])).toBe(false);
    expect(allCollapsed([], ["stale-id"])).toBe(false);
  });

  // Ids left over from a deleted project must not make the list look folded.
  it("ignores collapsed ids that no longer exist", () => {
    expect(allCollapsed(["a"], ["a", "gone"])).toBe(true);
    expect(allCollapsed(["a", "b"], ["a", "gone"])).toBe(false);
  });
});

describe("focus, pinned group and reset", () => {
  it("reads the old accordion switch as focus-follows", () => {
    expect(parseViewState({ accordion: true }).focusFollows).toBe(true);
    expect(parseViewState({ accordion: true, focusFollows: false }).focusFollows).toBe(false);
    expect(parseViewState({}).focusFollows).toBe(false);
  });

  it("shows the pinned group by default and keeps it off when switched off", () => {
    expect(DEFAULT_VIEW.pinnedGroup).toBe(true);
    expect(parseViewState({ pinnedGroup: false }).pinnedGroup).toBe(false);
    expect(parseViewState({ pinnedGroup: "no" }).pinnedGroup).toBe(true);
  });

  it("resets sort, display and tags but keeps what was folded by hand", () => {
    const view = parseViewState({
      projectSort: "name",
      compact: true,
      tagFilter: ["api"],
      projectFilter: ["p3"],
      collapsedProjects: ["p1"],
      collapsedSections: ["p1:s1"],
      personalAfter: "p2",
      threadOrder: ["t2", "t1"],
    });
    const reset = resetViewSettings(view);
    expect(reset.projectSort).toBe("manual");
    expect(reset.compact).toBe(false);
    expect(reset.tagFilter).toEqual([]);
    expect(reset.projectFilter).toEqual([]);
    expect(reset.collapsedProjects).toEqual(["p1"]);
    expect(reset.collapsedSections).toEqual(["p1:s1"]);
    expect(reset.personalAfter).toBe("p2");
    expect(reset.threadOrder).toEqual(["t2", "t1"]);
  });

  it("knows a default view from a changed one", () => {
    expect(isDefaultView(DEFAULT_VIEW)).toBe(true);
    expect(isDefaultView({ ...DEFAULT_VIEW, collapsedProjects: ["p1"] })).toBe(true);
    expect(isDefaultView({ ...DEFAULT_VIEW, threadSort: "state" })).toBe(false);
    expect(isDefaultView({ ...DEFAULT_VIEW, tagFilter: ["api"] })).toBe(false);
    expect(isDefaultView({ ...DEFAULT_VIEW, projectFilter: ["p1"] })).toBe(false);
  });
});

describe("collapsing a project's sections", () => {
  it("has no opinion for a project without sections", () => {
    expect(allSectionsFolded([], ["p1:s1"])).toBeNull();
    expect(toggleAllSections(["p1:s1"], [])).toEqual(["p1:s1"]);
  });

  it("reports folded only once every section is", () => {
    expect(allSectionsFolded(["p1:s1", "p1:s2"], ["p1:s1"])).toBe(false);
    expect(allSectionsFolded(["p1:s1", "p1:s2"], ["p1:s1", "p1:s2"])).toBe(true);
  });

  it("folds every section of the project when any is still open", () => {
    expect(toggleAllSections(["p1:s1"], ["p1:s1", "p1:s2"])).toEqual(["p1:s1", "p1:s2"]);
  });

  it("unfolds all of them once every one is already folded", () => {
    expect(toggleAllSections(["p1:s1", "p1:s2"], ["p1:s1", "p1:s2"])).toEqual([]);
  });

  it("leaves other projects' collapsed sections untouched", () => {
    expect(toggleAllSections(["p2:s1"], ["p1:s1"])).toEqual(["p2:s1", "p1:s1"]);
    expect(toggleAllSections(["p2:s1", "p1:s1"], ["p1:s1"])).toEqual(["p2:s1"]);
  });
});

describe("reading the project filter", () => {
  it("defaults to nothing picked", () => {
    expect(DEFAULT_VIEW.projectFilter).toEqual([]);
  });

  it("reads picked project ids like any other id list", () => {
    expect(parseViewState({ projectFilter: ["p1", "p1", 7, ""] }).projectFilter).toEqual([
      "p1",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import {
  matchesTagFilter,
  MAX_TAGS_PER_PROJECT,
  MAX_TAGGED_PROJECTS,
  MAX_TAG_LENGTH,
  normalizeTag,
  normalizeTags,
  parseTagMap,
  pruneTagFilter,
  sortedTags,
  tagCounts,
} from "@/lib/tags";
import { validProjectId } from "@/lib/colors";

const isProjectId = (id: unknown) => validProjectId(id);

describe("normalizeTag", () => {
  it("trims, collapses whitespace and lowercases", () => {
    expect(normalizeTag("  Back   End ")).toBe("back end");
  });

  it("removes control characters", () => {
    expect(normalizeTag("api\u0000\u001F")).toBe("api");
  });

  it("rejects anything empty or not a string", () => {
    expect(normalizeTag("   ")).toBeNull();
    expect(normalizeTag("")).toBeNull();
    expect(normalizeTag(42)).toBeNull();
    expect(normalizeTag(null)).toBeNull();
  });

  it("cuts an overlong tag to the limit", () => {
    expect(normalizeTag("x".repeat(200))).toHaveLength(MAX_TAG_LENGTH);
  });
});

describe("normalizeTags", () => {
  it("drops the empty ones and dedupes case-insensitively", () => {
    expect(normalizeTags(["Api", "api", " ", "API ", "web"])).toEqual(["api", "web"]);
  });

  it("keeps the order in which the tags were added", () => {
    expect(normalizeTags(["web", "api"])).toEqual(["web", "api"]);
  });

  it("caps how many tags one project may carry", () => {
    const many = Array.from({ length: 40 }, (_, index) => `tag-${index}`);
    expect(normalizeTags(many)).toHaveLength(MAX_TAGS_PER_PROJECT);
  });

  it("returns nothing for a value that is not a list", () => {
    expect(normalizeTags("api")).toEqual([]);
    expect(normalizeTags(null)).toEqual([]);
  });
});

describe("parseTagMap", () => {
  it("reads a stored map", () => {
    expect(parseTagMap({ p1: ["Api", "web"] }, isProjectId)).toEqual({
      p1: ["api", "web"],
    });
  });

  it("drops entries without a usable project id", () => {
    expect(parseTagMap({ "": ["api"], "x\u0000y": ["api"] }, isProjectId)).toEqual({});
  });

  it("stores no project whose tags all fell away — untagged has one spelling", () => {
    expect(parseTagMap({ p1: [], p2: ["  "], p3: "nope" }, isProjectId)).toEqual({});
  });

  it("falls back to an empty map for a foreign format", () => {
    expect(parseTagMap(null, isProjectId)).toEqual({});
    expect(parseTagMap("tags", isProjectId)).toEqual({});
  });

  it("caps how many projects it keeps", () => {
    const stored: Record<string, string[]> = {};
    for (let index = 0; index < MAX_TAGGED_PROJECTS + 20; index += 1) {
      stored[`p${index}`] = ["api"];
    }
    expect(Object.keys(parseTagMap(stored, isProjectId))).toHaveLength(
      MAX_TAGGED_PROJECTS,
    );
  });
});

describe("tagCounts", () => {
  it("counts how many projects carry each tag", () => {
    expect(
      tagCounts({ p1: ["web", "api"], p2: ["api", "infra"] }, ["p1", "p2"]),
    ).toEqual({ api: 2, infra: 1, web: 1 });
  });

  it("ignores stored tags of projects that no longer exist", () => {
    expect(tagCounts({ p1: ["api"], gone: ["api", "web"] }, ["p1"])).toEqual({
      api: 1,
    });
  });

  it("is empty when nothing is tagged", () => {
    expect(tagCounts({}, ["p1"])).toEqual({});
  });
});

describe("sortedTags", () => {
  it("offers the tags in use, alphabetical and without duplicates", () => {
    expect(sortedTags({ web: 1, api: 2, infra: 1 })).toEqual([
      "api",
      "infra",
      "web",
    ]);
  });

  it("is empty when nothing is tagged", () => {
    expect(sortedTags({})).toEqual([]);
  });
});

describe("matchesTagFilter", () => {
  it("keeps everything while no tag is picked", () => {
    expect(matchesTagFilter([], [])).toBe(true);
    expect(matchesTagFilter(["api"], [])).toBe(true);
  });

  it("is an OR across the picked tags", () => {
    expect(matchesTagFilter(["api"], ["api", "web"])).toBe(true);
    expect(matchesTagFilter(["infra"], ["api", "web"])).toBe(false);
  });

  it("removes an untagged project as soon as a tag is picked", () => {
    expect(matchesTagFilter([], ["api"])).toBe(false);
  });

  it("is unaffected by a project id when no project is picked (unchanged behaviour)", () => {
    expect(matchesTagFilter(["api"], ["api"], "p1", [])).toBe(true);
    expect(matchesTagFilter([], ["api"], "p1", [])).toBe(false);
    expect(matchesTagFilter([], [], "p1", [])).toBe(true);
  });

  it("keeps a picked project even without a matching tag", () => {
    expect(matchesTagFilter([], [], "p1", ["p1"])).toBe(true);
    expect(matchesTagFilter([], [], "p2", ["p1"])).toBe(false);
  });

  it("is a union of tag group and picked project", () => {
    // Tag group picked (web) plus a foreign project (p3) picked: a project in
    // the tag group stays visible, and so does the picked project even though
    // it carries neither tag.
    expect(matchesTagFilter(["web"], ["web"], "p1", ["p3"])).toBe(true);
    expect(matchesTagFilter([], ["web"], "p3", ["p3"])).toBe(true);
    expect(matchesTagFilter(["infra"], ["web"], "p2", ["p3"])).toBe(false);
  });
});

describe("pruneTagFilter", () => {
  it("drops tags no project carries any more", () => {
    expect(pruneTagFilter(["api", "gone"], ["api", "web"])).toEqual(["api"]);
  });

  it("empties itself when the last tag disappears", () => {
    expect(pruneTagFilter(["api"], [])).toEqual([]);
  });

  it("also prunes project ids no longer among the live projects", () => {
    expect(pruneTagFilter(["p1", "deleted"], ["p1", "p2"])).toEqual(["p1"]);
  });
});

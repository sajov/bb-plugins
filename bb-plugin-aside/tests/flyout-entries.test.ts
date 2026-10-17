import { describe, expect, it } from "vitest";
import { flyoutEntries } from "@/lib/search";

const projects = [
  { id: "p1", name: "bb-plugins (GitLab)", count: 2 },
  { id: "p2", name: "bb-plugins", count: 21 },
  { id: "p3", name: "Brain", count: 0 },
];
const tagCounts = { mastra: 1, management: 5, bb: 1 };

describe("flyoutEntries", () => {
  it("lists projects first, then tags, each by count", () => {
    const rows = flyoutEntries({ query: "", projects, tagCounts, activeProjects: [], activeTags: [] });
    expect(rows.map((row) => `${row.kind}:${row.name}`)).toEqual([
      "project:bb-plugins",
      "project:bb-plugins (GitLab)",
      "project:Brain",
      "tag:management",
      "tag:bb",
      "tag:mastra",
    ]);
  });

  it("narrows projects and tags by the query", () => {
    const rows = flyoutEntries({ query: "bb", projects, tagCounts, activeProjects: [], activeTags: [] });
    expect(rows.map((row) => row.name)).toEqual(["bb-plugins", "bb-plugins (GitLab)", "bb"]);
  });

  it("a # query offers tags only, by prefix", () => {
    const rows = flyoutEntries({ query: "#ma", projects, tagCounts, activeProjects: [], activeTags: [] });
    expect(rows.map((row) => row.name)).toEqual(["management", "mastra"]);
  });

  it("marks picked entries without moving them", () => {
    const rows = flyoutEntries({ query: "", projects, tagCounts, activeProjects: ["p1"], activeTags: ["mastra"] });
    expect(rows.filter((row) => row.picked).map((row) => row.name)).toEqual(["bb-plugins (GitLab)", "mastra"]);
    expect(rows[1].name).toBe("bb-plugins (GitLab)");
  });
});

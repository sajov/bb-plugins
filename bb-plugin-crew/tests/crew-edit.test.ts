import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { validateCrew } from "../lib/spec";
import {
  addGroupToFile,
  addLinkToFile,
  editorModel,
  nextMemberId,
  removeLinkFromFile,
  renameMemberInFile,
  setCrewValue,
  setMemberExecution,
  setMemberSkills,
  setMemberValue,
} from "../lib/crew-edit";

const BASE = `# the factory crew
version: "1"
name: mst-factory
baseBranch: main
groups:
  - id: orch
    members:
      - id: lead
        lead: true
        role: Plans.
        provider: claude-code
        model: claude-opus-5-5
  - id: dev
    members:
      - id: impl
        role: Implements.
        provider: claude-code
        model: claude-sonnet-5-5
        skills: [tdd, diagnose]
links:
  - from: orch-lead
    to: dev-impl
    kind: assigns_to
`;

const valid = (text: string) => validateCrew(text).problems.filter((problem) => problem.level === "error");

describe("editorModel", () => {
  it("reads members with keys, groups, skills and links", () => {
    const model = editorModel(BASE)!;
    expect(model.crew).toEqual({ name: "mst-factory", baseBranch: "main", instructions: "" });
    expect(model.groups).toEqual(["orch", "dev"]);
    expect(model.members.map((member) => member.key)).toEqual(["orch-lead", "dev-impl"]);
    expect(model.members[1]).toMatchObject({ group: "dev", id: "impl", lead: false, skills: ["tdd", "diagnose"], model: "claude-sonnet-5-5" });
    expect(model.members[0]!.lead).toBe(true);
    expect(model.links).toEqual([{ from: "orch-lead", to: "dev-impl", kind: "assigns_to" }]);
  });

  it("returns null for text that does not parse", () => {
    expect(editorModel("groups: [")).toBeNull();
    expect(editorModel("- a list")).toBeNull();
  });
});

describe("member edits", () => {
  it("sets and clears a member field and keeps comments", () => {
    const next = setMemberValue(BASE, "dev-impl", "role", "Builds things.");
    expect(next).toContain("# the factory crew");
    expect(editorModel(next)!.members[1]!.role).toBe("Builds things.");
    const cleared = setMemberValue(next, "dev-impl", "permissions", "");
    expect(YAML.parse(cleared).groups[1].members[0].permissions).toBeUndefined();
    expect(valid(next)).toEqual([]);
  });

  it("throws for an unknown member", () => {
    expect(() => setMemberValue(BASE, "dev-nope", "role", "x")).toThrow(/no member dev-nope/);
  });

  it("writes skills as a list and drops the key when empty", () => {
    const next = setMemberSkills(BASE, "dev-impl", ["tdd", "grilling"]);
    expect(editorModel(next)!.members[1]!.skills).toEqual(["tdd", "grilling"]);
    const empty = setMemberSkills(next, "dev-impl", []);
    expect(YAML.parse(empty).groups[1].members[0].skills).toBeUndefined();
  });

  it("renames a member and rewrites the links that name it", () => {
    const next = renameMemberInFile(BASE, "dev-impl", "builder");
    const model = editorModel(next)!;
    expect(model.members[1]!.key).toBe("dev-builder");
    expect(model.links).toEqual([{ from: "orch-lead", to: "dev-builder", kind: "assigns_to" }]);
    expect(valid(next)).toEqual([]);
  });

  it("refuses a rename onto an existing id or an invalid id", () => {
    const twice = addGroupToFile(BASE, "dev", "check");
    expect(() => renameMemberInFile(twice, "dev-impl", "check")).toThrow(/already/);
    expect(() => renameMemberInFile(BASE, "dev-impl", "bad id")).toThrow(/letters/);
  });
});

describe("links", () => {
  it("adds a link once and validates", () => {
    const next = addLinkToFile(BASE, "dev-impl", "orch-lead", "escalates_to");
    expect(editorModel(next)!.links).toHaveLength(2);
    expect(addLinkToFile(next, "dev-impl", "orch-lead", "escalates_to")).toBe(next);
    expect(valid(next)).toEqual([]);
  });

  it("creates the links list when the file has none", () => {
    const bare = BASE.slice(0, BASE.indexOf("links:"));
    const next = addLinkToFile(bare, "orch-lead", "dev-impl", "works_with");
    expect(editorModel(next)!.links).toEqual([{ from: "orch-lead", to: "dev-impl", kind: "works_with" }]);
  });

  it("refuses a link to itself", () => {
    expect(() => addLinkToFile(BASE, "dev-impl", "dev-impl", "works_with")).toThrow(/itself/);
  });

  it("removes a link by index", () => {
    expect(editorModel(removeLinkFromFile(BASE, 0))!.links).toEqual([]);
  });
});

describe("groups and crew settings", () => {
  it("adds a member to an existing group or a new group, inheriting the lead's provider", () => {
    const next = addGroupToFile(BASE, "qa", "review");
    const model = editorModel(next)!;
    expect(model.groups).toEqual(["orch", "dev", "qa"]);
    expect(model.members.at(-1)).toMatchObject({ key: "qa-review", provider: "claude-code", model: "claude-opus-5-5" });
    expect(valid(next)).toEqual([]);
  });

  it("picks the next free member id", () => {
    expect(nextMemberId(editorModel(BASE)!, "dev")).toBe("member");
    const next = addGroupToFile(BASE, "dev", "member");
    expect(nextMemberId(editorModel(next)!, "dev")).toBe("member2");
  });

  it("sets baseBranch and instructions, clearing on empty", () => {
    const next = setCrewValue(setCrewValue(BASE, "baseBranch", "develop"), "instructions", "Be brief.");
    expect(editorModel(next)!.crew).toEqual({ name: "mst-factory", baseBranch: "develop", instructions: "Be brief." });
    expect(editorModel(setCrewValue(next, "instructions", ""))!.crew.instructions).toBe("");
  });
});

describe("setMemberExecution", () => {
  it("writes provider, model and level, and drops a tier the picker no longer returns", () => {
    const withTier = setMemberValue(BASE, "dev-impl", "serviceTier", "fast");
    const next = setMemberExecution(withTier, "dev-impl", { providerId: "codex", model: "gpt-5", reasoningLevel: "high" });
    const member = YAML.parse(next).groups[1].members[0];
    expect(member).toMatchObject({ provider: "codex", model: "gpt-5", reasoningLevel: "high" });
    expect(member.serviceTier).toBeUndefined();
  });
});

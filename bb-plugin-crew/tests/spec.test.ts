import { describe, expect, it } from "vitest";
import {
  INSTRUCTION_LIMIT,
  hasErrors,
  parseCrewYaml,
  placementFor,
  serializeCrew,
  topoOrder,
  validateCrew,
  type CrewSpecInput,
  inlineExecution,
} from "../lib/spec";
import { TEMPLATES } from "../lib/templates";

function base(): CrewSpecInput {
  return {
    version: "1",
    name: "first",
    groups: [
      { id: "orch", members: [{ id: "lead", lead: true, provider: "claude-code", model: "claude-haiku-4-5-20251001" }] },
      { id: "dev", members: [{ id: "owner", provider: "claude-code", model: "claude-haiku-4-5-20251001" }, { id: "check", permissions: "ask", provider: "claude-code", model: "claude-haiku-4-5-20251001" }] },
    ],
    links: [
      { from: "orch-lead", to: "dev-owner", kind: "assigns_to" },
      { from: "orch-lead", to: "dev-check", kind: "assigns_to" },
    ],
  };
}

const codes = (input: unknown, options = {}) => validateCrew(input, options).problems.map((p) => p.code);

describe("crew file validation", () => {
  it("accepts a valid crew", () => {
    const result = validateCrew(base());
    expect(result.problems).toEqual([]);
    expect(result.members.map((m) => m.address)).toEqual(["orch-lead@first", "dev-owner@first", "dev-check@first"]);
  });

  it("reasoning level and service tier: valid values pass through, unknown ones are a schema error", () => {
    const spec = base();
    spec.groups[1]!.members[0] = { ...spec.groups[1]!.members[0]!, reasoningLevel: "high", serviceTier: "fast" };
    const owner = validateCrew(spec).members.find((m) => m.key === "dev-owner")!;
    expect([owner.reasoningLevel, owner.serviceTier]).toEqual(["high", "fast"]);
    expect(validateCrew(base()).members[0]!.reasoningLevel).toBeNull();
    const bad = base();
    bad.groups[1]!.members[0] = { ...bad.groups[1]!.members[0]!, reasoningLevel: "extreme" as never };
    expect(codes(bad)).toContain("schema");
  });

  it("rejects a schema violation (unknown permission)", () => {
    const spec = base();
    spec.permissions = "yolo" as never;
    expect(codes(spec)).toContain("schema");
  });

  describe("unique ids", () => {
    it("positive: distinct ids pass", () => expect(codes(base())).not.toContain("id-duplicate"));
    it("negative: duplicate group id", () => {
      const spec = base();
      spec.groups.push({ id: "dev", members: [{ id: "other" }] });
      expect(codes(spec)).toContain("id-duplicate");
    });
    it("negative: duplicate member id in a group", () => {
      const spec = base();
      spec.groups[1]!.members.push({ id: "owner" });
      expect(codes(spec)).toContain("id-duplicate");
    });
    it("negative: two members collide on the same address key", () => {
      const spec = base();
      // dev + owner-x and dev-owner + x both become "dev-owner-x".
      spec.groups[1]!.members.push({ id: "owner-x" });
      spec.groups.push({ id: "dev-owner", members: [{ id: "x" }] });
      const problem = validateCrew(spec).problems.find((p) => p.code === "id-duplicate");
      expect(problem?.message).toContain('"dev-owner-x"');
    });
  });

  describe("forbidden characters", () => {
    it("positive: dashes and underscores are fine", () => {
      const spec = base();
      spec.groups[1]!.members[0]!.id = "own_er-2";
      spec.links = [];
      expect(codes(spec)).not.toContain("id-chars");
    });
    it.each(["dev.owner", "dev@owner", "dev owner"])("negative: member id %j", (id) => {
      const spec = base();
      spec.groups[1]!.members[0]!.id = id;
      spec.links = [];
      expect(codes(spec)).toContain("id-chars");
    });
    it("negative: crew name with a dot", () => {
      const spec = base();
      spec.name = "a.b";
      expect(codes(spec)).toContain("id-chars");
    });
  });

  describe("exactly one lead", () => {
    it("positive: one explicit lead", () => {
      const result = validateCrew(base());
      expect(result.members.filter((m) => m.lead).map((m) => m.key)).toEqual(["orch-lead"]);
    });
    it("negative: no lead among several members", () => {
      const spec = base();
      delete spec.groups[0]!.members[0]!.lead;
      expect(codes(spec)).toContain("lead-missing");
    });
    it("negative: two leads", () => {
      const spec = base();
      spec.groups[1]!.members[0]!.lead = true;
      expect(codes(spec)).toContain("lead-multiple");
    });
    it("positive: a single member is its own lead", () => {
      const result = validateCrew({ ...base(), groups: [{ id: "solo", members: [{ id: "me", provider: "claude-code", model: "m" }] }], links: [] });
      expect(result.problems).toEqual([]);
      expect(result.members[0]!.lead).toBe(true);
    });
  });

  describe("link ends exist", () => {
    it("positive: all ends are members", () => expect(codes(base())).not.toContain("link-end"));
    it("negative: unknown end", () => {
      const spec = base();
      spec.links!.push({ from: "dev-owner", to: "dev-nobody", kind: "works_with" });
      expect(codes(spec)).toContain("link-end");
    });
    it("negative: a full address is not a member key", () => {
      const spec = base();
      spec.links = [{ from: "orch-lead@first", to: "dev-owner", kind: "works_with" }];
      expect(codes(spec)).toContain("link-end");
    });
  });

  describe("assigns_to cycle", () => {
    it("positive: a tree has no cycle", () => expect(codes(base())).not.toContain("assign-cycle"));
    it("positive: a cycle in works_with is allowed", () => {
      const spec = base();
      spec.links!.push({ from: "dev-owner", to: "orch-lead", kind: "works_with" });
      expect(codes(spec)).not.toContain("assign-cycle");
    });
    it("negative: a cycle in assigns_to", () => {
      const spec = base();
      spec.links!.push({ from: "dev-check", to: "orch-lead", kind: "assigns_to" });
      const problem = validateCrew(spec).problems.find((p) => p.code === "assign-cycle");
      expect(problem?.message).toContain("orch-lead → dev-check → orch-lead");
    });
  });

  describe("provider and model catalogue", () => {
    const catalog = { providers: new Map([["claude-code", new Set(["claude-haiku-4-5-20251001"])]]) };
    it("positive: known provider and model give no warning", () => {
      expect(validateCrew(base(), { catalog }).problems).toEqual([]);
    });
    it("negative: unknown provider is a warning, not an error", () => {
      const spec = base();
      spec.groups[1]!.members[0]!.provider = "nope";
      const problems = validateCrew(spec, { catalog }).problems;
      expect(problems.map((p) => [p.level, p.code])).toContainEqual(["warning", "unknown-provider"]);
      expect(hasErrors(problems)).toBe(false);
    });
    it("negative: unknown model is a warning", () => {
      const spec = base();
      spec.groups[1]!.members[0]!.model = "gpt-9";
      expect(validateCrew(spec, { catalog }).problems.map((p) => p.code)).toEqual(["unknown-model"]);
    });
    it("without a catalogue nothing is checked", () => {
      const spec = base();
      spec.groups[1]!.members[0]!.model = "gpt-9";
      expect(codes(spec)).toEqual([]);
    });
    it("negative: a member without provider or model is an error", () => {
      const spec = base();
      delete spec.groups[1]!.members[1]!.model;
      expect(codes(spec)).toContain("execution-missing");
    });
  });

  describe("full needs confirmation", () => {
    const full = () => {
      const spec = base();
      spec.groups[1]!.members[0]!.permissions = "full";
      return spec;
    };
    it("negative: full without confirmation", () => expect(codes(full())).toContain("full-unconfirmed"));
    it("positive: full with confirmation", () => expect(codes(full(), { confirmFull: true })).not.toContain("full-unconfirmed"));
    it("positive: no full member needs no confirmation", () => expect(codes(base())).not.toContain("full-unconfirmed"));
  });

  describe("instruction limit", () => {
    it("positive: short instructions fit", () => expect(codes(base())).not.toContain("instructions-too-long"));
    it("negative: inherited instructions push the member over the limit", () => {
      const spec = base();
      spec.instructions = "x".repeat(INSTRUCTION_LIMIT / 2);
      spec.groups[1]!.instructions = "y".repeat(INSTRUCTION_LIMIT / 2);
      const problems = validateCrew(spec).problems.filter((p) => p.code === "instructions-too-long");
      // Only the dev members inherit the group text.
      expect(problems.map((p) => p.message.split(":")[0])).toEqual(["dev-owner", "dev-check"]);
    });
  });

  describe("deputy", () => {
    it("positive: deputy names a member", () => {
      const spec = base();
      spec.groups[0]!.members[0]!.deputy = "dev-owner";
      expect(codes(spec)).not.toContain("deputy");
    });
    it("negative: deputy names nobody", () => {
      const spec = base();
      spec.groups[0]!.members[0]!.deputy = "dev-ghost";
      expect(codes(spec)).toContain("deputy");
    });
  });

  describe("inheritance crew → group → member", () => {
    it("member wins over group wins over crew (permissions, instructions)", () => {
      const spec = base();
      spec.permissions = "auto";
      spec.instructions = "crew rules";
      spec.groups[1]!.permissions = "ask";
      spec.groups[1]!.instructions = "group rules";
      spec.groups[1]!.members[0]!.permissions = "accept-edits";
      spec.groups[1]!.members[0]!.model = "own-model";
      const members = new Map(validateCrew(spec).members.map((m) => [m.key, m]));
      expect(members.get("orch-lead")!.permissions).toBe("auto");
      expect(members.get("dev-check")!.permissions).toBe("ask");
      expect(members.get("dev-owner")!.permissions).toBe("accept-edits");
      expect(members.get("dev-owner")!.model).toBe("own-model");
      expect(members.get("dev-owner")!.instructions).toEqual(["crew rules", "group rules"]);
      expect(members.get("orch-lead")!.instructions).toEqual(["crew rules"]);
    });

    it("skills: crew, group and member skills all inherit down, deduplicated", () => {
      const spec = base();
      spec.skills = ["memory"];
      spec.groups[1]!.skills = ["gitlab"];
      spec.groups[1]!.members[0]!.skills = ["gitlab", "tdd"];
      const members = new Map(validateCrew(spec).members.map((m) => [m.key, m]));
      expect(members.get("dev-owner")!.skills).toEqual(["memory", "gitlab", "tdd"]);
      expect(members.get("dev-check")!.skills).toEqual(["memory", "gitlab"]);
      expect(members.get("orch-lead")!.skills).toEqual(["memory"]);
    });
  });

  describe("skills catalogue", () => {
    const catalog = { names: new Set(["memory", "gitlab"]) };
    it("positive: known skill names give no warning", () => {
      const spec = base();
      spec.skills = ["memory"];
      spec.groups[1]!.members[0]!.skills = ["gitlab"];
      expect(codes(spec, { skills: catalog })).not.toContain("unknown-skill");
    });
    it("negative: an unknown skill name is a warning, not an error", () => {
      const spec = base();
      spec.groups[1]!.members[0]!.skills = ["no-such-skill"];
      const problems = validateCrew(spec, { skills: catalog }).problems;
      expect(problems.map((p) => [p.level, p.code])).toContainEqual(["warning", "unknown-skill"]);
      expect(hasErrors(problems)).toBe(false);
    });
    it("without a catalogue nothing is checked", () => {
      const spec = base();
      spec.groups[1]!.members[0]!.skills = ["no-such-skill"];
      expect(codes(spec)).toEqual([]);
    });
  });

  describe("graphs (BBP-30)", () => {
    it("inherit crew → group → member, deduplicated", () => {
      const spec = base();
      spec.graphs = ["onboarding"];
      spec.groups[1]!.graphs = ["release"];
      spec.groups[1]!.members[0]!.graphs = ["release", "triage"];
      const members = new Map(validateCrew(spec).members.map((m) => [m.key, m]));
      expect(members.get("dev-owner")!.graphs).toEqual(["onboarding", "release", "triage"]);
      expect(members.get("dev-check")!.graphs).toEqual(["onboarding", "release"]);
      expect(members.get("orch-lead")!.graphs).toEqual(["onboarding"]);
    });

    it("positive: a known graph id gives no warning", () => {
      const spec = base();
      spec.groups[1]!.members[0]!.graphs = ["release"];
      const catalog = { names: new Set(["release"]) };
      expect(codes(spec, { graphs: catalog })).not.toContain("unknown-graph");
    });
    it("negative: an unknown graph id is a warning, not an error", () => {
      const spec = base();
      spec.groups[1]!.members[0]!.graphs = ["no-such-graph"];
      const problems = validateCrew(spec, { graphs: { names: new Set(["release"]) } }).problems;
      expect(problems.map((p) => [p.level, p.code])).toContainEqual(["warning", "unknown-graph"]);
      expect(hasErrors(problems)).toBe(false);
    });
    it("without a catalogue nothing is checked", () => {
      const spec = base();
      spec.groups[1]!.members[0]!.graphs = ["no-such-graph"];
      expect(codes(spec)).toEqual([]);
    });
  });

  describe("environment auto", () => {
    it("writer gets its own worktree, reader shares the crew environment", () => {
      const members = new Map(validateCrew(base()).members.map((m) => [m.key, m]));
      expect(members.get("orch-lead")!.placement).toEqual({ kind: "crew-root", workspace: "managed-worktree" });
      expect(members.get("dev-owner")!.placement).toEqual({ kind: "own-worktree" });
      expect(members.get("dev-check")!.placement).toEqual({ kind: "shared" });
    });
    it.each(["accept-edits", "auto", "full"] as const)("%s counts as writing", (permissions) => {
      expect(placementFor(false, permissions, { type: "auto" }, { type: "auto" })).toEqual({ kind: "own-worktree" });
    });
    it("reuse shares everything, and the lead uses the project default", () => {
      expect(placementFor(false, "auto", { type: "reuse" }, { type: "reuse" })).toEqual({ kind: "shared" });
      expect(placementFor(true, "auto", { type: "reuse" }, { type: "reuse" })).toEqual({ kind: "crew-root", workspace: "project-default" });
    });
    it("worktree gives even a reader its own", () => {
      expect(placementFor(false, "ask", { type: "worktree" }, { type: "auto" })).toEqual({ kind: "own-worktree" });
    });
    it("host:<id> short form parses", () => {
      const spec = base();
      spec.environment = "host:mac-2" as never;
      expect(validateCrew(spec).members[1]!.placement).toEqual({ kind: "host", hostId: "mac-2" });
    });
    it("negative: several writers sharing one environment warn", () => {
      const spec = base();
      spec.environment = { type: "reuse" };
      expect(codes(spec)).toContain("shared-writers");
    });
    it("positive: under auto writers do not share, no warning", () => expect(codes(base())).not.toContain("shared-writers"));
  });

  describe("topological order", () => {
    it("puts the lead first even when it is declared last", () => {
      const spec = base();
      spec.groups.reverse();
      expect(validateCrew(spec).members.map((m) => m.key)).toEqual(["orch-lead", "dev-owner", "dev-check"]);
    });
    it("follows assigns_to breadth-first, then file order", () => {
      const members = validateCrew(base()).members;
      const reordered = topoOrder([...members].reverse(), [
        { from: "orch-lead", to: "dev-check", kind: "assigns_to" },
      ]);
      expect(reordered.map((m) => m.key)).toEqual(["orch-lead", "dev-check", "dev-owner"]);
    });
  });

  describe("YAML", () => {
    it("round-trips through serialize and parse", () => {
      const text = serializeCrew(base());
      expect(validateCrew(text).problems).toEqual([]);
      expect(validateCrew(text).spec).toEqual(validateCrew(base()).spec);
    });
    it("negative: syntax error becomes a yaml problem", () => {
      expect(parseCrewYaml("groups: [unclosed").problems[0]!.code).toBe("yaml");
      expect(codes("groups: [unclosed")).toEqual(["yaml"]);
    });
    it("accepts the concept's example with a numeric-looking version", () => {
      expect(codes(`version: 1\nname: x\ngroups:\n  - id: g\n    members:\n      - id: a\n        provider: p\n        model: m\n`)).toEqual([]);
    });
  });
});

describe("provider and model live on the member", () => {
  it("negative: a crew- or group-level provider/model is an error, not inherited", () => {
    const crew = { ...base(), provider: "claude-code" };
    expect(codes(crew)).toContain("execution-not-on-member");
    const group = base();
    group.groups[1] = { ...group.groups[1]!, model: "m" };
    expect(codes(group)).toContain("execution-not-on-member");
    const bare = base();
    delete bare.groups[0]!.members[0]!.provider;
    expect(codes(bare)).toContain("execution-missing");
  });

  it("positive: every member naming its own gives no error", () => {
    expect(codes(base())).not.toContain("execution-not-on-member");
    expect(codes(base())).not.toContain("execution-missing");
  });

  it("inlineExecution moves crew/group values onto members, member values win, and reports nothing to do otherwise", () => {
    const legacy = `version: 1\nname: x\nprovider: p\nmodel: m\ngroups:\n  - id: g\n    model: gm\n    members:\n      - id: a\n        lead: true\n      - id: b\n        model: own\n  - id: h\n    members:\n      - id: c\n`;
    const out = inlineExecution(legacy)!;
    expect(out).not.toBeNull();
    const members = new Map(validateCrew(out).members.map((m) => [m.key, m]));
    expect(validateCrew(out).problems.filter((p) => p.level === "error")).toEqual([]);
    expect([members.get("g-a")!.provider, members.get("g-a")!.model]).toEqual(["p", "gm"]);
    expect(members.get("g-b")!.model).toBe("own");
    expect([members.get("h-c")!.provider, members.get("h-c")!.model]).toEqual(["p", "m"]);
    expect(inlineExecution(out)).toBeNull();
  });
});

describe("templates", () => {
  it("ships pair, trio and research", () => expect(TEMPLATES.map((t) => t.id)).toEqual(["pair", "trio", "research"]));
  it.each(TEMPLATES.map((t) => [t.id, t]))("%s validates without problems", (_id, template) => {
    const result = validateCrew(template.spec);
    expect(result.problems).toEqual([]);
    expect(result.members.filter((m) => m.lead)).toHaveLength(1);
  });
  it("trio has 3 members with writer and reader placements", () => {
    const members = validateCrew(TEMPLATES[1]!.spec).members;
    expect(members.map((m) => [m.key, m.placement.kind])).toEqual([
      ["orch-lead", "crew-root"],
      ["dev-impl", "own-worktree"],
      ["dev-review", "shared"],
    ]);
  });
});

describe("E3 fields", () => {
  it("defaults: base branch main, lead busy timeout 10 min, default follow-up periods", async () => {
    const { DEFAULT_FOLLOW_UPS, followUpMinutes } = await import("../lib/spec");
    const spec = validateCrew(base()).spec!;
    expect(spec.baseBranch).toBe("main");
    expect(spec.leadBusyTimeout).toBe(10);
    expect(spec.checks).toBeUndefined();
    expect(followUpMinutes(spec, "p1")).toBe(DEFAULT_FOLLOW_UPS.p1);
    expect(followUpMinutes(validateCrew({ ...base(), followUps: { p1: 2 } }).spec!, "p1")).toBe(2);
  });
  it("negative: waitsFor on the crew's own task is an error; waitsFor without task only warns", () => {
    expect(codes({ ...base(), task: "CRD-1", waitsFor: [{ task: "CRD-1", until: "merged" }] })).toContain("waits-for-self");
    expect(codes({ ...base(), waitsFor: [{ task: "CRD-1", until: "done" }] })).toEqual(["waits-without-task"]);
    expect(codes({ ...base(), task: "CRD-2", waitsFor: [{ task: "CRD-1", until: "comment:ready" }] })).toEqual([]);
    expect(codes({ ...base(), followUps: { p9: 1 } })).toContain("schema");
    expect(codes({ ...base(), leadBusyTimeout: 0 })).toContain("schema");
  });
});

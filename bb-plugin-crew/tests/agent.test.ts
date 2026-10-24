import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import { agentInstructions, configureFor, GRAPH_TOOL_NAME, identifyMember, LEAD_ADMIN_TOOL_NAMES, registerAgentTools, TOOL_NAMES, toolsFor, WORK_TOOL_NAMES, type Confirm } from "../lib/agent";
import type { GraphRun, GraphsRpc } from "../lib/graphs";
import { INSTRUCTION_LIMIT } from "../lib/spec";
import { duoYaml, fakeSkillsCatalog, PROJECT, running, setup, trioYaml } from "./helpers";

function context(threadId: string, pluginMetadata: Record<string, unknown>): PluginAgentConfigurationContext {
  return {
    pluginMetadata,
    thread: { id: threadId, title: null, parentThreadId: null, sourceThreadId: null },
    project: { id: PROJECT, kind: "standard", name: "p", gitRemoteUrl: null },
    environment: { id: "env", name: null, path: null, branchName: null, workspaceProvisionType: null },
    host: { id: "h", name: "h" },
    provider: { id: "claude-code", model: "m", capabilities: { supportsNativeUserQuestion: false } },
    origin: { kind: null, pluginId: null },
  } as unknown as PluginAgentConfigurationContext;
}

async function withHost(options: { confirm?: Confirm; graphsRpc?: GraphsRpc | null; yaml?: string } = {}) {
  const env = setup({ graphsRpc: options.graphsRpc });
  const crew = await running(env.service, env.port, options.yaml);
  const { bb, harness } = createFakePluginHost({ pluginId: "crew", agentSkillIds: ["crew"] });
  registerAgentTools(bb, env.service, options);
  const meta = (key: string) => ({ ...env.port.threads.get(crew.threads[key]!)!.metadata });
  return { ...env, ...crew, harness, meta };
}

const mkRun = (overrides: Partial<GraphRun> & Pick<GraphRun, "id" | "status">): GraphRun => ({ error: null, state: null, childThreadIds: [], pendingQuestion: null, ...overrides });

function fakeGraphsRpc(run: GraphRun): GraphsRpc {
  return {
    listGraphs: async () => [{ id: "release", name: "Release" }],
    // Mirrors graph-studio's real startRun, which throws without a parent thread (BBP-30 review fix).
    startRun: async (args) => {
      if (!args.threadId) throw new Error("A run needs a parent thread whose environment the workers inherit.");
      return run;
    },
    getRun: async (id) => ({ ...run, id }),
    stopRun: async (id) => ({ ...run, id, status: "stopped" }),
  };
}

const text = (result: unknown) =>
  typeof result === "string" ? result : (result as { content: { text: string }[] }).content.map((part) => part.text).join("\n");
const isError = (result: unknown) => typeof result !== "string" && (result as { isError?: boolean }).isError === true;

describe("configure", () => {
  it("identifies a member only when the metadata matches the current binding", async () => {
    const { store, threads, meta } = await withHost();
    expect(identifyMember(store, meta("dev-impl"), threads["dev-impl"]!)?.member.key).toBe("dev-impl");
    // spoofed: right metadata copied onto another thread
    expect(identifyMember(store, meta("dev-impl"), threads["dev-review"]!)).toBeNull();
    // spoofed: made-up member, wrong address, missing fields
    expect(identifyMember(store, { ...meta("dev-impl"), member: "dev-ghost" }, threads["dev-impl"]!)).toBeNull();
    expect(identifyMember(store, { ...meta("dev-impl"), address: "orch-lead@trio" }, threads["dev-impl"]!)).toBeNull();
    expect(identifyMember(store, {}, threads["dev-impl"]!)).toBeNull();
  });

  it("negative: a retired binding no longer counts", async () => {
    const { store, threads, meta, members } = await withHost();
    store.retireBinding(members["dev-impl"]!.id);
    expect(identifyMember(store, meta("dev-impl"), threads["dev-impl"]!)).toBeNull();
  });

  it("members get the crew tools, the skill and instructions; spoofed metadata gets no tools", async () => {
    const { harness, threads, meta } = await withHost();
    const member = await harness.behavior.resolveAgentConfiguration(context(threads["dev-impl"]!, meta("dev-impl")));
    // A plain member: messaging and work tools; no crew_deliver, crew_directory or integrator tools.
    expect(member.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES, ...WORK_TOOL_NAMES].sort());
    expect(member.skills).toEqual(["crew"]);
    expect(member.instructions).toContain("You are dev-impl@trio, a member of the crew trio.");
    expect(member.instructions).toContain("Reply with crew_send");

    const spoofed = await harness.behavior.resolveAgentConfiguration(context("th_other", meta("dev-impl")));
    expect(spoofed.tools).toEqual([]);
    expect(spoofed.instructions).toBeNull();
    const plain = await harness.behavior.resolveAgentConfiguration(context("th_other", {}));
    expect(plain.tools).toEqual([]);
    expect(plain.skills).toEqual(["crew"]);
  });

  it("instructions stay within 4096 characters even with long inherited instructions", async () => {
    const { service, port } = setup();
    const long = "Follow the house rules carefully. ".repeat(110); // ~3700 chars, still a valid crew file
    const { crew, members, threads } = await running(service, port, trioYaml({ instructions: long }));
    const textOut = agentInstructions(service, crew, members["dev-impl"]!);
    expect(textOut.length).toBeLessThanOrEqual(INSTRUCTION_LIMIT);
    expect(textOut).toContain("summary, full text via crew_whoami");
    expect(textOut).toContain("Messaging (crew tools):");
    const short = agentInstructions(service, crew, members["orch-lead"]!);
    expect(short).toContain("the lead");
    const config = configureFor(service, { pluginMetadata: port.threads.get(threads["dev-impl"]!)!.metadata, thread: { id: threads["dev-impl"]! } });
    expect(config.instructions!.length).toBeLessThanOrEqual(INSTRUCTION_LIMIT);
  });

  it("negative: short instructions are not marked as a summary", async () => {
    const { service, port } = setup();
    const { crew, members } = await running(service, port);
    expect(agentInstructions(service, crew, members["dev-impl"]!)).not.toContain("summary");
  });

  it("member skills become a short 'Skill text: crew_whoami' hint; no skills means no hint", async () => {
    const { service, port } = setup();
    const { crew, members } = await running(service, port, trioYaml({ skills: ["memory"] }));
    expect(agentInstructions(service, crew, members["dev-impl"]!)).toContain("Skill text: crew_whoami");
    const { service: service2, port: port2 } = setup();
    const { crew: crew2, members: members2 } = await running(service2, port2);
    expect(agentInstructions(service2, crew2, members2["dev-impl"]!)).not.toContain("Skill text: crew_whoami");
  });
});

describe("crew tools", () => {
  it("crew_whoami and crew_peers answer for the calling thread", async () => {
    const { harness, threads } = await withHost();
    const whoami = text(await harness.behavior.callAgentTool("crew_whoami", {}, { threadId: threads["dev-impl"]! }));
    expect(whoami).toContain("Address: dev-impl@trio · shift 1");
    expect(whoami).toContain("Role: Builds.");
    const peers = text(await harness.behavior.callAgentTool("crew_peers", {}, { threadId: threads["dev-impl"]! }));
    expect(peers).toContain("- orch-lead (lead)");
    expect(peers).toContain("- dev-impl (you)");
    expect(peers).not.toContain("Other crew");
  });

  it("crew_whoami reports the full skill text; a skill missing from the catalog keeps the name plus a warning", async () => {
    const env = setup({ skills: fakeSkillsCatalog({ memory: "Recall past threads before starting work." }) });
    const crew = await running(env.service, env.port, trioYaml({ skills: ["memory", "ghost"] }));
    const { bb, harness } = createFakePluginHost({ pluginId: "crew", agentSkillIds: ["crew"] });
    registerAgentTools(bb, env.service);
    const whoami = text(await harness.behavior.callAgentTool("crew_whoami", {}, { threadId: crew.threads["dev-impl"]! }));
    expect(whoami).toContain("## Skill: memory\n\nRecall past threads before starting work.");
    expect(whoami).toContain("## Skill: ghost\n\n(not found in the skills catalog — only the name is known)");
  });

  it("a lead sees other crews' leads under crossCrew leads; negative: a member does not", async () => {
    const env = await withHost();
    await running(env.service, env.port, duoYaml());
    const lead = text(await env.harness.behavior.callAgentTool("crew_peers", {}, { threadId: env.threads["orch-lead"]! }));
    expect(lead).toContain("Other crew duo");
    const member = text(await env.harness.behavior.callAgentTool("crew_peers", {}, { threadId: env.threads["dev-impl"]! }));
    expect(member).not.toContain("Other crew duo");
  });

  it("crew_send delivers and reports; a refusal comes back as a tool error with the reason", async () => {
    const env = await withHost();
    await running(env.service, env.port, duoYaml());
    const ok = await env.harness.behavior.callAgentTool("crew_send", { to: "dev-review", body: "please check" }, { threadId: env.threads["dev-impl"]! });
    expect(isError(ok)).toBe(false);
    expect(text(ok)).toMatch(/dev-review@trio: delivered \(msg msg_\d+, chain ch_\d+, step 1\)/);
    const refused = await env.harness.behavior.callAgentTool("crew_send", { to: "core-lead@duo", body: "hi" }, { threadId: env.threads["dev-impl"]! });
    expect(isError(refused)).toBe(true);
    expect(text(refused)).toContain("crossCrew: leads");
    const bad = await env.harness.behavior.callAgentTool("crew_send", { to: "dev-nobody", body: "hi" }, { threadId: env.threads["dev-impl"]! });
    expect(isError(bad)).toBe(true);
  });

  it("memberKeys: short — crew_send, crew_work_create(owner) and links resolve short keys (BBP-255)", async () => {
    const yaml = trioYaml({ memberKeys: "short", links: [{ from: "lead", to: "impl", kind: "assigns_to" }] });
    const env = await withHost({ yaml });
    expect(Object.keys(env.threads).sort()).toEqual(["impl", "lead", "review"]);
    const sent = await env.harness.behavior.callAgentTool("crew_send", { to: "impl", body: "go" }, { threadId: env.threads["lead"]! });
    expect(isError(sent)).toBe(false);
    expect(text(sent)).toMatch(/impl@trio: delivered/);
    const created = await env.harness.behavior.callAgentTool("crew_work_create", { title: "Build", owner: "impl" }, { threadId: env.threads["lead"]! });
    expect(isError(created)).toBe(false);
    expect(text(created)).toContain("owner impl@trio");
    const old = await env.harness.behavior.callAgentTool("crew_send", { to: "dev-impl", body: "go" }, { threadId: env.threads["lead"]! });
    expect(isError(old)).toBe(true);
    expect(text(old)).toMatch(/unknown member/i);
  });

  it("crew_send kind info reports no answer expected; default to the human stays a question (BBP-23)", async () => {
    const env = await withHost();
    const info = await env.harness.behavior.callAgentTool("crew_send", { to: "human", body: "status: done", kind: "info" }, { threadId: env.threads["dev-impl"]! });
    expect(isError(info)).toBe(false);
    expect(text(info)).toContain("human: delivered as info (no answer expected)");
    expect(await env.service.needs(env.service.ctx.store.listCrews()[0]!.projectId)).toEqual([]);
    const ask = await env.harness.behavior.callAgentTool("crew_send", { to: "human", body: "which API?" }, { threadId: env.threads["dev-impl"]! });
    expect(text(ask)).not.toContain("as info");
    expect(env.service.ctx.store.openHumanQuestion(env.service.memberOfThread(env.threads["dev-impl"]!)!.member.id)).not.toBeNull();
  });

  it("crew_broadcast fans out; crew_inbox lists messages to me, bounded", async () => {
    const env = await withHost();
    const result = text(await env.harness.behavior.callAgentTool("crew_broadcast", { body: "standup" }, { threadId: env.threads["orch-lead"]! }));
    expect(result.split("\n")).toHaveLength(2);
    const inbox = text(await env.harness.behavior.callAgentTool("crew_inbox", { limit: 5 }, { threadId: env.threads["dev-impl"]! }));
    expect(inbox).toContain("orch-lead@trio → dev-impl@trio");
    expect(inbox).toContain("standup");
    const empty = text(await env.harness.behavior.callAgentTool("crew_inbox", {}, { threadId: env.threads["orch-lead"]! }));
    expect(empty).toBe("No messages to you yet.");
  });

  it("crew_work_create notifies the owner exactly once; negative: the creator as owner gets no message (BBP-259)", async () => {
    const env = await withHost();
    const before = env.store.listMessages().length;
    await env.harness.behavior.callAgentTool("crew_work_create", { title: "fix it", owner: "dev-review" }, { threadId: env.threads["dev-impl"]! });
    const sent = env.store.listMessages().slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.toAddress).toBe("dev-review@trio");
    await env.harness.behavior.callAgentTool("crew_work_create", { title: "mine", owner: "dev-impl" }, { threadId: env.threads["dev-impl"]! });
    expect(env.store.listMessages().slice(before)).toHaveLength(1);
  });

  describe("context: per-item starts a new shift on assignment (BBP-280, ADR 0005)", () => {
    const perItem = () => trioYaml({ groups: [
      { id: "orch", members: [{ id: "lead", lead: true, role: "Plans." }] },
      { id: "dev", members: [{ id: "impl", role: "Builds." }, { id: "review", permissions: "ask", role: "Reviews.", context: "per-item" }] },
    ] });
    const create = (env: Awaited<ReturnType<typeof withHost>>, title: string, owner: string) =>
      env.harness.behavior.callAgentTool("crew_work_create", { title, owner }, { threadId: env.threads["orch-lead"]! });
    const bound = (env: Awaited<ReturnType<typeof withHost>>, key: string) => env.store.currentBinding(env.members[key]!.id)!;

    it("two items in a row give two shifts; the second thread holds only the kickoff brief and the second item", async () => {
      const env = await withHost({ yaml: perItem() });
      const spawns = env.port.countCalls("spawn");
      await create(env, "first review", "dev-review");
      const first = bound(env, "dev-review");
      expect([first.shift, env.port.countCalls("spawn")]).toEqual([2, spawns + 1]);
      expect(env.port.threads.get(env.threads["dev-review"]!)!.archived).toBe(true);
      const item = env.service.queue.list(env.crew, { owner: "dev-review" })[0]!;
      env.service.queue.claim(env.crew, { kind: "human" }, item.id, "dev-review");
      await env.service.queue.done(env.crew, { kind: "human" }, item.id, "ok");
      await create(env, "second review", "dev-review");
      const second = bound(env, "dev-review");
      expect([second.shift, env.port.countCalls("spawn")]).toEqual([3, spawns + 2]);
      const thread = env.port.threads.get(second.threadId)!;
      expect(thread.request!.prompt).toContain("Kickoff brief for dev-review@trio");
      expect(thread.request!.prompt).toContain("second review");
      expect(thread.request!.prompt).not.toContain("first review");
      expect(thread.inbox).toEqual([]);
      expect(env.port.threads.get(first.threadId)!.archived).toBe(true);
    });

    it("a handoff to a per-item member starts a new shift too", async () => {
      const env = await withHost({ yaml: perItem() });
      const item = env.service.queue.create(env.crew, { kind: "human" }, { title: "look at this", owner: "dev-impl" });
      await env.harness.behavior.callAgentTool("crew_work_handoff", { id: item.id, to: "dev-review", note: "please" }, { threadId: env.threads["orch-lead"]! });
      const binding = bound(env, "dev-review");
      expect(binding.shift).toBe(2);
      expect(env.port.threads.get(binding.threadId)!.request!.prompt).toContain("look at this");
    });

    it("a persistent member keeps one shift for two items", async () => {
      const env = await withHost({ yaml: perItem() });
      const spawns = env.port.countCalls("spawn");
      await create(env, "build a", "dev-impl");
      await create(env, "build b", "dev-impl");
      expect(bound(env, "dev-impl")).toMatchObject({ shift: 1, threadId: env.threads["dev-impl"] });
      expect(env.port.countCalls("spawn")).toBe(spawns);
    });

    it("negative: an assignment while the member holds a claimed, open item resets nothing; the notice goes to the running thread", async () => {
      const env = await withHost({ yaml: perItem() });
      await create(env, "first review", "dev-review");
      const first = bound(env, "dev-review");
      env.port.threads.get(first.threadId)!.status = "idle";
      const item = env.service.queue.list(env.crew, { owner: "dev-review" })[0]!;
      env.service.queue.claim(env.crew, { kind: "human" }, item.id, "dev-review");
      const spawns = env.port.countCalls("spawn");
      await create(env, "second review", "dev-review");
      expect(bound(env, "dev-review")).toMatchObject({ shift: 2, threadId: first.threadId });
      expect(env.port.countCalls("spawn")).toBe(spawns);
      expect(env.port.threads.get(first.threadId)!.inbox.at(-1)!.text).toContain("second review");
    });
  });

  it("crew_work_create's description says the owner is notified, so no crew_send is needed (BBP-259)", async () => {
    const { harness, threads, meta } = await withHost();
    const config = await harness.behavior.resolveAgentConfiguration(context(threads["dev-impl"]!, meta("dev-impl")));
    const tool = config.tools.find((entry) => entry.name === "crew_work_create")!;
    expect(tool.description).toContain("Notifies the owner; no separate crew_send needed.");
  });

  it("negative: a thread that is not a member gets an error from every tool, whatever its metadata says", async () => {
    const env = await withHost();
    for (const name of TOOL_NAMES) {
      const args = name === "crew_send" ? { to: "dev-impl", body: "x" } : name === "crew_broadcast" ? { body: "x" } : {};
      const result = await env.harness.behavior.callAgentTool(name, args, { threadId: "th_stranger" });
      expect(isError(result)).toBe(true);
    }
    expect(env.store.listMessages()).toEqual([]);
  });
});

describe("lead-only tools (§4.5)", () => {
  it("configure gives the lead crew_add_member, crew_remove_member, crew_reset, crew_status; negative: a member does not get them at all", async () => {
    const { harness, threads, meta } = await withHost();
    const lead = (await harness.behavior.resolveAgentConfiguration(context(threads["orch-lead"]!, meta("orch-lead")))).tools.map((tool) => tool.name);
    for (const name of LEAD_ADMIN_TOOL_NAMES) expect(lead).toContain(name);
    const member = (await harness.behavior.resolveAgentConfiguration(context(threads["dev-impl"]!, meta("dev-impl")))).tools.map((tool) => tool.name);
    for (const name of LEAD_ADMIN_TOOL_NAMES) expect(member).not.toContain(name);
    expect(member).toContain("crew_handover_note");
  });

  it("negative: called anyway from a member thread (a live session keeps an old tool set), every one is refused", async () => {
    const env = await withHost({ confirm: async () => true });
    const calls: [string, Record<string, unknown>][] = [
      ["crew_add_member", { group: "dev", id: "x" }],
      ["crew_remove_member", { member: "dev-review" }],
      ["crew_reset", { member: "dev-review" }],
      ["crew_status", {}],
    ];
    for (const [name, args] of calls) {
      const result = await env.harness.behavior.callAgentTool(name, args, { threadId: env.threads["dev-impl"]! });
      expect(isError(result)).toBe(true);
      expect(text(result)).toContain("Only the lead");
    }
    expect(env.store.listMembers(env.crew.id)).toHaveLength(3);
    expect(env.port.countCalls("clearContext")).toBe(0);
  });

  it("the lead adds a member (applied at once) and reads the status", async () => {
    const env = await withHost();
    const added = await env.harness.behavior.callAgentTool("crew_add_member", { group: "dev", id: "docs", role: "Docs." }, { threadId: env.threads["orch-lead"]! });
    expect(isError(added)).toBe(false);
    expect(text(added)).toContain("spawned dev-docs@trio");
    const status = text(await env.harness.behavior.callAgentTool("crew_status", {}, { threadId: env.threads["orch-lead"]! }));
    expect(status).toContain("- dev-docs shift 1");
    expect(status).toContain("- orch-lead (lead) shift 1");
  });

  it("a model the lead passes is ignored: the new member takes its group's, and a doubled prefix is dropped (BBP-248)", async () => {
    const env = await withHost();
    const added = await env.harness.behavior.callAgentTool("crew_add_member", { group: "dev", id: "dev-docs", provider: "codex", model: "gpt-x" }, { threadId: env.threads["orch-lead"]! });
    expect(isError(added)).toBe(false);
    expect(text(added)).toContain("spawned dev-docs@trio");
    const yaml = env.store.crewFile(env.crew.id)!.yaml;
    expect(yaml).not.toContain("dev-dev-docs");
    expect(yaml).not.toContain("gpt-x");
    expect(yaml).not.toContain("codex");
    expect(env.store.listMembers(env.crew.id).find((member) => member.key === "dev-docs")).toBeDefined();
  });

  it("removing a member asks the human: confirmed → archived; declined → nothing changes", async () => {
    const asked: string[] = [];
    let answer = false;
    const env = await withHost({ confirm: async (_threadId, request) => (asked.push(request.kind), answer) });
    const declined = await env.harness.behavior.callAgentTool("crew_remove_member", { member: "dev-review" }, { threadId: env.threads["orch-lead"]! });
    expect(isError(declined)).toBe(true);
    expect(env.store.listMembers(env.crew.id)).toHaveLength(3);
    answer = true;
    const removed = await env.harness.behavior.callAgentTool("crew_remove_member", { member: "dev-review" }, { threadId: env.threads["orch-lead"]! });
    expect(text(removed)).toContain("removed dev-review@trio");
    expect(asked).toEqual(["remove-member", "remove-member"]);
  });

  it("full permissions ask the human; without a confirmation channel the tool refuses", async () => {
    const env = await withHost();
    const refused = await env.harness.behavior.callAgentTool("crew_add_member", { group: "dev", id: "root", permissions: "full" }, { threadId: env.threads["orch-lead"]! });
    expect(isError(refused)).toBe(true);
    expect(env.store.listMembers(env.crew.id)).toHaveLength(3);
  });

  it("crew_reset clears another member's context; negative: not the lead itself", async () => {
    const env = await withHost();
    const reset = await env.harness.behavior.callAgentTool("crew_reset", { member: "dev-impl", mode: "clear" }, { threadId: env.threads["orch-lead"]! });
    expect(text(reset)).toContain("shift 2");
    const self = await env.harness.behavior.callAgentTool("crew_reset", { member: "orch-lead" }, { threadId: env.threads["orch-lead"]! });
    expect(isError(self)).toBe(true);
  });

  it("crew_handover_note notes the brief of the calling member", async () => {
    const env = await withHost();
    const result = await env.harness.behavior.callAgentTool("crew_handover_note", { brief: "State: done." }, { threadId: env.threads["dev-impl"]! });
    expect(text(result)).toContain("noted (shift 1 → 2)");
    expect(env.store.activeHandover(env.members["dev-impl"]!.id)).toMatchObject({ state: "noted", brief: "State: done." });
  });
});

describe("crew_graph_run (BBP-30)", () => {
  const graphYaml = () =>
    trioYaml({
      groups: [
        { id: "orch", members: [{ id: "lead", lead: true, role: "Plans." }] },
        {
          id: "dev",
          members: [
            { id: "impl", role: "Builds.", graphs: ["release"] },
            { id: "review", permissions: "ask", role: "Reviews." },
          ],
        },
      ],
      links: [
        { from: "orch-lead", to: "dev-impl", kind: "assigns_to" },
        { from: "orch-lead", to: "dev-review", kind: "assigns_to" },
      ],
    });

  describe("tool gating", () => {
    it("positive: a member with graphs gets the tool", () => {
      const names = toolsFor({ lead: false, config: { graphs: ["release"] } }, { crossCrew: "leads" });
      expect(names).toContain(GRAPH_TOOL_NAME);
    });
    it("negative: a member without graphs does not", () => {
      const names = toolsFor({ lead: false, config: {} }, { crossCrew: "leads" });
      expect(names).not.toContain(GRAPH_TOOL_NAME);
    });
    it("negative: an empty graphs list does not either", () => {
      const names = toolsFor({ lead: false, config: { graphs: [] } }, { crossCrew: "leads" });
      expect(names).not.toContain(GRAPH_TOOL_NAME);
    });
  });

  it("end to end: dev-impl has the tool, dev-review does not", async () => {
    const env = await withHost({ yaml: graphYaml(), graphsRpc: fakeGraphsRpc(mkRun({ id: "run_1", status: "done" })) });
    const member = await env.harness.behavior.resolveAgentConfiguration(context(env.threads["dev-impl"]!, env.meta("dev-impl")));
    expect(member.tools.map((tool) => tool.name)).toContain(GRAPH_TOOL_NAME);
    const reviewer = await env.harness.behavior.resolveAgentConfiguration(context(env.threads["dev-review"]!, env.meta("dev-review")));
    expect(reviewer.tools.map((tool) => tool.name)).not.toContain(GRAPH_TOOL_NAME);
  });

  it("negative: a graph not in the member's list is refused without calling the RPC", async () => {
    let called = false;
    const rpc: GraphsRpc = {
      listGraphs: async () => [],
      startRun: async () => {
        called = true;
        throw new Error("should not run");
      },
      getRun: async () => null,
      stopRun: async () => null,
    };
    const env = await withHost({ yaml: graphYaml(), graphsRpc: rpc });
    const result = await env.harness.behavior.callAgentTool("crew_graph_run", { graph: "not-listed", input: "go" }, { threadId: env.threads["dev-impl"]! });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("not one of this member's allowed graphs");
    expect(called).toBe(false);
  });

  it("positive: a successful run returns its result, with the member context and the calling thread in the input/call", async () => {
    let seenInput = "";
    let seenThreadId = "";
    const rpc: GraphsRpc = {
      listGraphs: async () => [{ id: "release", name: "Release" }],
      startRun: async (args) => {
        if (!args.threadId) throw new Error("A run needs a parent thread whose environment the workers inherit.");
        seenInput = args.input;
        seenThreadId = args.threadId;
        return mkRun({ id: "run_1", status: "done", state: { collected: ["ok"] } });
      },
      getRun: async (id) => mkRun({ id, status: "done", state: { collected: ["ok"] } }),
      stopRun: async (id) => mkRun({ id, status: "stopped" }),
    };
    const env = await withHost({ yaml: graphYaml(), graphsRpc: rpc });
    const result = await env.harness.behavior.callAgentTool("crew_graph_run", { graph: "release", input: "ship it" }, { threadId: env.threads["dev-impl"]! });
    expect(isError(result)).toBe(false);
    expect(text(result)).toContain("run_1");
    expect(text(result)).toContain("collected");
    expect(seenInput).toContain("Crew: trio");
    expect(seenInput).toContain("Member: dev-impl");
    expect(seenInput).toContain("ship it");
    expect(seenThreadId).toBe(env.threads["dev-impl"]);
  });

  it("negative: a failed run is a tool error with the run's error", async () => {
    const env = await withHost({
      yaml: graphYaml(),
      graphsRpc: fakeGraphsRpc(mkRun({ id: "run_1", status: "failed", error: "node crashed" })),
    });
    const result = await env.harness.behavior.callAgentTool("crew_graph_run", { graph: "release", input: "go" }, { threadId: env.threads["dev-impl"]! });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("run_1");
    expect(text(result)).toContain("node crashed");
  });

  it("negative: a vanished run (getRun null mid-poll) is a tool error, not a false 'done'", async () => {
    const rpc: GraphsRpc = {
      listGraphs: async () => [{ id: "release", name: "Release" }],
      startRun: async (args) => {
        if (!args.threadId) throw new Error("A run needs a parent thread whose environment the workers inherit.");
        return mkRun({ id: "run_1", status: "running" });
      },
      getRun: async () => null,
      stopRun: async () => null,
    };
    const env = await withHost({ yaml: graphYaml(), graphsRpc: rpc });
    const result = await env.harness.behavior.callAgentTool("crew_graph_run", { graph: "release", input: "go" }, { threadId: env.threads["dev-impl"]! });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("run_1");
    expect(text(result)).toMatch(/vanished/);
  });
});


it("crew_work_create accepts waits_for and rejects a missing prerequisite", async () => {
  const e = await withHost();
  const prerequisite = e.service.queue.create(e.crew, { kind: "human" }, { title: "Prerequisite" });
  const call = (waits_for: string[]) => e.harness.behavior.callAgentTool("crew_work_create", { title: "Dependent", waits_for }, { threadId: e.threads["orch-lead"]! });
  const created = await call([prerequisite.id]);
  expect(isError(created)).toBe(false);
  expect(text(created)).toContain(`blocked by ${prerequisite.id}`);
  const bad = await call(["wi_missing"]);
  expect(isError(bad)).toBe(true);
  expect(text(bad)).toContain("same crew");
});

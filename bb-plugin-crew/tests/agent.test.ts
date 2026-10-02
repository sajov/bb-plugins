import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import { agentInstructions, configureFor, identifyMember, LEAD_ADMIN_TOOL_NAMES, registerAgentTools, TOOL_NAMES, WORK_TOOL_NAMES, type Confirm } from "../lib/agent";
import { INSTRUCTION_LIMIT } from "../lib/spec";
import { duoYaml, PROJECT, running, setup, trioYaml } from "./helpers";

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

async function withHost(options: { confirm?: Confirm } = {}) {
  const env = setup();
  const crew = await running(env.service, env.port);
  const { bb, harness } = createFakePluginHost({ pluginId: "crew", agentSkillIds: ["crew"] });
  registerAgentTools(bb, env.service, options);
  const meta = (key: string) => ({ ...env.port.threads.get(crew.threads[key]!)!.metadata });
  return { ...env, ...crew, harness, meta };
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

  it("member skills become a 'Prefer these skills' hint; no skills means no hint", async () => {
    const { service, port } = setup();
    const { crew, members } = await running(service, port, trioYaml({ skills: ["memory"] }));
    expect(agentInstructions(service, crew, members["dev-impl"]!)).toContain("Prefer these skills: memory");
    const { service: service2, port: port2 } = setup();
    const { crew: crew2, members: members2 } = await running(service2, port2);
    expect(agentInstructions(service2, crew2, members2["dev-impl"]!)).not.toContain("Prefer these skills");
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

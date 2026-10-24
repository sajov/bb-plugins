import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse, makeTurnFailedEvent } from "@get-bb/plugin-sdk/testing";
import { createCrewService } from "../lib/service";
import { createStore } from "../lib/store";
import plugin from "../server";
import { duoYaml, PROJECT, running, setup } from "./helpers";

const failure = (threadId: string, requestId = "req_quota") => makeTurnFailedEvent({
  threadId, requestId, turnId: "turn_quota", attemptNumber: 1,
  errorInfo: { category: "rate-limit", providerCode: "1308", httpStatusCode: 429 },
});
async function team() {
  const env = setup();
  const crew = await running(env.service, env.port, duoYaml());
  return { ...env, ...crew, event: failure(crew.threads["core-dev"]!) };
}
const notices = (t: Awaited<ReturnType<typeof team>>) => t.store.listMessages({ crewId: t.crew.id }).filter((row) => row.subject.startsWith("Member turn failed:"));

// These exercise the real service/delivery/store; only BB's thread port is faked.
describe("failed member turn notices", () => {
  it("wakes the idle leader with member, thread, error code and only this member's claimed work", async () => {
    const t = await team();
    const claimed = t.service.queue.create(t.crew, { kind: "human" }, { title: "Resume checkout", owner: "core-dev" });
    t.service.queue.claim(t.crew, { kind: "human" }, claimed.id, "core-dev");
    const other = t.store.insertWork({ id: "wi_other", crewId: t.crew.id, title: "Leader work", body: "", ownerMember: t.members["core-lead"]!.id, createdBy: "human", tier: "p2", dueAt: null, taskKey: null });
    t.store.transitionWork(other.id, { state: "claimed" }, "human", null);
    const open = t.service.queue.create(t.crew, { kind: "human" }, { title: "Not claimed yet", owner: "core-dev" });
    await t.service.turnFailed(t.event);
    const rows = notices(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fromAddress: "system", toAddress: "core-lead@duo", kind: "message", status: "delivered", deliveryMode: "start" });
    expect(rows[0]!.body).toContain("core-dev@duo");
    expect(rows[0]!.body).toContain(t.event.threadId);
    expect(rows[0]!.body).toContain("rate-limit");
    expect(rows[0]!.body).toContain("1308");
    expect(rows[0]!.body).toContain("429");
    expect(rows[0]!.body).toContain(claimed.id);
    expect(rows[0]!.body).not.toContain(open.id);
    expect(rows[0]!.body).not.toContain(other.id);
    expect(rows[0]!.body).toContain("Retry status is unknown");
    expect(t.port.calls.some((call) => call.method === "send" && (call.args as { threadId: string; mode: string }).threadId === t.threads["core-lead"] && (call.args as { mode: string }).mode === "start")).toBe(true);
  });

  it("deduplicates concurrent/replayed events durably, including after service reconstruction", async () => {
    const t = await team();
    await Promise.all([t.service.turnFailed(t.event), t.service.turnFailed(t.event)]);
    const restarted = createCrewService({ store: t.store, port: t.port, git: t.git });
    await restarted.turnFailed(t.event);
    expect(notices(t)).toHaveLength(1);
    expect(t.store.listChannel(t.crew.id, { topic: "notify" })).toHaveLength(1);
    // A subsequent failed retry has a different request id even if the provider reused its turn id.
    await restarted.turnFailed({ ...t.event, requestId: "req_retry", attemptNumber: 2 });
    expect(notices(t)).toHaveLength(2);
  });

  it("missing error classification and no provider turn are explicit, not invented", async () => {
    const t = await team();
    await t.service.turnFailed({ ...t.event, errorInfo: null, turnId: null });
    expect(notices(t)[0]!.body).toContain("Failure reason/code: unknown");
    expect(notices(t)[0]!.body).toContain("turn: not created");
    expect(notices(t)[0]!.body).toContain("Claimed work items: none");
  });

  it("a crew without a leader records one channel notice and sends nothing", async () => {
    const t = await team();
    t.store.markMemberRemoved(t.members["core-lead"]!.id);
    await expect(t.service.turnFailed(t.event)).resolves.toBeUndefined();
    await t.service.turnFailed(t.event);
    expect(notices(t)).toEqual([]);
    expect(t.store.listChannel(t.crew.id, { topic: "notify" })).toHaveLength(1);
    expect(t.store.listChannel(t.crew.id)[0]!.body).toContain("No crew lead exists");
  });

  it("an enqueue failure is recorded and contained without duplicate attempts", async () => {
    const t = await team();
    t.service.delivery.send = () => { throw new Error("outbox unavailable"); };
    await expect(t.service.turnFailed(t.event)).resolves.toBeUndefined();
    await t.service.turnFailed(t.event);
    expect(notices(t)).toHaveLength(0);
    expect(t.store.listChannel(t.crew.id, { topic: "notify" })).toHaveLength(1);
    expect(t.store.listChannel(t.crew.id)[0]!.body).toContain("outbox unavailable");
  });

  it("a failed delivery attempt stays in the normal queue and is also visible in the channel", async () => {
    const t = await team();
    t.port.sendFailures.push(new Error("leader delivery failed"));
    await expect(t.service.turnFailed(t.event)).resolves.toBeUndefined();
    expect(notices(t)).toHaveLength(1);
    expect(notices(t)[0]!.lastError).toContain("leader delivery failed");
    expect(t.store.listChannel(t.crew.id, { topic: "notify" }).some((row) => row.body.includes("Could not deliver member failure notice") && row.body.includes("leader delivery failed"))).toBe(true);
  });

  it("the leader, unrelated threads and retired bindings produce no member failure notice", async () => {
    const t = await team();
    await t.service.turnFailed(failure(t.threads["core-lead"]!));
    await t.service.turnFailed(failure("foreign_thread"));
    t.store.retireBinding(t.members["core-dev"]!.id);
    await t.service.turnFailed(t.event);
    expect(notices(t)).toEqual([]);
    expect(t.store.listChannel(t.crew.id)).toEqual([]);
  });
});

async function wired() {
  const host = createFakePluginHost({ pluginId: "crew" });
  await plugin(host.bb);
  const store = createStore(host.bb.storage.database());
  const { crew } = store.saveCrewFile(PROJECT, "duo", duoYaml());
  store.setCrewStatus(crew.id, "running");
  for (const [id, lead] of [["lead", true], ["dev", false]] as const) {
    const member = store.upsertMember(crew.id, { groupId: "core", memberId: id, address: `core-${id}@duo`, lead, config: {} });
    store.bind(member.id, `thread_${id}`, 1);
  }
  host.harness.sdk.stub("threads.get", async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: PROJECT, status: "idle" }));
  host.harness.sdk.stub("threads.queuedMessages.list", async () => []);
  host.harness.sdk.stub("threads.interactions.list", async () => []);
  host.harness.sdk.stub("threads.listRunning", async () => []);
  host.harness.sdk.stub("threads.send", async () => ({ delivery: "sent" }));
  return { ...host, store, crew };
}

describe("native turn failure listener", () => {
  it("thread.failed plus two turn.failed events produce one waking message, not two", async () => {
    const t = await wired();
    try {
      const failed = makeThreadResponse({ id: "thread_dev", projectId: PROJECT, status: "error" });
      expect((await t.harness.behavior.emitThreadEvent("thread.failed", { thread: failed, error: "quota 1308" })).errors).toEqual([]);
      const event = failure("thread_dev");
      expect((await t.harness.behavior.emitThreadEvent("turn.failed", event)).errors).toEqual([]);
      expect((await t.harness.behavior.emitThreadEvent("turn.failed", event)).errors).toEqual([]);
      const rows = t.store.listMessages({ crewId: t.crew.id }).filter((row) => row.subject.startsWith("Member turn failed:"));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ deliveryMode: "start", status: "delivered" });
      expect(t.harness.sdk.callsTo("threads.send")).toHaveLength(1);
    } finally { await t.harness.lifecycle.dispose(); }
  });

  it("a completed member turn or the leader's failed turn sends no notice", async () => {
    const t = await wired();
    try {
      const idle = makeThreadResponse({ id: "thread_dev", projectId: PROJECT, status: "idle" });
      expect((await t.harness.behavior.emitThreadEvent("thread.idle", { thread: idle, lastAssistantText: "Done." })).errors).toEqual([]);
      expect((await t.harness.behavior.emitThreadEvent("turn.failed", failure("thread_lead"))).errors).toEqual([]);
      expect(t.store.listMessages({ crewId: t.crew.id })).toEqual([]);
      expect(t.harness.sdk.callsTo("threads.send")).toEqual([]);
    } finally { await t.harness.lifecycle.dispose(); }
  });
});

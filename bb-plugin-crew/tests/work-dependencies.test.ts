import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../lib/cli";
import { createCrewService } from "../lib/service";
import { createStore, MIGRATIONS, migrateInPlace } from "../lib/store";
import { createWorkDependencies } from "../lib/work-dependencies";
import { duoYaml, PROJECT, running, setup } from "./helpers";

const human = { kind: "human" as const };
const project = async () => PROJECT;
async function fixture() {
  const env = setup();
  const team = await running(env.service, env.port);
  const q = env.service.queue;
  const a = q.create(team.crew, human, { title: "First prerequisite" });
  const b = q.create(team.crew, human, { title: "Second prerequisite" });
  const target = q.create(team.crew, human, { title: "Release", owner: "dev-impl", waitsFor: [a.id, b.id] });
  const notices = () => env.store.listMessages({}).filter((row) => row.subject.startsWith("Work dependencies "));
  return { ...env, ...team, q, a, b, target, notices };
}

describe("work item dependencies", () => {
  it("create is blocked, claim remains possible with an explicit warning", async () => {
    const e = await fixture();
    expect(e.target.blockedBy).toEqual([e.a.id, e.b.id].sort());
    const claimed = await runCli(e.service, ["work", "claim", e.target.id, "--as", "dev-impl"], { projectId: PROJECT }, project);
    expect(claimed.exitCode).toBe(0);
    expect(claimed.stdout).toContain("Warning: blocked by");
    expect(e.store.listTransitions(e.target.id).at(-1)?.note).toContain("Claimed while blocked by");
  });

  it("one done is insufficient; all done queues once to the owner, including after a service restart", async () => {
    const e = await fixture();
    await e.q.done(e.crew, human, e.a.id, "ready");
    expect(e.notices()).toHaveLength(0);
    expect(e.q.list(e.crew).find((row) => row.id === e.target.id)?.blockedBy).toEqual([e.b.id]);
    await e.q.done(e.crew, human, e.b.id, "ready");
    expect(e.notices()).toHaveLength(1);
    expect(e.notices()[0]).toMatchObject({ toMember: e.members["dev-impl"]!.id });
    for (const text of [e.target.id, "Release", e.a.id, "First prerequisite", e.b.id, "Second prerequisite"]) expect(e.notices()[0]!.body).toContain(text);
    // Recreate both store and service over the persisted database, without in-memory dedupe state.
    const restarted = createCrewService({ store: createStore(e.db), port: e.port, git: e.git, tasks: e.tasks, bbLimit: async () => null });
    await restarted.pollDependencies();
    await restarted.pollDependencies();
    expect(e.notices()).toHaveLength(1);
    expect(restarted.queue.list(e.crew).find((row) => row.id === e.target.id)?.blockedBy).toEqual([]);
  });

  it("a failed prerequisite tells only the lead once and stays blocked", async () => {
    const e = await fixture();
    await e.q.fail(e.crew, human, e.a.id, "provider unavailable");
    expect(e.notices()).toHaveLength(1);
    expect(e.notices()[0]).toMatchObject({ toMember: e.members["orch-lead"]!.id });
    expect(e.notices()[0]!.body).toContain("remains blocked");
    await e.service.pollDependencies();
    expect(e.notices()).toHaveLength(1);
    expect(e.q.list(e.crew).find((row) => row.id === e.target.id)?.blockedBy).toContain(e.a.id);
  });

  it("unowned work notifies the lead when ready", async () => {
    const e = await fixture();
    const unowned = e.q.create(e.crew, human, { title: "Unowned", waitsFor: [e.a.id] });
    await e.q.done(e.crew, human, e.a.id, "ready");
    expect(e.notices()).toHaveLength(1);
    expect(e.notices()[0]).toMatchObject({ toMember: e.members["orch-lead"]!.id });
    expect(e.notices()[0]!.body).toContain(unowned.id);
  });

  it("rejects self-dependencies and indirect cycles without changing the declaration", async () => {
    const e = await fixture();
    expect(() => e.q.wait(e.crew, human, e.a.id, [e.a.id])).toThrow(/self-dependency/);
    expect(() => e.q.wait(e.crew, human, e.a.id, [e.target.id])).toThrow(/cycle/);
    e.q.wait(e.crew, human, e.b.id, [e.a.id]);
    expect(() => e.q.wait(e.crew, human, e.a.id, [e.b.id])).toThrow(/cycle/);
    expect(e.q.list(e.crew).find((row) => row.id === e.a.id)?.waitsFor).toEqual([]);
  });

  it("rejects missing and other-crew dependencies, rolling back create", async () => {
    const e = await fixture();
    const other = await running(e.service, e.port, duoYaml());
    const foreign = e.q.create(other.crew, human, { title: "Foreign" });
    const before = e.store.listWork().length;
    for (const id of [foreign.id, "wi_missing"]) expect(() => e.q.create(e.crew, human, { title: "Invalid", waitsFor: [id] })).toThrow(/same crew/);
    expect(e.store.listWork()).toHaveLength(before);
  });

  it("existing-item updates and clearing are audited, only the human or own lead can declare", async () => {
    const e = await fixture();
    const member = { kind: "member" as const, member: e.members["dev-impl"]! };
    expect(() => e.q.wait(e.crew, member, e.target.id, [])).toThrow(/human or crew lead/);
    const actor = { kind: "member" as const, member: e.members["orch-lead"]! };
    e.q.wait(e.crew, actor, e.target.id, [e.a.id]);
    expect(e.store.listChannel(e.crew.id, { topic: "work" }).at(-1)).toMatchObject({ author: actor.member.address, body: expect.stringContaining(`${e.target.id} waits for: ${e.a.id}`) });
    e.q.wait(e.crew, human, e.target.id, []);
    expect(e.q.list(e.crew).find((row) => row.id === e.target.id)?.blockedBy).toEqual([]);
    expect(e.store.listChannel(e.crew.id, { topic: "work" }).at(-1)?.body).toContain("human declared");
    expect(e.store.listChannel(e.crew.id, { topic: "work" }).at(-1)?.body).toContain("cleared");
  });

  it("CLI create, list text/json and audited wait expose the dependency state", async () => {
    const e = await fixture();
    const run = (args: string[], threadId?: string) => runCli(e.service, ["work", ...args], { projectId: PROJECT, threadId }, project);
    const created = await run(["create", "CLI release", "--waits-for", `${e.a.id},${e.b.id}`]);
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain(`blocked by ${[e.a.id, e.b.id].sort().join(", ")}`);
    expect((await run(["list"])).stdout).toContain("blocked by");
    const listed = JSON.parse((await run(["list", "--json"])).stdout!) as { id: string; blockedBy: string[]; waitsFor: string[] }[];
    expect(listed.find((row) => row.id === e.target.id)).toMatchObject({ blockedBy: [e.a.id, e.b.id].sort(), waitsFor: [e.a.id, e.b.id].sort() });
    expect((await run(["wait", e.target.id, "--on", e.a.id], e.threads["dev-impl"])).exitCode).toBe(1);
    expect((await run(["wait", e.target.id, "--on", e.a.id], e.threads["orch-lead"])).exitCode).toBe(0);
    expect(e.store.listChannel(e.crew.id, { topic: "work" }).at(-1)?.author).toBe("orch-lead@trio");
    expect((await run(["wait", e.target.id, "--clear"])).exitCode).toBe(0);
    expect((await run(["wait", e.target.id, "--on", e.a.id, "--clear"])).exitCode).toBe(1);
    expect((await run(["wait", e.target.id])).exitCode).toBe(1);
  });

  it("a queue failure rolls back the notice and marker, then retries on the next poll", async () => {
    const e = await fixture();
    const delivery = e.service.delivery;
    const reporter = createWorkDependencies(e.store, delivery);
    e.store.transitionWork(e.a.id, { state: "done" }, "human", null);
    e.store.transitionWork(e.b.id, { state: "done" }, "human", null);
    const original = delivery.send.bind(delivery);
    const send = vi.spyOn(delivery, "send").mockImplementation((input) => { original(input); throw new Error("queue unavailable"); });
    expect(reporter.poll(e.crew)).toBe(0);
    expect(e.notices()).toHaveLength(0);
    expect(e.store.getWorkDependency(e.target.id)).toMatchObject({ satisfied: false, detail: "queue unavailable" });
    expect(e.store.listChannel(e.crew.id, { topic: "notify" }).at(-1)?.body).toContain("next dependency poll will retry");
    send.mockRestore();
    expect(reporter.poll(e.crew)).toBe(1);
    expect(e.notices()).toHaveLength(1);
  });

  it("an identical declaration does not announce readiness again", async () => {
    const e = await fixture();
    await e.q.done(e.crew, human, e.a.id, "ready");
    await e.q.done(e.crew, human, e.b.id, "ready");
    e.q.wait(e.crew, human, e.target.id, [e.b.id, e.a.id, e.a.id]);
    expect(e.notices()).toHaveLength(1);
  });
});


it("a crew without a lead keeps a visible retry obligation and notifies after recovery", async () => {
  const e = await fixture();
  e.q.wait(e.crew, human, e.target.id, []);
  const waiting = e.q.create(e.crew, human, { title: "Waiting for lead", waitsFor: [e.a.id] });
  e.db.prepare("UPDATE members SET lead = 0 WHERE crew_id = ?").run(e.crew.id);
  await e.q.done(e.crew, human, e.a.id, "ready");
  expect(e.notices()).toHaveLength(0);
  expect(e.q.list(e.crew).find((item) => item.id === waiting.id)?.dependencyDetail).toContain("No recipient");
  expect(e.store.getWorkDependency(waiting.id)?.satisfied).toBe(false);
  e.db.prepare("UPDATE members SET lead = 1 WHERE id = ?").run(e.members["orch-lead"]!.id);
  await e.service.pollDependencies();
  expect(e.notices()).toHaveLength(1);
  expect(e.store.getWorkDependency(waiting.id)).toMatchObject({ satisfied: true, detail: null });
});

it("a different crew's lead cannot declare dependencies, and deleting a crew cleans its declarations only", async () => {
  const e = await fixture();
  const other = await running(e.service, e.port, duoYaml());
  const foreignLead = Object.values(other.members).find((member) => member.lead)!;
  expect(() => e.q.wait(e.crew, { kind: "member", member: foreignLead }, e.target.id, [])).toThrow(/human or crew lead/);
  const a = e.q.create(other.crew, human, { title: "Other prerequisite" });
  const b = e.q.create(other.crew, human, { title: "Other dependent", waitsFor: [a.id] });
  e.store.deleteCrewRows(e.crew.id);
  expect(e.store.getWorkDependency(e.target.id)).toBeNull();
  expect(e.store.getWorkDependency(b.id)?.dependsOn).toEqual([a.id]);
});


it("closed items retain their declaration without showing blocked by", async () => {
  const e = await fixture();
  await e.q.done(e.crew, human, e.target.id, "closed");
  const failed = e.q.create(e.crew, human, { title: "Abandoned", waitsFor: [e.a.id] });
  e.q.fail(e.crew, human, failed.id, "cancelled");
  const rows = e.q.list(e.crew, { all: true });
  for (const id of [e.target.id, failed.id]) {
    expect(rows.find((row) => row.id === id)?.blockedBy).toEqual([]);
    expect(rows.find((row) => row.id === id)?.waitsFor).toContain(e.a.id);
  }
});

it("creation with already-done prerequisites is ready without a readiness notice", async () => {
  const e = await fixture();
  e.q.wait(e.crew, human, e.target.id, []);
  await e.q.done(e.crew, human, e.a.id, "ready");
  await e.q.done(e.crew, human, e.b.id, "ready");
  const ready = e.q.create(e.crew, human, { title: "Already ready", waitsFor: [e.a.id, e.b.id] });
  expect(ready.blockedBy).toEqual([]);
  await e.service.pollDependencies();
  expect(e.notices()).toHaveLength(0);
  expect(e.store.getWorkDependency(ready.id)?.satisfied).toBe(true);
});

it("restoring an item snapshot does not repeat its readiness notice", async () => {
  const e = await fixture();
  const snapshot = e.store.getWork(e.target.id)!;
  await e.q.done(e.crew, human, e.a.id, "ready");
  await e.q.done(e.crew, human, e.b.id, "ready");
  expect(e.notices()).toHaveLength(1);
  await e.q.done(e.crew, human, e.target.id, "closed");
  e.store.restoreWork(snapshot, "human");
  await e.service.pollDependencies();
  expect(e.notices()).toHaveLength(1);
});

it("upgrades the previous schema without changing existing work or migration order", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE _crew_migrations (idx INTEGER PRIMARY KEY)");
    MIGRATIONS.slice(0, -1).forEach((sql, index) => {
      db.exec(sql);
      db.prepare("INSERT INTO _crew_migrations VALUES (?)").run(index);
    });
    const store = createStore(db);
    const { crew } = store.saveCrewFile("p1", "legacy", "name: legacy\n");
    store.insertWork({ id: "wi_old", crewId: crew.id, title: "Existing work", body: "Preserved", ownerMember: null, createdBy: "human", tier: "p1", dueAt: null, taskKey: null });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'work_dependencies'").get()).toBeUndefined();
    migrateInPlace(db);
    migrateInPlace(db);
    expect(store.getWork("wi_old")).toMatchObject({ title: "Existing work", body: "Preserved", state: "open" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM _crew_migrations").get()).toEqual({ n: MIGRATIONS.length });
    store.saveWorkDependency({ itemId: "wi_old", dependsOn: [], satisfied: true, failedNotified: [], detail: null });
    expect(store.getWorkDependency("wi_old")?.satisfied).toBe(true);
  } finally {
    db.close();
  }
});

it("work list JSON refuses excess output instead of truncating it", async () => {
  const e = await fixture();
  for (let index = 0; index < 200; index++) e.q.create(e.crew, human, { title: "x".repeat(200) });
  const result = await runCli(e.service, ["work", "list", "--json"], { projectId: PROJECT }, project);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("narrow it");
  expect(result.stdout).toBeUndefined();
});

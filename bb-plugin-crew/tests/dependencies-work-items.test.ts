// `waitsFor: [{ task, until: "work-done" }]` — the explicit source of the native
// Crew queue: `task` is the exact id of a native work item (`wi_…`) of a crew of
// the same project. It goes through the same AND barrier and the same
// record/outbox transaction as every other source, and it never asks BB Tasks
// anything. Real store, real service, real delivery, real spec schema; the only
// fake parts are the ones the whole suite fakes (thread port, git, BB Tasks).
import Database from "better-sqlite3";
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createFakeTasks } from "../lib/dependencies";
import { createFakeGit } from "../lib/integration";
import { createCrewService } from "../lib/service";
import { hasErrors, validateCrew } from "../lib/spec";
import { createStore, migrateInPlace } from "../lib/store";
import { createFakeThreadPort } from "../lib/thread-port";
import { duoYaml, PROJECT, running } from "./helpers";

type Db = InstanceType<typeof Database>;

/** Holds the one file-backed database of the reopen case; removed when the file is done. */
const WORK = fileURLToPath(new URL("../.test-dependencies-work-items/", import.meta.url));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

const FOREIGN = "proj_2";

/** One "process": a service over `db`. A second world over the same file is a reopening. */
function world(options: { db?: Db; process?: string; epoch?: number; tasks?: boolean } = {}) {
  const db = options.db ?? new Database(":memory:");
  const process = options.process ?? "p1";
  migrateInPlace(db);
  let clock = options.epoch ?? Date.UTC(2026, 9, 20, 9, 0);
  let counter = 0;
  const store = createStore(db, () => ++clock);
  const port = createFakeThreadPort();
  const tasks = options.tasks === false ? null : createFakeTasks();
  const service = createCrewService({
    store,
    port,
    git: createFakeGit(),
    tasks,
    graphsRpc: null,
    bbLimit: async () => null,
    newId: () => `op_${process}_${++counter}`,
    newMessageId: (prefix) => `${prefix}_${process}_${++counter}`,
    newShortId: (prefix) => `${prefix}_${process}_${++counter}`,
    now: () => clock,
  });
  const human = { kind: "human" } as const;
  const crewNamed = (project: string, name: string) => store.findCrew(project, name)!;
  return {
    db,
    store,
    port,
    service,
    tasks,
    task: (key: string, status: string) => tasks!.tasks.set(key, { id: `t_${key}`, projectId: "tp", status, labelIds: [], comments: [] }),
    /** A native work item of a crew, left in `end`; the body and the closure note are the sensitive texts. */
    work: async (crew: string, title: string, end: "open" | "claimed" | "done" | "failed", extra: { body?: string; taskKey?: string; project?: string } = {}) => {
      const owner = crewNamed(extra.project ?? PROJECT, crew);
      const item = service.queue.create(owner, human, { title, body: extra.body, taskKey: extra.taskKey });
      if (end === "claimed") service.queue.claim(owner, human, item.id, "core-lead");
      if (end === "done") await service.queue.done(owner, human, item.id, `closure of ${title}`);
      if (end === "failed") service.queue.fail(owner, human, item.id, `reason of ${title}`);
      return item;
    },
    finish: async (crew: string, id: string, note = "closed") => void (await service.queue.done(crewNamed(PROJECT, crew), human, id, note)),
    /** The wake notices addressed to a crew, from the queue itself. */
    notices: (crew: string) =>
      store
        .listMessages({ projectId: PROJECT, limit: 1000 })
        .filter((message) => message.subject.startsWith("Dependency fulfilled") && message.toAddress.endsWith(`@${crew}`)),
    rows: (crew: string) => Object.fromEntries(store.listDependencies(store.findCrew(PROJECT, crew)!.id).map((row) => [`${row.taskKey} ${row.until}`, row])),
  };
}

const waiting = (name: string, task: string, waitsFor: { task: string; until: string }[]) => duoYaml({ name, task, waitsFor });
/** The problems this feature is about: schema refusals and the `waits-…` family. */
const codes = (yaml: string) => validateCrew(yaml).problems.map((problem) => problem.code).filter((code) => code === "schema" || code.startsWith("waits"));

/** The notice insert fails for this crew's lead, as a full disk or a crash between the two writes would. */
const failNoticesFor = (db: Db, crew: string) =>
  db.exec(
    `CREATE TEMP TRIGGER fail_notice_${crew} BEFORE INSERT ON messages
     WHEN NEW.subject LIKE 'Dependency fulfilled%' AND NEW.to_address = 'core-lead@${crew}'
     BEGIN SELECT RAISE(ABORT, 'injected: disk I/O error'); END`,
  );

describe("waitsFor until work-done: the native Crew queue as an explicit source", () => {
  it("schema: work-done is accepted, anything near it is still refused, and the task warning follows only the legacy sources", () => {
    const only = [{ task: "wi_ab12cd34", until: "work-done" }];
    const accepted = validateCrew(waiting("beta", "CRD-2", only));
    expect(hasErrors(accepted.problems)).toBe(false);
    expect(accepted.spec?.waitsFor).toEqual(only);

    // Unknown untils stay a schema error: the new value is added, the pattern is not loosened.
    for (const until of ["work-done:wi_ab12cd34", "work-finished", "workdone", "WORK-DONE", "work-done "]) {
      const refused = validateCrew(waiting("beta", "CRD-2", [{ task: "wi_ab12cd34", until }]));
      expect(refused.spec, until).toBeNull();
      expect(refused.problems.map((problem) => problem.code), until).toContain("schema");
    }

    // Nothing external is asked of the waiting crew's own task when every source is native ...
    expect(codes(duoYaml({ waitsFor: only }))).toEqual([]);
    // ... but a legacy source next to it still wants the label's task, and legacy-only files warn as before.
    expect(codes(duoYaml({ waitsFor: [...only, { task: "CRD-3", until: "done" }] }))).toEqual(["waits-without-task"]);
    expect(codes(duoYaml({ waitsFor: [...only, { task: "CRD-1", until: "merged" }] }))).toEqual(["waits-without-task"]);
    expect(codes(duoYaml({ waitsFor: [{ task: "CRD-3", until: "done" }] }))).toEqual(["waits-without-task"]);
  });

  it("AND: with two work items, one done and one open does not wake the lead; the last one wakes it once, with ids and milestone and none of the item's text", async () => {
    const w = world();
    await running(w.service, w.port, duoYaml({ name: "alpha" }));
    const first = await w.work("alpha", "first piece", "open", { body: "SECRET-BODY-1" });
    const second = await w.work("alpha", "second piece", "open", { body: "SECRET-BODY-2" });
    await running(w.service, w.port, waiting("beta", "CRD-2", [{ task: first.id, until: "work-done" }, { task: second.id, until: "work-done" }]));

    await w.finish("alpha", first.id, "SECRET-CLOSURE-1");
    expect(await w.service.pollDependencies()).toBe(1);
    expect(w.rows("beta")[`${first.id} work-done`]).toMatchObject({ state: "satisfied" });
    expect(w.rows("beta")[`${second.id} work-done`]).toMatchObject({ state: "open" });
    expect(w.notices("beta")).toHaveLength(0);
    expect(await w.service.pollDependencies()).toBe(0);
    expect(w.notices("beta")).toHaveLength(0);

    await w.finish("alpha", second.id, "SECRET-CLOSURE-2");
    expect(await w.service.pollDependencies()).toBe(1);
    const [notice, ...others] = w.notices("beta");
    expect(others).toEqual([]);
    expect(notice).toMatchObject({ kind: "message", fromAddress: "system", subject: `Dependency fulfilled: ${first.id} work-done, ${second.id} work-done` });
    for (const part of [first.id, second.id, "work-done", "alpha", "not an acceptance", "Re-read"]) expect(notice!.body, part).toContain(part);
    // Provenance and milestone only: nothing the item says travels in the notice, and the row proves no more than "done".
    expect(notice!.body).not.toMatch(/SECRET|first piece|second piece/);
    expect(w.rows("beta")[`${first.id} work-done`]!.detail).not.toMatch(/SECRET|first piece/);
    // A crew that waits for nothing never gets one.
    expect(w.notices("alpha")).toEqual([]);
  });

  it("exact id only: missing, foreign-project, open, claimed, failed, title and taskKey never satisfy; the exact id of a done item of another crew of the project does", async () => {
    const w = world();
    await running(w.service, w.port, duoYaml({ name: "alpha" }));
    await w.service.apply(FOREIGN, duoYaml({ name: "outside" }));
    const open = await w.work("alpha", "still open", "open");
    const claimed = await w.work("alpha", "being done", "claimed");
    const failed = await w.work("alpha", "gave up", "failed");
    const keyed = await w.work("alpha", "Ship the thing", "done", { taskKey: "CRD-7" });
    const foreign = await w.work("outside", "done elsewhere", "done", { project: FOREIGN });

    const unmet = [open.id, claimed.id, failed.id, "wi_missing", foreign.id, "CRD-7", "Ship the thing"];
    await running(w.service, w.port, waiting("beta", "CRD-2", unmet.map((task) => ({ task, until: "work-done" }))));
    await running(w.service, w.port, waiting("gamma", "CRD-5", [{ task: keyed.id, until: "work-done" }]));

    // gamma names the done item by its exact id and is told once; beta's conditions all look plausible and none holds.
    expect(await w.service.pollDependencies()).toBe(1);
    expect(w.notices("gamma")).toHaveLength(1);
    expect(w.rows("gamma")[`${keyed.id} work-done`]).toMatchObject({ state: "satisfied" });
    for (const task of unmet) expect(w.rows("beta")[`${task} work-done`], task).toMatchObject({ state: "open" });
    expect(w.notices("beta")).toHaveLength(0);

    // The two non-terminal items satisfy once they are done; the failed and the foreign one still do not.
    await w.finish("alpha", open.id);
    await w.finish("alpha", claimed.id);
    expect(await w.service.pollDependencies()).toBe(2);
    expect(w.rows("beta")[`${open.id} work-done`]).toMatchObject({ state: "satisfied" });
    expect(w.rows("beta")[`${claimed.id} work-done`]).toMatchObject({ state: "satisfied" });
    for (const task of [failed.id, "wi_missing", foreign.id, "CRD-7", "Ship the thing"]) expect(w.rows("beta")[`${task} work-done`], task).toMatchObject({ state: "open" });
    expect(w.notices("beta")).toHaveLength(0);
  });

  it("BB Tasks is not consulted for this source: a failing Tasks does not touch the native row, and an all-native crew produces no Tasks call at all", async () => {
    const w = world();
    const tasks = w.tasks!;
    await running(w.service, w.port, duoYaml({ name: "alpha" }));
    const piece = await w.work("alpha", "piece", "open");
    w.task("CRD-2", "in_progress");
    await running(w.service, w.port, waiting("beta", "CRD-2", [{ task: "CRD-3", until: "done" }, { task: piece.id, until: "work-done" }]));
    await running(w.service, w.port, waiting("gamma", "CRD-4", [{ task: piece.id, until: "work-done" }]));
    await w.finish("alpha", piece.id);

    // The legacy producer is down: every Tasks call throws.
    const real = tasks.getTask;
    tasks.getTask = async (key) => {
      tasks.calls.push(`getTask ${key}`);
      throw new Error("tasks plugin unavailable");
    };
    expect(await w.service.pollDependencies()).toBe(2);
    // The native rows are satisfied on their own; the legacy row stays open and nobody is told early.
    expect(w.rows("beta")[`${piece.id} work-done`]).toMatchObject({ state: "satisfied" });
    expect(w.rows("beta")["CRD-3 done"]).toMatchObject({ state: "open" });
    expect(w.notices("beta")).toHaveLength(0);
    expect(w.notices("gamma")).toHaveLength(1);
    // The legacy source really was asked (the check can fail) and the native one never was.
    expect(tasks.calls).toContain("getTask CRD-3");
    expect(tasks.calls.filter((call) => call.includes(piece.id) || call.includes("CRD-4"))).toEqual([]);

    // Tasks comes back: the legacy row completes the set, once.
    tasks.getTask = real;
    w.task("CRD-3", "done");
    expect(await w.service.pollDependencies()).toBe(1);
    expect(w.notices("beta")).toHaveLength(1);
    expect(w.notices("beta")[0]!.subject).toBe(`Dependency fulfilled: CRD-3 done, ${piece.id} work-done`);
    expect(tasks.calls.filter((call) => call.includes(piece.id))).toEqual([]);
  });

  it("rollback and replay: a failing notice insert leaves the native row open and explicit, and replays or a reopened database never add a second notice", async () => {
    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });
    const file = `${WORK}reopen.db`;

    const first = world({ db: new Database(file) });
    await running(first.service, first.port, duoYaml({ name: "alpha" }));
    const piece = await first.work("alpha", "piece", "open");
    const both = [{ task: piece.id, until: "work-done" }];
    await running(first.service, first.port, waiting("beta", "CRD-2", both));
    await running(first.service, first.port, waiting("gamma", "CRD-5", both));
    await first.finish("alpha", piece.id);
    failNoticesFor(first.db, "beta");

    // beta cannot be told: its row is not satisfied behind a notice that does not exist, and gamma is still served.
    await first.service.pollDependencies();
    expect(first.rows("beta")[`${piece.id} work-done`]).toMatchObject({ state: "open", detail: expect.stringContaining("injected") });
    expect(first.notices("beta")).toHaveLength(0);
    expect(first.notices("gamma")).toHaveLength(1);

    // The cause is gone: the next poll records the obligation, once; polls, applies and a reopened item add nothing.
    first.db.exec("DROP TRIGGER temp.fail_notice_beta");
    expect(await first.service.pollDependencies()).toBe(1);
    for (let i = 0; i < 3; i += 1) await first.service.pollDependencies();
    for (let i = 0; i < 2; i += 1) await first.service.apply(PROJECT, waiting("beta", "CRD-2", both));
    first.store.transitionWork(piece.id, { state: "open" }, "human", "reopened");
    await first.service.pollDependencies();
    await first.service.flush();
    expect(first.rows("beta")[`${piece.id} work-done`]).toMatchObject({ state: "satisfied" });
    expect(first.notices("beta")).toHaveLength(1);
    expect(first.notices("gamma")).toHaveLength(1);
    first.db.close();

    // A reopened database finds nothing open to flip.
    const second = world({ db: new Database(file), process: "p2", epoch: Date.UTC(2026, 9, 20, 10, 0) });
    await second.service.pollDependencies();
    await second.service.pollDependencies();
    expect(second.rows("beta")[`${piece.id} work-done`]).toMatchObject({ state: "satisfied" });
    expect(second.notices("beta")).toHaveLength(1);
    expect(second.notices("gamma")).toHaveLength(1);
    second.db.close();
  });

  it("legacy untouched: done still asks Tasks and never sees a native item, work-done needs no Tasks, and a mixed set costs Tasks only for its legacy row", async () => {
    // Without a Tasks port: `done` on a native id stays open (the old semantics), `work-done` on the same id is met.
    const bare = world({ tasks: false });
    await running(bare.service, bare.port, duoYaml({ name: "alpha" }));
    const piece = await bare.work("alpha", "piece", "done");
    await running(bare.service, bare.port, waiting("legacy", "CRD-2", [{ task: piece.id, until: "done" }]));
    await running(bare.service, bare.port, waiting("native", "CRD-4", [{ task: piece.id, until: "work-done" }]));
    expect(await bare.service.pollDependencies()).toBe(1);
    expect(bare.rows("legacy")[`${piece.id} done`]).toMatchObject({ state: "open" });
    expect(bare.notices("legacy")).toHaveLength(0);
    expect(bare.rows("native")[`${piece.id} work-done`]).toMatchObject({ state: "satisfied" });
    expect(bare.notices("native")).toHaveLength(1);

    // With one: a legacy `done` on a native id is a Tasks lookup that finds nothing, and CRD-3 `done` is not a work item either.
    const w = world();
    await running(w.service, w.port, duoYaml({ name: "alpha" }));
    const done = await w.work("alpha", "piece", "done");
    w.task("CRD-2", "todo");
    w.task("CRD-3", "done");
    await running(w.service, w.port, waiting("legacy", "CRD-8", [{ task: done.id, until: "done" }, { task: "CRD-3", until: "work-done" }]));
    expect(await w.service.pollDependencies()).toBe(0);
    expect(w.tasks!.calls).toContain(`getTask ${done.id}`);
    expect(w.tasks!.calls).not.toContain("getTask CRD-3");
    expect(w.rows("legacy")[`${done.id} done`]).toMatchObject({ state: "open" });
    expect(w.rows("legacy")["CRD-3 work-done"]).toMatchObject({ state: "open" });

    // A mixed set: the legacy row is labelled and read as before, the native row adds no Tasks call and no label.
    const mixed = world();
    await running(mixed.service, mixed.port, duoYaml({ name: "alpha" }));
    const native = await mixed.work("alpha", "piece", "done");
    mixed.task("CRD-2", "todo");
    mixed.task("CRD-3", "done");
    await running(mixed.service, mixed.port, waiting("beta", "CRD-2", [{ task: "CRD-3", until: "done" }, { task: native.id, until: "work-done" }]));
    expect(await mixed.service.pollDependencies()).toBe(2);
    expect(mixed.tasks!.calls).toEqual(["getTask CRD-2", "ensureLabel wartet-auf:CRD-3", "setLabels t_CRD-2", "getTask CRD-3"]);
    expect(mixed.rows("beta")["CRD-3 done"]).toMatchObject({ state: "satisfied", labelState: "set" });
    expect(mixed.rows("beta")[`${native.id} work-done`]).toMatchObject({ state: "satisfied", labelState: null });
    expect(mixed.notices("beta")).toHaveLength(1);
    expect(mixed.notices("beta")[0]!.subject).toBe(`Dependency fulfilled: CRD-3 done, ${native.id} work-done`);
  });
});

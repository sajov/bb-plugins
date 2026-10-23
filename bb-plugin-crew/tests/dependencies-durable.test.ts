// `waitsFor` is an AND barrier, and the wake notice is a durable obligation in
// the existing `messages` queue, written in the same transaction as the state
// that justifies it. Real store, real service, real delivery; the only fake
// parts are the ones the whole suite fakes (thread port, git, BB Tasks).
import Database from "better-sqlite3";
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createFakeTasks } from "../lib/dependencies";
import { createFakeGit } from "../lib/integration";
import { createCrewService } from "../lib/service";
import { createStore, migrateInPlace } from "../lib/store";
import { createFakeThreadPort } from "../lib/thread-port";
import { duoYaml, PROJECT, running } from "./helpers";

type Db = InstanceType<typeof Database>;

/** Holds the one file-backed database of the restart case; removed when the file is done. */
const WORK = fileURLToPath(new URL("../.test-dependencies-durable/", import.meta.url));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

/** One "process": a service over `db`. A second world over the same file is a restart. */
function world(db: Db = new Database(":memory:"), process = "p1", epoch = Date.UTC(2026, 9, 19, 9, 0)) {
  migrateInPlace(db);
  let clock = epoch;
  let counter = 0;
  const store = createStore(db, () => ++clock);
  const port = createFakeThreadPort();
  const tasks = createFakeTasks();
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
  return {
    db,
    store,
    port,
    service,
    task: (key: string, status: string) => tasks.tasks.set(key, { id: `t_${key}`, projectId: "tp", status, labelIds: [], comments: [] }),
    /** The wake notices addressed to a crew, from the queue itself. */
    notices: (crew: string) =>
      store
        .listMessages({ projectId: PROJECT, limit: 1000 })
        .filter((message) => message.subject.startsWith("Dependency fulfilled") && message.toAddress.endsWith(`@${crew}`)),
    rows: (crew: string) => Object.fromEntries(store.listDependencies(store.findCrew(PROJECT, crew)!.id).map((row) => [`${row.taskKey} ${row.until}`, row])),
  };
}

const waiting = (name: string, task: string, waitsFor: { task: string; until: string }[]) => duoYaml({ name, task, waitsFor });

/** The notice insert fails for this crew's lead, as a full disk or a crash between the two writes would. */
const failNoticesFor = (db: Db, crew: string) =>
  db.exec(
    `CREATE TEMP TRIGGER fail_notice_${crew} BEFORE INSERT ON messages
     WHEN NEW.subject LIKE 'Dependency fulfilled%' AND NEW.to_address = 'core-lead@${crew}'
     BEGIN SELECT RAISE(ABORT, 'injected: disk I/O error'); END`,
  );

describe("waitsFor: AND barrier and a durable wake notice", () => {
  it("AND: a satisfied condition does not wake the lead while another is open; the last one wakes it once, for the whole set", async () => {
    const w = world();
    const alpha = await running(w.service, w.port, duoYaml({ name: "alpha", task: "CRD-1" }));
    await running(w.service, w.port, waiting("beta", "CRD-2", [{ task: "CRD-1", until: "merged" }, { task: "CRD-3", until: "done" }]));
    w.task("CRD-3", "in_progress");

    const { merge } = await w.service.integration.request(alpha.crew, "core-lead@alpha");
    await w.service.integration.approve(merge.id);
    await w.service.flush();
    // The merged condition is observed and kept ...
    expect(w.rows("beta")["CRD-1 merged"]).toMatchObject({ state: "satisfied" });
    expect(w.rows("beta")["CRD-3 done"]).toMatchObject({ state: "open" });
    // ... but one condition is still open, so nobody is told to carry on.
    expect(w.notices("beta")).toHaveLength(0);
    await w.service.pollDependencies();
    expect(w.notices("beta")).toHaveLength(0);

    w.task("CRD-3", "done");
    expect(await w.service.pollDependencies()).toBe(1);
    const [notice, ...others] = w.notices("beta");
    expect(others).toEqual([]);
    expect(notice).toMatchObject({ kind: "message", fromAddress: "system", subject: "Dependency fulfilled: CRD-1 merged, CRD-3 done" });
    expect(notice!.body).toContain("CRD-1 merged");
    expect(notice!.body).toContain("CRD-3 done");
    expect(notice!.body).toContain("not an acceptance");
    expect(notice!.body).toContain("Re-read");
    // A crew that waits for nothing never gets one.
    expect(w.notices("alpha")).toEqual([]);
  });

  it("replay: the same poll, the same merged hook and the same apply leave exactly one notice per material set; dropping the last open row completes a set", async () => {
    const w = world();
    const alpha = await running(w.service, w.port, duoYaml({ name: "alpha", task: "CRD-1" }));
    const both = [{ task: "CRD-1", until: "merged" }, { task: "CRD-3", until: "done" }];
    await running(w.service, w.port, waiting("beta", "CRD-2", both));
    await running(w.service, w.port, waiting("gamma", "CRD-5", [{ task: "CRD-3", until: "done" }]));
    await running(w.service, w.port, waiting("delta", "CRD-4", [{ task: "CRD-3", until: "done" }, { task: "CRD-9", until: "done" }]));
    w.task("CRD-3", "done");
    const { merge } = await w.service.integration.request(alpha.crew, "core-lead@alpha");
    await w.service.integration.approve(merge.id);

    for (let i = 0; i < 3; i += 1) await w.service.pollDependencies();
    await w.service.dependencies.poll({ onlyMerged: true });
    for (let i = 0; i < 2; i += 1) await w.service.apply(PROJECT, waiting("beta", "CRD-2", both));
    await w.service.flush();
    expect(w.notices("gamma")).toHaveLength(1);
    expect(w.notices("beta")).toHaveLength(1);

    // delta: CRD-3 is done but CRD-9 is open, so no notice; removing CRD-9 from the file completes the set.
    expect(w.notices("delta")).toHaveLength(0);
    const only = waiting("delta", "CRD-4", [{ task: "CRD-3", until: "done" }]);
    for (let i = 0; i < 3; i += 1) await w.service.apply(PROJECT, only);
    await w.service.pollDependencies();
    await w.service.flush();
    expect(w.notices("delta")).toHaveLength(1);
    // Dropping a *satisfied* row, or a file with no conditions at all, completes nothing.
    await w.service.apply(PROJECT, waiting("beta", "CRD-2", [{ task: "CRD-3", until: "done" }]));
    await w.service.apply(PROJECT, waiting("gamma", "CRD-5", []));
    expect(w.notices("beta")).toHaveLength(1);
    expect(w.notices("gamma")).toHaveLength(1);
  });

  it("failure between the writes: no satisfied row without its notice; a crew that cannot be told stays open and explicit, and does not starve the others", async () => {
    const w = world();
    await running(w.service, w.port, waiting("beta", "CRD-2", [{ task: "CRD-3", until: "done" }]));
    await running(w.service, w.port, waiting("gamma", "CRD-5", [{ task: "CRD-3", until: "done" }]));
    const hollow = await running(w.service, w.port, waiting("hollow", "CRD-6", [{ task: "CRD-3", until: "done" }]));
    w.store.markMemberRemoved(hollow.members["core-lead"]!.id);
    w.task("CRD-3", "done");
    failNoticesFor(w.db, "beta");

    const poll = await w.service.pollDependencies().then(
      () => "resolved",
      (error: Error) => `rejected: ${error.message}`,
    );
    // The row is not satisfied behind a notice that does not exist; the reason is on the row.
    expect(w.rows("beta")["CRD-3 done"]).toMatchObject({ state: "open", detail: expect.stringContaining("injected") });
    expect(w.notices("beta")).toHaveLength(0);
    // The crew after it in the pass is still served.
    expect(w.notices("gamma")).toHaveLength(1);
    expect(poll).toBe("resolved");
    // No lead, no notice: the fulfilment is not discarded by marking it satisfied.
    expect(w.rows("hollow")["CRD-3 done"]).toMatchObject({ state: "open", detail: expect.stringMatching(/no lead/i) });

    // Once the cause is gone the next poll records the obligation, once.
    w.db.exec("DROP TRIGGER temp.fail_notice_beta");
    expect(await w.service.pollDependencies()).toBe(1);
    expect(w.rows("beta")["CRD-3 done"]).toMatchObject({ state: "satisfied" });
    expect(w.notices("beta")).toHaveLength(1);
    expect(w.notices("gamma")).toHaveLength(1);
    expect(w.rows("hollow")["CRD-3 done"]).toMatchObject({ state: "open" });
  });

  it("restart: a fulfilment that failed before its notice is recorded after the database is reopened, and later reopenings do not repeat it", async () => {
    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });
    const file = `${WORK}restart.db`;

    const first = world(new Database(file), "p1");
    await running(first.service, first.port, waiting("beta", "CRD-2", [{ task: "CRD-3", until: "done" }]));
    first.task("CRD-3", "done");
    failNoticesFor(first.db, "beta");
    await first.service.dependencies.poll().catch(() => 0);
    first.db.close();

    // The file says what is owed, not what was lost: the row is open, not satisfied behind nothing.
    const second = world(new Database(file), "p2", Date.UTC(2026, 9, 19, 10, 0));
    expect(second.rows("beta")["CRD-3 done"]).toMatchObject({ state: "open" });
    expect(second.notices("beta")).toHaveLength(0);
    second.task("CRD-3", "done");
    await second.service.dependencies.poll();
    expect(second.notices("beta")).toHaveLength(1);
    expect(second.notices("beta")[0]).toMatchObject({ status: "pending", fromAddress: "system", toAddress: "core-lead@beta" });
    second.db.close();

    const third = world(new Database(file), "p3", Date.UTC(2026, 9, 19, 11, 0));
    third.task("CRD-3", "done");
    await third.service.dependencies.poll();
    await third.service.dependencies.poll();
    expect(third.rows("beta")["CRD-3 done"]).toMatchObject({ state: "satisfied" });
    expect(third.notices("beta")).toHaveLength(1);
    third.db.close();
  });
});

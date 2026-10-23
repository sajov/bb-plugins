import { describe, expect, it } from "vitest";
import { createLocalGit, REJECT_LIMIT } from "../lib/integration";
import { labelFor } from "../lib/dependencies";
import { isIntegrator, validateCrew } from "../lib/spec";
import { duoYaml, PROJECT, running, setup } from "./helpers";

const sends = (port: ReturnType<typeof setup>["port"]) => port.calls.filter((call) => call.method === "send");

/** alpha (task CRD-1) and beta (task CRD-2, waits for CRD-1). */
async function twoCrews(options: { until?: string; alpha?: Parameters<typeof duoYaml>[0]; integrator?: boolean } = {}) {
  const env = setup();
  const alpha = await running(env.service, env.port, duoYaml({ name: "alpha", task: "CRD-1", ...options.alpha }));
  const beta = await running(env.service, env.port, duoYaml({ name: "beta", task: "CRD-2", waitsFor: [{ task: "CRD-1", until: options.until ?? "merged" }] }));
  const ops = options.integrator
    ? await running(
        env.service,
        env.port,
        duoYaml({ name: "ops", groups: [{ id: "ops", members: [{ id: "int", lead: true, integrator: true, role: "Merges delivered crew branches into main." }] }] }),
      )
    : null;
  const needs = async (crew: typeof alpha, key: string) => (await env.service.activity.refreshMember(crew.members[key]!))!.needsYou;
  const wakes = (crew: typeof alpha) =>
    env.store
      .listMessages({ toMember: crew.members["core-lead"]!.id })
      .filter((m) => m.kind === "message" && m.subject.startsWith("Dependency fulfilled"));
  return { ...env, alpha, beta, ops, needs, wakes };
}

describe("merge requests (human merges by default)", () => {
  it("crew_deliver opens a merge request on the lead's actual branch and puts the lead on Needs you (merge-request)", async () => {
    const { service, alpha, needs, store } = await twoCrews();
    expect(await needs(alpha, "core-lead")).not.toContain("merge-request");
    const { merge, integrator } = await service.integration.request(alpha.crew, "core-lead@alpha");
    const env = store.memberEnv(alpha.members["core-lead"]!.id)!;
    expect(merge).toMatchObject({ state: "open", branch: env.branch, base: "main" });
    expect(env.branch).toMatch(/^bb\//);
    expect(integrator).toBeNull();
    expect(await needs(alpha, "core-lead")).toContain("merge-request");
    // Only the lead: the other member is not on the list.
    expect(await needs(alpha, "core-dev")).not.toContain("merge-request");
    const view = await service.activity.refreshMember(alpha.members["core-lead"]!);
    expect(view!.question).toContain(`bb crew approve ${merge.id}`);
  });

  it("a second request returns the open one; approve merges, clears Needs you and tells every other running lead without waking them", async () => {
    const { service, alpha, beta, needs, git, port, store } = await twoCrews();
    const first = await service.integration.request(alpha.crew, "core-lead@alpha");
    const again = await service.integration.request(alpha.crew, "core-lead@alpha");
    expect(again.merge.id).toBe(first.merge.id);
    const before = sends(port).length;
    const merged = await service.integration.approve(first.merge.id);
    await service.flush();
    expect(merged).toMatchObject({ state: "merged", commitSha: "abc1234def", mergedBy: "human" });
    expect(git.count("merge")).toBe(1);
    expect(git.count("checks")).toBe(0);
    expect(await needs(alpha, "core-lead")).not.toContain("merge-request");
    const notes = store.listMessages().filter((m) => m.subject === "main moved");
    expect(notes.map((m) => m.toAddress).sort()).toEqual(["core-lead@beta"]);
    expect(notes.every((m) => m.kind === "system" && m.deliveryMode === "ui")).toBe(true);
    // The only turn started is beta's dependency wake; the notes themselves wake nobody.
    expect(sends(port).slice(before).map((call) => (call.args as { text: string }).text.includes("main moved"))).not.toContain(true);
    expect(beta.crew.name).toBe("beta");
  });

  it("negative: a conflict on approve returns the request to the human with the reason", async () => {
    const { service, alpha, git, needs } = await twoCrews();
    git.mergeResult = { ok: false, conflict: true, detail: "CONFLICT (content): Merge conflict in a.txt" };
    const { merge } = await service.integration.request(alpha.crew, "core-lead@alpha");
    const after = await service.integration.approve(merge.id);
    expect(after.state).toBe("returned");
    expect(after.reason).toContain("merge conflict");
    expect(await needs(alpha, "core-lead")).toContain("merge-request");
  });

  it("BBP-270: a merge behind a dirty main checkout is parked, never merged: no main moved, no onMerged, lead on Needs you (merge-parked)", async () => {
    const { service, alpha, beta, git, needs, store } = await twoCrews();
    git.mergeResult = { ok: true, commit: "p1", parked: true, checkout: "/repo/main" };
    const { merge } = await service.integration.request(alpha.crew, "core-lead@alpha");
    const after = await service.integration.approve(merge.id);
    await service.flush();
    expect(after).toMatchObject({ state: "parked", commitSha: "p1" });
    expect(after.reason).toContain("main checkout /repo/main has uncommitted changes; merge parked on refs/crew/integration/main");
    expect(store.listMessages().filter((m) => m.subject === "main moved")).toEqual([]);
    expect(store.listDependencies(beta.crew.id).every((dependency) => dependency.state === "open")).toBe(true);
    expect(await needs(alpha, "core-lead")).toContain("merge-parked");
    expect(await needs(alpha, "core-lead")).not.toContain("merge-request");
    expect(store.listMerges({ projectId: PROJECT, states: ["merged"] })).toEqual([]);
  });

  it("BBP-271: once the checkout is clean, approving the parked request releases it: merged, main moved, dependencies fulfilled", async () => {
    const { service, alpha, beta, git, needs, store, wakes } = await twoCrews();
    git.mergeResult = { ok: true, commit: "p1", parked: true };
    const { merge } = await service.integration.request(alpha.crew, "core-lead@alpha");
    await service.integration.approve(merge.id);
    git.releaseResult = { kind: "released", commit: "p1" };
    const after = await service.integration.approve(merge.id);
    await service.flush();
    expect(after).toMatchObject({ state: "merged", commitSha: "p1", reason: null });
    expect(git.count("merge")).toBe(1);
    expect(store.listMessages().filter((m) => m.subject === "main moved").length).toBe(1);
    expect(store.listDependencies(beta.crew.id).every((dependency) => dependency.state === "satisfied")).toBe(true);
    expect(wakes(beta).length).toBe(1);
    expect(await needs(alpha, "core-lead")).not.toContain("merge-parked");
  });

  it("BBP-271: the next merge releases every parked request first, each merged with its own main moved", async () => {
    const { service, alpha, beta, ops, git, store } = await twoCrews({ integrator: true });
    git.mergeResult = { ok: true, commit: "p1", parked: true };
    const first = (await service.integration.request(alpha.crew, "core-lead@alpha")).merge;
    await service.integration.approve(first.id);
    git.releaseResult = { kind: "released", commit: "p1" };
    git.mergeResult = { ok: true, commit: "m2" };
    const second = (await service.integration.request(beta.crew, "core-lead@beta")).merge;
    expect(await service.integration.approve(second.id)).toMatchObject({ state: "merged", commitSha: "m2" });
    await service.flush();
    expect(store.getMerge(first.id)).toMatchObject({ state: "merged", commitSha: "p1" });
    expect(git.calls.findIndex((call) => call.method === "release")).toBeLessThan(git.calls.findIndex((call) => call.method === "merge" && call.args[1] === second.branch));
    expect(store.listMessages({ toMember: ops!.members["ops-int"]!.id }).filter((m) => m.subject === "main moved").length).toBe(2);
  });

  it("negative BBP-271: while the checkout is still dirty the parked request stays parked and nothing moves", async () => {
    const { service, alpha, beta, git, needs, store } = await twoCrews();
    git.mergeResult = { ok: true, commit: "p1", parked: true };
    const { merge } = await service.integration.request(alpha.crew, "core-lead@alpha");
    await service.integration.approve(merge.id);
    git.releaseResult = { kind: "held" };
    expect(await service.integration.approve(merge.id)).toMatchObject({ state: "parked" });
    await service.flush();
    expect(git.count("merge")).toBe(1);
    expect(store.listMessages().filter((m) => m.subject === "main moved")).toEqual([]);
    expect(store.listDependencies(beta.crew.id).every((dependency) => dependency.state === "open")).toBe(true);
    expect(await needs(alpha, "core-lead")).toContain("merge-parked");
  });

  it("reject closes the request and tells the lead; a closed request cannot be approved", async () => {
    const { service, alpha, store, needs } = await twoCrews();
    const { merge } = await service.integration.request(alpha.crew, "core-lead@alpha");
    await service.integration.reject(merge.id, "needs tests");
    expect(store.listMessages({ toMember: alpha.members["core-lead"]!.id }).at(-1)!.body).toContain("needs tests");
    expect(await needs(alpha, "core-lead")).not.toContain("merge-request");
    await expect(service.integration.approve(merge.id)).rejects.toThrow("is rejected");
  });

  it("BBP-87: a branch already fully contained in base (merged outside this flow) auto-closes as merged and drops off Needs you", async () => {
    const { service, alpha, git, needs, store } = await twoCrews();
    const { merge } = await service.integration.request(alpha.crew, "core-lead@alpha");
    expect(await needs(alpha, "core-lead")).toContain("merge-request");
    // The human merged the branch directly (or it otherwise landed in main already): no commits left on top of base.
    git.aheadCount = 0;
    expect(await needs(alpha, "core-lead")).not.toContain("merge-request");
    expect(store.getMerge(merge.id)).toMatchObject({ state: "merged" });
  });

  it("negative: a merge request with real unmerged commits stays open", async () => {
    const { service, alpha, git, needs } = await twoCrews();
    await service.integration.request(alpha.crew, "core-lead@alpha");
    git.aheadCount = 2;
    expect(await needs(alpha, "core-lead")).toContain("merge-request");
  });

  it("negative: no worktree branch, or the crew working on main, is refused", async () => {
    const { service, alpha, port, store } = await twoCrews();
    const lead = alpha.members["core-lead"]!;
    const thread = port.threads.get(alpha.threads["core-lead"]!)!;
    port.environments.set(thread.environmentId!, { path: "/repo", branch: "main", defaultBranch: "main" });
    await expect(service.integration.request(alpha.crew, lead.address)).rejects.toThrow("directly on main");
    thread.environmentId = null;
    store.setMemberEnv(lead.id, { environmentId: null, path: null, branch: null });
    await expect(service.integration.request(alpha.crew, lead.address)).rejects.toThrow("branch is unknown");
  });
});

describe("human questions (BBP-87)", () => {
  it("a question tied to this crew's own task auto-closes once the task is done", async () => {
    const { service, alpha, needs, tasks, store } = await twoCrews();
    const lead = alpha.members["core-lead"]!;
    await service.send({ projectId: PROJECT, from: { kind: "member", member: lead, crew: alpha.crew }, to: "human", body: "v1 or v2?" });
    expect(await needs(alpha, "core-lead")).toContain("human-question");
    expect(store.openHumanQuestion(lead.id)).not.toBeNull();
    tasks.tasks.set("CRD-1", { id: "t1", projectId: "tp", status: "done", labelIds: [], comments: [] });
    expect(await needs(alpha, "core-lead")).not.toContain("human-question");
    expect(store.openHumanQuestion(lead.id)).toBeNull();
  });

  it("negative: a question stays open while the task is not done", async () => {
    const { service, alpha, needs, tasks } = await twoCrews();
    const lead = alpha.members["core-lead"]!;
    await service.send({ projectId: PROJECT, from: { kind: "member", member: lead, crew: alpha.crew }, to: "human", body: "v1 or v2?" });
    tasks.tasks.set("CRD-1", { id: "t1", projectId: "tp", status: "in_progress", labelIds: [], comments: [] });
    expect(await needs(alpha, "core-lead")).toContain("human-question");
  });
});

describe("integrator", () => {
  it("the grant is the explicit field, never the role text", () => {
    expect(isIntegrator({ integrator: true })).toBe(true);
    expect(isIntegrator({ integrator: false, role: "Integrator for the project" })).toBe(false);
    expect(isIntegrator({ role: "integrator" })).toBe(false);
    expect(isIntegrator({ integrator: "yes" })).toBe(false);
    expect(isIntegrator(undefined)).toBe(false);
  });

  it("validation: at most one integrator per crew", () => {
    const one = validateCrew(duoYaml({ groups: [{ id: "core", members: [{ id: "lead", lead: true, integrator: true }, { id: "dev" }] }] }));
    expect(one.problems.map((p) => p.code)).not.toContain("integrator-multiple");
    const two = validateCrew(duoYaml({ groups: [{ id: "core", members: [{ id: "lead", lead: true, integrator: true }, { id: "dev", integrator: true }] }] }));
    expect(two.problems.find((p) => p.code === "integrator-multiple")?.level).toBe("error");
  });

  it("validation: a role that mentions integrator without the field warns", () => {
    const text = validateCrew(duoYaml({ groups: [{ id: "core", members: [{ id: "lead", lead: true, role: "Integrator for the project." }, { id: "dev" }] }] }));
    expect(text.problems.find((p) => p.code === "integrator-role-text")?.level).toBe("warning");
    const granted = validateCrew(duoYaml({ groups: [{ id: "core", members: [{ id: "lead", lead: true, integrator: true, role: "Integrator for the project." }, { id: "dev" }] }] }));
    expect(granted.problems.map((p) => p.code)).not.toContain("integrator-role-text");
  });

  it("green checks: the integrator merges without the human", async () => {
    const { service, alpha, ops, git, store, needs } = await twoCrews({ integrator: true, alpha: { checks: "npm test" } });
    const { merge, integrator } = await service.integration.request(alpha.crew, "core-lead@alpha");
    expect(integrator?.address).toBe("ops-int@ops");
    expect(store.listMessages({ toMember: ops!.members["ops-int"]!.id }).at(-1)!.body).toContain(`crew_merge(id: "${merge.id}")`);
    const after = await service.integration.integratorMerge(merge.id, ops!.members["ops-int"]!);
    expect(after).toMatchObject({ state: "merged", mergedBy: "ops-int@ops" });
    expect(git.calls.find((call) => call.method === "checks")!.args[1]).toBe("npm test");
    expect(await needs(alpha, "core-lead")).not.toContain("merge-request");
  });

  it("negative: a conflict or no checks command send it back to the human; nothing is merged on red", async () => {
    const conflict = await twoCrews({ integrator: true, alpha: { checks: "npm test" } });
    conflict.git.mergeResult = { ok: false, conflict: true, detail: "CONFLICT" };
    const b = await conflict.service.integration.request(conflict.alpha.crew, "x");
    expect((await conflict.service.integration.integratorMerge(b.merge.id, conflict.ops!.members["ops-int"]!)).state).toBe("returned");

    const unchecked = await twoCrews({ integrator: true });
    const c = await unchecked.service.integration.request(unchecked.alpha.crew, "x");
    const afterNone = await unchecked.service.integration.integratorMerge(c.merge.id, unchecked.ops!.members["ops-int"]!);
    expect(afterNone.reason).toContain("no checks command");
    expect(unchecked.git.count("merge")).toBe(0);
  });

  it("red checks (test failures): rejected, not returned, and the crew lead gets the log with 'fix, then crew_deliver again'", async () => {
    const red = await twoCrews({ integrator: true, alpha: { checks: "npm test" } });
    red.git.checksResult = { kind: "failed", code: 1, output: "1 failing" };
    const a = await red.service.integration.request(red.alpha.crew, "x");
    const afterRed = await red.service.integration.integratorMerge(a.merge.id, red.ops!.members["ops-int"]!);
    expect(afterRed).toMatchObject({ state: "rejected", checksOutput: "1 failing" });
    expect(afterRed.reason).toContain("checks failed");
    expect(red.git.count("merge")).toBe(0);
    // Not the human's problem (yet): no Needs you for the lead.
    expect(await red.needs(red.alpha, "core-lead")).not.toContain("merge-request");
    const toLead = red.store.listMessages({ toMember: red.alpha.members["core-lead"]!.id }).at(-1)!;
    expect(toLead.subject).toBe(`Merge request ${a.merge.id}: checks failed`);
    expect(toLead.body).toContain("1 failing");
    expect(toLead.body).toContain("fix, then crew_deliver again");
    // It is rejected; the integrator cannot retry the same request.
    await expect(red.service.integration.integratorMerge(a.merge.id, red.ops!.members["ops-int"]!)).rejects.toThrow();
  });

  it("environment errors (command not found, timeout) are reported as 'could not run', separate from failing tests", async () => {
    const env = await twoCrews({ integrator: true, alpha: { checks: "npm test" } });
    env.git.checksResult = { kind: "env", code: 127, output: "command not found" };
    const { merge } = await env.service.integration.request(env.alpha.crew, "x");
    const after = await env.service.integration.integratorMerge(merge.id, env.ops!.members["ops-int"]!);
    expect(after.state).toBe("rejected");
    expect(after.reason).toContain("checks could not run (environment)");
  });

  it("the 3rd red check in a row (same crew) returns to the human instead of rejecting again", async () => {
    const env = await twoCrews({ integrator: true, alpha: { checks: "npm test" } });
    env.git.checksResult = { kind: "failed", code: 1, output: "1 failing" };
    for (let i = 0; i < REJECT_LIMIT - 1; i += 1) {
      const { merge } = await env.service.integration.request(env.alpha.crew, "x");
      const after = await env.service.integration.integratorMerge(merge.id, env.ops!.members["ops-int"]!);
      expect(after.state).toBe("rejected");
    }
    const { merge: lastMerge } = await env.service.integration.request(env.alpha.crew, "x");
    const last = await env.service.integration.integratorMerge(lastMerge.id, env.ops!.members["ops-int"]!);
    expect(last.state).toBe("returned");
    expect(await env.needs(env.alpha, "core-lead")).toContain("merge-request");
  });

  it("negative: a member without the integrator role cannot merge", async () => {
    const { service, alpha } = await twoCrews({ integrator: true, alpha: { checks: "true" } });
    const { merge } = await service.integration.request(alpha.crew, "x");
    await expect(service.integration.integratorMerge(merge.id, alpha.members["core-dev"]!)).rejects.toThrow("integrator: true");
  });
});

describe("rebase", () => {
  it("a conflict aborts, puts the branch owner on Needs you (merge-conflict); a later clean rebase clears it", async () => {
    const { service, beta, git, needs } = await twoCrews();
    git.rebaseResult = { ok: false, conflict: true, files: ["src/a.ts"], detail: "CONFLICT" };
    const failed = await service.integration.rebase(beta.members["core-lead"]!);
    expect(failed.ok).toBe(false);
    expect(await needs(beta, "core-lead")).toContain("merge-conflict");
    expect((await service.activity.refreshMember(beta.members["core-lead"]!))!.question).toContain("src/a.ts");
    expect(await needs(beta, "core-dev")).not.toContain("merge-conflict");
    git.rebaseResult = { ok: true, head: "123" };
    await service.integration.rebase(beta.members["core-lead"]!);
    expect(await needs(beta, "core-lead")).not.toContain("merge-conflict");
  });

  it("plan shows how far the crew branch is behind main", async () => {
    const { service, git } = await twoCrews();
    git.behindCount = 3;
    const planned = await service.plan(PROJECT, duoYaml({ name: "alpha", task: "CRD-1" }));
    expect(planned.behind).toBe(3);
    git.behindCount = null;
    expect((await service.plan(PROJECT, duoYaml({ name: "alpha", task: "CRD-1" }))).behind).toBeNull();
  });
});

describe("waitsFor", () => {
  it("merged: nothing before the merge; after it the waiting lead gets one notice and decides whether to rebase", async () => {
    const { service, alpha, beta, wakes, store, port, tasks } = await twoCrews();
    expect(await service.pollDependencies()).toBe(0);
    expect(wakes(beta)).toEqual([]);
    const { merge } = await service.integration.request(alpha.crew, "core-lead@alpha");
    await service.integration.approve(merge.id);
    await service.flush();
    expect(wakes(beta).length).toBe(1);
    expect(wakes(beta)[0]!.body).toContain("crew_rebase");
    expect(wakes(beta)[0]!.body).toContain("is yours to decide");
    // A waking message: it started a turn in beta's lead thread.
    expect(port.threads.get(beta.threads["core-lead"]!)!.inbox.filter((entry) => entry.text.includes("Dependency fulfilled")).length).toBe(1);
    for (let i = 0; i < 3; i += 1) await service.pollDependencies();
    expect(wakes(beta).length).toBe(1);
    expect(store.listDependencies(beta.crew.id)[0]).toMatchObject({ state: "satisfied" });
    // merged is answered from the plugin's merges: no tasks RPC for CRD-1.
    expect(tasks.calls.filter((call) => call === "getTask CRD-1")).toEqual([]);
    // Alpha waits for nothing and got no wake.
    expect(wakes(alpha)).toEqual([]);
  });

  it("done: fulfilled when the task is done, once", async () => {
    const { service, beta, wakes, tasks } = await twoCrews({ until: "done" });
    tasks.tasks.set("CRD-1", { id: "t1", projectId: "tp", status: "in_progress", labelIds: [], comments: [] });
    expect(await service.pollDependencies()).toBe(0);
    tasks.tasks.get("CRD-1")!.status = "done";
    expect(await service.pollDependencies()).toBe(1);
    expect(await service.pollDependencies()).toBe(0);
    expect(wakes(beta).length).toBe(1);
  });

  it("comment:<keyword>: fulfilled by a comment containing it, case-insensitive", async () => {
    const { service, beta, wakes, tasks } = await twoCrews({ until: "comment:schema stable" });
    tasks.tasks.set("CRD-1", { id: "t1", projectId: "tp", status: "todo", labelIds: [], comments: ["still moving"] });
    expect(await service.pollDependencies()).toBe(0);
    tasks.tasks.get("CRD-1")!.comments.push("Schema STABLE from a1f3c9");
    expect(await service.pollDependencies()).toBe(1);
    expect(wakes(beta).length).toBe(1);
  });

  it("the waiting task gets the label wartet-auf:<KEY>, set once; a label failure is stored and the dependency still works", async () => {
    const ok = await twoCrews();
    ok.tasks.tasks.set("CRD-2", { id: "t2", projectId: "tp", status: "todo", labelIds: ["lbl_x"], comments: [] });
    await ok.service.pollDependencies();
    await ok.service.pollDependencies();
    expect(ok.tasks.tasks.get("CRD-2")!.labelIds).toEqual(["lbl_x", "lbl_1"]);
    expect(ok.tasks.labels.get(`tp:${labelFor("CRD-1")}`)).toBe("lbl_1");
    expect(labelFor("CRD-1")).toBe("wartet-auf:CRD-1");
    expect(ok.tasks.calls.filter((call) => call.startsWith("ensureLabel")).length).toBe(1);
    expect(ok.store.listDependencies(ok.beta.crew.id)[0]!.labelState).toBe("set");

    const broken = await twoCrews();
    broken.tasks.failLabels = true;
    broken.tasks.tasks.set("CRD-2", { id: "t2", projectId: "tp", status: "todo", labelIds: [], comments: [] });
    await broken.service.pollDependencies();
    expect(broken.store.listDependencies(broken.beta.crew.id)[0]).toMatchObject({ labelState: "skipped", detail: expect.stringContaining("labels unavailable") });
    const { merge } = await broken.service.integration.request(broken.alpha.crew, "x");
    await broken.service.integration.approve(merge.id);
    expect(broken.wakes(broken.beta).length).toBe(1);
  });

  it("apply mirrors waitsFor: removed entries disappear, and a stopped waiting crew is not woken", async () => {
    const { service, beta, store, alpha, wakes } = await twoCrews();
    expect(store.listDependencies(beta.crew.id).map((row) => `${row.taskKey} ${row.until}`)).toEqual(["CRD-1 merged"]);
    await service.stop(beta.crew);
    const { merge } = await service.integration.request(alpha.crew, "x");
    await service.integration.approve(merge.id);
    expect(wakes(beta)).toEqual([]);
    await service.apply(PROJECT, duoYaml({ name: "beta", task: "CRD-2" }));
    expect(store.listDependencies(beta.crew.id)).toEqual([]);
  });
});

describe("local git backend", () => {
  it("BBP-269: builds the merge commit with merge-tree + commit-tree and fast-forwards a clean main checkout; no merge runs in the checkout", async () => {
    const calls: string[] = [];
    const git = createLocalGit(async (args, cwd) => {
      calls.push(`${cwd}: ${args.join(" ")}`);
      if (args[0] === "worktree") return { code: 0, stdout: "worktree /repo\nHEAD 1\nbranch refs/heads/main\n\nworktree /wt\nbranch refs/heads/bb/x\n", stderr: "" };
      if (args[0] === "merge-tree") return { code: 0, stdout: "tree1\n", stderr: "" };
      if (args[0] === "commit-tree") return { code: 0, stdout: "c1\n", stderr: "" };
      if (args.includes("--verify")) return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(await git.merge("/wt", "bb/x", "main", "m")).toEqual({ ok: true, commit: "c1" });
    expect(calls).toContain("/repo: merge --ff-only c1");
    expect(calls.some((call) => call.includes("--no-ff") || call.includes("update-ref"))).toBe(false);
  });

  it("BBP-270: a dirty main worktree is never merged into: the commit is parked on refs/crew/integration/main", async () => {
    const calls: string[] = [];
    const git = createLocalGit(async (args, cwd) => {
      calls.push(`${cwd}: ${args.join(" ")}`);
      if (args[0] === "worktree") return { code: 0, stdout: "worktree /repo\nbranch refs/heads/main\n", stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: " M a.txt\n", stderr: "" };
      if (args.includes("--verify")) return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "merge-tree") return { code: 0, stdout: "tree1\n", stderr: "" };
      if (args[0] === "commit-tree") return { code: 0, stdout: "c1\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(await git.merge("/wt", "bb/x", "main", "m")).toEqual({ ok: true, commit: "c1", parked: true, checkout: "/repo" });
    expect(calls).toContain("/wt: update-ref refs/crew/integration/main c1");
    expect(calls.some((call) => (call.startsWith("/repo:") && !call.startsWith("/repo: status")) || call.includes("refs/heads/main") || call.includes("stash"))).toBe(false);
  });

  it("checks(): NODE_ENV is left out of the process env (the server's NODE_ENV=production must not reach vitest)", async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const git = createLocalGit();
      const result = await git.checks(process.cwd(), 'node -e "process.stdout.write(String(process.env.NODE_ENV))"');
      expect(result.output).toBe("undefined");
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
  });

  it("checks(): ANSI escape codes are stripped from the stored output", async () => {
    const git = createLocalGit(async () => ({ code: 0, stdout: "\u001b[32mok\u001b[0m\n", stderr: "" }));
    const result = await git.checks("/wt", "npm test");
    expect(result.output).toBe("ok");
  });

  it("checks(): exit 127 (command not found) is an environment error, not a test failure", async () => {
    const git = createLocalGit(async () => ({ code: 127, stdout: "", stderr: "sh: npm: command not found" }));
    expect((await git.checks("/wt", "npm test")).kind).toBe("env");
  });

  it("checks(): exit 126 (not executable) is an environment error", async () => {
    const git = createLocalGit(async () => ({ code: 126, stdout: "", stderr: "permission denied" }));
    expect((await git.checks("/wt", "npm test")).kind).toBe("env");
  });

  it("checks(): a timed-out/killed run is an environment error", async () => {
    const git = createLocalGit(async () => ({ code: 1, stdout: "", stderr: "", killed: true }));
    expect((await git.checks("/wt", "npm test")).kind).toBe("env");
  });

  it("checks(): a normal non-zero exit is a test failure", async () => {
    const git = createLocalGit(async () => ({ code: 1, stdout: "1 failing", stderr: "" }));
    expect((await git.checks("/wt", "npm test")).kind).toBe("failed");
  });
});

describe("merge outcome reaches the submitting lead (BBP-250)", () => {
  const toLead = (env: Awaited<ReturnType<typeof twoCrews>>) => env.store.listMessages({ toMember: env.alpha.members["core-lead"]!.id });

  it("merge by another crew's integrator: the submitting lead gets exactly one waking message with MR, commit and ticket, and no 'main moved'", async () => {
    const env = await twoCrews({ integrator: true, alpha: { checks: "npm test" } });
    const { merge } = await env.service.integration.request(env.alpha.crew, "core-lead@alpha");
    const before = toLead(env).length;
    await env.service.integration.integratorMerge(merge.id, env.ops!.members["ops-int"]!);
    await env.service.flush();
    const after = toLead(env).slice(before);
    expect(after).toHaveLength(1);
    expect(after[0]!.kind).toBe("message");
    expect(after[0]!.subject).toBe(`Merge request ${merge.id} merged`);
    expect(after[0]!.body).toContain(merge.id);
    expect(after[0]!.body).toContain("abc1234def");
    expect(after[0]!.body).toContain("CRD-1");
    expect(after[0]!.body).toContain("ops-int@ops");
    // Other crews still get the non-waking note.
    expect(env.store.listMessages().filter((m) => m.subject === "main moved").map((m) => m.toAddress).sort()).toEqual(["core-lead@beta", "ops-int@ops"]);
  });

  it("merge by the human: the submitting lead gets the merged message as well", async () => {
    const env = await twoCrews();
    const { merge } = await env.service.integration.request(env.alpha.crew, "core-lead@alpha");
    const before = toLead(env).length;
    await env.service.integration.approve(merge.id);
    const after = toLead(env).slice(before);
    expect(after.map((m) => m.subject)).toEqual([`Merge request ${merge.id} merged`]);
  });

  it("merge by the crew's own integrator who is the lead: no message, the tool result is the report", async () => {
    const env = setup();
    const own = await running(env.service, env.port, duoYaml({ name: "solo", task: "CRD-9", checks: "npm test", groups: [{ id: "core", members: [{ id: "lead", lead: true, integrator: true, role: "Leads and merges." }] }] }));
    const leadRow = own.members["core-lead"]!;
    const { merge } = await env.service.integration.request(own.crew, leadRow.address);
    const before = env.store.listMessages({ toMember: leadRow.id }).length;
    const after = await env.service.integration.integratorMerge(merge.id, leadRow);
    expect(after.state).toBe("merged");
    expect(env.store.listMessages({ toMember: leadRow.id }).slice(before)).toEqual([]);
  });

  it("negative: a conflict (returned to the human) is reported to the submitting lead with reason, MR and ticket", async () => {
    const env = await twoCrews({ integrator: true, alpha: { checks: "npm test" } });
    env.git.mergeResult = { ok: false, conflict: true, detail: "CONFLICT in a.txt" };
    const { merge } = await env.service.integration.request(env.alpha.crew, "core-lead@alpha");
    const before = toLead(env).length;
    await env.service.integration.integratorMerge(merge.id, env.ops!.members["ops-int"]!);
    const after = toLead(env).slice(before);
    expect(after).toHaveLength(1);
    expect(after[0]!.kind).toBe("message");
    expect(after[0]!.subject).toBe(`Merge request ${merge.id} returned to the human`);
    expect(after[0]!.body).toContain("merge conflict");
    expect(after[0]!.body).toContain("CRD-1");
  });

  it("negative: red checks (rejected) name the ticket in the message to the lead", async () => {
    const env = await twoCrews({ integrator: true, alpha: { checks: "npm test" } });
    env.git.checksResult = { kind: "failed", code: 1, output: "1 failing" };
    const { merge } = await env.service.integration.request(env.alpha.crew, "core-lead@alpha");
    await env.service.integration.integratorMerge(merge.id, env.ops!.members["ops-int"]!);
    expect(toLead(env).at(-1)!.body).toContain("CRD-1");
  });
});

describe("human reject names the delivery (BBP-250)", () => {
  it("the lead's reject message carries MR, branch and ticket", async () => {
    const { service, alpha, store } = await twoCrews();
    const { merge } = await service.integration.request(alpha.crew, "core-lead@alpha");
    await service.integration.reject(merge.id, "needs tests");
    const body = store.listMessages({ toMember: alpha.members["core-lead"]!.id }).at(-1)!.body;
    expect(body).toContain(`MR ${merge.id}`);
    expect(body).toContain("ticket CRD-1");
    expect(body).toContain("needs tests");
  });
});

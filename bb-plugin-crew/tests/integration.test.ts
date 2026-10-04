import { describe, expect, it } from "vitest";
import { createLocalGit } from "../lib/integration";
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

  it("a second request returns the open one; approve merges, clears Needs you and tells every running lead without waking them", async () => {
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
    expect(notes.map((m) => m.toAddress).sort()).toEqual(["core-lead@alpha", "core-lead@beta"]);
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

  it("negative: red checks, a conflict or no checks command send it back to the human; nothing is merged on red", async () => {
    const red = await twoCrews({ integrator: true, alpha: { checks: "npm test" } });
    red.git.checksResult = { ok: false, output: "1 failing" };
    const a = await red.service.integration.request(red.alpha.crew, "x");
    const afterRed = await red.service.integration.integratorMerge(a.merge.id, red.ops!.members["ops-int"]!);
    expect(afterRed).toMatchObject({ state: "returned", checksOutput: "1 failing" });
    expect(red.git.count("merge")).toBe(0);
    expect(await red.needs(red.alpha, "core-lead")).toContain("merge-request");
    // It is the human's now; the integrator cannot retry it.
    await expect(red.service.integration.integratorMerge(a.merge.id, red.ops!.members["ops-int"]!)).rejects.toThrow("the human's now");

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
  it("merged: nothing before the merge; after it the waiting lead gets exactly one waking message with the rebase order", async () => {
    const { service, alpha, beta, wakes, store, port, tasks } = await twoCrews();
    expect(await service.pollDependencies()).toBe(0);
    expect(wakes(beta)).toEqual([]);
    const { merge } = await service.integration.request(alpha.crew, "core-lead@alpha");
    await service.integration.approve(merge.id);
    await service.flush();
    expect(wakes(beta).length).toBe(1);
    expect(wakes(beta)[0]!.body).toContain("crew_rebase");
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
  it("merges with --no-ff in the worktree that has main, and aborts on conflict", async () => {
    const calls: string[] = [];
    const git = createLocalGit(async (args, cwd) => {
      calls.push(`${cwd}: ${args.join(" ")}`);
      if (args[0] === "worktree") return { code: 0, stdout: "worktree /repo\nHEAD 1\nbranch refs/heads/main\n\nworktree /wt\nbranch refs/heads/bb/x\n", stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "merge" && args[1] === "--no-ff") return { code: 1, stdout: "CONFLICT (content): Merge conflict in a", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const outcome = await git.merge("/wt", "bb/x", "main", "m");
    expect(outcome).toMatchObject({ ok: false, conflict: true });
    expect(calls).toContain("/repo: merge --abort");
  });

  it("negative: a dirty main worktree is not merged into", async () => {
    const git = createLocalGit(async (args) => {
      if (args[0] === "worktree") return { code: 0, stdout: "worktree /repo\nbranch refs/heads/main\n", stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: " M a.txt\n", stderr: "" };
      throw new Error(`unexpected git ${args.join(" ")}`);
    });
    expect(await git.merge("/wt", "bb/x", "main", "m")).toMatchObject({ ok: false, conflict: false, detail: expect.stringContaining("uncommitted") });
  });
});

import { describe, expect, it } from "vitest";
import { deriveActivity, rowStatusFor, type ActivityInput } from "../lib/activity";
import type { GraphRun, GraphsRpc } from "../lib/graphs";
import type { ThreadInfo } from "../lib/thread-port";
import { running, setup } from "./helpers";

const mkRun = (overrides: Partial<GraphRun> & Pick<GraphRun, "id" | "status">): GraphRun => ({
  error: null,
  state: null,
  childThreadIds: [],
  pendingQuestion: null,
  ...overrides,
});

const thread = (overrides: Partial<ThreadInfo> = {}): ThreadInfo => ({
  id: "th_1",
  projectId: "p",
  providerId: "claude-code",
  parentThreadId: null,
  title: "x",
  status: "idle",
  archived: false,
  environmentId: "env",
  lastReadAt: 100,
  latestAttentionAt: 50,
  ...overrides,
});
const input = (overrides: Partial<ActivityInput> = {}): ActivityInput => ({
  thread: thread(),
  interactions: [],
  humanQuestion: null,
  stoppedLoops: 0,
  held: 0,
  ...overrides,
});

describe("activity axes", () => {
  it("thread axis: present, archived, missing — without a live thread activity is unknown", () => {
    expect(deriveActivity(input()).thread).toBe("present");
    expect(deriveActivity(input({ thread: thread({ archived: true }) }))).toMatchObject({ thread: "archived", activity: "unknown" });
    expect(deriveActivity(input({ thread: null }))).toMatchObject({ thread: "missing", activity: "unknown" });
  });

  it("working for every busy status, idle for idle, error for error", () => {
    for (const status of ["active", "pending", "starting", "stopping"]) {
      expect(deriveActivity(input({ thread: thread({ status }) })).activity).toBe("working");
    }
    expect(deriveActivity(input()).activity).toBe("idle");
    expect(deriveActivity(input({ thread: thread({ status: "error" }) }))).toMatchObject({ activity: "error", needsYou: ["error"] });
  });

  it("needs-you with its reason: approval, question, human question; negative: none without a reason", () => {
    expect(deriveActivity(input({ interactions: [{ id: "i", kind: "approval", title: "Run it?" }] }))).toMatchObject({
      activity: "needs-you",
      needsYou: ["approval"],
      question: "Run it?",
    });
    expect(deriveActivity(input({ interactions: [{ id: "i", kind: "user_question", title: "Which?" }] })).needsYou).toEqual(["question"]);
    expect(deriveActivity(input({ humanQuestion: { subject: "S", body: "B" } }))).toMatchObject({
      activity: "needs-you",
      needsYou: ["human-question"],
      question: "S: B",
    });
    expect(deriveActivity(input())).toMatchObject({ needsYou: [], question: null });
  });

  it("interactions of an archived thread do not count", () => {
    expect(deriveActivity(input({ thread: thread({ archived: true }), interactions: [{ id: "i", kind: "approval", title: "?" }] })).needsYou).toEqual([]);
  });

  it("a stopped loop needs you without changing the activity", () => {
    expect(deriveActivity(input({ stoppedLoops: 1 }))).toMatchObject({ activity: "idle", needsYou: ["loop"], diagnoses: ["Stopped: loop"] });
  });
});

describe("diagnoses", () => {
  it("On hold only with held messages", () => {
    expect(deriveActivity(input({ held: 2 })).diagnoses).toEqual(["On hold"]);
    expect(deriveActivity(input()).diagnoses).toEqual([]);
  });
  it("Unread result: idle and attention after the last read; negative: read, working, or never produced anything", () => {
    expect(deriveActivity(input({ thread: thread({ lastReadAt: 10, latestAttentionAt: 50 }) })).diagnoses).toEqual(["Unread result"]);
    expect(deriveActivity(input({ thread: thread({ lastReadAt: null, latestAttentionAt: 50 }) })).diagnoses).toEqual(["Unread result"]);
    expect(deriveActivity(input({ thread: thread({ lastReadAt: 60, latestAttentionAt: 50 }) })).diagnoses).toEqual([]);
    expect(deriveActivity(input({ thread: thread({ status: "active", lastReadAt: 10, latestAttentionAt: 50 }) })).diagnoses).toEqual([]);
    expect(deriveActivity(input({ thread: thread({ lastReadAt: null, latestAttentionAt: 0 }) })).diagnoses).toEqual([]);
  });
});

describe("row status icon", () => {
  it("error for Needs you, running while working, success for an unread result, nothing otherwise", () => {
    expect(rowStatusFor(deriveActivity(input({ stoppedLoops: 1 })))).toMatchObject({ tone: "error", label: "Needs you: loop" });
    expect(rowStatusFor(deriveActivity(input({ thread: thread({ status: "active" }) })))).toMatchObject({ tone: "running" });
    expect(rowStatusFor(deriveActivity(input({ thread: thread({ lastReadAt: 1 }) })))).toMatchObject({ tone: "success" });
    expect(rowStatusFor(deriveActivity(input()))).toBeNull();
  });
  it("Needs you outranks working", () => {
    const derived = deriveActivity(input({ thread: thread({ status: "active" }), humanQuestion: { subject: "s", body: "b" } }));
    expect(rowStatusFor(derived)!.tone).toBe("error");
  });
});

describe("activity tracker", () => {
  it("reconciles from threads.get and reports only real changes", async () => {
    const { service, port, store } = setup();
    const changes: string[] = [];
    const { threads, crew } = await running(service, port);
    // A tracker of its own, so the change log starts empty.
    const { createActivityTracker } = await import("../lib/activity");
    const tracker = createActivityTracker({ store, port, onChange: (view) => changes.push(`${view.key}:${view.activity}`) });
    await tracker.refreshAll();
    expect(changes.sort()).toEqual(["dev-impl:idle", "dev-review:idle", "orch-lead:idle"]);
    changes.length = 0;
    await tracker.refreshAll();
    expect(changes).toEqual([]);
    port.threads.get(threads["dev-impl"]!)!.status = "active";
    await tracker.refreshThread(threads["dev-impl"]!);
    expect(changes).toEqual(["dev-impl:working"]);
    expect(await tracker.refreshThread("th_unknown")).toBeNull();
    expect((await tracker.views(store.getCrew(crew.id)!)).map((view) => view.rowStatus?.tone ?? null)).toEqual([null, "running", null]);
  });

  it("held messages show as On hold on the recipient", async () => {
    const { service, port } = setup();
    const { self, threads } = await running(service, port);
    port.threads.get(threads["dev-impl"]!)!.interactions.push({ id: "i", kind: "approval", title: "ok?" });
    await service.send({ projectId: "proj_1", from: self("orch-lead"), to: "dev-impl", body: "x" });
    const view = (await service.activity.refreshAll()).find((v) => v.key === "dev-impl")!;
    expect(view).toMatchObject({ held: 1, activity: "needs-you", needsYou: ["approval"] });
    expect(view.diagnoses).toContain("On hold");
  });
});

describe("graph-approval on Needs you (BBP-32)", () => {
  it("positive: deriveActivity adds graph-approval and the question text", () => {
    const derived = deriveActivity(input({ graphQuestion: { runId: "run_1", graphId: "release", nodeId: "n1", question: "Ship it?" } }));
    expect(derived.needsYou).toContain("graph-approval");
    expect(derived.question).toContain("Ship it?");
  });

  it("positive: a run waiting on a human node shows up with its live question", async () => {
    const { service, port, store } = setup();
    const { crew, members } = await running(service, port);
    store.insertGraphRun({ runId: "run_1", crewId: crew.id, memberId: members["dev-impl"]!.id, graphId: "release", status: "running" });
    const rpc: GraphsRpc = {
      listGraphs: async () => [],
      startRun: async () => mkRun({ id: "x", status: "running" }),
      getRun: async (id) => mkRun({ id, status: "waiting-human", pendingQuestion: { nodeId: "n1", label: "Approve", question: "Ship it?" } }),
      stopRun: async (id) => mkRun({ id, status: "stopped" }),
    };
    const { createActivityTracker } = await import("../lib/activity");
    const tracker = createActivityTracker({ store, port, graphsRpc: rpc });
    const view = (await tracker.refreshAll()).find((v) => v.key === "dev-impl")!;
    expect(view.needsYou).toContain("graph-approval");
    expect(view.question).toContain("Ship it?");
    expect(view.graphQuestion).toEqual({ runId: "run_1", graphId: "release", nodeId: "n1", question: "Ship it?" });
    // The live status is also folded back into the stored row.
    expect(store.getGraphRun("run_1")!.status).toBe("waiting-human");
  });

  it("negative: once the run continues past the human node, the entry is gone", async () => {
    const { service, port, store } = setup();
    const { crew, members } = await running(service, port);
    store.insertGraphRun({ runId: "run_1", crewId: crew.id, memberId: members["dev-impl"]!.id, graphId: "release", status: "waiting-human" });
    const rpc: GraphsRpc = {
      listGraphs: async () => [],
      startRun: async () => mkRun({ id: "x", status: "running" }),
      getRun: async (id) => mkRun({ id, status: "running" }),
      stopRun: async (id) => mkRun({ id, status: "stopped" }),
    };
    const { createActivityTracker } = await import("../lib/activity");
    const tracker = createActivityTracker({ store, port, graphsRpc: rpc });
    const view = (await tracker.refreshAll()).find((v) => v.key === "dev-impl")!;
    expect(view.needsYou).not.toContain("graph-approval");
    expect(view.graphQuestion).toBeNull();
  });

  it("negative: a finished run never asks graph-studio again and is not an entry", async () => {
    const { service, port, store } = setup();
    const { crew, members } = await running(service, port);
    store.insertGraphRun({ runId: "run_1", crewId: crew.id, memberId: members["dev-impl"]!.id, graphId: "release", status: "done" });
    let calls = 0;
    const rpc: GraphsRpc = {
      listGraphs: async () => [],
      startRun: async () => mkRun({ id: "x", status: "running" }),
      getRun: async (id) => {
        calls += 1;
        return mkRun({ id, status: "waiting-human", pendingQuestion: { nodeId: "n1", label: "x", question: "still asks?" } });
      },
      stopRun: async (id) => mkRun({ id, status: "stopped" }),
    };
    const { createActivityTracker } = await import("../lib/activity");
    const tracker = createActivityTracker({ store, port, graphsRpc: rpc });
    const view = (await tracker.refreshAll()).find((v) => v.key === "dev-impl")!;
    expect(view.needsYou).not.toContain("graph-approval");
    expect(calls).toBe(0);
  });

  it("negative: no runs at all means no entry and no RPC calls", async () => {
    let calls = 0;
    const rpc: GraphsRpc = {
      listGraphs: async () => [],
      startRun: async () => mkRun({ id: "x", status: "running" }),
      getRun: async (id) => {
        calls += 1;
        return mkRun({ id, status: "waiting-human" });
      },
      stopRun: async (id) => mkRun({ id, status: "stopped" }),
    };
    const { service, port, store } = setup();
    await running(service, port);
    const { createActivityTracker } = await import("../lib/activity");
    const tracker = createActivityTracker({ store, port, graphsRpc: rpc });
    const view = (await tracker.refreshAll()).find((v) => v.key === "dev-impl")!;
    expect(view.needsYou).not.toContain("graph-approval");
    expect(view.graphRuns).toEqual([]);
    expect(calls).toBe(0);
  });

  it("negative: without a configured graphsRpc, graph-approval never fires even for a waiting run", async () => {
    const { service, port, store } = setup();
    const { crew, members } = await running(service, port);
    store.insertGraphRun({ runId: "run_1", crewId: crew.id, memberId: members["dev-impl"]!.id, graphId: "release", status: "waiting-human" });
    const view = (await service.activity.refreshAll()).find((v) => v.key === "dev-impl")!;
    expect(view.needsYou).not.toContain("graph-approval");
  });
});

describe("liveViews", () => {
  const v = (memberRow: string, threadId: string | null = "th") => ({ memberRow, threadId });
  it("keeps the views of members that exist and have a thread", async () => {
    const { liveViews } = await import("../lib/activity");
    expect(liveViews([v("m1"), v("m2")], new Set(["m1", "m2"])).map((x) => x.memberRow)).toEqual(["m1", "m2"]);
  });
  it("negative: a removed member's cached view and a view without thread are dropped", async () => {
    const { liveViews } = await import("../lib/activity");
    expect(liveViews([v("gone"), v("m1", null), v("m2")], new Set(["m1", "m2"])).map((x) => x.memberRow)).toEqual(["m2"]);
  });
});

import { describe, expect, it } from "vitest";
import { runToCompletion, type GraphRun, type GraphsRpc } from "../lib/graphs";

const mkRun = (overrides: Partial<GraphRun> & Pick<GraphRun, "id" | "status">): GraphRun => ({ error: null, state: null, childThreadIds: [], pendingQuestion: null, ...overrides });

function fakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    wait: async (ms: number) => {
      now += ms;
    },
  };
}

function fakeRpc(runs: GraphRun[]): Pick<GraphsRpc, "startRun" | "getRun"> {
  let polled = 0;
  return {
    // Mirrors graph-studio's real startRun, which throws without a parent thread (BBP-30 review fix).
    startRun: async (args) => {
      if (!args.threadId) throw new Error("A run needs a parent thread whose environment the workers inherit.");
      return runs[0]!;
    },
    getRun: async (id) => {
      polled += 1;
      const run = runs[Math.min(polled, runs.length - 1)]!;
      return { ...run, id };
    },
  };
}

describe("runToCompletion", () => {
  it("negative: startRun without threadId is refused (graph-studio needs a parent thread)", async () => {
    const rpc = fakeRpc([mkRun({ id: "run_1", status: "done" })]);
    const clock = fakeClock();
    await expect(
      runToCompletion(rpc, { graphId: "g", input: "hi", threadId: "", projectId: null }, { wait: clock.wait, now: clock.now }),
    ).rejects.toThrow(/parent thread/);
  });

  it("positive: a run already done on start needs no polling", async () => {
    const rpc = fakeRpc([mkRun({ id: "run_1", status: "done", state: { ok: true } })]);
    const clock = fakeClock();
    const { run, timedOut } = await runToCompletion(rpc, { graphId: "g", input: "hi", threadId: "th_1", projectId: "p" }, { wait: clock.wait, now: clock.now });
    expect(run.status).toBe("done");
    expect(timedOut).toBe(false);
  });

  it("positive: polls through running states to a terminal one", async () => {
    const rpc = fakeRpc([
      mkRun({ id: "run_1", status: "running" }),
      mkRun({ id: "run_1", status: "running" }),
      mkRun({ id: "run_1", status: "done", state: { collected: true } }),
    ]);
    const clock = fakeClock();
    const { run, timedOut } = await runToCompletion(rpc, { graphId: "g", input: "hi", threadId: "th_1", projectId: null }, { wait: clock.wait, now: clock.now, pollMs: 100 });
    expect(run.status).toBe("done");
    expect(run.state).toEqual({ collected: true });
    expect(timedOut).toBe(false);
  });

  it("negative: a failed run is reported, not retried further", async () => {
    const rpc = fakeRpc([mkRun({ id: "run_1", status: "failed", error: "node crashed" })]);
    const clock = fakeClock();
    const { run, timedOut } = await runToCompletion(rpc, { graphId: "g", input: "hi", threadId: "th_1", projectId: null }, { wait: clock.wait, now: clock.now });
    expect(run.status).toBe("failed");
    expect(run.error).toBe("node crashed");
    expect(timedOut).toBe(false);
  });

  it("negative: a run stuck running past the timeout is reported as timed out, run id intact", async () => {
    const rpc = fakeRpc([mkRun({ id: "run_1", status: "running" })]);
    const clock = fakeClock();
    const { run, timedOut } = await runToCompletion(
      rpc,
      { graphId: "g", input: "hi", threadId: "th_1", projectId: null },
      { wait: clock.wait, now: clock.now, pollMs: 1000, timeoutMs: 2500 },
    );
    expect(timedOut).toBe(true);
    expect(run.status).toBe("running");
    expect(run.id).toBe("run_1");
  });

  it("negative: getRun returning null mid-poll is a failure, not a silent success (the run vanished)", async () => {
    const rpc: Pick<GraphsRpc, "startRun" | "getRun"> = {
      startRun: async () => (mkRun({ id: "run_1", status: "running" })),
      getRun: async () => null,
    };
    const clock = fakeClock();
    const { run, timedOut } = await runToCompletion(rpc, { graphId: "g", input: "hi", threadId: "th_1", projectId: null }, { wait: clock.wait, now: clock.now });
    expect(timedOut).toBe(false);
    expect(run.status).toBe("failed");
    expect(run.id).toBe("run_1");
    expect(run.error).toMatch(/vanished/);
  });
});

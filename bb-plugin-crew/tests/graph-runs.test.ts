// BBP-31: a graph run linked back to the member/crew that started it —
// durable storage, activity, bb crew stop (cancel) and bb crew delete
// (worker thread cleanup).
import { describe, expect, it } from "vitest";
import type { GraphRun, GraphsRpc } from "../lib/graphs";
import { PROJECT, running, setup, trioYaml } from "./helpers";

const mkRun = (overrides: Partial<GraphRun> & Pick<GraphRun, "id" | "status">): GraphRun => ({ error: null, state: null, childThreadIds: [], ...overrides });

describe("store: graph_runs", () => {
  it("positive: insert, get, update status, list by member and by crew", () => {
    const { store } = setup();
    store.insertGraphRun({ runId: "run_1", crewId: "crew_1", memberId: "member_1", graphId: "release", status: "running" });
    expect(store.getGraphRun("run_1")).toMatchObject({ runId: "run_1", crewId: "crew_1", memberId: "member_1", graphId: "release", status: "running" });
    store.updateGraphRunStatus("run_1", "done");
    expect(store.getGraphRun("run_1")!.status).toBe("done");
    expect(store.listGraphRuns("member_1")).toHaveLength(1);
    expect(store.listGraphRuns("nobody")).toEqual([]);
    expect(store.listGraphRunsForCrew("crew_1")).toHaveLength(1);
  });

  it("positive: listOpenGraphRunsForCrew only returns non-terminal runs", () => {
    const { store } = setup();
    store.insertGraphRun({ runId: "run_open", crewId: "crew_1", memberId: "m", graphId: "g", status: "running" });
    store.insertGraphRun({ runId: "run_waiting", crewId: "crew_1", memberId: "m", graphId: "g", status: "waiting-human" });
    store.insertGraphRun({ runId: "run_done", crewId: "crew_1", memberId: "m", graphId: "g", status: "done" });
    store.insertGraphRun({ runId: "run_failed", crewId: "crew_1", memberId: "m", graphId: "g", status: "failed" });
    expect(store.listOpenGraphRunsForCrew("crew_1").map((row) => row.runId).sort()).toEqual(["run_open", "run_waiting"]);
  });

  it("negative: getGraphRun of an unknown id is null", () => {
    const { store } = setup();
    expect(store.getGraphRun("nope")).toBeNull();
  });
});

describe("activity: graphRuns surface a member's runs", () => {
  it("positive: open and finished runs both show on the member's activity view", async () => {
    const { service, port, store } = setup();
    const crew = await running(service, port);
    const member = crew.members["dev-impl"]!;
    store.insertGraphRun({ runId: "run_1", crewId: crew.crew.id, memberId: member.id, graphId: "release", status: "running" });
    const view = await service.activity.refreshMember(member);
    expect(view!.graphRuns).toEqual([{ runId: "run_1", graphId: "release", status: "running" }]);
  });

  it("negative: a member with no runs has an empty list", async () => {
    const { service, port } = setup();
    const crew = await running(service, port);
    const view = await service.activity.refreshMember(crew.members["dev-review"]!);
    expect(view!.graphRuns).toEqual([]);
  });
});

describe("service.graphs.run: records the run durably", () => {
  it("positive: onStart inserts the row, onPoll keeps its status current", async () => {
    const rpc: GraphsRpc = {
      listGraphs: async () => [{ id: "release", name: "Release" }],
      startRun: async () => mkRun({ id: "run_1", status: "running" }),
      getRun: async (id) => mkRun({ id, status: "done" }),
      stopRun: async (id) => mkRun({ id, status: "stopped" }),
    };
    const { service, port, store } = setup({ graphsRpc: rpc });
    const crew = await running(service, port);
    const member = crew.members["dev-impl"]!;
    const { run } = await service.graphs.run({
      graphId: "release",
      input: "go",
      threadId: crew.threads["dev-impl"]!,
      projectId: PROJECT,
      crewId: crew.crew.id,
      memberId: member.id,
    });
    expect(run.status).toBe("done");
    expect(store.getGraphRun("run_1")).toMatchObject({ memberId: member.id, crewId: crew.crew.id, graphId: "release", status: "done" });
  });

  it("negative: rejects without a configured graphsRpc, and records nothing", async () => {
    const { service, port, store } = setup({ graphsRpc: null });
    const crew = await running(service, port);
    await expect(
      service.graphs.run({ graphId: "release", input: "go", threadId: crew.threads["dev-impl"]!, projectId: PROJECT, crewId: crew.crew.id, memberId: crew.members["dev-impl"]!.id }),
    ).rejects.toThrow("not available");
    expect(store.listGraphRunsForCrew(crew.crew.id)).toEqual([]);
  });
});

describe("service.graphs.cancelOpen (bb crew stop)", () => {
  it("positive: stops every open run via the RPC and marks it stopped locally", async () => {
    const stopped: string[] = [];
    const rpc: GraphsRpc = {
      listGraphs: async () => [],
      startRun: async () => mkRun({ id: "x", status: "running" }),
      getRun: async (id) => mkRun({ id, status: "running" }),
      stopRun: async (id) => {
        stopped.push(id);
        return mkRun({ id, status: "stopped" });
      },
    };
    const { service, port, store } = setup({ graphsRpc: rpc });
    const crew = await running(service, port);
    store.insertGraphRun({ runId: "run_open", crewId: crew.crew.id, memberId: crew.members["dev-impl"]!.id, graphId: "release", status: "running" });
    store.insertGraphRun({ runId: "run_done", crewId: crew.crew.id, memberId: crew.members["dev-impl"]!.id, graphId: "release", status: "done" });
    const cancelled = await service.graphs.cancelOpen(crew.crew.id);
    expect(cancelled).toBe(1);
    expect(stopped).toEqual(["run_open"]);
    expect(store.getGraphRun("run_open")!.status).toBe("stopped");
    // negative: an already-done run is left alone, not re-stopped.
    expect(store.getGraphRun("run_done")!.status).toBe("done");
  });

  it("negative: no open runs means no RPC calls", async () => {
    let calls = 0;
    const rpc: GraphsRpc = {
      listGraphs: async () => [],
      startRun: async () => mkRun({ id: "x", status: "running" }),
      getRun: async (id) => mkRun({ id, status: "running" }),
      stopRun: async (id) => {
        calls += 1;
        return mkRun({ id, status: "stopped" });
      },
    };
    const { service, port } = setup({ graphsRpc: rpc });
    const crew = await running(service, port);
    expect(await service.graphs.cancelOpen(crew.crew.id)).toBe(0);
    expect(calls).toBe(0);
  });

  it("bb crew stop cancels the crew's open graph runs", async () => {
    const stopped: string[] = [];
    const rpc: GraphsRpc = {
      listGraphs: async () => [],
      startRun: async () => mkRun({ id: "x", status: "running" }),
      getRun: async (id) => mkRun({ id, status: "running" }),
      stopRun: async (id) => {
        stopped.push(id);
        return mkRun({ id, status: "stopped" });
      },
    };
    const { service, port, store } = setup({ graphsRpc: rpc });
    const crew = await running(service, port);
    store.insertGraphRun({ runId: "run_open", crewId: crew.crew.id, memberId: crew.members["dev-impl"]!.id, graphId: "release", status: "running" });
    await service.stop(store.getCrew(crew.crew.id)!);
    expect(stopped).toEqual(["run_open"]);
  });
});

describe("service.graphs.workerThreadIds and bb crew delete", () => {
  it("positive: collects childThreadIds across every run of the crew, done or open", async () => {
    const rpc: GraphsRpc = {
      listGraphs: async () => [],
      startRun: async () => mkRun({ id: "x", status: "running" }),
      getRun: async (id) =>
        id === "run_1"
          ? mkRun({ id, status: "done", childThreadIds: ["thr_worker_1", "thr_worker_2"] })
          : mkRun({ id, status: "running", childThreadIds: ["thr_worker_3"] }),
      stopRun: async (id) => mkRun({ id, status: "stopped" }),
    };
    const { service, port, store } = setup({ graphsRpc: rpc });
    const crew = await running(service, port);
    store.insertGraphRun({ runId: "run_1", crewId: crew.crew.id, memberId: crew.members["dev-impl"]!.id, graphId: "release", status: "done" });
    store.insertGraphRun({ runId: "run_2", crewId: crew.crew.id, memberId: crew.members["dev-impl"]!.id, graphId: "release", status: "running" });
    const ids = await service.graphs.workerThreadIds(crew.crew.id);
    expect(ids.sort()).toEqual(["thr_worker_1", "thr_worker_2", "thr_worker_3"]);
  });

  it("negative: a run graph-studio can no longer report on contributes nothing, best-effort", async () => {
    const rpc: GraphsRpc = {
      listGraphs: async () => [],
      startRun: async () => mkRun({ id: "x", status: "running" }),
      getRun: async () => {
        throw new Error("gone");
      },
      stopRun: async (id) => mkRun({ id, status: "stopped" }),
    };
    const { service, port, store } = setup({ graphsRpc: rpc });
    const crew = await running(service, port);
    store.insertGraphRun({ runId: "run_1", crewId: crew.crew.id, memberId: crew.members["dev-impl"]!.id, graphId: "release", status: "done" });
    expect(await service.graphs.workerThreadIds(crew.crew.id)).toEqual([]);
  });

  it("negative: no runs at all means no worker threads and no RPC calls", async () => {
    let calls = 0;
    const rpc: GraphsRpc = {
      listGraphs: async () => [],
      startRun: async () => mkRun({ id: "x", status: "running" }),
      getRun: async (id) => {
        calls += 1;
        return mkRun({ id, status: "done" });
      },
      stopRun: async (id) => mkRun({ id, status: "stopped" }),
    };
    const { service, port } = setup({ graphsRpc: rpc });
    const crew = await running(service, port);
    expect(await service.graphs.workerThreadIds(crew.crew.id)).toEqual([]);
    expect(calls).toBe(0);
  });

  it("bb crew delete --threads delete also deletes the graph run worker threads", async () => {
    const rpc: GraphsRpc = {
      listGraphs: async () => [],
      startRun: async () => mkRun({ id: "x", status: "running" }),
      getRun: async (id) => mkRun({ id, status: "done", childThreadIds: ["thr_worker_1"] }),
      stopRun: async (id) => mkRun({ id, status: "stopped" }),
    };
    const { service, port, store } = setup({ graphsRpc: rpc });
    const crew = await running(service, port, trioYaml());
    store.insertGraphRun({ runId: "run_1", crewId: crew.crew.id, memberId: crew.members["dev-impl"]!.id, graphId: "release", status: "done" });
    port.addForeign({ id: "thr_worker_1", projectId: PROJECT, parentThreadId: null });
    await service.stop(store.getCrew(crew.crew.id)!);
    const result = await service.delete(store.getCrew(crew.crew.id)!, { threads: "delete" });
    expect(port.threads.has("thr_worker_1")).toBe(false);
    expect(result.warnings).toContain("deleted 1 graph run worker thread(s)");
  });

  it("negative: archive mode does not touch graph run worker threads", async () => {
    const rpc: GraphsRpc = {
      listGraphs: async () => [],
      startRun: async () => mkRun({ id: "x", status: "running" }),
      getRun: async (id) => mkRun({ id, status: "done", childThreadIds: ["thr_worker_1"] }),
      stopRun: async (id) => mkRun({ id, status: "stopped" }),
    };
    const { service, port, store } = setup({ graphsRpc: rpc });
    const crew = await running(service, port, trioYaml());
    store.insertGraphRun({ runId: "run_1", crewId: crew.crew.id, memberId: crew.members["dev-impl"]!.id, graphId: "release", status: "done" });
    port.addForeign({ id: "thr_worker_1", projectId: PROJECT, parentThreadId: null });
    await service.stop(store.getCrew(crew.crew.id)!);
    await service.delete(store.getCrew(crew.crew.id)!);
    expect(port.threads.has("thr_worker_1")).toBe(true);
  });
});

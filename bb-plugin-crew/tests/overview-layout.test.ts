import { describe, expect, it } from "vitest";
import { buildOverviewGraph, crewNodeId, filterOverviewGraph, taskNodeId, type OverviewSource } from "../lib/overview-graph";
import { CREW_H, CREW_W, layoutOverview, TASK_H, TASK_W } from "../lib/overview-layout";

function source(): OverviewSource {
  return {
    crews: [
      { name: "alpha", status: "running", summary: "", task: "BBP-1", branch: null, needsYou: 0, members: [] },
      { name: "beta", status: "idle", summary: "", task: null, branch: null, needsYou: 0, members: [] },
    ],
    leadLinks: [],
    dependencies: [],
  };
}

describe("layoutOverview", () => {
  it("places one frame per project with crews in a row below the tasks", () => {
    const graph = buildOverviewGraph([{ id: "p1", name: "P1" }], new Map([["p1", source()]]));
    const all = new Set(graph.nodes.map((node) => node.id));
    const layout = layoutOverview(graph, all);
    expect(layout.frames).toHaveLength(1);
    const task = layout.placed.find((placed) => placed.id === taskNodeId("p1", "BBP-1"))!;
    const alpha = layout.placed.find((placed) => placed.id === crewNodeId("p1", "alpha"))!;
    const beta = layout.placed.find((placed) => placed.id === crewNodeId("p1", "beta"))!;
    expect(task.width).toBe(TASK_W);
    expect(alpha.width).toBe(CREW_W);
    expect(alpha.height).toBe(CREW_H);
    expect(task.height).toBe(TASK_H);
    // The task sits above the crew row.
    expect(task.y).toBeLessThan(alpha.y);
    // Crews sit side by side, not stacked.
    expect(beta.x).toBeGreaterThan(alpha.x);
    expect(beta.y).toBe(alpha.y);
  });

  it("lays frames out left to right for several projects", () => {
    const graph = buildOverviewGraph(
      [{ id: "p1", name: "P1" }, { id: "p2", name: "P2" }],
      new Map([["p1", source()], ["p2", source()]]),
    );
    const all = new Set(graph.nodes.map((node) => node.id));
    const layout = layoutOverview(graph, all);
    expect(layout.frames).toHaveLength(2);
    expect(layout.frames[1]!.x).toBeGreaterThan(layout.frames[0]!.x + layout.frames[0]!.width);
  });

  it("skips a project with nothing visible, and shrinks a frame when some nodes are filtered out", () => {
    const graph = buildOverviewGraph([{ id: "p1", name: "P1" }], new Map([["p1", source()]]));
    const filtered = filterOverviewGraph(graph, { projectIds: null, showCrews: true, showTasks: false, showDone: true, search: "" });
    const layout = layoutOverview(graph, filtered.visible);
    expect(layout.frames).toHaveLength(1);
    expect(layout.placed.some((placed) => placed.node.kind === "task")).toBe(false);
  });

  it("produces an empty layout when nothing is visible", () => {
    const graph = buildOverviewGraph([{ id: "p1", name: "P1" }], new Map([["p1", source()]]));
    const layout = layoutOverview(graph, new Set());
    expect(layout.frames).toHaveLength(0);
    expect(layout.placed).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildOverviewGraph,
  crewNodeId,
  filterOverviewGraph,
  taskNodeId,
  visibleOverviewEdges,
  type OverviewSource,
  type OverviewGraph,
} from "../lib/overview-graph";

function source(overrides: Partial<OverviewSource> = {}): OverviewSource {
  return {
    crews: [
      { name: "alpha", status: "running", summary: "", task: "BBP-1", branch: "bb/alpha", needsYou: 0, members: [{ key: "alpha-lead", lead: true, activity: "working" }], labelTasks: [] },
      { name: "beta", status: "idle", summary: "", task: null, branch: "bb/beta", needsYou: 1, members: [{ key: "beta-lead", lead: true, activity: "idle" }], labelTasks: [] },
    ],
    leadLinks: [{ from: "alpha", to: "beta", count: 3 }],
    dependencies: [{ crew: "beta", task: "BBP-2", until: "done", state: "open", source: null }],
    ...overrides,
  };
}

describe("buildOverviewGraph", () => {
  it("maps crews and their own ticket into nodes, with a task→crew edge", () => {
    const graph = buildOverviewGraph([{ id: "p1", name: "Project One" }], new Map([["p1", source()]]));
    const alpha = crewNodeId("p1", "alpha");
    const task = taskNodeId("p1", "BBP-1");
    expect(graph.nodes.find((node) => node.id === alpha)).toMatchObject({ kind: "crew", name: "alpha", status: "running" });
    expect(graph.nodes.find((node) => node.id === task)).toMatchObject({ kind: "task", key: "BBP-1", done: false });
    expect(graph.edges).toContainEqual(expect.objectContaining({ kind: "task-crew", from: task, to: alpha, active: true }));
  });

  it("marks a task→crew edge inactive when the crew isn't working", () => {
    const graph = buildOverviewGraph([{ id: "p1", name: "P" }], new Map([["p1", source()]]));
    const beta = crewNodeId("p1", "beta");
    const dep = taskNodeId("p1", "BBP-2");
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: dep, to: beta, active: true })); // state: "open"
  });

  it("marks a dependency done when its state is settled, and reuses the task node", () => {
    const graph = buildOverviewGraph(
      [{ id: "p1", name: "P" }],
      new Map([["p1", source({ dependencies: [{ crew: "beta", task: "BBP-2", until: "done", state: "merged", source: null }] })]]),
    );
    const dep = graph.nodes.find((node) => node.id === taskNodeId("p1", "BBP-2"));
    expect(dep).toMatchObject({ done: true });
  });

  it("builds lead↔lead edges between crews of the same project", () => {
    const graph = buildOverviewGraph([{ id: "p1", name: "P" }], new Map([["p1", source()]]));
    expect(graph.edges).toContainEqual(expect.objectContaining({ kind: "lead-lead", from: crewNodeId("p1", "alpha"), to: crewNodeId("p1", "beta"), count: 3 }));
  });

  it("ignores a lead link naming a crew that doesn't exist", () => {
    const graph = buildOverviewGraph(
      [{ id: "p1", name: "P" }],
      new Map([["p1", source({ leadLinks: [{ from: "alpha", to: "ghost", count: 1 }] })]]),
    );
    expect(graph.edges.some((edge) => edge.kind === "lead-lead")).toBe(false);
  });

  it("summarises crew and task counts per project, and handles a project with no overview yet", () => {
    const graph = buildOverviewGraph(
      [{ id: "p1", name: "P1" }, { id: "p2", name: "P2" }],
      new Map([["p1", source()]]),
    );
    expect(graph.projects).toMatchObject([
      { id: "p1", name: "P1", crewCount: 2, taskCount: 2 },
      { id: "p2", name: "P2", crewCount: 0, taskCount: 0 },
    ]);
  });

  it("keeps project, crew and task ordering stable", () => {
    const graph = buildOverviewGraph([{ id: "p1", name: "P" }], new Map([["p1", source()]]));
    expect(graph.nodes.map((node) => node.id)).toEqual([
      crewNodeId("p1", "alpha"),
      crewNodeId("p1", "beta"),
      taskNodeId("p1", "BBP-1"),
      taskNodeId("p1", "BBP-2"),
    ]);
  });
});

describe("buildOverviewGraph: label-assigned tasks (crew-<crew> label, no crew.task)", () => {
  it("draws an active task→crew edge for a label task whose ticket is in_progress", () => {
    const graph = buildOverviewGraph(
      [{ id: "p1", name: "P" }],
      new Map([["p1", source({ crews: [{ name: "gamma", status: "idle", summary: "", task: null, branch: null, needsYou: 0, members: [], labelTasks: [{ key: "BBP-84", title: "Label edge", status: "in_progress" }] }] })]]),
    );
    const gamma = crewNodeId("p1", "gamma");
    const task = taskNodeId("p1", "BBP-84");
    expect(graph.nodes.find((node) => node.id === task)).toMatchObject({ kind: "task", key: "BBP-84", title: "Label edge", done: false });
    expect(graph.edges).toContainEqual(expect.objectContaining({ kind: "task-crew", from: task, to: gamma, active: true }));
  });

  it("marks the task done once the ticket is done or canceled, inactive edge", () => {
    const graph = buildOverviewGraph(
      [{ id: "p1", name: "P" }],
      new Map([["p1", source({ crews: [{ name: "gamma", status: "idle", summary: "", task: null, branch: null, needsYou: 0, members: [], labelTasks: [{ key: "BBP-84", title: "Label edge", status: "done" }] }] })]]),
    );
    const task = graph.nodes.find((node) => node.id === taskNodeId("p1", "BBP-84"));
    expect(task).toMatchObject({ done: true });
    expect(graph.edges).toContainEqual(expect.objectContaining({ active: false }));
  });

  it("dedupes with the crew.task edge when the label task is the same ticket", () => {
    const graph = buildOverviewGraph(
      [{ id: "p1", name: "P" }],
      new Map([
        [
          "p1",
          source({
            crews: [{ name: "alpha", status: "running", summary: "", task: "BBP-1", branch: "bb/alpha", needsYou: 0, members: [{ key: "alpha-lead", lead: true, activity: "working" }], labelTasks: [{ key: "BBP-1", title: "Alpha ticket", status: "in_progress" }] }],
          }),
        ],
      ]),
    );
    const alpha = crewNodeId("p1", "alpha");
    const task = taskNodeId("p1", "BBP-1");
    expect(graph.edges.filter((edge) => edge.kind === "task-crew" && edge.from === task && edge.to === alpha)).toHaveLength(1);
  });

  it("skips crews with no label tasks", () => {
    const graph = buildOverviewGraph([{ id: "p1", name: "P" }], new Map([["p1", source()]]));
    expect(graph.projects[0]).toMatchObject({ taskCount: 2 });
  });
});

describe("filterOverviewGraph", () => {
  const graph: OverviewGraph = buildOverviewGraph([{ id: "p1", name: "P1" }, { id: "p2", name: "P2" }], new Map([["p1", source()], ["p2", source()]]));

  it("shows everything with the default filters", () => {
    const filtered = filterOverviewGraph(graph, { projectIds: null, showCrews: true, showTasks: true, showDone: true, search: "" });
    expect(filtered.visible.size).toBe(graph.nodes.length);
    expect(filtered.focus).toEqual([]);
  });

  it("narrows to one project via the chip set", () => {
    const filtered = filterOverviewGraph(graph, { projectIds: new Set(["p1"]), showCrews: true, showTasks: true, showDone: true, search: "" });
    expect([...filtered.visible].every((id) => id.includes(":p1:"))).toBe(true);
    expect(filtered.visible.size).toBeGreaterThan(0);
  });

  it("hides crews when the Crews toggle is off", () => {
    const filtered = filterOverviewGraph(graph, { projectIds: null, showCrews: false, showTasks: true, showDone: true, search: "" });
    expect([...filtered.visible].some((id) => id.startsWith("crew:"))).toBe(false);
  });

  it("hides tasks when the Tasks toggle is off", () => {
    const filtered = filterOverviewGraph(graph, { projectIds: null, showCrews: true, showTasks: false, showDone: true, search: "" });
    expect([...filtered.visible].some((id) => id.startsWith("task:"))).toBe(false);
  });

  it("hides done tasks when the Done toggle is off, but keeps open ones", () => {
    const withDone = buildOverviewGraph(
      [{ id: "p1", name: "P1" }],
      new Map([["p1", source({ dependencies: [{ crew: "beta", task: "BBP-2", until: "done", state: "merged", source: null }] })]]),
    );
    const filtered = filterOverviewGraph(withDone, { projectIds: null, showCrews: true, showTasks: true, showDone: false, search: "" });
    expect(filtered.visible.has(taskNodeId("p1", "BBP-2"))).toBe(false);
    expect(filtered.visible.has(taskNodeId("p1", "BBP-1"))).toBe(true);
  });

  it("matches and focuses search hits across crew name, branch, member key and task key", () => {
    const filtered = filterOverviewGraph(graph, { projectIds: null, showCrews: true, showTasks: true, showDone: true, search: "beta-lead" });
    expect(filtered.matched.has(crewNodeId("p1", "beta"))).toBe(true);
    expect(filtered.matched.has(crewNodeId("p2", "beta"))).toBe(true);
    expect([...filtered.focus].sort()).toEqual([crewNodeId("p1", "beta"), crewNodeId("p2", "beta")].sort());
  });

  it("is case-insensitive and matches a task key", () => {
    const filtered = filterOverviewGraph(graph, { projectIds: null, showCrews: true, showTasks: true, showDone: true, search: "bbp-1" });
    expect(filtered.matched.has(taskNodeId("p1", "BBP-1"))).toBe(true);
  });
});

describe("visibleOverviewEdges", () => {
  it("drops an edge whose endpoint got filtered out", () => {
    const graph = buildOverviewGraph([{ id: "p1", name: "P" }], new Map([["p1", source()]]));
    const visible = new Set(graph.nodes.filter((node) => node.kind === "crew").map((node) => node.id));
    const edges = visibleOverviewEdges(graph, visible);
    expect(edges.some((edge) => edge.kind === "task-crew")).toBe(false);
    expect(edges.some((edge) => edge.kind === "lead-lead")).toBe(true);
  });
});

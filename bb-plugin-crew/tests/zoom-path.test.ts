import { describe, expect, it } from "vitest";
import { breadcrumb, zoomLevel, zoomOut, type ZoomPath } from "../lib/zoom-path";
import { buildOverviewGraph, crewNodeId, type OverviewSource } from "../lib/overview-graph";
import { layoutOverview, MAX_CREWS_PER_ROW, MAX_ROW_WIDTH } from "../lib/overview-layout";

const all: ZoomPath = {};
const project: ZoomPath = { projectId: "p1" };
const crew: ZoomPath = { projectId: "p1", crew: "factory-4" };
const agent: ZoomPath = { projectId: "p1", crew: "factory-4", member: "dev-impl" };

describe("zoom path (BBP-83)", () => {
  it("names the four levels: projects, project, crew, agent", () => {
    expect([all, project, crew, agent].map(zoomLevel)).toEqual([0, 1, 2, 3]);
  });

  it("Esc goes exactly one level up; negative: at the top it stays at the top", () => {
    expect(zoomOut(agent)).toEqual(crew);
    expect(zoomOut(crew)).toEqual(project);
    expect(zoomOut(project)).toEqual(all);
    expect(zoomOut(all)).toEqual(all);
  });

  it("the breadcrumb lists every level down to the current one, with the project's name", () => {
    expect(breadcrumb(agent, (id) => (id === "p1" ? "bb-plugins" : id)).map((step) => step.label)).toEqual(["All", "bb-plugins", "factory-4", "dev-impl"]);
    expect(breadcrumb(agent, () => "x").map((step) => step.path)).toEqual([all, project, crew, agent]);
  });

  it("negative: at the top the breadcrumb is only All", () => {
    expect(breadcrumb(all, () => "x").map((step) => step.label)).toEqual(["All"]);
  });
});

function crews(count: number, overrides: Partial<OverviewSource["crews"][number]> = {}): OverviewSource {
  return {
    crews: Array.from({ length: count }, (_, i) => ({ name: `c${i}`, status: "idle", summary: "", task: null, branch: null, needsYou: 0, members: [], labelTasks: [], ...overrides })),
    leadLinks: [],
    dependencies: [],
  };
}

describe("project clusters (BBP-83)", () => {
  it("a cluster counts its running crews and the crews that wait on you", () => {
    const base = crews(3);
    const source = { ...base, crews: [{ ...base.crews[0]!, status: "running" }, { ...base.crews[1]!, status: "running", needsYou: 2 }, base.crews[2]!] };
    const graph = buildOverviewGraph([{ id: "p1", name: "P1" }], new Map([["p1", source]]));
    expect(graph.projects[0]).toMatchObject({ crewCount: 3, runningCount: 2, needsYouCount: 1 });
  });

  it("negative: an idle project counts nothing running and nothing waiting", () => {
    const graph = buildOverviewGraph([{ id: "p1", name: "P1" }], new Map([["p1", crews(2)]]));
    expect(graph.projects[0]).toMatchObject({ runningCount: 0, needsYouCount: 0 });
  });

  it("wraps a project's crews into rows, so ten crews do not make one thin strip", () => {
    const graph = buildOverviewGraph([{ id: "p1", name: "P1" }], new Map([["p1", crews(10)]]));
    const layout = layoutOverview(graph, new Set(graph.nodes.map((node) => node.id)));
    const ys = new Set(layout.placed.map((placed) => placed.y));
    expect(ys.size).toBe(Math.ceil(10 / MAX_CREWS_PER_ROW));
    const first = layout.placed.find((placed) => placed.id === crewNodeId("p1", "c0"))!;
    const wrapped = layout.placed.find((placed) => placed.id === crewNodeId("p1", `c${MAX_CREWS_PER_ROW}`))!;
    expect(wrapped.x).toBe(first.x);
    expect(wrapped.y).toBeGreaterThan(first.y);
  });

  it("negative: up to a row's worth of crews stay on one row", () => {
    const graph = buildOverviewGraph([{ id: "p1", name: "P1" }], new Map([["p1", crews(MAX_CREWS_PER_ROW)]]));
    const layout = layoutOverview(graph, new Set(graph.nodes.map((node) => node.id)));
    expect(new Set(layout.placed.map((placed) => placed.y)).size).toBe(1);
  });

  it("wraps frames onto a new row past the row width; negative: two small frames share a row", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
    const graph = buildOverviewGraph(many, new Map(many.map((p) => [p.id, crews(MAX_CREWS_PER_ROW)])));
    const layout = layoutOverview(graph, new Set(graph.nodes.map((node) => node.id)));
    expect(new Set(layout.frames.map((frame) => frame.y)).size).toBeGreaterThan(1);
    expect(Math.max(...layout.frames.map((frame) => frame.x + frame.width))).toBeLessThanOrEqual(MAX_ROW_WIDTH);
    const two = layoutOverview(
      buildOverviewGraph(many.slice(0, 2), new Map(many.slice(0, 2).map((p) => [p.id, crews(1)]))),
      new Set(buildOverviewGraph(many.slice(0, 2), new Map(many.slice(0, 2).map((p) => [p.id, crews(1)]))).nodes.map((node) => node.id)),
    );
    expect(two.frames[0]!.y).toBe(two.frames[1]!.y);
  });
});

describe("expanded crew in the layout (BBP-83)", () => {
  it("a crew given a larger size pushes its row neighbour right and the next row down", () => {
    const graph = buildOverviewGraph([{ id: "p1", name: "P1" }], new Map([["p1", crews(MAX_CREWS_PER_ROW + 1)]]));
    const visible = new Set(graph.nodes.map((node) => node.id));
    const plain = layoutOverview(graph, visible);
    const big = layoutOverview(graph, visible, new Map([[crewNodeId("p1", "c0"), { width: 900, height: 600 }]]));
    const at = (layout: typeof plain, name: string) => layout.placed.find((placed) => placed.id === crewNodeId("p1", name))!;
    expect(at(big, "c0")).toMatchObject({ width: 900, height: 600 });
    expect(at(big, "c1").x).toBeGreaterThan(at(plain, "c1").x);
    expect(at(big, `c${MAX_CREWS_PER_ROW}`).y).toBeGreaterThan(at(plain, `c${MAX_CREWS_PER_ROW}`).y);
  });

  it("negative: without sizes the layout is unchanged", () => {
    const graph = buildOverviewGraph([{ id: "p1", name: "P1" }], new Map([["p1", crews(4)]]));
    const visible = new Set(graph.nodes.map((node) => node.id));
    expect(layoutOverview(graph, visible, new Map())).toEqual(layoutOverview(graph, visible));
  });
});

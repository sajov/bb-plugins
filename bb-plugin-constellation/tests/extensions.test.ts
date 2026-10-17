// BBP-190: crews from the crew plugin hang into the canvas's own tree.
import { describe, expect, it, vi } from "vitest";
import { collectLayers } from "../lib/extensions";
import { mergeExtensions } from "../lib/merge-extensions";
import type { CanvasNode } from "../vendor/bb-canvas/lib/types";

const base = {
  nodes: [
    { id: "agents", kind: "agents", label: "Agents", parentId: null },
    { id: "project:p1", kind: "project", label: "Shop", parentId: "agents" },
    { id: "thread:t1", kind: "thread", label: "lead@factory-1", parentId: "project:p1", meta: { threadId: "t1" } },
    { id: "thread:t2", kind: "thread", label: "Plain chat", parentId: "project:p1", meta: { threadId: "t2" } },
  ] as CanvasNode[],
  edges: [],
  expanded: ["agents", "project:p1"],
};

const crew = {
  nodes: [
    { id: "crew:f1", kind: "crew", label: "factory-1", parentId: "project:p1", meta: { crew: "factory-1" } },
    { id: "member:lead@f1", kind: "member", label: "lead", status: "running", parentId: "crew:f1", meta: { threadId: "t1", lead: true, activity: "working" } },
    { id: "member:impl@f1", kind: "member", label: "impl", parentId: "crew:f1", meta: { threadId: "t3" } },
    { id: "crew:elsewhere", kind: "crew", label: "other", parentId: "project:p9", meta: {} },
  ],
  edges: [{ from: "member:lead@f1", to: "member:impl@f1", variant: "message", relation: true }],
  expanded: ["crew:f1"],
  frames: [{ id: "frame:factory-1", parentId: null, label: "factory-1" }],
};

describe("mergeExtensions", () => {
  const merged = mergeExtensions(base, crew, new Map([["t1", { providerId: "claude-code", status: "active" }]]));
  const byId = new Map(merged.nodes.map((node) => [node.id, node]));

  it("draws a member that runs in a thread as that thread, under its crew — one card, not two", () => {
    expect(merged.nodes.filter((node) => node.id === "thread:t1")).toHaveLength(1);
    expect(byId.get("thread:t1")).toMatchObject({ kind: "thread", parentId: "crew:f1", label: "lead", status: "running" });
    expect(byId.get("thread:t1")!.meta).toMatchObject({ member: true, threadId: "t1", provider: "claude-code" });
  });

  it("keeps the overview's other threads and adds the crew under its project", () => {
    expect(byId.get("thread:t2")?.parentId).toBe("project:p1");
    expect(byId.get("crew:f1")?.parentId).toBe("project:p1");
  });

  it("leaves out a crew of a project the overview does not show", () => {
    expect(byId.has("crew:elsewhere")).toBe(false);
  });

  it("renames the crew's links to the threads, and counts crews on the project", () => {
    expect(merged.edges).toContainEqual(expect.objectContaining({ from: "thread:t1", to: "thread:t3" }));
    expect(byId.get("project:p1")!.meta).toMatchObject({ crews: 1 });
    expect(merged.frames).toHaveLength(1);
    expect(merged.expanded).toContain("crew:f1");
  });

  it("changes nothing without a layer", () => {
    expect(mergeExtensions(base, null).nodes).toHaveLength(4);
  });
});

describe("collectLayers", () => {
  const layer = { contractVersion: 3, nodes: [{ id: "crew:a" }], edges: [], expanded: [], frames: [] };

  it("asks an active extension for every project and merges the answers", async () => {
    const call = vi.fn(async () => layer);
    const result = await collectLayers(["p1", "p2"], new Set(["crew"]), call);
    expect(call).toHaveBeenCalledTimes(2);
    expect(result.nodes).toHaveLength(2);
    expect(result.sources).toEqual(["crew"]);
  });

  it("skips an extension that is not running, and survives a failing one", async () => {
    expect((await collectLayers(["p1"], new Set(), vi.fn())).nodes).toHaveLength(0);
    const failing = await collectLayers(["p1"], new Set(["crew"]), async () => {
      throw new Error("503");
    });
    expect(failing).toMatchObject({ nodes: [], sources: [] });
  });
});

describe("graph runs from Graph Studio (BBP-191)", () => {
  const runs = {
    nodes: [
      { id: "graph-run:r1", kind: "graph-run", label: "review-flow", status: "running", parentId: "thread:t2", meta: { fallbackParentId: "project:p1" } },
      { id: "graph-run:r2", kind: "graph-run", label: "old-flow", parentId: "thread:gone", meta: { fallbackParentId: "project:p1" } },
    ],
    edges: [],
    expanded: [],
    frames: [],
  };
  const merged = mergeExtensions(base, runs);
  const byId = new Map(merged.nodes.map((node) => [node.id, node]));

  it("hangs a run under the thread it was started from", () => {
    expect(byId.get("graph-run:r1")?.parentId).toBe("thread:t2");
  });

  it("falls back to the project when that thread is not in view, and counts runs apart", () => {
    expect(byId.get("graph-run:r2")?.parentId).toBe("project:p1");
    expect(byId.get("project:p1")!.meta).toMatchObject({ runs: 1, crews: 0 });
  });

  it("passes the window start on to the extensions", async () => {
    const call = vi.fn(async () => ({ nodes: [], edges: [], expanded: [], frames: [] }));
    await collectLayers(["p1"], new Set(["graph-studio"]), call, 1000);
    expect(call).toHaveBeenCalledWith("graph-studio", "canvasExtensionLayer", { projectId: "p1", sinceMs: 1000 });
  });
});

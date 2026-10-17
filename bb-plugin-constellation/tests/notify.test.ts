// BBP-174 spike 2: notify prototype with caller verification.
//
// Uses the real SDK testing harness (createFakePluginHost), not a hand-rolled
// stand-in: `harness.callRpc(method, input, options)` validates input/output
// like the real host and sets `experimental_caller` exactly the way
// `bb.sdk.plugins.callRpc` would server-side per the SDK docs (SDK >= 0.6.15;
// the 0.5.29 used by crew/graph-studio has no such mechanism — that was the
// Spike 1 finding).
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCanvasNotify, startPollingFallback, type ReloadTracker } from "../lib/notify";

function setup() {
  const { bb, harness } = createFakePluginHost();
  const reloads: { pluginId: string; scope: unknown }[] = [];
  const tracker: ReloadTracker = {
    reload: (pluginId, scope) => {
      reloads.push({ pluginId, scope });
    },
  };
  registerCanvasNotify(bb, tracker, { knownExtensions: new Set(["crew"]) });
  return { harness, reloads };
}

describe("canvas.notify caller verification (BBP-174 Spike 2, criterion 3)", () => {
  it("accepts a real plugin call with a matching pluginId and triggers a reload", async () => {
    const { harness, reloads } = setup();
    const result = await harness.callRpc("canvas.notify", { pluginId: "crew" }, { experimental_caller: { kind: "plugin", pluginId: "crew" } });
    expect(result).toEqual({ accepted: true });
    await vi.waitFor(() => expect(reloads).toEqual([{ pluginId: "crew", scope: undefined }]));
  });

  it("negative: rejects a spoofed call (caller claims a different pluginId than it is) and triggers no reload", async () => {
    const { harness, reloads } = setup();
    const result = await harness.callRpc("canvas.notify", { pluginId: "crew" }, { experimental_caller: { kind: "plugin", pluginId: "evil" } });
    expect(result).toEqual({ accepted: false });
    expect(reloads).toEqual([]);
  });

  it("negative: rejects a call with no plugin identity (kind: client, e.g. straight from the UI or the CLI)", async () => {
    const { harness, reloads } = setup();
    const result = await harness.callRpc("canvas.notify", { pluginId: "crew" }, { experimental_caller: { kind: "client" } });
    expect(result).toEqual({ accepted: false });
    expect(reloads).toEqual([]);
  });

  it("negative: rejects an extension not registered with the canvas, even with a genuine caller identity", async () => {
    const { harness, reloads } = setup();
    const result = await harness.callRpc("canvas.notify", { pluginId: "unregistered" }, { experimental_caller: { kind: "plugin", pluginId: "unregistered" } });
    expect(result).toEqual({ accepted: false });
    expect(reloads).toEqual([]);
  });
});

describe("debounce (600ms, BBP-174 Spike 2)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("collapses several notifies for the same plugin/scope within 600ms into one reload", async () => {
    const { harness, reloads } = setup();
    const caller = { experimental_caller: { kind: "plugin" as const, pluginId: "crew" } };
    void harness.callRpc("canvas.notify", { pluginId: "crew" }, caller);
    await vi.advanceTimersByTimeAsync(200);
    void harness.callRpc("canvas.notify", { pluginId: "crew" }, caller);
    await vi.advanceTimersByTimeAsync(200);
    void harness.callRpc("canvas.notify", { pluginId: "crew" }, caller);
    await vi.advanceTimersByTimeAsync(600);
    expect(reloads).toEqual([{ pluginId: "crew", scope: undefined }]);
  });

  it("negative: two notifies more than 600ms apart trigger two reloads", async () => {
    const { harness, reloads } = setup();
    const caller = { experimental_caller: { kind: "plugin" as const, pluginId: "crew" } };
    void harness.callRpc("canvas.notify", { pluginId: "crew" }, caller);
    await vi.advanceTimersByTimeAsync(600);
    void harness.callRpc("canvas.notify", { pluginId: "crew" }, caller);
    await vi.advanceTimersByTimeAsync(600);
    expect(reloads).toEqual([{ pluginId: "crew", scope: undefined }, { pluginId: "crew", scope: undefined }]);
  });
});

describe("10s polling fallback for extensions without notify (BBP-174 Spike 2)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reloads every 10s while the view stays visible", async () => {
    const reloads: { pluginId: string; scope: unknown }[] = [];
    const stop = startPollingFallback("graph-studio", { projectId: "p1" }, {
      reload: (pluginId, scope) => reloads.push({ pluginId, scope }),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reloads).toEqual([
      { pluginId: "graph-studio", scope: { projectId: "p1" } },
      { pluginId: "graph-studio", scope: { projectId: "p1" } },
    ]);
    stop();
  });

  it("negative: stops reloading once stopped (the view was left)", async () => {
    const reloads: unknown[] = [];
    const stop = startPollingFallback("graph-studio", {}, { reload: () => reloads.push(true) });
    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reloads).toEqual([]);
  });
});

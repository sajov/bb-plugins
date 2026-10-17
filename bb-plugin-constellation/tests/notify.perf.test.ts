// BBP-174 Spike 2: real (not estimated) latency for notify → debounce →
// reload, through the SDK's own testing harness (createFakePluginHost),
// 20 runs, reported as p50/p95. Not asserted against a threshold here: the
// Spike comment on BBP-174 carries the numbers this prints.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, it } from "vitest";
import { registerCanvasNotify } from "../lib/notify";

describe("BBP-174 Spike 2: notify -> reload latency (p50/p95, 20 runs)", () => {
  it("measures for real through the SDK testing harness", { timeout: 20_000 }, async () => {
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const { bb, harness } = createFakePluginHost();
      const reloaded = new Promise<number>((resolve) => {
        registerCanvasNotify(bb, { reload: () => resolve(Date.now()) }, { knownExtensions: new Set(["crew"]) });
      });
      const t0 = Date.now();
      await harness.callRpc("canvas.notify", { pluginId: "crew" }, { experimental_caller: { kind: "plugin", pluginId: "crew" } });
      const t1 = await reloaded;
      samples.push(t1 - t0);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    // eslint-disable-next-line no-console
    console.log(`BBP-174 notify->reload: p50=${p50}ms p95=${p95}ms avg=${avg.toFixed(1)}ms samples=${JSON.stringify(sorted)}`);
  });
});

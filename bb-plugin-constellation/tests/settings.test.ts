// BBP-287: the overview window's defaults are plugin settings, as in agent-graph.
import { describe, expect, it, vi } from "vitest";
import canvas from "../server";

describe("the Canvas plugin settings", () => {
  it("defines window, thread limit and turns per thread with the overview defaults", () => {
    const define = vi.fn();
    canvas({ settings: { define }, rpc: { register: vi.fn() } } as never);
    expect(define).toHaveBeenCalledWith(
      expect.objectContaining({
        windowHours: expect.objectContaining({ type: "number", default: 12 }),
        maxThreads: expect.objectContaining({ type: "number", default: 20 }),
        overviewTurns: expect.objectContaining({ type: "number", default: 1 }),
      }),
    );
  });
});

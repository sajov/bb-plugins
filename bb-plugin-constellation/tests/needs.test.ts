import { describe, expect, it, vi } from "vitest";
import { answerNeeds } from "../lib/extensions";
import { needsOf } from "../components/needs-panel";

describe("answerNeeds (BBP-303)", () => {
  it("answers a graph run's approval in graph-studio", async () => {
    const call = vi.fn(async () => ({ run: null }));
    expect(await answerNeeds({ kind: "graph-studio", runId: "r1", nodeId: "gate" }, "OK", call)).toEqual({ ok: true, error: null });
    expect(call).toHaveBeenCalledWith("graph-studio", "answerHuman", { runId: "r1", answer: "OK", nodeId: "gate" });
  });

  it("answers a crew member's question as a human message", async () => {
    const call = vi.fn(async () => ({ messages: [], error: null }));
    await answerNeeds({ kind: "crew", projectId: "p", address: "lead@factory-1" }, "yes", call);
    expect(call).toHaveBeenCalledWith("crew", "sendMessage", { projectId: "p", to: "lead@factory-1", body: "yes", crew: null, replyTo: null });
  });

  it("reports a refused or failing call", async () => {
    expect(await answerNeeds({ kind: "crew", projectId: "p", address: "x" }, "a", async () => ({ error: "unknown address" }))).toEqual({ ok: false, error: "unknown address" });
    expect(await answerNeeds({ kind: "graph-studio", runId: "r" }, "a", async () => { throw new Error("down"); })).toEqual({ ok: false, error: "down" });
  });
});

describe("needsOf", () => {
  it("reads needsYou and a gate's waitsForYou, ignores the unknown", () => {
    expect(needsOf({ needsYou: { kind: "graph-studio", runId: "r", nodeId: "n", question: "Q?" } })).toMatchObject({ kind: "graph-studio", runId: "r", question: "Q?" });
    expect(needsOf({ waitsForYou: { kind: "crew", projectId: "p", address: "a" } })).toMatchObject({ kind: "crew", address: "a" });
    expect(needsOf({ needsYou: { kind: "other" } })).toBeNull();
    expect(needsOf(undefined)).toBeNull();
  });
});

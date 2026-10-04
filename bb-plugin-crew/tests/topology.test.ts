import { describe, expect, it } from "vitest";
import type { NeedsReason } from "../lib/activity";
import { activityTone, reasonCounts, reasonSeverity, topReasonLabel } from "../lib/topology";

describe("reasonSeverity (BBP-95)", () => {
  it("error only for a real failure: error, merge-conflict", () => {
    expect(reasonSeverity("error")).toBe("error");
    expect(reasonSeverity("merge-conflict")).toBe("error");
  });

  it("decision for everything that waits on a human choice or just attention", () => {
    const decisions: NeedsReason[] = ["human-question", "question", "approval", "merge-request", "graph-approval", "loop", "follow-up", "context"];
    for (const reason of decisions) expect(reasonSeverity(reason)).toBe("decision");
  });
});

describe("reasonCounts", () => {
  it("splits a mixed reason list into errors and decisions", () => {
    expect(reasonCounts(["error", "approval", "merge-request"])).toEqual({ errors: 1, decisions: 2 });
    expect(reasonCounts(["merge-request"])).toEqual({ errors: 0, decisions: 1 });
    expect(reasonCounts([])).toEqual({ errors: 0, decisions: 0 });
  });
});

describe("activityTone (BBP-95: red only for errors, amber for decisions)", () => {
  it("a crew with only a ready merge request is amber, not red", () => {
    expect(activityTone("idle", ["merge-request"])).toBe("var(--warning)");
  });

  it("an error or merge conflict is red even alongside a decision reason", () => {
    expect(activityTone("idle", ["merge-request", "error"])).toBe("var(--destructive)");
    expect(activityTone("idle", ["merge-conflict"])).toBe("var(--destructive)");
  });

  it("approval, question and graph-approval are amber", () => {
    for (const reason of ["approval", "question", "human-question", "graph-approval", "loop", "follow-up", "context"] as const) {
      expect(activityTone("idle", [reason])).toBe("var(--warning)");
    }
  });

  it("falls back to activity colour when there is no reason: blue working, grey idle/unknown", () => {
    expect(activityTone("working", [])).toBe("var(--timeline-accent)");
    expect(activityTone("idle", [])).toBe("var(--muted-foreground)");
    expect(activityTone("unknown", [])).toBe("var(--muted-foreground)");
    expect(activityTone("error", [])).toBe("var(--destructive)");
  });
});

describe("topReasonLabel", () => {
  it("is null with no reasons, the label alone with one", () => {
    expect(topReasonLabel([])).toBeNull();
    expect(topReasonLabel(["merge-request"])).toBe("MR ready");
  });

  it("picks the most important reason first and counts the rest", () => {
    expect(topReasonLabel(["loop", "merge-conflict", "approval"])).toBe("Conflict +2");
    expect(topReasonLabel(["context", "error"])).toBe("Error +1");
    expect(topReasonLabel(["follow-up", "loop"])).toBe("Follow-up +1");
  });
});

// Plan and problem lines, shared by `bb crew plan` and the crew-file editor's
// preview (§8.1 E4: "Apply shows the same preview as plan"). No Node imports:
// the frontend bundle uses this file too.
export type PlanLine = { key: string; address: string; action: string; reasons: readonly string[]; threadId: string | null };
export type ProblemLine = { level: "error" | "warning"; message: string };

export function formatProblems(problems: readonly ProblemLine[]): string[] {
  return problems.map((problem) => `  ${problem.level === "error" ? "error" : "warning"}: ${problem.message}`);
}

export function formatPlan(items: readonly PlanLine[]): string[] {
  return items.map(
    (item) =>
      `  ${item.action.padEnd(9)} ${item.address.padEnd(28)} ${item.threadId ?? "-"}${item.reasons.length ? `  (${item.reasons.join("; ")})` : ""}`,
  );
}

/** A member's context use (0..1) as the rounded percentage shown in the UI and agent tools. */
export function formatContextShare(share: number): string {
  return `${Math.round(share * 100)}%`;
}

// Topology tab (§4.6): how links are drawn and what a member is doing, in
// words and colour. The layout itself lives in lib/canvas-layout.ts.
import type { NeedsReason } from "./activity";

/** How each link kind is drawn on the canvas and named in the legend. */
export const LINK_STYLE: Record<string, { stroke: string; dash?: string; arrow: boolean; label: string }> = {
  assigns_to: { stroke: "var(--muted-foreground)", arrow: true, label: "assigns" },
  works_with: { stroke: "var(--muted-foreground)", dash: "5 4", arrow: false, label: "works with" },
  // BBP-97: an allowed escalation path is not a problem, so it reads amber — the same
  // "needs a decision" tone as SEVERITY_COLOR.decision — never red (that is reserved for errors).
  escalates_to: { stroke: "var(--warning)", dash: "3 3", arrow: true, label: "escalates" },
  can_read: { stroke: "var(--muted-foreground)", dash: "1 4", arrow: true, label: "can read" },
};

/**
 * What a member is doing, in one word. Activity is only known for a live
 * thread, so for an archived or missing one the thread axis says more than
 * "unknown" does.
 */
export function activityLabel(view: { activity: string; thread: string; needsYou: readonly string[] } | null, fallback: string): string {
  if (!view) return fallback;
  if (view.needsYou.length > 0) return "needs you";
  if (view.thread === "archived") return "archived";
  if (view.thread === "missing") return "no thread";
  return view.activity;
}

/** Running reads blue (BBP-95); the host's primary is neutral and already marks the selection. */
export const RUNNING = "var(--timeline-accent)";

export type ReasonSeverity = "error" | "decision";

/** BBP-95: only a real failure is red — everything else that waits on a human decision is amber. */
const ERROR_REASONS: ReadonlySet<NeedsReason> = new Set(["error", "merge-conflict"]);

export function reasonSeverity(reason: NeedsReason): ReasonSeverity {
  return ERROR_REASONS.has(reason) ? "error" : "decision";
}

/** True if any reason in the list is a hard error, not just a decision waiting on the human. */
export function hasErrorReason(reasons: readonly string[]): boolean {
  return reasons.some((reason) => reasonSeverity(reason as NeedsReason) === "error");
}

/** Counts, split by severity, for a badge that tells errors and decisions apart. */
export function reasonCounts(reasons: readonly string[]): { errors: number; decisions: number } {
  let errors = 0;
  let decisions = 0;
  for (const reason of reasons) (reasonSeverity(reason as NeedsReason) === "error" ? errors++ : decisions++);
  return { errors, decisions };
}

/** Most-important-first order for showing a reason on a card with room for only one. */
const REASON_ORDER: readonly NeedsReason[] = [
  "merge-conflict",
  "error",
  "human-question",
  "question",
  "approval",
  "graph-approval",
  "merge-request",
  "follow-up",
  "loop",
  "context",
];

/** Short reason labels for a card or table row, as opposed to the fuller text in the member inspector. */
export const REASON_LABEL: Record<NeedsReason, string> = {
  "merge-conflict": "Conflict",
  error: "Error",
  "human-question": "Question",
  question: "Question",
  approval: "Approval",
  "graph-approval": "Approval",
  "merge-request": "MR ready",
  "follow-up": "Follow-up",
  loop: "Loop",
  context: "Context",
};

export function reasonLabel(reason: NeedsReason): string {
  return REASON_LABEL[reason] ?? reason;
}

/** The most important reason's short label, plus how many more reasons also apply. */
export function topReasonLabel(reasons: readonly string[]): string | null {
  if (reasons.length === 0) return null;
  const [top] = [...reasons].sort((a, b) => REASON_ORDER.indexOf(a as NeedsReason) - REASON_ORDER.indexOf(b as NeedsReason));
  const label = reasonLabel(top! as NeedsReason);
  return reasons.length > 1 ? `${label} +${reasons.length - 1}` : label;
}

/**
 * Node colour by activity and needs-you reason, from the BB theme. A real
 * error wins over everything else; a reason that only waits on a human
 * decision (an approval, a ready merge request, a question) is amber, not
 * red (BBP-95).
 */
export function activityTone(activity: string, reasons: readonly string[]): string {
  if (hasErrorReason(reasons)) return "var(--destructive)";
  if (reasons.length > 0) return "var(--warning)";
  switch (activity) {
    case "working":
      return RUNNING;
    case "error":
      return "var(--destructive)";
    case "idle":
    case "unknown":
      return "var(--muted-foreground)";
    default:
      return "var(--border)";
  }
}

/**
 * Colours per severity, written as var() with a fallback and color-mix() for
 * tints rather than named Tailwind classes (bg-warning/10, text-warning-text),
 * the pattern bb-plugin-aside uses for host tokens (BBP-95).
 */
export const SEVERITY_COLOR: Record<ReasonSeverity, string> = { error: "var(--destructive)", decision: "var(--warning)" };
export const SEVERITY_TEXT_COLOR: Record<ReasonSeverity, string> = {
  error: "var(--destructive-text,var(--destructive))",
  decision: "var(--warning-text,var(--warning))",
};
export const SEVERITY_TEXT: Record<ReasonSeverity, string> = {
  error: "text-[color:var(--destructive-text,var(--destructive))]",
  decision: "text-[color:var(--warning-text,var(--warning))]",
};

/** A tinted surface: fill and, optionally, border as a share of the severity colour. */
export function severityTint(severity: ReasonSeverity, fill: number, edge?: number): { background: string; borderColor?: string } {
  const mix = (share: number) => `color-mix(in oklab, ${SEVERITY_COLOR[severity]} ${share}%, transparent)`;
  return edge === undefined ? { background: mix(fill) } : { background: mix(fill), borderColor: mix(edge) };
}

// One single-colour line icon per node kind, drawn in `currentColor` so the
// card decides the tint. 14px, 1.5 stroke — the same weight as the host's
// sidebar icons.
import type { CanvasNodeKind } from "../lib/types";

const PATHS: Record<CanvasNodeKind, string> = {
  agents: "M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z",
  project: "M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z",
  crew: "M5.5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM2 13c0-2 1.6-3.5 3.5-3.5S9 11 9 13M11 7.5a1.6 1.6 0 1 0 0-3.2M11.5 9.6c1.4.3 2.5 1.6 2.5 3.4",
  member: "M8 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4",
  "graph-run": "M4 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM12 9.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM5.5 5h3a2 2 0 0 1 2 2v2.5",
  step: "M3 3.5h10v3H3zM3 9.5h10v3H3z",
  thread: "M3 3.5h10v7H7l-3 2.5v-2.5H3z",
  turn: "M3 8h8M8 5l3 3-3 3",
  "tool-call": "M9.5 3.5a3 3 0 0 0-3.4 4L3 10.6 5.4 13l3.1-3.1a3 3 0 0 0 4-3.4l-1.8 1.8-1.8-.5-.5-1.8z",
  subagent: "M8 2.5 3 5v6l5 2.5 5-2.5V5zM8 2.5v10M3 5l5 2.5M13 5l-5 2.5",
  "system-event": "M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8 7v3M8 5.3v.1",
};

export function KindIcon({ kind }: { kind: CanvasNodeKind }) {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[kind]} />
    </svg>
  );
}

export const KIND_LABEL: Record<CanvasNodeKind, string> = {
  agents: "Agents",
  project: "Project",
  crew: "Crew",
  member: "Member",
  "graph-run": "Graph run",
  step: "Step",
  thread: "Thread",
  turn: "Turn",
  "tool-call": "Tool call",
  subagent: "Subagent",
  "system-event": "System event",
};

const CHILD_NOUN: Partial<Record<CanvasNodeKind, [string, string]>> = {
  agents: ["project", "projects"],
  crew: ["member", "members"],
  "graph-run": ["step", "steps"],
};

/** The card's second line: what the node is, plus the one number or fact
 *  that tells it apart from its siblings ("Crew · 9 members", "Member ·
 *  claude-opus-5-5"). Everything else lives in the sidebar. */
/** What a tool call did, by its row's `workKind` — "Tool call" for every
 *  step said nothing (BBP-206 acceptance in BB). */
const WORK_LABEL: Record<string, string> = {
  command: "Command",
  tool: "Tool",
  "file-read": "Read",
  "image-view": "View image",
  search: "Search",
  "web-search": "Web search",
  "web-fetch": "Fetch",
  "image-generation": "Generate image",
  "plan-steps": "Plan",
  extension: "Extension",
  approval: "Approval",
  form: "Form",
  question: "Question",
  workflow: "Workflow",
};

const CHANGE_LABEL: Record<string, string> = { create: "New file", delete: "Delete file" };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function describeToolCall(meta?: Record<string, unknown>): string {
  const workKind = str(meta?.workKind);
  const what =
    workKind === "file-change"
      ? CHANGE_LABEL[str(meta?.changeKind) ?? ""] ?? "Edit"
      : (workKind && WORK_LABEL[workKind]) ?? KIND_LABEL["tool-call"];
  const exitCode = meta?.exitCode;
  const facts = [
    what,
    str(meta?.diffStats),
    typeof exitCode === "number" && exitCode !== 0 ? `exit ${exitCode}` : undefined,
    str(meta?.duration),
  ];
  return facts.filter((fact): fact is string => fact !== undefined).join(" · ");
}

export function describeNode(kind: CanvasNodeKind, childCount: number, meta?: Record<string, unknown>): string {
  if (meta?.step === true) {
    // A graph step (BBP-303): what it is, how often it ran, or that it has not yet.
    // Form B (big flows): a whole branch on one card, or the lanes folded away.
    if (typeof meta.folded === "number") return `${meta.folded} more ${meta.folded === 1 ? "branch" : "branches"}`;
    const branch = meta.branch as { done?: unknown; total?: unknown } | undefined;
    if (branch && typeof branch.done === "number" && typeof branch.total === "number") return `Branch · ${branch.done}/${branch.total} steps`;
    if (meta.ghost === true) return "Step · not reached";
    if (meta.gate === true) return "Approval";
    const attempts = typeof meta.attempts === "number" && meta.attempts > 1 ? `×${meta.attempts}` : undefined;
    return ["Step", attempts].filter(Boolean).join(" · ");
  }
  if (kind === "thread" && meta?.member === true) {
    // A crew member's thread (BBP-190): lead or not, what it is doing, provider.
    const facts = [meta.lead === true ? "lead" : undefined, meta.activity ?? meta.state, meta.provider].filter(
      (value): value is string => typeof value === "string" && value !== "",
    );
    return facts.length > 0 ? facts.join(" · ") : "Member";
  }
  if (kind === "thread") {
    // As agent-graph: provider and branch; the state shows in the card's dot.
    const facts = (typeof meta?.branch === "string" && meta.branch !== "" ? [meta?.provider, meta.branch] : [meta?.state, meta?.provider]).filter(
      (value): value is string => typeof value === "string" && value !== "",
    );
    return facts.length > 0 ? facts.join(" · ") : KIND_LABEL.thread;
  }
  if (kind === "tool-call") return describeToolCall(meta);
  // A graph run: how far it got (BBP-303), the strip below shows where.
  if (kind === "graph-run" && typeof meta?.steps === "string" && !meta?.placeholder) return `${KIND_LABEL["graph-run"]} · ${meta.steps}`;
  // As agent-graph: the root and a project count what hangs under them.
  if (kind === "agents") return `${childCount} ${childCount === 1 ? "project" : "projects"}`;
  if (kind === "project") {
    // Crews hang under a project too (BBP-190): counted apart from threads.
    const crews = typeof meta?.crews === "number" ? meta.crews : 0;
    const runs = typeof meta?.runs === "number" ? meta.runs : 0;
    const threads = childCount - crews - runs;
    const parts = [`${threads} ${threads === 1 ? "thread" : "threads"}`];
    if (crews > 0) parts.push(`${crews} ${crews === 1 ? "crew" : "crews"}`);
    if (runs > 0) parts.push(`${runs} ${runs === 1 ? "run" : "runs"}`);
    return parts.join(" · ");
  }
  // A message row is a turn's request or its reply, not another turn.
  if (kind === "turn" && meta?.from === "User") return "Request";
  if (kind === "turn" && meta?.from === "Agent") return "Reply";
  // A crew that is "running" (not stopped) with every member idle must not
  // read as active (BBP-214 feedback 1) — the member count alone can't tell
  // the two apart, so the layer hands over how many are actually active.
  if (kind === "crew" && typeof meta?.members === "number" && typeof meta?.active === "number") {
    return `${KIND_LABEL.crew} · ${meta.active} of ${meta.members} active`;
  }
  const parts = [KIND_LABEL[kind]];
  // An enriched turn's label is its first line, so the step count moves here.
  const steps = meta?.summaryCount;
  if (kind === "turn" && typeof steps === "number" && typeof meta?.firstLine === "string" && meta.firstLine !== "") {
    parts.push(`${steps} ${steps === 1 ? "step" : "steps"}`);
  }
  const noun = CHILD_NOUN[kind];
  if (noun && childCount > 0) parts.push(`${childCount} ${childCount === 1 ? noun[0] : noun[1]}`);
  const model = typeof meta?.model === "string" ? meta.model.split("/").pop() : undefined;
  if (kind === "member" && model) parts.push(model);
  return parts.join(" · ");
}

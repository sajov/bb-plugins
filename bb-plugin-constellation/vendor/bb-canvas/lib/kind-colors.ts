// Card colours as in agent-graph (BBP-298): each kind of node gets an accent
// — a bar on the card's left edge and a tinted square behind its icon — and
// the "Color" toggle switches that accent between the node's type and its
// state. A page that passes no colour mode keeps the old neutral cards.
import type { CanvasNode, CanvasStatus } from "./types";

export type ColorMode = "type" | "status";

/** The legend's entries, in its order. */
export const TYPE_COLORS = {
  project: "#6366f1",
  thread: "#0ea5e9",
  turn: "#a855f7",
  subagent: "#ec4899",
  shell: "#84cc16",
  edit: "#f59e0b",
  read: "#06b6d4",
  other: "#94a3b8",
} as const;

export type TypeColorKey = keyof typeof TYPE_COLORS;

export const TYPE_LABELS: Record<TypeColorKey, string> = {
  project: "Project",
  thread: "Thread",
  turn: "Turn",
  subagent: "Subagent",
  shell: "Shell",
  edit: "File edit",
  read: "Read / search",
  other: "Other tool",
};

export const STATUS_COLORS: Record<"running" | "failed" | "done" | "idle", string> = {
  running: "#3b82f6",
  failed: "#ef4444",
  done: "#10b981",
  idle: "#9ca3af",
};

const READ_WORK = new Set(["file-read", "image-view", "search", "web-search", "web-fetch"]);

/** Which legend entry a node belongs to. */
export function typeKey(node: Pick<CanvasNode, "kind" | "meta">): TypeColorKey {
  switch (node.kind) {
    case "agents":
    case "project":
    case "crew":
      return "project";
    case "thread":
    case "member":
    case "graph-run":
      return "thread";
    case "turn":
    case "step":
    case "system-event":
      return "turn";
    case "subagent":
      return "subagent";
    case "tool-call": {
      const work = node.meta?.workKind;
      if (work === "command") return "shell";
      if (work === "file-change") return "edit";
      if (work === "delegation") return "subagent";
      return typeof work === "string" && READ_WORK.has(work) ? "read" : "other";
    }
    default:
      return "other";
  }
}

/** The legend's state buckets; "waiting" and "escalated" count as running. */
export function statusKey(status: CanvasStatus | undefined): keyof typeof STATUS_COLORS {
  if (status === "running" || status === "waiting" || status === "escalated") return "running";
  if (status === "failed") return "failed";
  if (status === "done") return "done";
  return "idle";
}

export function accentOf(node: Pick<CanvasNode, "kind" | "meta" | "status">, mode: ColorMode): string {
  return mode === "type" ? TYPE_COLORS[typeKey(node)] : STATUS_COLORS[statusKey(node.status)];
}

/** The short tag a log row carries in front of its command (BBP-298). */
export const TYPE_TAGS: Record<TypeColorKey, string> = {
  project: "proj",
  thread: "thread",
  turn: "turn",
  subagent: "agent",
  shell: "shell",
  edit: "edit",
  read: "read",
  other: "tool",
};

/** "400ms", "1.2s", "2m 10s", "85.6s" → milliseconds; anything else → null. */
export function durationMs(text: unknown): number | null {
  if (typeof text !== "string") return null;
  let total = 0;
  let matched = false;
  for (const [, value, unit] of text.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h)\b/g)) {
    matched = true;
    total += Number(value) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const)[unit as "ms" | "s" | "m" | "h"];
  }
  return matched ? total : null;
}

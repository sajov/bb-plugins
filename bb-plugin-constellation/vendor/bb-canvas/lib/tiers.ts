// Which of the three visual tiers a node's kind renders as (BBP-214 stage 2).
// A single place to look up size and typography per tier, so `layoutTree`
// and `NodeCard` agree on geometry without duplicating the mapping.
import type { CanvasNode, CanvasNodeKind } from "./types";

export type Tier = "group" | "card" | "row";

/** Group: a headerless header row (agents/project/crew). Card: today's node
 *  shape (graph-run/thread/member). Row: a compact line for high-volume leaf
 *  activity (step/turn/tool-call/subagent). */
export const TIER_OF: Record<CanvasNodeKind, Tier> = {
  // Root and projects are cards, as in agent-graph (BBP-298); the activity
  // under a thread stays the compact one-line row of our own design.
  agents: "card",
  project: "card",
  crew: "card",
  "graph-run": "card",
  thread: "card",
  member: "card",
  step: "row",
  turn: "row",
  "tool-call": "row",
  subagent: "row",
  "system-event": "row",
};

export type TierSize = { width: number; height: number };

export const TIER_SIZE: Record<Tier, TierSize> = {
  group: { width: 220, height: 28 },
  card: { width: 220, height: 52 },
  // Wide enough for a command line read as a log (BBP-298).
  row: { width: 260, height: 26 },
};

export type TierTypography = {
  titleSize: number;
  titleWeight: number;
  subSize: number;
  subWeight: number;
};

export const TIER_TYPOGRAPHY: Record<Tier, TierTypography> = {
  group: { titleSize: 13, titleWeight: 600, subSize: 12, subWeight: 400 },
  card: { titleSize: 13, titleWeight: 600, subSize: 11, subWeight: 400 },
  row: { titleSize: 12, titleWeight: 400, subSize: 12, subWeight: 400 },
};

export function sizeOf(kind: CanvasNodeKind): TierSize {
  return TIER_SIZE[TIER_OF[kind]];
}

/** A node's own size: its tier's, unless it carries a `meta.size` of its own
 *  (a step stream is as tall as the lines it shows, BBP-320). */
export function sizeOfNode(node: Pick<CanvasNode, "kind" | "meta">): TierSize {
  const own = node.meta?.size as Partial<TierSize> | undefined;
  const base = sizeOf(node.kind);
  return typeof own?.height === "number" ? { width: typeof own.width === "number" ? own.width : base.width, height: own.height } : base;
}

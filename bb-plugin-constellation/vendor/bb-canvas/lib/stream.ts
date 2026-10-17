// A turn's steps as one stream (BBP-320): its messages, and under each the
// tool calls that followed it, in one node of fixed height that scrolls like
// a terminal instead of one card per step. A long turn no longer grows the
// tree by hundreds of rows, and the layout does not jump while it runs.
import type { CanvasNode } from "./types";

/** Height of one line in the stream: a 26px row and its gap. */
export const STREAM_LINE = 32;
/** The most lines the stream shows at once; older ones scroll. */
export const STREAM_MAX_LINES = 10;
/** Room above the first line for the count. */
export const STREAM_HEAD = 22;
export const STREAM_WIDTH = 320;

export const streamId = (parentId: string): string => `${parentId}:stream`;

/** One message and the steps that followed it. `message` is absent for the
 *  steps that came before the turn's first message. */
export type StreamGroup = { message?: CanvasNode; steps: CanvasNode[] };

export type StreamMeta = { groups: StreamGroup[]; messages: number; steps: number };

/** A message of the conversation (a `conversation` row), drawn as a card. */
export function isMessage(node: CanvasNode): boolean {
  return node.kind === "turn" && node.meta?.kind === "conversation";
}

/** A turn card of its own: a real or live turn, not a message under one. */
function isTurn(node: CanvasNode): boolean {
  return node.kind === "turn" && !isMessage(node);
}

/** Leaves only: a subagent opens its own steps and stays a card in the tree. */
function streamable(node: CanvasNode): boolean {
  return isMessage(node) || node.kind === "tool-call" || node.kind === "system-event";
}

export function groupSteps(items: readonly CanvasNode[]): StreamGroup[] {
  const groups: StreamGroup[] = [];
  for (const item of items) {
    if (isMessage(item)) groups.push({ message: item, steps: [] });
    else if (groups.length === 0) groups.push({ steps: [item] });
    else groups[groups.length - 1]!.steps.push(item);
  }
  return groups;
}

/** Lines the stream shows by default: every message, and the steps of the
 *  newest group only — older groups start folded. */
export function defaultLines(groups: readonly StreamGroup[]): number {
  return groups.reduce((sum, group, index) => sum + (group.message ? 1 : 0) + (index === groups.length - 1 || !group.message ? group.steps.length : 0), 0);
}

/**
 * Replaces the streamable children of every turn with one stream node under
 * it. A "+N earlier" node the provider cut off older steps into is dissolved:
 * the stream holds them all. Subagents stay cards of their own, after the
 * stream. A turn without streamable children is left alone.
 */
export function streamTurns(nodes: readonly CanvasNode[]): { nodes: CanvasNode[]; owner: Map<string, string> } {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const earlier = new Map<string, string>();
  for (const node of nodes) if (typeof node.meta?.earlier === "number" && node.parentId !== null && byId.get(node.parentId)?.kind === "turn") earlier.set(node.id, node.parentId);
  // The turn a node streams into, if any: its own parent, or the turn above
  // an "earlier" node it was moved under.
  const turnOf = (node: CanvasNode): string | null => {
    if (node.parentId === null) return null;
    const parentId = earlier.get(node.parentId) ?? node.parentId;
    const parent = byId.get(parentId);
    return parent && isTurn(parent) && streamable(node) ? parentId : null;
  };
  const items = new Map<string, CanvasNode[]>();
  const owner = new Map<string, string>();
  for (const node of nodes) {
    if (earlier.has(node.id)) continue;
    const turn = turnOf(node);
    if (turn === null) continue;
    items.set(turn, [...(items.get(turn) ?? []), node]);
    owner.set(node.id, streamId(turn));
  }
  if (items.size === 0) return { nodes: [...nodes], owner };
  const out: CanvasNode[] = [];
  for (const node of nodes) {
    if (owner.has(node.id) || earlier.has(node.id)) continue;
    out.push(node);
    const own = items.get(node.id);
    if (!own) continue;
    const groups = groupSteps(own);
    const messages = groups.filter((group) => group.message).length;
    const steps = own.length - messages;
    const lines = Math.max(1, Math.min(STREAM_MAX_LINES, defaultLines(groups)));
    const meta: StreamMeta & Record<string, unknown> = {
      groups,
      messages,
      steps,
      stream: true,
      size: { width: STREAM_WIDTH, height: STREAM_HEAD + lines * STREAM_LINE },
    };
    const running = own.some((item) => item.status === "running");
    out.push({
      id: streamId(node.id),
      kind: "system-event",
      label: streamLabel(messages, steps),
      parentId: node.id,
      // Running, so the activity line reaches it; a failed line shows inside.
      ...(running ? { status: "running" as const } : {}),
      meta,
    });
  }
  return { nodes: out, owner };
}

/** The stream's count; a part that is zero is left out ("4 steps", not
 *  "0 messages · 4 steps"). */
export function streamLabel(messages: number, steps: number): string {
  const parts = [
    ...(messages > 0 ? [`${messages} ${messages === 1 ? "message" : "messages"}`] : []),
    ...(steps > 0 || messages === 0 ? [`${steps} ${steps === 1 ? "step" : "steps"}`] : []),
  ];
  return parts.join(" · ");
}

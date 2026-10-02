// Communication on the canvas: who talked to whom inside one crew, and in
// which order. Graph Studio's canvas shows where a run stands and its timeline
// how it got there; the crew canvas does the same for messages.
//
// Pure, so the mapping from messages to flows is tested without a DOM.

/** The fields of a message this module reads; MessageDto satisfies it. */
export type CommsMessage = {
  id: string;
  fromAddress: string;
  toAddress: string;
  createdAt: number;
};

/** All messages between one ordered pair of members. */
export type Flow = {
  id: string;
  from: string;
  to: string;
  count: number;
  lastAt: number;
  lastId: string;
};

/** How long a flow keeps its moving dot after its last message. */
export const RECENT_MS = 2 * 60 * 1000;

/** How many messages the timeline strip shows; older ones stay in the log. */
export const STRIP_LIMIT = 40;

export function flowId(from: string, to: string): string {
  return `msg:${from}->${to}`;
}

/**
 * The member key behind an address of this crew, or null. Addresses are
 * `key@crew`; "human", "system" and other crews' members have no node on
 * this canvas, so their messages stay in the log only.
 */
export function memberKeyOf(address: string, crewName: string, known: ReadonlySet<string>): string | null {
  const at = address.lastIndexOf("@");
  if (at <= 0) return null;
  if (address.slice(at + 1) !== crewName) return null;
  const key = address.slice(0, at);
  return known.has(key) ? key : null;
}

/** One flow per ordered member pair that exchanged messages; self-messages are dropped. */
export function messageFlows(messages: readonly CommsMessage[], crewName: string, known: ReadonlySet<string>): Flow[] {
  const flows = new Map<string, Flow>();
  for (const message of messages) {
    const from = memberKeyOf(message.fromAddress, crewName, known);
    const to = memberKeyOf(message.toAddress, crewName, known);
    if (!from || !to || from === to) continue;
    const id = flowId(from, to);
    const flow = flows.get(id);
    if (!flow) flows.set(id, { id, from, to, count: 1, lastAt: message.createdAt, lastId: message.id });
    else {
      flow.count += 1;
      if (message.createdAt >= flow.lastAt) {
        flow.lastAt = message.createdAt;
        flow.lastId = message.id;
      }
    }
  }
  return [...flows.values()];
}

/** Flows with a message within the recent window. */
export function recentFlowIds(flows: readonly Flow[], now: number, windowMs = RECENT_MS): Set<string> {
  return new Set(flows.filter((flow) => now - flow.lastAt <= windowMs).map((flow) => flow.id));
}

/** The flow a message travels on, or null when one end has no node. */
export function flowOf(message: CommsMessage, crewName: string, known: ReadonlySet<string>): string | null {
  const from = memberKeyOf(message.fromAddress, crewName, known);
  const to = memberKeyOf(message.toAddress, crewName, known);
  return from && to && from !== to ? flowId(from, to) : null;
}

/** Oldest first, the newest `limit`: the order the strip and the replay walk. */
export function timeline<T extends CommsMessage>(messages: readonly T[], limit = STRIP_LIMIT): T[] {
  const ordered = [...messages].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return ordered.slice(Math.max(0, ordered.length - limit));
}

/** The short name of an address for the strip: the key for this crew, the full address otherwise. */
export function shortAddress(address: string, crewName: string): string {
  return address.endsWith(`@${crewName}`) ? address.slice(0, -(crewName.length + 1)) : address;
}

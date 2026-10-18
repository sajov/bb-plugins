import { z } from "zod";

/** What the evaluating model decides about a thread. */
export const assessmentSchema = z.object({
  headline: z.string().trim().min(1).max(80),
  purpose: z.string().trim().min(1).max(400),
  progress: z.number().int().min(0).max(100),
  state: z.enum(["working", "waiting", "done"]),
  nextStep: z.string().trim().max(200).nullable(),
  actions: z
    .array(z.object({ label: z.string().trim().min(1).max(48), reply: z.string().trim().min(1).max(300) }))
    .max(4),
});
export type NextAction = Assessment["actions"][number];
export type Assessment = z.infer<typeof assessmentSchema>;

/** A stored assessment plus what it was made from, so a re-run can be skipped. */
// The two newer fields are optional here so assessments stored before they
// existed still load; the next evaluation fills them in.
export const purposeSchema = assessmentSchema.extend({
  headline: z.string().optional(),
  actions: assessmentSchema.shape.actions.optional(),
  /** Single reply from before actions existed; read as one action. */
  suggestedReply: z.string().nullable().optional(),
  threadId: z.string(),
  messageCount: z.number().int().min(0),
  evaluatedAt: z.number(),
  model: z.string(),
});
export type Purpose = z.infer<typeof purposeSchema>;

export interface Message {
  role: "user" | "assistant";
  text: string;
}

/** Same event pair Recall indexes: the user's turn and the agent's messages. */
export const MESSAGE_EVENT_TYPES = ["client/turn/requested", "item/completed"] as const;

export function messagesFromEvents(events: readonly { type: string; data: unknown }[]): Message[] {
  const messages: Message[] = [];
  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (event.type === "client/turn/requested") {
      const input = Array.isArray(data.input) ? data.input : [];
      const text = input
        .map((part) => {
          const record = (part ?? {}) as Record<string, unknown>;
          return record.type === "text" && typeof record.text === "string" ? record.text : "";
        })
        .filter(Boolean)
        .join("\n");
      if (text) messages.push({ role: "user", text });
    } else if (event.type === "item/completed") {
      const item = (data.item ?? {}) as Record<string, unknown>;
      if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        messages.push({ role: "assistant", text: item.text });
      }
    }
  }
  return messages;
}

const PER_MESSAGE_CHARS = 1500;
const TRANSCRIPT_CHARS = 24000;

/**
 * The transcript the model reads: the first message (it usually states the
 * goal) plus as many of the latest ones as fit. The middle is what gets cut,
 * because the purpose lives at the start and the state at the end.
 */
export function buildTranscript(messages: readonly Message[]): string {
  const render = (message: Message) => {
    const text =
      message.text.length > PER_MESSAGE_CHARS
        ? `${message.text.slice(0, PER_MESSAGE_CHARS)} […]`
        : message.text;
    return `### ${message.role === "user" ? "User" : "Agent"}\n${text}`;
  };
  if (messages.length === 0) return "";
  const first = render(messages[0]);
  const tail: string[] = [];
  let budget = TRANSCRIPT_CHARS - first.length;
  for (let index = messages.length - 1; index > 0; index--) {
    const block = render(messages[index]);
    if (block.length > budget) break;
    tail.unshift(block);
    budget -= block.length;
  }
  const skipped = messages.length - 1 - tail.length;
  return [first, ...(skipped > 0 ? [`[… ${skipped} messages omitted …]`] : []), ...tail].join("\n\n");
}

export function buildPrompt(title: string, transcript: string): string {
  return [
    "You assess a coding-agent session so its owner can see at a glance what it is for and where it stands.",
    "Read the transcript and reply with ONE JSON object and nothing else — no code fence, no prose:",
    '{"headline": string, "purpose": string, "progress": integer 0-100, "state": "working" | "waiting" | "done", "nextStep": string | null, "actions": [{"label": string, "reply": string}]}',
    "- headline: at most six words naming what the session is about, like a ticket title. No verbs like 'working on'.",
    "- purpose: one or two short sentences: the goal of the session and its current state. Write it in the language the user writes in.",
    "- progress: how far the goal is reached.",
    '- state: "waiting" when the last agent message asks the user a question or for a decision; "done" when the goal is reached and nothing is open; otherwise "working".',
    '- nextStep: the open step — when state is "waiting", the decision or answer the user owes; when "working", what remains to be done. A few words. null when done.',
    '- actions: up to four distinct next moves the user can pick with one key, best first. label: two to five words naming the move (e.g. "Take option 1", "Resume e2e tests", "Drop the branch"). reply: the message sent to the agent when picked, written so it works without context — sessions are often picked up again after days. When "waiting", one action per sensible answer to the open question; when "working", resume the open step plus real alternatives; an empty array when done or nothing fits.',
    "Write every text field in the language the user writes in.",
    "Do not use tools. Do not change anything.",
    "",
    `Session title: ${title}`,
    "",
    transcript,
  ].join("\n");
}

/** Pull the JSON object out of the reply; models wrap it in fences or prose despite being told not to. */
export function parseAssessment(reply: string | null | undefined): Assessment | null {
  if (!reply) return null;
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const raw = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof raw.progress === "number") raw.progress = Math.round(Math.min(100, Math.max(0, raw.progress)));
    if (raw.nextStep === "") raw.nextStep = null;
    if (!Array.isArray(raw.actions)) raw.actions = [];
    raw.actions = (raw.actions as unknown[]).slice(0, 4);
    const parsed = assessmentSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Whether a stored assessment needs a new run. Nothing new said means nothing
 * new to assess; the interval keeps a chatty thread from paying for Opus on
 * every turn.
 */
export function needsEvaluation(
  stored: Pick<Purpose, "messageCount" | "evaluatedAt" | "headline" | "actions"> | undefined,
  messageCount: number,
  now: number,
  minIntervalMs: number,
): boolean {
  if (messageCount === 0) return false;
  if (stored === undefined) return true;
  // Stored before headlines existed: the card has nothing short to show.
  if (stored.headline === undefined || stored.actions === undefined) return true;
  if (stored.messageCount === messageCount) return false;
  return now - stored.evaluatedAt >= minIntervalMs;
}

/** The actions to offer, reading an assessment stored before actions existed as one action. */
export function actionsOf(purpose: Pick<Purpose, "actions" | "suggestedReply"> | undefined): NextAction[] {
  if (purpose === undefined) return [];
  if (purpose.actions !== undefined) return purpose.actions;
  return purpose.suggestedReply ? [{ label: "Send suggested reply", reply: purpose.suggestedReply }] : [];
}

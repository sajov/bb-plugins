// The canvas page's last level (BBP-131 WI4): a crew member's bound thread,
// and — lazily, once that thread node is opened — its turns and tool calls
// from the SDK timeline. Pure mapping, so it is testable without the SDK.
import type { CanvasEdge, CanvasNode } from "./types";
import { formatTimeRange } from "./format";
import type { ThreadLike } from "./canvas-details";

export const threadNodeId = (threadId: string): string => `thread:${threadId}`;

/**
 * One thread node per member/run that has a bound thread. Collapsed by
 * default — its turns are not worth the weight until someone asks for them.
 * Returns `null` for a node without a `meta.threadId`, so a caller can map
 * over every node in a layer without filtering first.
 */
export function threadNodeFor(parent: CanvasNode, info: ThreadInfo = {}): CanvasNode | null {
  const threadId = parent.meta?.threadId;
  if (typeof threadId !== "string" || threadId === "") return null;
  const title = info.title?.trim() ?? "";
  const firstMessage = truncate(info.firstUserMessage ?? "", 48);
  return {
    id: threadNodeId(threadId),
    kind: "thread",
    label: title || firstMessage || "Thread",
    parentId: parent.id,
    meta: compact({ threadId, title, state: info.state, provider: info.provider }),
  };
}

/** What a caller may already know about the thread: its title (the card's
 *  label), else its first user message, plus state and provider. */
export type ThreadInfo = {
  title?: string | null;
  firstUserMessage?: string | null;
  state?: string | null;
  provider?: string | null;
};

/** Drops `undefined`, `null` and `""` so the sidebar never shows an empty
 *  field (its `curateMeta` only drops `undefined`/`null`). */
function compact(meta: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

/** What `enrichThreadNodes` needs to turn a placeholder thread node into its
 *  real card: the thread itself, and — only when it has no title — its
 *  first user message, for the same fallback `threadNodeFor` applies. */
export type ThreadTitlePort = {
  get: (threadId: string) => Promise<ThreadLike>;
  firstUserMessage: (threadId: string) => Promise<string | undefined>;
};

/** Replaces each placeholder `"Thread"` node (built eagerly by `threadNodeFor`
 *  with no `info`) with one carrying the thread's real title/state/provider,
 *  once that is readable (BBP-206 requirement 3). A thread that cannot be
 *  read, or a node that is not a thread's parent, is left exactly as it was
 *  — this never throws and never drops a node. */
export async function enrichThreadNodes(
  parents: readonly CanvasNode[],
  nodes: readonly CanvasNode[],
  port: ThreadTitlePort,
): Promise<CanvasNode[]> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  await Promise.all(
    parents.map(async (parent) => {
      const threadId = parent.meta?.threadId;
      if (typeof threadId !== "string" || threadId === "") return;
      const id = threadNodeId(threadId);
      const existing = byId.get(id);
      if (!existing) return;
      // Already enriched (a poll rebuilds every node from scratch, but a
      // caller that carries enrichment over between polls hands back the
      // same node) — state/provider are always set once a thread has been
      // read successfully, even when it has no title of its own (BBP-206 R3:
      // re-fetching every thread on every 5s poll starved `enrichTurnNodes`
      // of time to ever finish before the next poll reset the tree).
      if (existing.meta?.state !== undefined || existing.meta?.provider !== undefined) return;
      try {
        const thread = await port.get(threadId);
        const title = thread.title || thread.titleFallback || undefined;
        const firstUserMessage = title ? undefined : await port.firstUserMessage(threadId).catch(() => undefined);
        const rebuilt = threadNodeFor(parent, {
          title,
          state: thread.displayStatus ?? thread.status,
          provider: thread.providerId,
          firstUserMessage,
        });
        if (rebuilt) byId.set(id, rebuilt);
      } catch {
        // Thread unreadable: the placeholder "Thread" label stands.
      }
    }),
  );
  return nodes.map((node) => byId.get(node.id) ?? node);
}

/** The slice of a `ThreadTimelineResponse` row this mapping reads, aligned
 *  with the SDK's real `TimelineRow` union (verified against the
 *  `@get-bb/plugin-sdk` bundled zod schemas and real samples, BBP-206 R2a/b/c
 *  — see `bb-canvas/fixtures/real-timeline-rows.json`): `kind` is `"turn"`,
 *  `"conversation"`, `"work"`, or `"system"`. A `"work"` row's `workKind` is
 *  a 16-way discriminated union with *disjoint* fields per kind; every kind
 *  gets its own label and meta fields below (none reads just `"work"`), down
 *  to the field names the real zod schemas use. */
export type TimelineRowLike = {
  id: string;
  kind: string;
  turnId?: string | null;
  text?: string;
  role?: string;
  status?: string;
  summaryCount?: number;
  /** Where this row sits in the thread's source sequence — a turn row needs
   *  both ends to fetch its own steps via `timelineTurnSummaryDetails`. */
  sourceSeqStart?: number;
  sourceSeqEnd?: number;
  /** A `"turn"` row's own nested rows. The real SDK never populates this —
   *  turn steps are fetched lazily via `timelineTurnSummaryDetails` — but a
   *  caller that already has them (e.g. a future eager page) can still nest them. */
  children?: readonly TimelineRowLike[] | null;
  /** Discriminates a `"work"` row: `"command"` (shell), `"tool"` (MCP/other
   *  tool calls), `"file-change"` (Edit/Write), `"delegation"` (subagent
   *  spawn), or one of 12 other kinds this mapping does not special-case. */
  workKind?: string;
  /** Real Unix-ms timestamps (not strings — BBP-206 R2b correction). */
  startedAt?: number;
  completedAt?: number;
  /** `workKind: "command"` fields: a shell invocation. No `toolName`/`toolArgs`. */
  command?: string;
  cwd?: string;
  exitCode?: number;
  /** `workKind: "tool"` fields: an MCP/other tool call. No `exitCode`/`command`. */
  toolName?: string;
  toolArgs?: unknown;
  /** Shared by `command` and `tool`. */
  output?: string;
  outputPreview?: string;
  /** `workKind: "file-change"` fields: one file edit. No `output`/`exitCode`. */
  change?: {
    path?: string;
    kind?: string;
    movePath?: string | null;
    diffStats?: { added: number; removed: number };
  };
  stdout?: string | null;
  stderr?: string | null;
  /** `workKind: "delegation"` (subagent) row's task description. */
  description?: string | null;
  /** A delegation row's own nested rows (`TimelineDelegationWorkRow.childRows`). */
  childRows?: readonly TimelineRowLike[] | null;
  /** A `"system"` row's own fields. */
  title?: string;
  detail?: string | null;
  /** e.g. `"debug"`, `"error"`, `"reconnect"`, or `"operation"` (see `operationKind`). */
  systemKind?: string;
  /** e.g. `"context-clear"`, `"compaction"`, `"parent-change"`, `"reasoning"`,
   *  `"warning"` — real values are hyphenated, not underscored. */
  operationKind?: string;
  /** Only present when `operationKind === "parent-change"`; titles are the
   *  human-readable form, preferred over the bare ids. */
  parentChange?: {
    action?: string;
    previousParentThreadId?: string;
    previousParentThreadTitle?: string;
    nextParentThreadId?: string;
    nextParentThreadTitle?: string;
  };
  /** `workKind: "file-read"` / `"image-view"`: the file opened. Also read by
   *  `"search"` for a path-scoped search (its own `path` is nullable there). */
  path?: string | null;
  /** `workKind: "search"` fields: a grep/glob/list call. */
  query?: string;
  mode?: string;
  /** `workKind: "web-search"` fields. */
  queries?: readonly string[];
  /** `workKind: "web-fetch"` fields. */
  url?: string;
  /** `workKind: "web-fetch"` / `"image-generation"` fields. */
  prompt?: string | null;
  /** `workKind: "image-generation"` fields. */
  error?: string | null;
  /** `workKind: "plan-steps"` fields. */
  explanation?: string | null;
  steps?: readonly { step: string; status?: string }[];
  /** `workKind: "extension"` fields, e.g. `"ui/confirm"`. */
  extensionKind?: string;
  /** `workKind: "approval"` fields: a file-edit or permission-grant gate. */
  approvalKind?: string;
  lifecycle?: string;
  target?: { itemId?: string; toolName?: string | null };
  /** `workKind: "form"` / `"question"` shared field. */
  interactionId?: string;
  /** `workKind: "form"` fields. */
  rendererId?: string;
  /** `workKind: "question"` fields. */
  questions?: readonly { prompt: string }[];
  /** `workKind: "workflow"` fields. */
  workflowName?: string | null;
  taskType?: string;
  summary?: string | null;
  /** A `"conversation"` row's own request classification (BBP-228) — not yet
   *  used by `turnTitle` (reserved for a future kind-specific form). */
  systemMessageKind?: string;
  /** A `"conversation"` row's own structured detail for its `[bb system]`
   *  notice (BBP-228 R2) — for a single child-thread completion, `threadName`
   *  is that child's display name, already resolved server-side; `turnTitle`
   *  uses it instead of ever showing the bare thread id. */
  systemMessageSubject?: { kind?: string; threadId?: string; threadName?: string } | null;
};

const TURN_STATUS: Record<string, CanvasNode["status"]> = {
  running: "running",
  queued: "waiting",
  done: "done",
  completed: "done",
  failed: "failed",
  skipped: "idle",
};

function truncate(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** A delegation row is the SDK's representation of a spawned subagent. */
function isSubagentRow(row: TimelineRowLike): boolean {
  return row.workKind === "delegation";
}

/** A tool call's arguments as one short string: the command if there is
 *  one, else the arguments as JSON. Empty when there are none. */
function argsText(args: unknown): string {
  if (args === undefined || args === null || args === "") return "";
  if (typeof args === "string") return args;
  if (typeof args === "object" && typeof (args as { command?: unknown }).command === "string") {
    return (args as { command: string }).command;
  }
  // Indented: the sidebar shows it as code, one argument per line.
  return JSON.stringify(args, null, 2) ?? "";
}

/** `"400ms"` under a second, else `"2.3s"` — computed from real Unix-ms
 *  numbers (BBP-206 R2b: `Date.parse` on a number was always `NaN`). */
function duration(startedAt?: number, completedAt?: number): string | undefined {
  if (typeof startedAt !== "number" || typeof completedAt !== "number") return undefined;
  const ms = completedAt - startedAt;
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** The first conversation row with `role: "user"` among `rows` — the turn's
 *  own request, as found in its (always-null-on-real-pages) `children`, kept
 *  only as the `turnDetailsToCanvas`/`enrichTurnNodes` fallback path's
 *  source of truth (BBP-228 moved the primary source to thread-level rows,
 *  see `timelineToCanvas`). */
function firstUserConversation(rows: readonly TimelineRowLike[] | null | undefined): TimelineRowLike | undefined {
  return (rows ?? []).find((row) => row.kind === "conversation" && row.role === "user");
}

/** Derives a turn's card title from the raw text of its triggering request
 *  (BBP-228): a crew message's `From: … → To: …` header becomes `"from
 *  <sender>: <subject>"` (or, lacking a `Subject:` line, the first line after
 *  the `---` separator); a kickoff brief becomes `"Kickoff: <name>"`; a `[bb
 *  message from thread:…]` becomes `"from thread: <line>"`; a `[bb system]`
 *  notice keeps just its own first line; anything else is used as-is. Never
 *  empty — a request with no usable line after stripping its prefix falls
 *  back to `"Turn"`. `systemMessageKind` is accepted for a future
 *  kind-specific form but not evaluated this round; `systemMessageSubject`
 *  is used for exactly one shape — a single child-thread completion
 *  (`"@thread:<id> completed:"`) — where its `threadName` replaces the id
 *  (BBP-228 R2: a title must never show a bare thread id). */
export function turnTitle(
  text: string,
  _systemMessageKind?: string,
  systemMessageSubject?: TimelineRowLike["systemMessageSubject"],
): string {
  const trimmed = (text ?? "").trim();
  if (trimmed === "") return "Turn";
  const lines = trimmed.split("\n");
  const firstLine = lines[0]!.trim();

  const kickoff = firstLine.match(/^\[crew\] Kickoff brief for (.+)$/);
  if (kickoff) {
    const name = kickoff[1]!.trim();
    return name ? `Kickoff: ${name}` : "Turn";
  }

  const fromTo = firstLine.match(/^\[crew\] From: (.+?) → To: .+$/);
  if (fromTo) {
    const sender = fromTo[1]!.split(/[@→]/)[0]!.trim();
    const subjectLine = lines.slice(1).find((line) => /^Subject:/.test(line.trim()));
    if (subjectLine) {
      const subject = subjectLine.trim().replace(/^Subject:\s*/, "").trim();
      if (subject) return `from ${sender}: ${subject}`;
    }
    const sepIndex = lines.findIndex((line) => line.trim() === "---");
    if (sepIndex >= 0) {
      const firstAfter = lines.slice(sepIndex + 1).find((line) => line.trim() !== "");
      if (firstAfter) return firstAfter.trim();
    }
    return "Turn";
  }

  const threadMessage = trimmed.match(/^\[bb message from thread:[^\]]*\]\s*([\s\S]*)$/);
  if (threadMessage) {
    const line = (threadMessage[1] ?? "").split("\n").find((candidate) => candidate.trim() !== "");
    return line ? `from thread: ${line.trim()}` : "Turn";
  }

  const system = trimmed.match(/^\[bb system\]\s*([\s\S]*)$/);
  if (system) {
    const restLines = (system[1] ?? "").split("\n");
    const firstIdx = restLines.findIndex((candidate) => candidate.trim() !== "");
    if (firstIdx === -1) return "Turn";
    const line = restLines[firstIdx]!.trim();
    const childDone = line.match(/^@thread:\S+\s+completed:$/);
    if (childDone) {
      const name = systemMessageSubject?.threadName?.trim();
      const label = name ? `${name} done` : "thread done";
      const contentLine = restLines.slice(firstIdx + 1).find((candidate) => candidate.trim() !== "");
      return contentLine ? `${label}: ${contentLine.trim()}` : label;
    }
    return line;
  }

  const firstNonEmpty = lines.find((line) => line.trim() !== "");
  return firstNonEmpty ? firstNonEmpty.trim() : "Turn";
}

/** Strips a request's own header/footer noise for the sidebar's "Request"
 *  field (BBP-228 R2) — the raw text (with every prefix/header line intact)
 *  stays available as `meta.requestRaw`, behind "Debug", so nothing is lost.
 *  A crew message's `From/To`/`Sent`/`Subject` header is dropped up to its
 *  `---` separator (or, lacking one, just its first line); a trailing
 *  "Reply with crew_send(...)" footer (the crew tool's own boilerplate) is
 *  dropped; a kickoff brief loses only its own first line; a `[bb system]`/
 *  `[bb message from thread:…]` notice loses just its prefix, and a single
 *  child completion also its bare "@thread:<id> completed:" line. Anything else
 *  passes through unchanged. */
export function cleanRequestText(text: string): string {
  const raw = text ?? "";
  const lines = raw.split("\n");
  const firstLine = (lines[0] ?? "").trim();
  let body: string;

  if (/^\[crew\] Kickoff brief for /.test(firstLine)) {
    body = lines.slice(1).join("\n");
  } else if (/^\[crew\] From: .+ → To: .+$/.test(firstLine)) {
    let i = 1;
    while (i < lines.length && lines[i]!.trim() !== "---" && lines[i]!.trim() !== "") i++;
    if (lines[i]?.trim() === "---") i++;
    body = lines.slice(i).join("\n");
  } else {
    const threadMessage = raw.match(/^\[bb message from thread:[^\]]*\]\s*([\s\S]*)$/);
    const system = raw.match(/^\[bb system\]\s*([\s\S]*)$/);
    body = threadMessage ? (threadMessage[1] ?? "") : system ? (system[1] ?? "") : raw;
  }

  body = body.replace(/\n?-{3,}\s*\nReply with crew_send\([\s\S]*$/, "");
  // A child-completion notice's "@thread:<id> completed:" line is only the
  // bare id — the title already names the child ("steps-impl done: …").
  body = body.replace(/^\s*@thread:\S+\s+completed:[ \t]*(\n|$)/, "");
  return body.trim();
}

function fileName(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  return path.split("/").pop() || path;
}

function rowLabel(row: TimelineRowLike): string {
  if (row.kind === "conversation") return truncate(row.text ?? "(empty)", 48) || "(empty)";
  if (isSubagentRow(row)) return `Agent: ${row.description ?? "(no description)"}`;
  if (row.toolName) return row.toolName;
  return row.kind;
}

// The sidebar itself truncates a long value behind a "more" toggle
// (BBP-206 review round 1) — every meta builder below stores the full
// value, never a clipped one, so "more" always has the real thing to reveal.
function timedMeta(row: TimelineRowLike, threadId: string | undefined): Record<string, unknown> {
  return compact({
    duration: duration(row.startedAt, row.completedAt),
    ...formatTimeRange(row.startedAt, row.completedAt),
    // Raw, for ordering steps across threads (the tool-call terminal).
    startedAtMs: row.startedAt,
    ...(threadId && typeof row.sourceSeqStart === "number" ? { threadId, sourceSeq: row.sourceSeqStart } : {}),
  });
}

function commandMeta(row: TimelineRowLike, threadId: string | undefined): Record<string, unknown> {
  return compact({
    command: row.command,
    cwd: row.cwd,
    outputPreview: row.outputPreview || row.output || "",
    exitCode: row.exitCode,
    ...timedMeta(row, threadId),
  });
}

function toolMeta(row: TimelineRowLike, threadId: string | undefined): Record<string, unknown> {
  const argsString = argsText(row.toolArgs);
  const isCommandShaped = typeof row.toolArgs === "string" || typeof (row.toolArgs as { command?: unknown } | null)?.command === "string";
  return compact({
    toolName: row.toolName,
    ...(isCommandShaped ? { command: argsString } : { toolArgs: argsString }),
    outputPreview: row.outputPreview || row.output || "",
    ...timedMeta(row, threadId),
  });
}

function fileChangeMeta(row: TimelineRowLike, threadId: string | undefined): Record<string, unknown> {
  const diffStats = row.change?.diffStats;
  return compact({
    path: row.change?.path,
    changeKind: row.change?.kind,
    diffStats: diffStats ? `+${diffStats.added} -${diffStats.removed}` : undefined,
    stdout: row.stdout || "",
    stderr: row.stderr || "",
    ...timedMeta(row, threadId),
  });
}

/** Dispatches a `"work"` row's sidebar fields by `workKind` — every one of
 *  the real 16 has disjoint fields (a shell command's `exitCode` does not
 *  exist on an MCP tool call, a file edit has neither); reading them through
 *  one flat object produced `[object Object]`/empty fields before (BBP-206
 *  R2b finding 1). A row whose `workKind` this still doesn't recognise (the
 *  schema evolves) falls through to an empty object — status/summary from
 *  the caller still show, nothing crashes or reads a field that isn't there. */
function workMeta(row: TimelineRowLike, threadId: string | undefined): Record<string, unknown> {
  switch (row.workKind) {
    case "command":
      return commandMeta(row, threadId);
    case "tool":
      return toolMeta(row, threadId);
    case "file-change":
      return fileChangeMeta(row, threadId);
    case "file-read":
    case "image-view":
      return compact({ path: row.path, ...timedMeta(row, threadId) });
    case "search":
      return compact({ query: row.query, mode: row.mode, path: row.path, ...timedMeta(row, threadId) });
    case "web-search":
      return compact({ queries: row.queries?.join(", "), ...timedMeta(row, threadId) });
    case "web-fetch":
      return compact({ url: row.url, prompt: row.prompt, ...timedMeta(row, threadId) });
    case "image-generation":
      return compact({ prompt: row.prompt, error: row.error, ...timedMeta(row, threadId) });
    case "plan-steps":
      return compact({
        explanation: row.explanation,
        steps: row.steps && row.steps.length > 0 ? row.steps.map((step) => step.step).join(", ") : undefined,
        ...timedMeta(row, threadId),
      });
    case "extension":
      return compact({ extensionKind: row.extensionKind, ...timedMeta(row, threadId) });
    case "approval":
      return compact({
        approvalKind: row.approvalKind,
        lifecycle: row.lifecycle,
        toolName: row.target?.toolName,
        ...timedMeta(row, threadId),
      });
    case "form":
      return compact({ title: row.title, rendererId: row.rendererId, lifecycle: row.lifecycle, ...timedMeta(row, threadId) });
    case "question":
      return compact({
        lifecycle: row.lifecycle,
        questions: row.questions && row.questions.length > 0 ? row.questions.map((question) => question.prompt).join(", ") : undefined,
        ...timedMeta(row, threadId),
      });
    case "workflow":
      return compact({ workflowName: row.workflowName, taskType: row.taskType, summary: row.summary, ...timedMeta(row, threadId) });
    default:
      return {};
  }
}

/** The card label for a `"work"` row, by `workKind` — never just `"work"`
 *  (BBP-206 R2 review). Delegation is handled by `rowLabel`'s subagent
 *  branch before this is ever reached. A `workKind` this doesn't recognise
 *  (the schema evolves) falls back to `rowLabel`'s generic tool-name-or-kind
 *  reading — not a crash, not an empty card. */
function workLabel(row: TimelineRowLike): string {
  switch (row.workKind) {
    case "command":
      return row.command ? truncate(row.command, 48) : row.kind;
    case "tool":
      return row.toolName ?? row.kind;
    case "file-change":
      return fileName(row.change?.path) ?? row.kind;
    case "file-read":
    case "image-view":
      return fileName(row.path) ?? row.kind;
    case "search":
      return row.query ? truncate(row.query, 48) : row.kind;
    case "web-search":
      return row.queries?.[0] ? truncate(row.queries[0], 48) : row.kind;
    case "web-fetch":
      return row.url ? truncate(row.url, 48) : row.kind;
    case "image-generation":
      return row.prompt ? truncate(row.prompt, 48) : "Image";
    case "plan-steps":
      return row.explanation ? truncate(row.explanation, 48) : "Plan";
    case "extension":
      return row.extensionKind ?? row.kind;
    case "approval":
      return row.approvalKind === "permission-grant"
        ? truncate(`Permission: ${row.target?.toolName ?? "?"}`, 48)
        : truncate(`Approve: ${row.target?.toolName ?? "edit"}`, 48);
    case "form":
      return row.title ?? row.kind;
    case "question":
      return row.questions?.[0]?.prompt ? truncate(row.questions[0].prompt, 48) : "Question";
    case "workflow":
      return row.workflowName || row.description || row.kind;
    default:
      return rowLabel(row);
  }
}

const RUNNING_ROW = new Set(["running", "in_progress", "pending", "started", "streaming"]);
const SETTLED_ROW = new Set(["completed", "error", "failed", "cancelled", "canceled", "skipped", "done"]);

/** Builds a row's own canvas node plus, for a subagent spawn, its own
 *  `childRows` flattened alongside it. */
function rowNodes(row: TimelineRowLike, parentId: string, threadId?: string): CanvasNode[] {
  const id = `row:${row.id}`;
  const isWork = row.kind === "work" && !isSubagentRow(row);
  const failed = (isWork && typeof row.exitCode === "number" && row.exitCode !== 0) || row.status === "error" || row.status === "failed";
  // A step still at work: the running path then reaches down to it, as in
  // agent-graph (BBP-298). Started without an end and not settled counts too.
  const running =
    !failed &&
    row.kind === "work" &&
    (RUNNING_ROW.has(row.status ?? "") || (row.startedAt != null && row.completedAt == null && !SETTLED_ROW.has(row.status ?? "")));
  const node: CanvasNode = {
    id,
    kind: row.kind === "conversation" ? "turn" : isSubagentRow(row) ? "subagent" : "tool-call",
    label: isWork ? workLabel(row) : rowLabel(row),
    ...(failed ? { status: "failed" as const } : running ? { status: "running" as const } : {}),
    parentId,
    meta: {
      rowId: row.id,
      kind: row.kind,
      ...(row.status ? { status: row.status } : {}),
      ...(isWork && row.workKind ? { workKind: row.workKind } : {}),
      // A message row's own text, so its sidebar is not just ids (BBP-206 design).
      ...(row.kind === "conversation" ? compact({ from: row.role === "user" ? "User" : row.role === "assistant" ? "Agent" : row.role, text: row.text }) : {}),
      ...(row.output && isSubagentRow(row) ? { summary: row.output } : {}),
      ...(isWork ? workMeta(row, threadId) : {}),
    },
  };
  const children = mapRows(row.childRows ?? [], id, threadId);
  return [node, ...children];
}

/** An error, or an operation that says what happened, stands on its own.
 *  `reasoning` rows never reach here — `mapRows` pulls every one of them out
 *  into `thoughtsNode` first — but the check stays as a defensive no-op in
 *  case that ever changes. Every other minor system row is noise worth one
 *  bundled node. */
function isOwnSystemEvent(row: TimelineRowLike): boolean {
  if (row.systemKind === "error") return true;
  if (row.systemKind !== "operation") return false;
  if (row.operationKind === "reasoning") return false;
  // A parent-change's own information lives in `parentChange`, not `detail`
  // (which is often null for it) — it always stands on its own regardless.
  if (row.operationKind === "parent-change") return true;
  return !!row.detail;
}

function systemEventNode(row: TimelineRowLike, parentId: string): CanvasNode {
  const parentChange = row.operationKind === "parent-change" ? row.parentChange : undefined;
  return {
    id: `row:${row.id}`,
    kind: "system-event",
    label: row.title || row.operationKind || row.systemKind || "system event",
    ...(row.systemKind === "error" ? { status: "failed" as const } : {}),
    parentId,
    meta: compact({
      rowId: row.id,
      detail: row.detail,
      ...(parentChange
        ? {
            oldParent: parentChange.previousParentThreadTitle ?? parentChange.previousParentThreadId,
            newParent: parentChange.nextParentThreadTitle ?? parentChange.nextParentThreadId,
          }
        : {}),
    }),
  };
}

/** A bundle that collapses to exactly one row still shows that row's own
 *  title as its label (BBP-206 R3) — a lone "1 system event" node hides its
 *  only content behind the collapsed Details block for no reason; only a
 *  genuinely titleless row falls back to the generic count label. */
function bundledSystemNode(rows: readonly TimelineRowLike[], parentId: string): CanvasNode {
  if (rows.length === 1 && rows[0]!.title) return systemEventNode(rows[0]!, parentId);
  const titles = rows.map((row) => row.title).filter((title): title is string => !!title);
  return {
    id: `row:${rows[0]!.id}`,
    kind: "system-event",
    label: `${rows.length} system ${rows.length === 1 ? "event" : "events"}`,
    parentId,
    meta: compact({ rowId: rows[0]!.id, ...(titles.length > 0 ? { titles } : {}) }),
  };
}

/** A reasoning ("thought") row — `operationKind: "reasoning"`. In a real
 *  turn these interleave with tool calls rather than running consecutively,
 *  so run-based bundling left each one standing alone: 85 separate
 *  "1 system event" nodes per turn in practice (BBP-206 R3). Every thought
 *  in one sibling list (one turn, or the thread-level list) is pulled out
 *  and bundled together regardless of where it sits among the others. */
function isReasoningRow(row: TimelineRowLike): boolean {
  return row.kind === "system" && row.systemKind === "operation" && row.operationKind === "reasoning";
}

function thoughtsNode(rows: readonly TimelineRowLike[], parentId: string): CanvasNode {
  const starts = rows.map((row) => row.startedAt).filter((value): value is number => typeof value === "number");
  const ends = rows.map((row) => row.completedAt).filter((value): value is number => typeof value === "number");
  const span = starts.length > 0 && ends.length > 0 ? duration(Math.min(...starts), Math.max(...ends)) : undefined;
  const thoughts = rows.map((row) => row.detail || row.title).filter((text): text is string => !!text);
  return {
    id: `row:${rows[0]!.id}`,
    kind: "system-event",
    label: `${rows.length} ${rows.length === 1 ? "thought" : "thoughts"}${span ? ` · ${span}` : ""}`,
    parentId,
    meta: compact({ rowId: rows[0]!.id, ...(thoughts.length > 0 ? { titles: thoughts } : {}) }),
  };
}

/** Maps sibling rows: every thought (see `isReasoningRow`) in the list
 *  bundles into one node regardless of position, then each remaining run of
 *  consecutive minor system rows bundles as before. */
function mapRows(rows: readonly TimelineRowLike[], parentId: string, threadId?: string): CanvasNode[] {
  const thoughts = rows.filter(isReasoningRow);
  const rest = thoughts.length > 0 ? rows.filter((row) => !isReasoningRow(row)) : rows;
  const nodes: CanvasNode[] = thoughts.length > 0 ? [thoughtsNode(thoughts, parentId)] : [];
  let bundle: TimelineRowLike[] = [];
  const flush = () => {
    if (bundle.length > 0) nodes.push(bundledSystemNode(bundle, parentId));
    bundle = [];
  };
  for (const row of rest) {
    if (row.kind === "system" && !isOwnSystemEvent(row)) {
      bundle.push(row);
      continue;
    }
    flush();
    nodes.push(...(row.kind === "system" ? [systemEventNode(row, parentId)] : rowNodes(row, parentId, threadId)));
  }
  flush();
  return nodes;
}

/**
 * Converts one page of a thread's timeline into canvas nodes under
 * `threadNodeId(threadId)`. A `"turn"` row's own `children` (its
 * conversation and work rows) become its canvas children; every other
 * top-level row hangs directly off the thread.
 */
/** Maps each turn to the raw text of the thread-level request that triggered
 *  it (BBP-228): a `"conversation"`/`role: "user"` row's `turnId` names its
 *  turn directly; a row with no `turnId` (observed on Pi threads) is instead
 *  assigned to the next `"turn"` row that follows it in `sourceSeqStart`
 *  order, as long as that turn has no request yet — a trailing row with no
 *  turn left to follow stays unassigned. Every matched or Pi-style user row
 *  is excluded from the returned index so the thread never also renders it
 *  as its own node (only engaged when the page has at least one turn row at
 *  all, so a page of bare conversation rows keeps its original rendering). */
function requestsByTurn(rows: readonly TimelineRowLike[]): { byTurnKey: Map<string, TimelineRowLike>; consumed: ReadonlySet<number> } {
  const byTurnKey = new Map<string, TimelineRowLike>();
  const consumed = new Set<number>();
  const turnKeys = new Set(rows.filter((row) => row.kind === "turn").map((row) => row.turnId ?? row.id));
  if (turnKeys.size === 0) return { byTurnKey, consumed };

  rows.forEach((row, index) => {
    if (row.kind !== "conversation" || row.role !== "user") return;
    consumed.add(index);
    if (typeof row.turnId === "string" && turnKeys.has(row.turnId) && !byTurnKey.has(row.turnId) && row.text) {
      byTurnKey.set(row.turnId, row);
    }
  });

  const turnsBySeq = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.kind === "turn" && typeof row.sourceSeqStart === "number")
    .sort((a, b) => a.row.sourceSeqStart! - b.row.sourceSeqStart!);
  const orphans = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row, index }) => consumed.has(index) && (row.turnId === undefined || row.turnId === null) && typeof row.sourceSeqStart === "number")
    .sort((a, b) => a.row.sourceSeqStart! - b.row.sourceSeqStart!);
  for (const { row } of orphans) {
    const key = row.turnId ?? undefined;
    if (key !== undefined && byTurnKey.has(key)) continue;
    const next = turnsBySeq.find(({ row: turn }) => turn.sourceSeqStart! > row.sourceSeqStart! && !byTurnKey.has(turn.turnId ?? turn.id));
    if (next && row.text) byTurnKey.set(next.row.turnId ?? next.row.id, row);
  }

  return { byTurnKey, consumed };
}

/** The text of the last `"conversation"`/`role: "assistant"` row sharing a
 *  given turn's `turnId` — its answer preview (BBP-228). Only matches by
 *  `turnId` (no Pi fallback for the answer side, per spec). */
function answersByTurn(rows: readonly TimelineRowLike[]): Map<string, string> {
  const byTurnKey = new Map<string, string>();
  for (const row of rows) {
    if (row.kind === "conversation" && row.role === "assistant" && typeof row.turnId === "string" && row.text) {
      byTurnKey.set(row.turnId, row.text);
    }
  }
  return byTurnKey;
}

export function timelineToCanvas(
  threadId: string,
  response: { rows: readonly TimelineRowLike[] },
  stepsLimit: number | null = null,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const parent = threadNodeId(threadId);
  const { byTurnKey: requestRows, consumed } = requestsByTurn(response.rows);
  const answerText = answersByTurn(response.rows);
  const nodes: CanvasNode[] = [];
  let pending: TimelineRowLike[] = [];
  // A running turn has no turn row yet, only its steps — each carrying the
  // turn's id. Those are grouped under a turn card of their own, as agent-graph
  // shows them, instead of hanging loose off the thread (BBP-298).
  const turnKeys = new Set(response.rows.filter((row) => row.kind === "turn").map((row) => row.turnId ?? row.id));
  const liveTurns = new Map<string, CanvasNode>();
  const flush = () => {
    const loose: TimelineRowLike[] = [];
    const grouped = new Map<string, TimelineRowLike[]>();
    for (const row of pending) {
      const key = row.turnId;
      if (row.kind !== "system" && typeof key === "string" && !turnKeys.has(key)) {
        // The request itself titles the turn card; it is not a step of it.
        if (row.kind === "conversation" && row.role === "user") continue;
        grouped.set(key, [...(grouped.get(key) ?? []), row]);
      }
      else loose.push(row);
    }
    nodes.push(...mapRows(loose, parent, threadId));
    for (const [key, rows] of grouped) {
      let turn = liveTurns.get(key);
      if (!turn) {
        const request = requestRows.get(key) ?? response.rows.find((row) => row.kind === "conversation" && row.role === "user" && row.turnId === key && row.text);
        const title = request?.text ? turnTitle(request.text, request.systemMessageKind, request.systemMessageSubject) : undefined;
        turn = {
          id: `row:live-turn:${key}`,
          kind: "turn",
          label: title ? truncate(title, 48) : "Turn in progress",
          status: "running",
          parentId: parent,
          meta: { threadId, turnId: key, live: true, ...(title ? { firstLine: title, request: cleanRequestText(request!.text!) } : {}) },
        };
        liveTurns.set(key, turn);
        nodes.push(turn);
      }
      nodes.push(...mapRows(rows, turn.id, threadId));
    }
    pending = [];
  };
  response.rows.forEach((row, index) => {
    if (row.kind !== "turn") {
      // A reply belongs to its turn (the turn card carries it as its answer);
      // as a card of its own it cluttered the thread (BBP-298).
      const folded = row.kind === "conversation" && row.role === "assistant" && typeof row.turnId === "string" && turnKeys.has(row.turnId);
      if (!consumed.has(index) && !folded) pending.push(row);
      return;
    }
    flush();
    const turnNodeId = `row:${row.id}`;
    const turnKey = row.turnId ?? row.id;
    const summaryCount = row.summaryCount ?? (row.children?.length ?? 0);
    const requestRow = requestRows.get(turnKey) ?? firstUserConversation(row.children);
    const requestFullText = requestRow?.text;
    const title = requestFullText !== undefined ? turnTitle(requestFullText, requestRow?.systemMessageKind, requestRow?.systemMessageSubject) : undefined;
    const answerPreview = answerText.get(turnKey);
    nodes.push({
      id: turnNodeId,
      kind: "turn",
      label: title ? truncate(title, 48) : `Turn · ${summaryCount} ${summaryCount === 1 ? "step" : "steps"}`,
      ...(row.status && TURN_STATUS[row.status] ? { status: TURN_STATUS[row.status] } : {}),
      parentId: parent,
      meta: {
        rowId: row.id,
        threadId,
        turnId: turnKey,
        sourceSeqStart: row.sourceSeqStart,
        sourceSeqEnd: row.sourceSeqEnd,
        summaryCount,
        ...(title ? { firstLine: title } : {}),
        // The sidebar's own rows: the cleaned request (the card title is
        // only its first line; the raw text with every header/footer line
        // intact stays behind "Debug" as requestRaw, BBP-228 R2), the
        // answer, and how long the turn took.
        ...(requestFullText?.trim() ? { request: cleanRequestText(requestFullText), requestRaw: requestFullText.trim() } : {}),
        ...(answerPreview ? { answerPreview } : {}),
        ...(duration(row.startedAt, row.completedAt) ? { duration: duration(row.startedAt, row.completedAt) } : {}),
      },
    });
    nodes.push(...mapRows(row.children ?? [], turnNodeId, threadId));
  });
  flush();
  // A running turn's steps arrive loose under the thread, not yet grouped
  // under a turn: the same newest-N rule applies to them (BBP-298).
  if (stepsLimit === null) return { nodes, edges: [] };
  const parents = new Set(nodes.map((node) => node.parentId).filter((id): id is string => id !== null));
  return { nodes: [...parents].reduce((list, parentId) => limitSteps(list, parentId, stepsLimit), nodes), edges: [] };
}

const STEP_KINDS = new Set<CanvasNode["kind"]>(["tool-call", "subagent"]);

/** Keeps the newest `limit` tool-call/subagent children of `parentId` on it;
 *  the older ones move under one collapsed "+N earlier" node (BBP-286). */
function limitSteps(nodes: CanvasNode[], parentId: string, limit: number): CanvasNode[] {
  const steps = nodes.filter((node) => node.parentId === parentId && STEP_KINDS.has(node.kind));
  if (steps.length <= limit) return nodes;
  const hidden = new Set(steps.slice(0, steps.length - limit).map((node) => node.id));
  const earlierId = `${parentId}:earlier`;
  const earlier: CanvasNode = { id: earlierId, kind: "system-event", label: `+${hidden.size} earlier`, parentId, meta: { earlier: hidden.size } };
  const moved = nodes.map((node) => (hidden.has(node.id) ? { ...node, parentId: earlierId } : node));
  const at = moved.findIndex((node) => hidden.has(node.id));
  return [...moved.slice(0, at), earlier, ...moved.slice(at)];
}

/** Converts a turn's lazily-fetched steps (`timelineTurnSummaryDetails`'s
 *  `rows`) into canvas nodes under the turn's own node id. Same row mapping
 *  as `timelineToCanvas`'s thread-level rows (tool-call, subagent incl.
 *  nested `childRows`) — only the parent differs. With a `stepsLimit`, only
 *  the newest that many steps hang off the turn; the older ones move under
 *  one collapsed "+N earlier" node in front of them (BBP-286). */
export function turnDetailsToCanvas(
  turnNodeId: string,
  response: { rows: readonly TimelineRowLike[] },
  threadId?: string,
  stepsLimit: number | null = null,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const nodes = mapRows(response.rows, turnNodeId, threadId);
  const steps = nodes.filter((node) => node.parentId === turnNodeId);
  if (stepsLimit === null || steps.length <= stepsLimit) return { nodes, edges: [] };
  const hidden = new Set(steps.slice(0, steps.length - stepsLimit).map((node) => node.id));
  const earlierId = `${turnNodeId}:earlier`;
  const earlier: CanvasNode = {
    id: earlierId,
    kind: "system-event",
    label: `+${hidden.size} earlier`,
    parentId: turnNodeId,
    meta: { earlier: hidden.size },
  };
  const moved = nodes.map((node) => (hidden.has(node.id) ? { ...node, parentId: earlierId } : node));
  return { nodes: [earlier, ...moved], edges: [] };
}

/** What `enrichTurnNodes` needs to fetch one turn's lazily-loaded steps —
 *  the same page `loadChildren` fetches on an expand click, just triggered
 *  eagerly here so the card's first line doesn't wait for that. */
export type TurnFirstLinePort = {
  turnDetails: (
    turnId: string,
    threadId: string,
    sourceSeqStart: number,
    sourceSeqEnd: number,
  ) => Promise<{ rows: readonly TimelineRowLike[] }>;
};

/** Replaces each turn node without a `meta.firstLine` — real thread-level
 *  pages never carry a turn's `children` (BBP-206 R2b finding 3: they are
 *  always `null`, fetched lazily) — with one carrying the first line of its
 *  own request, once that page loads. A turn with 0 steps, missing
 *  coordinates, or whose first page has no `role: "user"` row keeps its
 *  plain `"Turn · n steps"` label; this never throws and never drops a node. */
export async function enrichTurnNodes(nodes: readonly CanvasNode[], port: TurnFirstLinePort): Promise<CanvasNode[]> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const pending = nodes.filter((node) => node.kind === "turn" && node.meta?.firstLine === undefined);
  await Promise.all(
    pending.map(async (node) => {
      const { threadId, turnId, sourceSeqStart, sourceSeqEnd, summaryCount } = node.meta ?? {};
      if (
        typeof threadId !== "string" ||
        typeof turnId !== "string" ||
        typeof sourceSeqStart !== "number" ||
        typeof sourceSeqEnd !== "number" ||
        typeof summaryCount !== "number" ||
        summaryCount === 0
      ) {
        return;
      }
      try {
        const { rows } = await port.turnDetails(turnId, threadId, sourceSeqStart, sourceSeqEnd);
        const request = firstUserConversation(rows);
        if (!request?.text) return;
        const title = turnTitle(request.text, request.systemMessageKind, request.systemMessageSubject);
        byId.set(node.id, {
          ...node,
          // The step count is already the card's subtitle ("Turn · n steps").
          label: truncate(title, 48),
          meta: { ...node.meta, firstLine: title, request: cleanRequestText(request.text), requestRaw: request.text.trim() },
        });
      } catch {
        // Turn steps unreadable: the plain "Turn · n steps" label stands.
      }
    }),
  );
  return nodes.map((node) => byId.get(node.id) ?? node);
}

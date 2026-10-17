// The domain-free vocabulary every canvas provider speaks. Crew, graph-studio
// and (later) threads each translate their own records into these two shapes;
// this package never imports a domain type in return.

export type CanvasNodeKind =
  | "agents"
  | "project"
  | "crew"
  | "member"
  | "graph-run"
  | "step"
  | "thread"
  | "turn"
  | "tool-call"
  | "subagent"
  | "system-event";

export type CanvasStatus = "idle" | "running" | "waiting" | "done" | "failed" | "escalated";

export type CanvasNode = {
  id: string;
  kind: CanvasNodeKind;
  label: string;
  /** Undefined draws a neutral dot — colour by status lands in BBP-146. */
  status?: CanvasStatus;
  /** `null` marks a root. A parent id absent from the node set also roots the
   *  node, rather than throwing — a provider that forgot one ancestor must not
   *  take the rest of the tree down with it. */
  parentId: string | null;
  meta?: Record<string, unknown>;
  /** The frame this node's card sits inside, if any (BBP-165). */
  frameId?: string;
};

/**
 * A visual grouping drawn behind a set of nodes — e.g. a crew's lead and
 * members — rather than a property of a single node. `parentId` nests one
 * frame inside another; `null` roots it, the same convention as `CanvasNode`.
 */
export type CanvasFrame = {
  id: string;
  parentId: string | null;
  label?: string;
};

/** "step": one step of a flow to the next, left to right (BBP-303). */
export type CanvasEdgeVariant = "flow" | "back" | "message" | "step";

/** Whether this edge leads to a node that is running right now (animated),
 *  or sits on the path from the root to the current selection
 *  (`"selected-path"`, BBP-220, solid and unanimated). Undefined draws a
 *  plain `--border` line — the state before BBP-146, and also a finished or
 *  failed child since BBP-214 stage 1 ("taken" removed: a done step must not
 *  look like ongoing activity). `"now"` takes precedence over
 *  `"selected-path"` when both would apply. A `message` edge never carries
 *  this: that is BBP-97's. */
/** "needs": on the way to something that waits for the human (BBP-303). */
/** `skipped`: a decision's exit the run did not take (BBP-303). */
export type CanvasEdgeState = "now" | "needs" | "selected-path" | "skipped";

/**
 * An edge beyond the tree itself: `layoutTree` draws the parent/child line for
 * every visible node on its own, so only the exceptions — a back reference, a
 * message between two nodes that are not parent and child — are declared
 * here.
 */
export type CanvasEdge = {
  from: string;
  to: string;
  variant: CanvasEdgeVariant;
  label?: string;
  count?: number;
  state?: CanvasEdgeState;
  /** A declared relation between two nodes — a crew's link (BBP-202): drawn
   *  only on demand, see `relationsView`. */
  relation?: boolean;
  /** Set by `relationsView` when a node is selected. */
  emphasis?: CanvasEdgeEmphasis;
  /** The single links a bundled relation edge stands for (BBP-201/203), by
   *  node id — what the sidebar lists per kind. */
  links?: readonly RelationLink[];
};

export type RelationLink = { from: string; to: string; kind: string };

export type CanvasEdgeEmphasis = "highlight" | "dim";

export type CuratedField = { label: string; value: string };

/** The `meta` keys worth their own row in the sidebar, per kind, in display
 *  order. Everything else a provider put in `meta` — and every curated key a
 *  provider happened not to set — falls into the collapsed "Details" block
 *  instead of the raw dump this replaces (BBP-185). A kind's node-level
 *  `status` already has its own pill in the header, so it is curated only
 *  for `tool-call`/`subagent`, whose nodes carry no top-level `status`. */
const CURATED_KEYS: Partial<Record<CanvasNodeKind, readonly string[]>> = {
  crew: ["crew", "members", "lead"],
  member: ["address", "role", "lead", "activity"],
  "graph-run": ["graphId", "runId", "started", "steps", "threadId"],
  step: ["nodeId", "attempts"],
  // `state` is the thread's own BB status, loaded on selection; the node-level
  // pill is the status of whatever the thread hangs under, not the thread.
  thread: ["title", "state", "provider", "model", "turns", "created", "updated"],
  // `firstLine` is the card title, already the sidebar header — not repeated.
  turn: ["from", "request", "answerPreview", "duration", "summaryCount", "text"],
  "tool-call": [
    "toolName",
    "command",
    "toolArgs",
    "path",
    "changeKind",
    "diffStats",
    "cwd",
    // The less common workKinds' own content (search, web, plan, approval,
    // form, question, workflow): what the call was about, not a hidden detail.
    "query",
    "mode",
    "queries",
    "url",
    "prompt",
    "explanation",
    "steps",
    "approvalKind",
    "extensionKind",
    "title",
    "questions",
    "workflowName",
    "taskType",
    "summary",
    "lifecycle",
    "outputPreview",
    "error",
    "stdout",
    "stderr",
    "exitCode",
    "duration",
    "startedAt",
    "completedAt",
  ],
  subagent: ["status", "summary"],
  "system-event": ["detail", "oldParent", "newParent"],
};

const FIELD_LABELS: Record<string, string> = {
  threadId: "Thread",
  runId: "Run",
  graphId: "Graph",
  crew: "Crew",
  status: "Status",
  role: "Role",
  lead: "Lead",
  activity: "Activity",
  address: "Address",
  nodeId: "Node",
  attempts: "Attempts",
  rowId: "Row",
  summary: "Summary",
  members: "Members",
  started: "Started",
  steps: "Steps",
  title: "Title",
  state: "Status",
  provider: "Provider",
  model: "Model",
  turns: "Turns",
  created: "Created",
  updated: "Updated",
  firstLine: "First line",
  request: "Request",
  requestRaw: "Request (raw)",
  answerPreview: "Answer",
  toolName: "Tool",
  command: "Command",
  toolArgs: "Input",
  outputPreview: "Output",
  exitCode: "Exit code",
  duration: "Duration",
  startedAt: "Started",
  completedAt: "Completed",
  detail: "Detail",
  oldParent: "Old parent",
  newParent: "New parent",
  titles: "Events",
  path: "Path",
  changeKind: "Change",
  diffStats: "Diff",
  cwd: "Directory",
  stdout: "Stdout",
  stderr: "Stderr",
  sourceSeq: "Source seq",
  sourceSeqStart: "Source seq start",
  sourceSeqEnd: "Source seq end",
  seq: "Seq",
  turnId: "Turn",
  kind: "Row kind",
  workKind: "Work kind",
  from: "From",
  text: "Message",
  summaryCount: "Steps",
  query: "Query",
  mode: "Mode",
  queries: "Queries",
  url: "URL",
  prompt: "Prompt",
  error: "Error",
  explanation: "Plan",
  approvalKind: "Approval",
  extensionKind: "Extension",
  questions: "Questions",
  workflowName: "Workflow",
  taskType: "Task type",
  lifecycle: "State",
};

/** Ids and sequence numbers the mapping needs but a reader does not: shown
 *  only behind the sidebar's collapsed "Debug" toggle, unless a kind curates
 *  one (a graph run's `threadId`, say). */
const TECHNICAL_KEYS: ReadonlySet<string> = new Set([
  "rowId",
  "startedAtMs",
  "kind",
  "sourceSeq",
  "sourceSeqStart",
  "sourceSeqEnd",
  "seq",
  "threadId",
  "turnId",
  "workKind",
  // A step's raw provider status ("completed", "error") — the card's status
  // pill already says it; a kind that means it (subagent) curates it.
  "status",
  // A turn's untouched request text (BBP-228 R2) — "request" above is the
  // cleaned version a reader wants; this is only for checking the cleanup.
  "requestRaw",
]);

function fieldLabel(key: string): string {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  return key.length > 0 ? key[0].toUpperCase() + key.slice(1) : key;
}

/** An array value (e.g. a bundled system-event's `titles`) renders one
 *  entry per line — `String(value)` would otherwise comma-join it. */
function fieldValue(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join("\n") : String(value);
}

/** Splits a node's `meta` into the fields its kind curates (in the kind's
 *  own order) and everything left over, for the sidebar's main body versus
 *  its collapsed "Details" block, with technical ids split off into
 *  `debug` for the "Debug" toggle. A missing, `null`, or `undefined` value is
 *  dropped rather than shown as `"null"`. */
export function curateMeta(
  kind: CanvasNodeKind,
  meta: Record<string, unknown> | undefined,
): { curated: CuratedField[]; details: CuratedField[]; debug: CuratedField[] } {
  const entries = meta ?? {};
  const curatedKeys = CURATED_KEYS[kind] ?? [];
  const curated: CuratedField[] = [];
  for (const key of curatedKeys) {
    const value = entries[key];
    if (value === undefined || value === null) continue;
    curated.push({ label: fieldLabel(key), value: fieldValue(value) });
  }
  const curatedKeySet = new Set(curatedKeys);
  const details: CuratedField[] = [];
  const debug: CuratedField[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (curatedKeySet.has(key) || value === undefined || value === null) continue;
    (TECHNICAL_KEYS.has(key) ? debug : details).push({ label: fieldLabel(key), value: fieldValue(value) });
  }
  return { curated, details, debug };
}

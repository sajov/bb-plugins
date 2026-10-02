// Persistence: crews, versioned crew files, members, bindings, journal, links.
//
// The plugin DB is the source of truth (§4.3); thread metadata is a mirror.
// MIGRATIONS is append-only: statements are applied by index, so a statement
// inserted in the middle would never run on a database already past it. Later
// stages (messages, work items, channel, snapshots) append here.
import type { Database } from "better-sqlite3";

export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS crews (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     name TEXT NOT NULL,
     file_version INTEGER NOT NULL,
     status TEXT NOT NULL,
     lead_member_id TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE (project_id, name)
   )`,
  `CREATE TABLE IF NOT EXISTS crew_files (
     crew_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     yaml TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (crew_id, version)
   )`,
  `CREATE TABLE IF NOT EXISTS members (
     id TEXT PRIMARY KEY,
     crew_id TEXT NOT NULL,
     group_id TEXT NOT NULL,
     member_id TEXT NOT NULL,
     address TEXT NOT NULL,
     lead INTEGER NOT NULL,
     config_json TEXT NOT NULL,
     removed_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS members_by_crew ON members (crew_id)`,
  `CREATE TABLE IF NOT EXISTS member_bindings (
     member_id TEXT NOT NULL,
     shift INTEGER NOT NULL,
     thread_id TEXT NOT NULL,
     bound_at INTEGER NOT NULL,
     retired_at INTEGER,
     PRIMARY KEY (member_id, shift)
   )`,
  `CREATE TABLE IF NOT EXISTS member_ops (
     op_id TEXT PRIMARY KEY,
     member_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     state TEXT NOT NULL,
     thread_id TEXT,
     error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS member_ops_by_member ON member_ops (member_id, state)`,
  `CREATE TABLE IF NOT EXISTS links (
     crew_id TEXT NOT NULL,
     from_member TEXT NOT NULL,
     to_member TEXT NOT NULL,
     kind TEXT NOT NULL,
     PRIMARY KEY (crew_id, from_member, to_member, kind)
   )`,
  // E2 — messaging (§3.4, §3.9.6). Every message is stored, rejected ones
  // included. Both sides carry member and crew so the feed of either crew and
  // the project feed read from one table.
  `CREATE TABLE IF NOT EXISTS messages (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     chain_id TEXT NOT NULL,
     step INTEGER NOT NULL,
     reply_to TEXT,
     kind TEXT NOT NULL,
     from_address TEXT NOT NULL,
     from_member TEXT,
     from_crew TEXT,
     to_address TEXT NOT NULL,
     to_member TEXT,
     to_crew TEXT,
     subject TEXT NOT NULL,
     body TEXT NOT NULL,
     priority TEXT NOT NULL,
     status TEXT NOT NULL,
     reason TEXT,
     hold TEXT,
     delivery_mode TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     forced INTEGER NOT NULL DEFAULT 0,
     answered_at INTEGER,
     appended_to TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     delivered_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS messages_by_recipient ON messages (to_member, status)`,
  `CREATE INDEX IF NOT EXISTS messages_by_chain ON messages (chain_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS messages_by_project ON messages (project_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS messages_by_status ON messages (status)`,
  `CREATE TABLE IF NOT EXISTS stopped_chains (
     chain_id TEXT PRIMARY KEY,
     reason TEXT NOT NULL,
     at INTEGER NOT NULL
   )`,
  // E3 — channel, work queue, follow-ups, integration, dependencies (§3.5–§3.9).
  `CREATE TABLE IF NOT EXISTS channel_messages (
     id TEXT PRIMARY KEY,
     crew_id TEXT NOT NULL,
     author TEXT NOT NULL,
     topic TEXT,
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS channel_by_crew ON channel_messages (crew_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS work_items (
     id TEXT PRIMARY KEY,
     crew_id TEXT NOT NULL,
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     owner_member TEXT,
     created_by TEXT NOT NULL,
     state TEXT NOT NULL,
     tier TEXT NOT NULL,
     due_at INTEGER,
     task_key TEXT,
     closure_note TEXT,
     epoch INTEGER NOT NULL DEFAULT 0,
     state_since INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS work_by_crew ON work_items (crew_id, state)`,
  `CREATE TABLE IF NOT EXISTS work_transitions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     item_id TEXT NOT NULL,
     from_state TEXT,
     to_state TEXT NOT NULL,
     actor TEXT NOT NULL,
     note TEXT,
     at INTEGER NOT NULL
   )`,
  // UNIQUE is what makes "each rung is logged once" hold under concurrent or repeated sweeps.
  `CREATE TABLE IF NOT EXISTS escalations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     crew_id TEXT NOT NULL,
     subject_kind TEXT NOT NULL,
     subject_id TEXT NOT NULL,
     rung INTEGER NOT NULL,
     target TEXT,
     at INTEGER NOT NULL,
     UNIQUE (subject_kind, subject_id, rung)
   )`,
  `CREATE TABLE IF NOT EXISTS crew_dependencies (
     crew_id TEXT NOT NULL,
     task_key TEXT NOT NULL,
     until TEXT NOT NULL,
     state TEXT NOT NULL,
     satisfied_at INTEGER,
     label_state TEXT,
     detail TEXT,
     PRIMARY KEY (crew_id, task_key, until)
   )`,
  `CREATE TABLE IF NOT EXISTS merge_requests (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     crew_id TEXT NOT NULL,
     branch TEXT NOT NULL,
     base TEXT NOT NULL,
     requested_by TEXT NOT NULL,
     state TEXT NOT NULL,
     reason TEXT,
     checks_output TEXT,
     commit_sha TEXT,
     merged_by TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS merges_by_project ON merge_requests (project_id, state)`,
  `CREATE TABLE IF NOT EXISTS member_needs (
     member_id TEXT NOT NULL,
     reason TEXT NOT NULL,
     detail TEXT,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (member_id, reason)
   )`,
  `CREATE TABLE IF NOT EXISTS member_env (
     member_id TEXT PRIMARY KEY,
     environment_id TEXT,
     path TEXT,
     branch TEXT,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS member_state (
     member_id TEXT PRIMARY KEY,
     busy_since INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS crew_settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  // E4 — lifecycle (§3.3) and the RPC contract (§4.8).
  `CREATE TABLE IF NOT EXISTS snapshots (
     id TEXT PRIMARY KEY,
     crew_id TEXT NOT NULL,
     label TEXT,
     json TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS snapshots_by_crew ON snapshots (crew_id, created_at)`,
  // One row per handover; `writing` and `noted` hold the member's messages.
  `CREATE TABLE IF NOT EXISTS handovers (
     id TEXT PRIMARY KEY,
     member_id TEXT NOT NULL,
     state TEXT NOT NULL,
     old_thread TEXT NOT NULL,
     old_shift INTEGER NOT NULL,
     new_thread TEXT,
     brief TEXT,
     item_id TEXT,
     detail TEXT,
     started_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS handovers_by_member ON handovers (member_id, state)`,
  // The PRIMARY KEY is what makes sendToMember idempotent per correlationId.
  `CREATE TABLE IF NOT EXISTS rpc_sends (
     correlation_id TEXT PRIMARY KEY,
     message_id TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  // BBP-31: links a graph-studio run (crew_graph_run) back to the member and
  // crew that started it, durably — graph-studio only indexes runs by thread.
  `CREATE TABLE IF NOT EXISTS graph_runs (
     run_id TEXT PRIMARY KEY,
     crew_id TEXT NOT NULL,
     member_id TEXT NOT NULL,
     graph_id TEXT NOT NULL,
     status TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS graph_runs_by_member ON graph_runs (member_id, status)`,
  `CREATE INDEX IF NOT EXISTS graph_runs_by_crew ON graph_runs (crew_id, status)`,
];

export const CREW_STATUSES = ["stopped", "starting", "running", "degraded"] as const;
export type CrewStatus = (typeof CREW_STATUSES)[number];

export type CrewRow = {
  id: string;
  projectId: string;
  name: string;
  fileVersion: number;
  status: CrewStatus;
  leadMemberId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type MemberRow = {
  id: string;
  crewId: string;
  groupId: string;
  memberId: string;
  key: string;
  address: string;
  lead: boolean;
  config: Record<string, unknown>;
  removedAt: number | null;
};

export type BindingRow = {
  memberId: string;
  shift: number;
  threadId: string;
  boundAt: number;
  retiredAt: number | null;
};

export const MESSAGE_STATUSES = [
  "pending",
  "delivered",
  "queued",
  "on_hold",
  "throttled",
  "stopped_loop",
  "rejected",
  "failed",
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];
/** `info`: a status report to the human — shown, but never an open question (BBP-23). */
export type MessageKind = "message" | "system" | "info";
export type Priority = "normal" | "urgent";
/** Why a message waits: re-evaluated by the delivery service on every drain. */
export type HoldReason = "interaction" | "crew-stopped" | "lead-busy" | "handover";
export type DeliveryMode = "start" | "queue-if-active" | "steer-if-active" | "ui";

export type MessageRow = {
  id: string;
  projectId: string;
  chainId: string;
  step: number;
  replyTo: string | null;
  kind: MessageKind;
  fromAddress: string;
  fromMember: string | null;
  fromCrew: string | null;
  toAddress: string;
  toMember: string | null;
  toCrew: string | null;
  subject: string;
  body: string;
  priority: Priority;
  status: MessageStatus;
  reason: string | null;
  hold: HoldReason | null;
  deliveryMode: DeliveryMode | null;
  attempts: number;
  lastError: string | null;
  forced: boolean;
  answeredAt: number | null;
  appendedTo: string | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
};

export type NewMessage = Omit<
  MessageRow,
  "attempts" | "lastError" | "forced" | "answeredAt" | "createdAt" | "updatedAt" | "deliveredAt" | "hold" | "deliveryMode"
> & { hold?: HoldReason | null; deliveryMode?: DeliveryMode | null; delivered?: boolean };


export const WORK_STATES = ["open", "claimed", "done", "failed"] as const;
export type WorkState = (typeof WORK_STATES)[number];
export type WorkItemRow = {
  id: string;
  crewId: string;
  title: string;
  body: string;
  ownerMember: string | null;
  createdBy: string;
  state: WorkState;
  tier: "p0" | "p1" | "p2" | "p3";
  dueAt: number | null;
  taskKey: string | null;
  closureNote: string | null;
  /** Bumped by handoff and unclaim: a new owner gets a fresh set of follow-up rungs. */
  epoch: number;
  stateSince: number;
  createdAt: number;
  updatedAt: number;
};
export type TransitionRow = { itemId: string; fromState: string | null; toState: string; actor: string; note: string | null; at: number };
export type EscalationRow = { crewId: string; subjectKind: string; subjectId: string; rung: number; target: string | null; at: number };
export type ChannelRow = { id: string; crewId: string; author: string; topic: string | null; body: string; createdAt: number };
export type DependencyState = "open" | "satisfied";
export type DependencyRow = {
  crewId: string;
  taskKey: string;
  until: string;
  state: DependencyState;
  satisfiedAt: number | null;
  labelState: string | null;
  detail: string | null;
};
/** `open` and `returned` wait for the human; `returned` came back from the integrator or a failed merge. */
export const MERGE_STATES = ["open", "returned", "merged", "rejected"] as const;
export type MergeState = (typeof MERGE_STATES)[number];
export type MergeRequestRow = {
  id: string;
  projectId: string;
  crewId: string;
  branch: string;
  base: string;
  requestedBy: string;
  state: MergeState;
  reason: string | null;
  checksOutput: string | null;
  commitSha: string | null;
  mergedBy: string | null;
  createdAt: number;
  updatedAt: number;
};
export type SnapshotRow = { id: string; crewId: string; label: string | null; json: string; createdAt: number };
/** `writing`, `noted` and `completing` hold the member's messages; `done` and `failed` release them. */
export type HandoverState = "writing" | "noted" | "completing" | "done" | "failed";
export type HandoverRow = {
  id: string;
  memberId: string;
  state: HandoverState;
  oldThread: string;
  oldShift: number;
  newThread: string | null;
  brief: string | null;
  itemId: string | null;
  detail: string | null;
  startedAt: number;
  updatedAt: number;
};
export type MemberEnvRow = { memberId: string; environmentId: string | null; path: string | null; branch: string | null; updatedAt: number };

/** BBP-31: a graph-studio run started by crew_graph_run, linked to the member and crew that started it. */
export type GraphRunRow = {
  runId: string;
  crewId: string;
  memberId: string;
  graphId: string;
  status: string;
  startedAt: number;
  updatedAt: number;
};
const OPEN_GRAPH_RUN_STATUSES = ["running", "stopping", "waiting-human"] as const;

export type MessageFilter = {
  projectId?: string;
  crewId?: string;
  chainId?: string;
  status?: MessageStatus;
  crossCrew?: boolean;
  toMember?: string;
  limit?: number;
};

export type OpState = "intent" | "done" | "failed";
export type OpRow = {
  opId: string;
  memberId: string;
  kind: string;
  state: OpState;
  threadId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

/** For tests and anything without `bb.storage.migrate`: same append-only rule. */
export function migrateInPlace(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS _crew_migrations (idx INTEGER PRIMARY KEY)");
  const done = new Set(
    (db.prepare("SELECT idx FROM _crew_migrations").all() as { idx: number }[]).map((row) => row.idx),
  );
  MIGRATIONS.forEach((statement, idx) => {
    if (done.has(idx)) return;
    db.exec(statement);
    db.prepare("INSERT INTO _crew_migrations (idx) VALUES (?)").run(idx);
  });
}

/** Members are keyed by crew and key, so the same crew file always maps to the same rows. */
export function memberRowId(crewId: string, key: string): string {
  return `${crewId}:${key}`;
}

type Raw = Record<string, unknown>;

const toCrew = (row: Raw): CrewRow => ({
  id: String(row.id),
  projectId: String(row.project_id),
  name: String(row.name),
  fileVersion: Number(row.file_version),
  status: row.status as CrewStatus,
  leadMemberId: (row.lead_member_id as string | null) ?? null,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
});

const toMember = (row: Raw): MemberRow => ({
  id: String(row.id),
  crewId: String(row.crew_id),
  groupId: String(row.group_id),
  memberId: String(row.member_id),
  key: `${row.group_id}-${row.member_id}`,
  address: String(row.address),
  lead: Number(row.lead) === 1,
  config: JSON.parse(String(row.config_json)) as Record<string, unknown>,
  removedAt: (row.removed_at as number | null) ?? null,
});

const toBinding = (row: Raw): BindingRow => ({
  memberId: String(row.member_id),
  shift: Number(row.shift),
  threadId: String(row.thread_id),
  boundAt: Number(row.bound_at),
  retiredAt: (row.retired_at as number | null) ?? null,
});

const toOp = (row: Raw): OpRow => ({
  opId: String(row.op_id),
  memberId: String(row.member_id),
  kind: String(row.kind),
  state: row.state as OpState,
  threadId: (row.thread_id as string | null) ?? null,
  error: (row.error as string | null) ?? null,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
});

const toMessage = (row: Raw): MessageRow => ({
  id: String(row.id),
  projectId: String(row.project_id),
  chainId: String(row.chain_id),
  step: Number(row.step),
  replyTo: (row.reply_to as string | null) ?? null,
  kind: row.kind as MessageKind,
  fromAddress: String(row.from_address),
  fromMember: (row.from_member as string | null) ?? null,
  fromCrew: (row.from_crew as string | null) ?? null,
  toAddress: String(row.to_address),
  toMember: (row.to_member as string | null) ?? null,
  toCrew: (row.to_crew as string | null) ?? null,
  subject: String(row.subject),
  body: String(row.body),
  priority: row.priority as Priority,
  status: row.status as MessageStatus,
  reason: (row.reason as string | null) ?? null,
  hold: (row.hold as HoldReason | null) ?? null,
  deliveryMode: (row.delivery_mode as DeliveryMode | null) ?? null,
  attempts: Number(row.attempts),
  lastError: (row.last_error as string | null) ?? null,
  forced: Number(row.forced) === 1,
  answeredAt: (row.answered_at as number | null) ?? null,
  appendedTo: (row.appended_to as string | null) ?? null,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
  deliveredAt: (row.delivered_at as number | null) ?? null,
});


const toWork = (row: Raw): WorkItemRow => ({
  id: String(row.id),
  crewId: String(row.crew_id),
  title: String(row.title),
  body: String(row.body),
  ownerMember: (row.owner_member as string | null) ?? null,
  createdBy: String(row.created_by),
  state: row.state as WorkState,
  tier: row.tier as WorkItemRow["tier"],
  dueAt: (row.due_at as number | null) ?? null,
  taskKey: (row.task_key as string | null) ?? null,
  closureNote: (row.closure_note as string | null) ?? null,
  epoch: Number(row.epoch),
  stateSince: Number(row.state_since),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
});
const toDependency = (row: Raw): DependencyRow => ({
  crewId: String(row.crew_id),
  taskKey: String(row.task_key),
  until: String(row.until),
  state: row.state as DependencyState,
  satisfiedAt: (row.satisfied_at as number | null) ?? null,
  labelState: (row.label_state as string | null) ?? null,
  detail: (row.detail as string | null) ?? null,
});
const toMerge = (row: Raw): MergeRequestRow => ({
  id: String(row.id),
  projectId: String(row.project_id),
  crewId: String(row.crew_id),
  branch: String(row.branch),
  base: String(row.base),
  requestedBy: String(row.requested_by),
  state: row.state as MergeState,
  reason: (row.reason as string | null) ?? null,
  checksOutput: (row.checks_output as string | null) ?? null,
  commitSha: (row.commit_sha as string | null) ?? null,
  mergedBy: (row.merged_by as string | null) ?? null,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
});

const toGraphRun = (row: Raw): GraphRunRow => ({
  runId: String(row.run_id),
  crewId: String(row.crew_id),
  memberId: String(row.member_id),
  graphId: String(row.graph_id),
  status: String(row.status),
  startedAt: Number(row.started_at),
  updatedAt: Number(row.updated_at),
});

const toHandover = (row: Raw): HandoverRow => ({
  id: String(row.id),
  memberId: String(row.member_id),
  state: row.state as HandoverState,
  oldThread: String(row.old_thread),
  oldShift: Number(row.old_shift),
  newThread: (row.new_thread as string | null) ?? null,
  brief: (row.brief as string | null) ?? null,
  itemId: (row.item_id as string | null) ?? null,
  detail: (row.detail as string | null) ?? null,
  startedAt: Number(row.started_at),
  updatedAt: Number(row.updated_at),
});

export type Store = ReturnType<typeof createStore>;

export function createStore(db: Database, now: () => number = Date.now) {
  return {
    listCrews(projectId?: string): CrewRow[] {
      const rows = projectId
        ? db.prepare("SELECT * FROM crews WHERE project_id = ? ORDER BY name").all(projectId)
        : db.prepare("SELECT * FROM crews ORDER BY project_id, name").all();
      return (rows as Raw[]).map(toCrew);
    },
    getCrew(id: string): CrewRow | null {
      const row = db.prepare("SELECT * FROM crews WHERE id = ?").get(id) as Raw | undefined;
      return row ? toCrew(row) : null;
    },
    findCrew(projectId: string, name: string): CrewRow | null {
      const row = db
        .prepare("SELECT * FROM crews WHERE project_id = ? AND name = ?")
        .get(projectId, name) as Raw | undefined;
      return row ? toCrew(row) : null;
    },
    /**
     * Store a crew file. A byte-identical file keeps its version, so saving
     * the same YAML twice does not inflate the history.
     */
    saveCrewFile(projectId: string, name: string, yaml: string): { crew: CrewRow; changed: boolean } {
      const at = now();
      return db.transaction(() => {
        let crew = this.findCrew(projectId, name);
        if (!crew) {
          const id = `${projectId}:${name}`;
          db.prepare(
            `INSERT INTO crews (id, project_id, name, file_version, status, lead_member_id, created_at, updated_at)
             VALUES (?, ?, ?, 0, 'stopped', NULL, ?, ?)`,
          ).run(id, projectId, name, at, at);
          crew = this.getCrew(id)!;
        }
        const current = this.crewFile(crew.id);
        if (current && current.yaml === yaml) return { crew, changed: false };
        const version = crew.fileVersion + 1;
        db.prepare("INSERT INTO crew_files (crew_id, version, yaml, created_at) VALUES (?, ?, ?, ?)").run(
          crew.id,
          version,
          yaml,
          at,
        );
        db.prepare("UPDATE crews SET file_version = ?, updated_at = ? WHERE id = ?").run(version, at, crew.id);
        return { crew: this.getCrew(crew.id)!, changed: true };
      })();
    },
    crewFile(crewId: string, version?: number): { version: number; yaml: string } | null {
      const row = (
        version === undefined
          ? db.prepare("SELECT version, yaml FROM crew_files WHERE crew_id = ? ORDER BY version DESC LIMIT 1").get(crewId)
          : db.prepare("SELECT version, yaml FROM crew_files WHERE crew_id = ? AND version = ?").get(crewId, version)
      ) as { version: number; yaml: string } | undefined;
      return row ?? null;
    },
    setCrewStatus(crewId: string, status: CrewStatus): void {
      db.prepare("UPDATE crews SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), crewId);
    },
    setLead(crewId: string, memberRow: string | null): void {
      db.prepare("UPDATE crews SET lead_member_id = ?, updated_at = ? WHERE id = ?").run(memberRow, now(), crewId);
    },

    upsertMember(crewId: string, input: {
      groupId: string;
      memberId: string;
      address: string;
      lead: boolean;
      config: Record<string, unknown>;
    }): MemberRow {
      const id = memberRowId(crewId, `${input.groupId}-${input.memberId}`);
      db.prepare(
        `INSERT INTO members (id, crew_id, group_id, member_id, address, lead, config_json, removed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET address = excluded.address, lead = excluded.lead,
           config_json = excluded.config_json, removed_at = NULL`,
      ).run(id, crewId, input.groupId, input.memberId, input.address, input.lead ? 1 : 0, JSON.stringify(input.config));
      return this.getMember(id)!;
    },
    getMember(id: string): MemberRow | null {
      const row = db.prepare("SELECT * FROM members WHERE id = ?").get(id) as Raw | undefined;
      return row ? toMember(row) : null;
    },
    listMembers(crewId: string, includeRemoved = false): MemberRow[] {
      const rows = db
        .prepare(`SELECT * FROM members WHERE crew_id = ? ${includeRemoved ? "" : "AND removed_at IS NULL"} ORDER BY rowid`)
        .all(crewId) as Raw[];
      return rows.map(toMember);
    },
    markMemberRemoved(id: string): void {
      db.prepare("UPDATE members SET removed_at = ? WHERE id = ?").run(now(), id);
    },

    currentBinding(memberRow: string): BindingRow | null {
      const row = db
        .prepare("SELECT * FROM member_bindings WHERE member_id = ? AND retired_at IS NULL ORDER BY shift DESC LIMIT 1")
        .get(memberRow) as Raw | undefined;
      return row ? toBinding(row) : null;
    },
    lastShift(memberRow: string): number {
      const row = db.prepare("SELECT MAX(shift) AS shift FROM member_bindings WHERE member_id = ?").get(memberRow) as
        | { shift: number | null }
        | undefined;
      return row?.shift ?? 0;
    },
    /** Retires the current binding (if any) and binds the thread as the next shift. */
    bind(memberRow: string, threadId: string, shift: number): BindingRow {
      const at = now();
      db.transaction(() => {
        db.prepare("UPDATE member_bindings SET retired_at = ? WHERE member_id = ? AND retired_at IS NULL").run(at, memberRow);
        db.prepare(
          "INSERT INTO member_bindings (member_id, shift, thread_id, bound_at, retired_at) VALUES (?, ?, ?, ?, NULL)",
        ).run(memberRow, shift, threadId, at);
      })();
      return this.currentBinding(memberRow)!;
    },
    retireBinding(memberRow: string): void {
      db.prepare("UPDATE member_bindings SET retired_at = ? WHERE member_id = ? AND retired_at IS NULL").run(now(), memberRow);
    },

    insertOp(op: { opId: string; memberId: string; kind: string }): void {
      const at = now();
      db.prepare(
        "INSERT INTO member_ops (op_id, member_id, kind, state, thread_id, error, created_at, updated_at) VALUES (?, ?, ?, 'intent', NULL, NULL, ?, ?)",
      ).run(op.opId, op.memberId, op.kind, at, at);
    },
    finishOp(opId: string, state: "done" | "failed", threadId: string | null, error: string | null): void {
      db.prepare("UPDATE member_ops SET state = ?, thread_id = ?, error = ?, updated_at = ? WHERE op_id = ?").run(
        state,
        threadId,
        error,
        now(),
        opId,
      );
    },
    openOps(memberRow: string): OpRow[] {
      return (
        db.prepare("SELECT * FROM member_ops WHERE member_id = ? AND state = 'intent' AND kind = 'spawn' ORDER BY created_at").all(memberRow) as Raw[]
      ).map(toOp);
    },
    listOps(memberRow: string): OpRow[] {
      return (db.prepare("SELECT * FROM member_ops WHERE member_id = ? ORDER BY created_at, rowid").all(memberRow) as Raw[]).map(toOp);
    },

    replaceLinks(crewId: string, links: { from: string; to: string; kind: string }[]): void {
      db.transaction(() => {
        db.prepare("DELETE FROM links WHERE crew_id = ?").run(crewId);
        const insert = db.prepare("INSERT OR IGNORE INTO links (crew_id, from_member, to_member, kind) VALUES (?, ?, ?, ?)");
        for (const link of links) insert.run(crewId, link.from, link.to, link.kind);
      })();
    },
    listLinks(crewId: string): { from: string; to: string; kind: string }[] {
      return (
        db.prepare("SELECT from_member, to_member, kind FROM links WHERE crew_id = ? ORDER BY rowid").all(crewId) as Raw[]
      ).map((row) => ({ from: String(row.from_member), to: String(row.to_member), kind: String(row.kind) }));
    },

    /** The member whose *current* binding is this thread — the DB's answer, not the metadata's. */
    memberByThread(threadId: string): MemberRow | null {
      const row = db
        .prepare(
          `SELECT m.* FROM member_bindings b JOIN members m ON m.id = b.member_id
           WHERE b.thread_id = ? AND b.retired_at IS NULL AND m.removed_at IS NULL LIMIT 1`,
        )
        .get(threadId) as Raw | undefined;
      return row ? toMember(row) : null;
    },

    insertMessage(message: NewMessage): MessageRow {
      const at = now();
      db.prepare(
        `INSERT INTO messages (id, project_id, chain_id, step, reply_to, kind, from_address, from_member, from_crew,
           to_address, to_member, to_crew, subject, body, priority, status, reason, hold, delivery_mode, attempts,
           last_error, forced, answered_at, appended_to, created_at, updated_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, NULL, ?, ?, ?, ?)`,
      ).run(
        message.id,
        message.projectId,
        message.chainId,
        message.step,
        message.replyTo,
        message.kind,
        message.fromAddress,
        message.fromMember,
        message.fromCrew,
        message.toAddress,
        message.toMember,
        message.toCrew,
        message.subject,
        message.body,
        message.priority,
        message.status,
        message.reason,
        message.hold ?? null,
        message.deliveryMode ?? null,
        message.appendedTo,
        at,
        at,
        message.delivered ? at : null,
      );
      return this.getMessage(message.id)!;
    },
    getMessage(id: string): MessageRow | null {
      const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Raw | undefined;
      return row ? toMessage(row) : null;
    },
    /** Only the delivery-relevant columns change after insert; the text never does (except appends to an open human question). */
    updateMessage(
      id: string,
      patch: Partial<Pick<MessageRow, "status" | "reason" | "hold" | "deliveryMode" | "lastError" | "forced" | "answeredAt" | "body">> & {
        delivered?: boolean;
        attempt?: boolean;
      },
    ): MessageRow {
      const at = now();
      const sets: string[] = ["updated_at = ?"];
      const values: unknown[] = [at];
      const column: Record<string, string> = {
        status: "status",
        reason: "reason",
        hold: "hold",
        deliveryMode: "delivery_mode",
        lastError: "last_error",
        answeredAt: "answered_at",
        body: "body",
      };
      for (const [key, name] of Object.entries(column)) {
        if (key in patch) {
          sets.push(`${name} = ?`);
          values.push((patch as Record<string, unknown>)[key] ?? null);
        }
      }
      if (patch.forced !== undefined) {
        sets.push("forced = ?");
        values.push(patch.forced ? 1 : 0);
      }
      if (patch.delivered) {
        sets.push("delivered_at = ?");
        values.push(at);
      }
      if (patch.attempt) sets.push("attempts = attempts + 1");
      db.prepare(`UPDATE messages SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
      return this.getMessage(id)!;
    },
    listMessages(filter: MessageFilter = {}): MessageRow[] {
      const where: string[] = [];
      const values: unknown[] = [];
      if (filter.projectId) {
        where.push("project_id = ?");
        values.push(filter.projectId);
      }
      if (filter.crewId) {
        where.push("(from_crew = ? OR to_crew = ?)");
        values.push(filter.crewId, filter.crewId);
      }
      if (filter.chainId) {
        where.push("chain_id = ?");
        values.push(filter.chainId);
      }
      if (filter.status) {
        where.push("status = ?");
        values.push(filter.status);
      }
      if (filter.toMember) {
        where.push("to_member = ?");
        values.push(filter.toMember);
      }
      // Cross-crew: both sides are crews and they differ. Human and system
      // messages have no crew on one side and are not cross-crew.
      if (filter.crossCrew) where.push("from_crew IS NOT NULL AND to_crew IS NOT NULL AND from_crew <> to_crew");
      const limit = Math.max(1, Math.min(filter.limit ?? 200, 1000));
      const rows = db
        .prepare(
          `SELECT * FROM (SELECT *, rowid AS r FROM messages ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY created_at DESC, r DESC LIMIT ${limit}) ORDER BY created_at, r`,
        )
        .all(...values) as Raw[];
      return rows.map(toMessage);
    },
    /** Work for the delivery service: pending rows and holds that may have cleared. */
    deliverable(): MessageRow[] {
      return (
        db
          .prepare(
            // Leads and the human first (§3.9.5): cross-crew agreements must not wait behind routine work.
            `SELECT m.* FROM messages m LEFT JOIN members t ON t.id = m.to_member
             WHERE m.status IN ('pending', 'throttled') OR (m.status = 'on_hold' AND m.hold IN ('interaction', 'crew-stopped', 'lead-busy', 'handover'))
             ORDER BY CASE WHEN m.from_address = 'human' OR t.lead = 1 THEN 0 ELSE 1 END, m.created_at, m.rowid`,
          )
          .all() as Raw[]
      ).map(toMessage);
    },
    /** Latest message that reached this member (delivered or queued). */
    lastReceived(memberRow: string): MessageRow | null {
      const row = db
        .prepare(
          `SELECT * FROM messages WHERE to_member = ? AND status IN ('delivered', 'queued')
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(memberRow) as Raw | undefined;
      return row ? toMessage(row) : null;
    },
    lastSent(memberRow: string): MessageRow | null {
      const row = db
        .prepare("SELECT * FROM messages WHERE from_member = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get(memberRow) as Raw | undefined;
      return row ? toMessage(row) : null;
    },
    /** Messages of a chain that count towards the hourly cap: everything not refused. */
    chainCountSince(chainId: string, since: number): number {
      const row = db
        .prepare(
          "SELECT COUNT(*) AS n FROM messages WHERE chain_id = ? AND created_at >= ? AND status NOT IN ('rejected', 'stopped_loop')",
        )
        .get(chainId, since) as { n: number };
      return row.n;
    },
    openHumanQuestion(memberRow: string): MessageRow | null {
      const row = db
        .prepare(
          `SELECT * FROM messages WHERE from_member = ? AND to_address = 'human' AND answered_at IS NULL
             AND appended_to IS NULL AND kind != 'info' AND status = 'delivered' ORDER BY created_at, rowid LIMIT 1`,
        )
        .get(memberRow) as Raw | undefined;
      return row ? toMessage(row) : null;
    },
    answerHumanQuestions(memberRow: string): string[] {
      const open = db
        .prepare("SELECT id FROM messages WHERE from_member = ? AND to_address = 'human' AND answered_at IS NULL AND kind != 'info'")
        .all(memberRow) as { id: string }[];
      db.prepare(
        "UPDATE messages SET answered_at = ?, updated_at = ? WHERE from_member = ? AND to_address = 'human' AND answered_at IS NULL AND kind != 'info'",
      ).run(
        now(),
        now(),
        memberRow,
      );
      return open.map((row) => row.id);
    },
    countByMember(memberRow: string, side: "from" | "to", status: MessageStatus): number {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${side === "from" ? "from_member" : "to_member"} = ? AND status = ?`)
        .get(memberRow, status) as { n: number };
      return row.n;
    },
    stopChain(chainId: string, reason: string): void {
      db.prepare("INSERT OR IGNORE INTO stopped_chains (chain_id, reason, at) VALUES (?, ?, ?)").run(chainId, reason, now());
    },
    chainStop(chainId: string): { reason: string; at: number } | null {
      const row = db.prepare("SELECT reason, at FROM stopped_chains WHERE chain_id = ?").get(chainId) as
        | { reason: string; at: number }
        | undefined;
      return row ?? null;
    },
    rerouteMessage(id: string, member: MemberRow, reason: string): MessageRow {
      db.prepare("UPDATE messages SET to_member = ?, to_address = ?, to_crew = ?, reason = ?, hold = NULL, status = 'pending', updated_at = ? WHERE id = ?").run(
        member.id,
        member.address,
        member.crewId,
        reason,
        now(),
        id,
      );
      return this.getMessage(id)!;
    },

    // --- channel (§3.5)
    insertChannel(row: Omit<ChannelRow, "createdAt">): ChannelRow {
      const at = now();
      db.prepare("INSERT INTO channel_messages (id, crew_id, author, topic, body, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        row.id,
        row.crewId,
        row.author,
        row.topic,
        row.body,
        at,
      );
      return { ...row, createdAt: at };
    },
    listChannel(crewId: string, options: { since?: number; topic?: string; limit?: number } = {}): ChannelRow[] {
      const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
      const rows = db
        .prepare(
          `SELECT * FROM (SELECT *, rowid AS r FROM channel_messages WHERE crew_id = ? AND created_at > ? ${options.topic ? "AND topic = ?" : ""}
           ORDER BY created_at DESC, r DESC LIMIT ${limit}) ORDER BY created_at, r`,
        )
        .all(...[crewId, options.since ?? 0, ...(options.topic ? [options.topic] : [])]) as Raw[];
      return rows.map((row) => ({
        id: String(row.id),
        crewId: String(row.crew_id),
        author: String(row.author),
        topic: (row.topic as string | null) ?? null,
        body: String(row.body),
        createdAt: Number(row.created_at),
      }));
    },

    // --- work queue (§3.6)
    insertWork(item: Pick<WorkItemRow, "id" | "crewId" | "title" | "body" | "ownerMember" | "createdBy" | "tier" | "dueAt" | "taskKey">): WorkItemRow {
      const at = now();
      db.transaction(() => {
        db.prepare(
          `INSERT INTO work_items (id, crew_id, title, body, owner_member, created_by, state, tier, due_at, task_key, closure_note, epoch, state_since, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL, 0, ?, ?, ?)`,
        ).run(item.id, item.crewId, item.title, item.body, item.ownerMember, item.createdBy, item.tier, item.dueAt, item.taskKey, at, at, at);
        db.prepare("INSERT INTO work_transitions (item_id, from_state, to_state, actor, note, at) VALUES (?, NULL, 'open', ?, NULL, ?)").run(
          item.id,
          item.createdBy,
          at,
        );
      })();
      return this.getWork(item.id)!;
    },
    getWork(id: string): WorkItemRow | null {
      const row = db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as Raw | undefined;
      return row ? toWork(row) : null;
    },
    listWork(filter: { crewId?: string; states?: readonly WorkState[]; owner?: string } = {}): WorkItemRow[] {
      const where: string[] = [];
      const values: unknown[] = [];
      if (filter.crewId) {
        where.push("crew_id = ?");
        values.push(filter.crewId);
      }
      if (filter.states && filter.states.length > 0) {
        where.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
        values.push(...filter.states);
      }
      if (filter.owner) {
        where.push("owner_member = ?");
        values.push(filter.owner);
      }
      return (
        db.prepare(`SELECT * FROM work_items ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, rowid`).all(...values) as Raw[]
      ).map(toWork);
    },
    /** One state change plus its transition row, atomically. */
    transitionWork(
      id: string,
      patch: { state: WorkState; owner?: string | null; closureNote?: string | null; bumpEpoch?: boolean },
      actor: string,
      note: string | null,
    ): WorkItemRow {
      const at = now();
      db.transaction(() => {
        const before = this.getWork(id)!;
        db.prepare(
          `UPDATE work_items SET state = ?, owner_member = ?, closure_note = ?, epoch = epoch + ?, state_since = ?, updated_at = ? WHERE id = ?`,
        ).run(
          patch.state,
          patch.owner === undefined ? before.ownerMember : patch.owner,
          patch.closureNote === undefined ? before.closureNote : patch.closureNote,
          patch.bumpEpoch ? 1 : 0,
          at,
          at,
          id,
        );
        db.prepare("INSERT INTO work_transitions (item_id, from_state, to_state, actor, note, at) VALUES (?, ?, ?, ?, ?, ?)").run(
          id,
          before.state,
          patch.state,
          actor,
          note,
          at,
        );
      })();
      return this.getWork(id)!;
    },
    listTransitions(itemId: string): TransitionRow[] {
      return (db.prepare("SELECT * FROM work_transitions WHERE item_id = ? ORDER BY id").all(itemId) as Raw[]).map((row) => ({
        itemId: String(row.item_id),
        fromState: (row.from_state as string | null) ?? null,
        toState: String(row.to_state),
        actor: String(row.actor),
        note: (row.note as string | null) ?? null,
        at: Number(row.at),
      }));
    },
    /** True only for the call that logged the rung; every later call for the same rung is a no-op. */
    logEscalation(row: Omit<EscalationRow, "at">): boolean {
      const result = db
        .prepare("INSERT OR IGNORE INTO escalations (crew_id, subject_kind, subject_id, rung, target, at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(row.crewId, row.subjectKind, row.subjectId, row.rung, row.target, now());
      return result.changes === 1;
    },
    listEscalations(filter: { crewId?: string; subjectId?: string } = {}): EscalationRow[] {
      const where: string[] = [];
      const values: unknown[] = [];
      if (filter.crewId) {
        where.push("crew_id = ?");
        values.push(filter.crewId);
      }
      if (filter.subjectId) {
        where.push("subject_id = ?");
        values.push(filter.subjectId);
      }
      return (
        db.prepare(`SELECT * FROM escalations ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id`).all(...values) as Raw[]
      ).map((row) => ({
        crewId: String(row.crew_id),
        subjectKind: String(row.subject_kind),
        subjectId: String(row.subject_id),
        rung: Number(row.rung),
        target: (row.target as string | null) ?? null,
        at: Number(row.at),
      }));
    },
    highestRung(subjectKind: string, subjectId: string): number {
      const row = db.prepare("SELECT MAX(rung) AS rung FROM escalations WHERE subject_kind = ? AND subject_id = ?").get(subjectKind, subjectId) as {
        rung: number | null;
      };
      return row.rung ?? 0;
    },

    // --- dependencies (§3.9.2)
    /** Rows for the crew file's waitsFor; rows no longer in the file are dropped, satisfied ones kept. */
    syncDependencies(crewId: string, wanted: readonly { task: string; until: string }[]): DependencyRow[] {
      db.transaction(() => {
        const keep = new Set(wanted.map((entry) => `${entry.task}\u0000${entry.until}`));
        for (const row of this.listDependencies(crewId)) {
          if (!keep.has(`${row.taskKey}\u0000${row.until}`)) {
            db.prepare("DELETE FROM crew_dependencies WHERE crew_id = ? AND task_key = ? AND until = ?").run(crewId, row.taskKey, row.until);
          }
        }
        const insert = db.prepare(
          "INSERT OR IGNORE INTO crew_dependencies (crew_id, task_key, until, state, satisfied_at, label_state, detail) VALUES (?, ?, ?, 'open', NULL, NULL, NULL)",
        );
        for (const entry of wanted) insert.run(crewId, entry.task, entry.until);
      })();
      return this.listDependencies(crewId);
    },
    listDependencies(crewId?: string): DependencyRow[] {
      const rows = crewId
        ? db.prepare("SELECT * FROM crew_dependencies WHERE crew_id = ? ORDER BY rowid").all(crewId)
        : db.prepare("SELECT * FROM crew_dependencies ORDER BY rowid").all();
      return (rows as Raw[]).map(toDependency);
    },
    /** True only for the call that flipped the row: the wake message hangs on this. */
    satisfyDependency(crewId: string, taskKey: string, until: string, detail: string): boolean {
      const result = db
        .prepare(
          "UPDATE crew_dependencies SET state = 'satisfied', satisfied_at = ?, detail = ? WHERE crew_id = ? AND task_key = ? AND until = ? AND state = 'open'",
        )
        .run(now(), detail, crewId, taskKey, until);
      return result.changes === 1;
    },
    setDependencyLabel(crewId: string, taskKey: string, until: string, labelState: string, detail: string | null): void {
      db.prepare("UPDATE crew_dependencies SET label_state = ?, detail = COALESCE(?, detail) WHERE crew_id = ? AND task_key = ? AND until = ?").run(
        labelState,
        detail,
        crewId,
        taskKey,
        until,
      );
    },

    // --- merge requests (§3.9.1)
    insertMerge(row: Pick<MergeRequestRow, "id" | "projectId" | "crewId" | "branch" | "base" | "requestedBy">): MergeRequestRow {
      const at = now();
      db.prepare(
        `INSERT INTO merge_requests (id, project_id, crew_id, branch, base, requested_by, state, reason, checks_output, commit_sha, merged_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, NULL, NULL, NULL, ?, ?)`,
      ).run(row.id, row.projectId, row.crewId, row.branch, row.base, row.requestedBy, at, at);
      return this.getMerge(row.id)!;
    },
    getMerge(id: string): MergeRequestRow | null {
      const row = db.prepare("SELECT * FROM merge_requests WHERE id = ?").get(id) as Raw | undefined;
      return row ? toMerge(row) : null;
    },
    updateMerge(id: string, patch: Partial<Pick<MergeRequestRow, "state" | "reason" | "checksOutput" | "commitSha" | "mergedBy">>): MergeRequestRow {
      const column: Record<string, string> = { state: "state", reason: "reason", checksOutput: "checks_output", commitSha: "commit_sha", mergedBy: "merged_by" };
      const sets = ["updated_at = ?"];
      const values: unknown[] = [now()];
      for (const [key, name] of Object.entries(column)) {
        if (key in patch) {
          sets.push(`${name} = ?`);
          values.push((patch as Record<string, unknown>)[key] ?? null);
        }
      }
      db.prepare(`UPDATE merge_requests SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
      return this.getMerge(id)!;
    },
    listMerges(filter: { projectId?: string; crewId?: string; states?: readonly MergeState[] } = {}): MergeRequestRow[] {
      const where: string[] = [];
      const values: unknown[] = [];
      if (filter.projectId) {
        where.push("project_id = ?");
        values.push(filter.projectId);
      }
      if (filter.crewId) {
        where.push("crew_id = ?");
        values.push(filter.crewId);
      }
      if (filter.states && filter.states.length > 0) {
        where.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
        values.push(...filter.states);
      }
      return (
        db.prepare(`SELECT * FROM merge_requests ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, rowid`).all(...values) as Raw[]
      ).map(toMerge);
    },

    // --- plugin-raised Needs-you reasons (merge-conflict)
    setNeed(memberRow: string, reason: string, detail: string | null): void {
      db.prepare(
        "INSERT INTO member_needs (member_id, reason, detail, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(member_id, reason) DO UPDATE SET detail = excluded.detail",
      ).run(memberRow, reason, detail, now());
    },
    clearNeed(memberRow: string, reason: string): void {
      db.prepare("DELETE FROM member_needs WHERE member_id = ? AND reason = ?").run(memberRow, reason);
    },
    listNeeds(memberRow: string): { reason: string; detail: string | null }[] {
      return (db.prepare("SELECT reason, detail FROM member_needs WHERE member_id = ? ORDER BY created_at").all(memberRow) as Raw[]).map((row) => ({
        reason: String(row.reason),
        detail: (row.detail as string | null) ?? null,
      }));
    },

    // --- where a member's thread works (BB picks the branch name, so it is read back)
    setMemberEnv(memberRow: string, env: { environmentId: string | null; path: string | null; branch: string | null }): void {
      db.prepare(
        `INSERT INTO member_env (member_id, environment_id, path, branch, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(member_id) DO UPDATE SET environment_id = excluded.environment_id, path = excluded.path, branch = excluded.branch, updated_at = excluded.updated_at`,
      ).run(memberRow, env.environmentId, env.path, env.branch, now());
    },
    memberEnv(memberRow: string): MemberEnvRow | null {
      const row = db.prepare("SELECT * FROM member_env WHERE member_id = ?").get(memberRow) as Raw | undefined;
      return row
        ? {
            memberId: String(row.member_id),
            environmentId: (row.environment_id as string | null) ?? null,
            path: (row.path as string | null) ?? null,
            branch: (row.branch as string | null) ?? null,
            updatedAt: Number(row.updated_at),
          }
        : null;
    },

    /** Since when the member's thread has been seen busy; null = idle or never seen. */
    busySince(memberRow: string): number | null {
      const row = db.prepare("SELECT busy_since FROM member_state WHERE member_id = ?").get(memberRow) as { busy_since: number | null } | undefined;
      return row?.busy_since ?? null;
    },
    markBusy(memberRow: string, busy: boolean, at: number): void {
      if (busy) {
        db.prepare(
          "INSERT INTO member_state (member_id, busy_since) VALUES (?, ?) ON CONFLICT(member_id) DO UPDATE SET busy_since = COALESCE(member_state.busy_since, excluded.busy_since)",
        ).run(memberRow, at);
      } else {
        db.prepare("INSERT INTO member_state (member_id, busy_since) VALUES (?, NULL) ON CONFLICT(member_id) DO UPDATE SET busy_since = NULL").run(memberRow);
      }
    },

    // --- E4: bindings history, snapshots, handovers, RPC idempotency
    listBindings(memberRow: string): BindingRow[] {
      return (db.prepare("SELECT * FROM member_bindings WHERE member_id = ? ORDER BY shift").all(memberRow) as Raw[]).map(toBinding);
    },
    /** The binding of any member (current or retired) to this thread. */
    bindingOfThread(threadId: string): (BindingRow & { crewId: string }) | null {
      const row = db
        .prepare("SELECT b.*, m.crew_id FROM member_bindings b JOIN members m ON m.id = b.member_id WHERE b.thread_id = ? ORDER BY b.retired_at IS NULL DESC, b.shift DESC LIMIT 1")
        .get(threadId) as Raw | undefined;
      return row ? { ...toBinding(row), crewId: String(row.crew_id) } : null;
    },
    /**
     * Make exactly this (shift, thread) the member's current binding again —
     * restore: the row is revived if it exists, created otherwise.
     */
    restoreBinding(memberRow: string, threadId: string, shift: number): BindingRow {
      const at = now();
      db.transaction(() => {
        db.prepare("UPDATE member_bindings SET retired_at = ? WHERE member_id = ? AND retired_at IS NULL").run(at, memberRow);
        db.prepare(
          `INSERT INTO member_bindings (member_id, shift, thread_id, bound_at, retired_at) VALUES (?, ?, ?, ?, NULL)
           ON CONFLICT(member_id, shift) DO UPDATE SET thread_id = excluded.thread_id, retired_at = NULL`,
        ).run(memberRow, shift, threadId, at);
      })();
      return this.currentBinding(memberRow)!;
    },
    insertSnapshot(row: Omit<SnapshotRow, "createdAt">): SnapshotRow {
      const at = now();
      db.prepare("INSERT INTO snapshots (id, crew_id, label, json, created_at) VALUES (?, ?, ?, ?, ?)").run(row.id, row.crewId, row.label, row.json, at);
      return { ...row, createdAt: at };
    },
    getSnapshot(id: string): SnapshotRow | null {
      const row = db.prepare("SELECT * FROM snapshots WHERE id = ?").get(id) as Raw | undefined;
      return row
        ? { id: String(row.id), crewId: String(row.crew_id), label: (row.label as string | null) ?? null, json: String(row.json), createdAt: Number(row.created_at) }
        : null;
    },
    listSnapshots(crewId: string): SnapshotRow[] {
      return (db.prepare("SELECT * FROM snapshots WHERE crew_id = ? ORDER BY created_at, rowid").all(crewId) as Raw[]).map((row) => ({
        id: String(row.id),
        crewId: String(row.crew_id),
        label: (row.label as string | null) ?? null,
        json: String(row.json),
        createdAt: Number(row.created_at),
      }));
    },
    /** Put a work item back exactly as a snapshot recorded it (insert or overwrite). */
    restoreWork(item: WorkItemRow, actor: string): void {
      const at = now();
      db.transaction(() => {
        const before = this.getWork(item.id);
        db.prepare(
          `INSERT INTO work_items (id, crew_id, title, body, owner_member, created_by, state, tier, due_at, task_key, closure_note, epoch, state_since, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET state = excluded.state, owner_member = excluded.owner_member, closure_note = excluded.closure_note,
             epoch = excluded.epoch, state_since = excluded.state_since, updated_at = excluded.updated_at`,
        ).run(item.id, item.crewId, item.title, item.body, item.ownerMember, item.createdBy, item.state, item.tier, item.dueAt, item.taskKey, item.closureNote, item.epoch, at, item.createdAt, at);
        db.prepare("INSERT INTO work_transitions (item_id, from_state, to_state, actor, note, at) VALUES (?, ?, ?, ?, 'restored from snapshot', ?)").run(
          item.id,
          before?.state ?? null,
          item.state,
          actor,
          at,
        );
      })();
    },
    insertHandover(row: Pick<HandoverRow, "id" | "memberId" | "oldThread" | "oldShift">): HandoverRow {
      const at = now();
      db.prepare(
        "INSERT INTO handovers (id, member_id, state, old_thread, old_shift, new_thread, brief, item_id, detail, started_at, updated_at) VALUES (?, ?, 'writing', ?, ?, NULL, NULL, NULL, NULL, ?, ?)",
      ).run(row.id, row.memberId, row.oldThread, row.oldShift, at, at);
      return this.getHandover(row.id)!;
    },
    getHandover(id: string): HandoverRow | null {
      const row = db.prepare("SELECT * FROM handovers WHERE id = ?").get(id) as Raw | undefined;
      return row ? toHandover(row) : null;
    },
    /** The member's handover that still holds its messages, if any. */
    activeHandover(memberRow: string): HandoverRow | null {
      const row = db
        .prepare("SELECT * FROM handovers WHERE member_id = ? AND state IN ('writing', 'noted', 'completing') ORDER BY started_at DESC, rowid DESC LIMIT 1")
        .get(memberRow) as Raw | undefined;
      return row ? toHandover(row) : null;
    },
    listHandovers(filter: { memberId?: string; states?: readonly HandoverState[] } = {}): HandoverRow[] {
      const where: string[] = [];
      const values: unknown[] = [];
      if (filter.memberId) {
        where.push("member_id = ?");
        values.push(filter.memberId);
      }
      if (filter.states && filter.states.length > 0) {
        where.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
        values.push(...filter.states);
      }
      return (
        db.prepare(`SELECT * FROM handovers ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at, rowid`).all(...values) as Raw[]
      ).map(toHandover);
    },
    /** Moves only forward from an open state: a second completion of the same handover is a no-op (returns false). */
    updateHandover(id: string, patch: Partial<Pick<HandoverRow, "state" | "newThread" | "brief" | "itemId" | "detail">>, from?: readonly HandoverState[]): boolean {
      const column: Record<string, string> = { state: "state", newThread: "new_thread", brief: "brief", itemId: "item_id", detail: "detail" };
      const sets = ["updated_at = ?"];
      const values: unknown[] = [now()];
      for (const [key, name] of Object.entries(column)) {
        if (key in patch) {
          sets.push(`${name} = ?`);
          values.push((patch as Record<string, unknown>)[key] ?? null);
        }
      }
      const guard = from && from.length > 0 ? ` AND state IN (${from.map(() => "?").join(", ")})` : "";
      return db.prepare(`UPDATE handovers SET ${sets.join(", ")} WHERE id = ?${guard}`).run(...values, id, ...(from ?? [])).changes === 1;
    },
    /** BBP-31: record a just-started graph run, linked to the member and crew. */
    insertGraphRun(row: Pick<GraphRunRow, "runId" | "crewId" | "memberId" | "graphId" | "status">): GraphRunRow {
      const at = now();
      db.prepare(
        "INSERT INTO graph_runs (run_id, crew_id, member_id, graph_id, status, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(row.runId, row.crewId, row.memberId, row.graphId, row.status, at, at);
      return this.getGraphRun(row.runId)!;
    },
    getGraphRun(runId: string): GraphRunRow | null {
      const row = db.prepare("SELECT * FROM graph_runs WHERE run_id = ?").get(runId) as Raw | undefined;
      return row ? toGraphRun(row) : null;
    },
    updateGraphRunStatus(runId: string, status: string): void {
      db.prepare("UPDATE graph_runs SET status = ?, updated_at = ? WHERE run_id = ?").run(status, now(), runId);
    },
    /** Every run linked to this member (board/activity), newest first. */
    listGraphRuns(memberId: string): GraphRunRow[] {
      return (db.prepare("SELECT * FROM graph_runs WHERE member_id = ? ORDER BY started_at DESC, rowid DESC").all(memberId) as Raw[]).map(toGraphRun);
    },
    /** Every run ever linked to this crew (cleanup on delete), regardless of status. */
    listGraphRunsForCrew(crewId: string): GraphRunRow[] {
      return (db.prepare("SELECT * FROM graph_runs WHERE crew_id = ? ORDER BY started_at, rowid").all(crewId) as Raw[]).map(toGraphRun);
    },
    /** Open runs of this crew (bb crew stop cancels these). */
    listOpenGraphRunsForCrew(crewId: string): GraphRunRow[] {
      return (
        db
          .prepare(`SELECT * FROM graph_runs WHERE crew_id = ? AND status IN (${OPEN_GRAPH_RUN_STATUSES.map(() => "?").join(", ")}) ORDER BY started_at, rowid`)
          .all(crewId, ...OPEN_GRAPH_RUN_STATUSES) as Raw[]
      ).map(toGraphRun);
    },

    rpcSend(correlationId: string): string | null {
      const row = db.prepare("SELECT message_id FROM rpc_sends WHERE correlation_id = ?").get(correlationId) as { message_id: string } | undefined;
      return row?.message_id ?? null;
    },
    recordRpcSend(correlationId: string, messageId: string): void {
      db.prepare("INSERT INTO rpc_sends (correlation_id, message_id, created_at) VALUES (?, ?, ?)").run(correlationId, messageId, now());
    },

    /** Every thread a member of the crew was ever bound to (current and retired shifts, removed members included). */
    crewThreads(crewId: string): { memberId: string; key: string; lead: boolean; threadId: string; shift: number; retired: boolean }[] {
      return (
        db
          .prepare(
            `SELECT b.member_id, b.thread_id, b.shift, b.retired_at, m.group_id, m.member_id AS mid, m.lead FROM member_bindings b
             JOIN members m ON m.id = b.member_id WHERE m.crew_id = ? ORDER BY m.rowid, b.shift`,
          )
          .all(crewId) as Raw[]
      ).map((row) => ({
        memberId: String(row.member_id),
        key: `${row.group_id}-${row.mid}`,
        lead: Number(row.lead) === 1,
        threadId: String(row.thread_id),
        shift: Number(row.shift),
        retired: row.retired_at !== null,
      }));
    },
    /**
     * Remove every row of a crew, in one transaction (`bb crew delete`).
     *
     * Messages that only concern this crew go; a cross-crew message keeps its
     * row for the other crew's history, with the deleted side's crew column
     * set to `deleted:<crewId>` and its member cleared, so nothing can be
     * delivered to or attributed to a member that no longer exists. Such a
     * message still waiting for the deleted side is rejected. Returns the
     * number of rows removed per table; `messages-marked` and
     * `messages-rejected` count changed cross-crew rows.
     */
    deleteCrewRows(crewId: string): Record<string, number> {
      const counts: Record<string, number> = {};
      const run = (label: string, sql: string, ...params: unknown[]) => {
        counts[label] = (counts[label] ?? 0) + db.prepare(sql).run(...params).changes;
      };
      const memberIds = `SELECT id FROM members WHERE crew_id = ?`;
      // Own: no live crew on the other side (none, this crew, or one deleted before).
      const own = `((from_crew = ? AND (to_crew IS NULL OR to_crew = ? OR to_crew LIKE 'deleted:%')) OR (to_crew = ? AND (from_crew IS NULL OR from_crew LIKE 'deleted:%')))`;
      db.transaction(() => {
        const tombstone = `deleted:${crewId}`;
        const at = now();
        const ownIds = `SELECT id FROM messages WHERE ${own}`;
        const ownChains = (db.prepare(`SELECT DISTINCT chain_id FROM messages WHERE ${own}`).all(crewId, crewId, crewId) as { chain_id: string }[]).map((row) => row.chain_id);
        run("rpc_sends", `DELETE FROM rpc_sends WHERE message_id IN (${ownIds})`, crewId, crewId, crewId);
        run("messages", `DELETE FROM messages WHERE ${own}`, crewId, crewId, crewId);
        // A chain row is only this crew's once no surviving message uses the chain.
        for (const chain of ownChains) run("stopped_chains", "DELETE FROM stopped_chains WHERE chain_id = ? AND NOT EXISTS (SELECT 1 FROM messages WHERE chain_id = ?)", chain, chain);
        run(
          "messages-rejected",
          `UPDATE messages SET status = 'rejected', hold = NULL, reason = 'recipient crew deleted', updated_at = ?
           WHERE to_crew = ? AND status IN ('pending', 'on_hold', 'throttled', 'stopped_loop')`,
          at,
          crewId,
        );
        run("messages-marked", "UPDATE messages SET to_crew = ?, to_member = NULL, updated_at = ? WHERE to_crew = ?", tombstone, at, crewId);
        run("messages-marked", "UPDATE messages SET from_crew = ?, from_member = NULL, updated_at = ? WHERE from_crew = ?", tombstone, at, crewId);
        for (const table of ["member_bindings", "member_ops", "member_needs", "member_env", "member_state", "handovers"]) {
          run(table, `DELETE FROM ${table} WHERE member_id IN (${memberIds})`, crewId);
        }
        run("work_transitions", "DELETE FROM work_transitions WHERE item_id IN (SELECT id FROM work_items WHERE crew_id = ?)", crewId);
        for (const table of ["work_items", "channel_messages", "escalations", "crew_dependencies", "merge_requests", "snapshots", "graph_runs", "links", "crew_files", "members"]) {
          run(table, `DELETE FROM ${table} WHERE crew_id = ?`, crewId);
        }
        // No setting is crew-scoped today; the prefix keeps a future per-crew key from outliving its crew.
        run("crew_settings", "DELETE FROM crew_settings WHERE key LIKE ? ESCAPE '\\'", `${crewId.replace(/[\\%_]/g, (c) => `\\${c}`)}:%`);
        run("crews", "DELETE FROM crews WHERE id = ?", crewId);
      })();
      return counts;
    },

    getSetting(key: string): string | null {
      const row = db.prepare("SELECT value FROM crew_settings WHERE key = ?").get(key) as { value: string } | undefined;
      return row?.value ?? null;
    },
    setSetting(key: string, value: string | null): void {
      if (value === null) db.prepare("DELETE FROM crew_settings WHERE key = ?").run(key);
      else db.prepare("INSERT INTO crew_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
    },
  };
}

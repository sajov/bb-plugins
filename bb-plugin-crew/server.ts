// bb-plugin-crew — server entry: storage, service, RPC, CLI.
//
// Crew file, members, apply/stop with sync and journal.
// E2: messages with delivery service, activity axes and "Needs you", agent
// tools and per-thread configuration.
// E3: channel, work queue with follow-ups, integration via main, waitsFor,
// directory, lead relief, thread limit, project overview (§3.5–§3.9.5).
// E4: snapshot/restore, reset/handover, add/remove member, attach/detach,
// export/import, lead-only tools, the confirmation form, the RPC contract for
// other plugins (§3.3, §4.5–§4.8).
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { defineRpcContract, type BbPluginApi, type JsonValue } from "@get-bb/plugin-sdk";
import { parseLimitStatus } from "./lib/capacity";
import { createTasksRpcPort } from "./lib/dependencies";
import { z } from "zod";
import { liveViews, type ActivityView } from "./lib/activity";
import { reasonCounts } from "./lib/topology";
import { DEFAULT_POLICY } from "./lib/policy";
import { registerAgentTools, type Confirm } from "./lib/agent";
import { CONTRACT_VERSION } from "./lib/contract";
import { openLayout } from "./lib/layout";
import { runCli, CLI_COMMANDS, type CliContext } from "./lib/cli";
import { CrewFileEditError } from "./lib/crewfile";
import { AddressError } from "./lib/delivery";
import { createGraphsRpc } from "./lib/graphs";
import { resolveSkillsCatalog } from "./lib/skills";
import { ApplyRefused } from "./lib/sync";
import { createCrewService, DeleteRefused } from "./lib/service";
import type { Catalog, SkillsCatalog } from "./lib/spec";
import { inlineExecution, REASONING_LEVELS, SERVICE_TIERS } from "./lib/spec";
import { createStore, MERGE_STATES, MESSAGE_STATUSES, MIGRATIONS, WORK_STATES, type MessageRow, type Store } from "./lib/store";
import { createSdkThreadPort } from "./lib/thread-port";

const problemSchema = z.object({ level: z.enum(["error", "warning"]), code: z.string(), message: z.string() });
const crewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  fileVersion: z.number(),
  status: z.enum(["stopped", "starting", "running", "degraded"]),
  updatedAt: z.number(),
  /** The BB project's name, for the panel's project switch; null when BB did not report it. */
  projectName: z.string().nullable().default(null),
});
const memberSchema = z.object({
  key: z.string(),
  groupId: z.string().default(""),
  address: z.string(),
  lead: z.boolean(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  permissions: z.string().nullable(),
  shift: z.number().nullable(),
  threadId: z.string().nullable(),
  thread: z.enum(["present", "archived", "missing"]),
  status: z.string().nullable(),
  actualProvider: z.string().nullable(),
  actualModel: z.string().nullable(),
});
const planItemSchema = z.object({
  key: z.string(),
  address: z.string(),
  action: z.enum(["reuse", "unarchive", "spawn", "update", "remove"]),
  reasons: z.array(z.string()),
  threadId: z.string().nullable(),
});
const resultSchema = z.object({
  key: z.string(),
  address: z.string(),
  result: z.enum(["reused", "unarchived", "spawned", "updated", "removed", "failed"]),
  threadId: z.string().nullable(),
  shift: z.number().nullable(),
  detail: z.string().nullable(),
});
const messageSchema = z.object({
  id: z.string(),
  chainId: z.string(),
  step: z.number(),
  replyTo: z.string().nullable(),
  kind: z.enum(["message", "system", "info"]),
  fromAddress: z.string(),
  fromCrew: z.string().nullable(),
  toAddress: z.string(),
  toCrew: z.string().nullable(),
  subject: z.string(),
  body: z.string(),
  priority: z.enum(["normal", "urgent"]),
  status: z.enum(MESSAGE_STATUSES),
  reason: z.string().nullable(),
  deliveryMode: z.string().nullable(),
  attempts: z.number(),
  lastError: z.string().nullable(),
  crossCrew: z.boolean(),
  openQuestion: z.boolean(),
  createdAt: z.number(),
  deliveredAt: z.number().nullable(),
});
const rowStatusSchema = z.object({ icon: z.string(), label: z.string(), tone: z.enum(["default", "error", "running", "success"]) });
const activitySchema = z.object({
  key: z.string(),
  address: z.string(),
  lead: z.boolean(),
  crewName: z.string(),
  threadId: z.string().nullable(),
  status: z.string().nullable(),
  thread: z.enum(["present", "archived", "missing"]),
  activity: z.enum(["working", "idle", "needs-you", "error", "unknown"]),
  needsYou: z.array(z.string()),
  question: z.string().nullable(),
  held: z.number(),
  diagnoses: z.array(z.string()),
  rowStatus: rowStatusSchema.nullable(),
  openWork: z.number().default(0),
  context: z.number().nullable().default(null),
  graphRuns: z.array(z.object({ runId: z.string(), graphId: z.string(), status: z.string() })).default([]),
  graphQuestion: z.object({ runId: z.string(), graphId: z.string(), nodeId: z.string(), question: z.string() }).nullable().default(null),
});
const channelSchema = z.object({ id: z.string(), author: z.string(), topic: z.string().nullable(), body: z.string(), createdAt: z.number() });
const workSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  owner: z.string().nullable(),
  state: z.enum(WORK_STATES),
  tier: z.string(),
  dueAt: z.number().nullable(),
  taskKey: z.string().nullable(),
  closureNote: z.string().nullable(),
  rung: z.number(),
});
const mergeSchema = z.object({
  id: z.string(),
  crew: z.string(),
  branch: z.string(),
  base: z.string(),
  state: z.enum(MERGE_STATES),
  reason: z.string().nullable(),
  commitSha: z.string().nullable(),
  mergedBy: z.string().nullable(),
  createdAt: z.number(),
});
const overviewSchema = z.object({
  crews: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      summary: z.string(),
      task: z.string().nullable(),
      branch: z.string().nullable(),
      behind: z.number().nullable(),
      merge: mergeSchema.nullable(),
      needsYou: z.number(),
      members: z.array(z.object({ key: z.string(), lead: z.boolean(), activity: z.string(), needsYou: z.array(z.string()) })),
      /** BB tasks carrying the label `crew-<name>` (BBP-84): the factory tick never sets `task`, so this is their only link to the diagram. */
      labelTasks: z.array(z.object({ key: z.string(), title: z.string(), status: z.string() })),
      /** `crew.yaml`'s `crossCrew` policy (BBP-97): draws the project-level lead↔lead edge even without traffic yet. */
      crossCrew: z.enum(["leads", "open", "none"]),
    }),
  ),
  leadLinks: z.array(z.object({ from: z.string(), to: z.string(), count: z.number() })),
  dependencies: z.array(z.object({ crew: z.string(), task: z.string(), until: z.string(), state: z.string(), source: z.string().nullable() })),
  threads: z.object({ limit: z.number().nullable(), source: z.string(), running: z.number().nullable(), members: z.number() }),
});
const crewRef = z.object({ projectId: z.string().min(1), name: z.string().min(1).max(64) });
const memberRef = crewRef.extend({ member: z.string().min(1).max(200) });
const contractMember = z.object({
  memberId: z.string(),
  address: z.string(),
  crew: z.string(),
  key: z.string(),
  lead: z.boolean(),
  role: z.string(),
  threadId: z.string().nullable(),
  shift: z.number().nullable(),
  activity: z.string(),
});
const lifecycleResult = z.object({ results: z.array(resultSchema), problems: z.array(problemSchema), error: z.string().nullable() });
const threadSummary = z.object({ id: z.string(), title: z.string().nullable(), status: z.string(), providerId: z.string() });
const fileInput = z.object({
  projectId: z.string().min(1),
  /** Crew name, template id, or inline YAML (when `yaml` is set). */
  ref: z.string().max(200).optional(),
  yaml: z.string().max(200_000).optional(),
  fresh: z.array(z.string()).max(50).default([]),
  confirmFull: z.boolean().default(false),
});

export type CrewDto = z.infer<typeof crewSchema>;
export type MemberDto = z.infer<typeof memberSchema>;
export type MessageDto = z.infer<typeof messageSchema>;
export type ActivityDto = z.infer<typeof activitySchema>;
export type ChannelDto = z.infer<typeof channelSchema>;
export type WorkDto = z.infer<typeof workSchema>;
export type MergeDto = z.infer<typeof mergeSchema>;
export type OverviewDto = z.infer<typeof overviewSchema>;

export const rpcContract = defineRpcContract({
  listCrews: {
    input: z.object({ projectId: z.string().nullable().default(null) }),
    output: z.object({ crews: z.array(crewSchema) }),
  },
  getCrew: {
    input: crewRef,
    output: z.object({
      crew: crewSchema.nullable(),
      members: z.array(memberSchema),
      links: z.array(z.object({ from: z.string(), to: z.string(), kind: z.string() })).default([]),
    }),
  },
  plan: {
    input: fileInput,
    output: z.object({ problems: z.array(problemSchema), items: z.array(planItemSchema) }),
  },
  apply: {
    input: fileInput,
    output: z.object({ crew: crewSchema, problems: z.array(problemSchema), results: z.array(resultSchema) }),
  },
  stop: {
    input: crewRef.extend({ archive: z.boolean().default(false) }),
    output: z.object({ crew: crewSchema.nullable() }),
  },
  /** `bb crew delete`: refusals come back as `error` (with `blockers` when `force` would override them). */
  deleteCrew: {
    input: crewRef.extend({ threads: z.enum(["archive", "delete", "keep"]).default("archive"), force: z.boolean().default(false) }),
    output: z.object({
      deleted: z.boolean(),
      threads: z.array(
        z.object({
          key: z.string(),
          threadId: z.string(),
          shift: z.number(),
          retired: z.boolean(),
          outcome: z.enum(["archived", "already-archived", "deleted", "kept", "missing", "failed"]),
          children: z.number(),
          error: z.string().nullable(),
        }),
      ),
      rows: z.record(z.string(), z.number()),
      warnings: z.array(z.string()),
      blockers: z.array(z.string()),
      error: z.string().nullable(),
    }),
  },
  getCrewFile: {
    input: crewRef,
    output: z.object({ yaml: z.string().nullable(), version: z.number().nullable() }),
  },
  saveCrewFile: {
    input: z.object({ projectId: z.string().min(1), yaml: z.string().max(200_000) }),
    output: z.object({ crew: crewSchema.nullable(), problems: z.array(problemSchema) }),
  },
  getActivity: {
    input: crewRef,
    output: z.object({ members: z.array(activitySchema) }),
  },
  listMessages: {
    input: z.object({
      projectId: z.string().min(1),
      crew: z.string().max(64).optional(),
      chainId: z.string().max(64).optional(),
      status: z.enum(MESSAGE_STATUSES).optional(),
      crossCrew: z.boolean().default(false),
      limit: z.number().int().min(1).max(500).default(200),
    }),
    output: z.object({ messages: z.array(messageSchema) }),
  },
  sendMessage: {
    input: z.object({
      projectId: z.string().min(1),
      to: z.string().min(1).max(200),
      body: z.string().min(1).max(20_000),
      subject: z.string().max(200).optional(),
      crew: z.string().max(64).nullable().default(null),
      replyTo: z.string().max(64).nullable().default(null),
    }),
    output: z.object({ messages: z.array(messageSchema), error: z.string().nullable() }),
  },
  messageAction: {
    input: z.object({ id: z.string().min(1).max(64), action: z.enum(["release", "discard"]) }),
    output: z.object({ message: messageSchema.nullable(), error: z.string().nullable() }),
  },
  stopChain: {
    input: z.object({ chainId: z.string().min(1).max(64) }),
    output: z.object({ stopped: z.number() }),
  },
  /** Project overview (§3.9 "Oberfläche"): crew cards, lead-to-lead lines, waitsFor lines, thread limit. */
  projectOverview: {
    input: z.object({ projectId: z.string().min(1) }),
    output: overviewSchema,
  },
  listChannel: {
    input: crewRef.extend({ since: z.number().optional(), limit: z.number().int().min(1).max(500).default(200) }),
    output: z.object({ posts: z.array(channelSchema) }),
  },
  postChannel: {
    input: crewRef.extend({ body: z.string().min(1).max(20_000), topic: z.string().max(80).nullable().default(null) }),
    output: z.object({ post: channelSchema.nullable(), error: z.string().nullable() }),
  },
  listWork: {
    input: crewRef.extend({ all: z.boolean().default(false) }),
    output: z.object({ items: z.array(workSchema) }),
  },
  listMerges: {
    input: z.object({ projectId: z.string().min(1), all: z.boolean().default(false) }),
    output: z.object({ merges: z.array(mergeSchema) }),
  },
  mergeAction: {
    input: z.object({ id: z.string().min(1).max(64), action: z.enum(["approve", "reject"]), note: z.string().max(2000).default("") }),
    output: z.object({ merge: mergeSchema.nullable(), error: z.string().nullable() }),
  },
  // --- E4 lifecycle (§3.3, §4.6) -----------------------------------------
  /** The member a thread is (header badge, commands); null for any other thread. */
  memberOfThread: {
    input: z.object({ threadId: z.string().min(1).max(64) }),
    output: z.object({
      member: z
        .object({ key: z.string(), address: z.string(), crew: z.string(), projectId: z.string(), shift: z.number(), lead: z.boolean(), handover: z.string().nullable(), leadThreadId: z.string().nullable() })
        .nullable(),
    }),
  },
  snapshot: {
    input: crewRef.extend({ label: z.string().max(200).nullable().default(null) }),
    output: z.object({ id: z.string().nullable(), bindings: z.number(), work: z.number(), messages: z.number(), error: z.string().nullable() }),
  },
  listSnapshots: {
    input: crewRef,
    output: z.object({ snapshots: z.array(z.object({ id: z.string(), label: z.string().nullable(), createdAt: z.number(), fileVersion: z.number() })) }),
  },
  restore: {
    input: z.object({ projectId: z.string().min(1), id: z.string().min(1).max(64) }),
    output: lifecycleResult,
  },
  reset: {
    input: memberRef.extend({ mode: z.enum(["clear", "new"]).default("clear") }),
    output: lifecycleResult,
  },
  handover: {
    input: memberRef.extend({ brief: z.string().max(20_000).optional() }),
    output: z.object({ handover: z.string().nullable(), state: z.string().nullable(), error: z.string().nullable() }),
  },
  attachCandidates: {
    input: z.object({ projectId: z.string().min(1) }),
    output: z.object({ threads: z.array(threadSummary) }),
  },
  attach: {
    input: memberRef.extend({ threadId: z.string().min(1).max(64), replace: z.boolean().default(false) }),
    output: lifecycleResult,
  },
  detach: {
    input: memberRef,
    output: z.object({ threadId: z.string().nullable(), error: z.string().nullable() }),
  },
  addMember: {
    input: crewRef.extend({
      group: z.string().min(1).max(64),
      id: z.string().min(1).max(64),
      role: z.string().max(2000).optional(),
      provider: z.string().max(80).optional(),
      model: z.string().max(120).optional(),
      reasoningLevel: z.enum(REASONING_LEVELS).optional(),
      serviceTier: z.enum(SERVICE_TIERS).optional(),
      permissions: z.enum(["ask", "accept-edits", "auto", "full"]).optional(),
      confirmFull: z.boolean().default(false),
    }),
    output: lifecycleResult,
  },
  removeMember: {
    input: memberRef,
    output: lifecycleResult,
  },
  importFile: {
    input: z.object({ projectId: z.string().min(1), yaml: z.string().max(200_000) }),
    output: z.object({ crew: crewSchema.nullable(), changed: z.boolean(), problems: z.array(problemSchema), items: z.array(planItemSchema) }),
  },
  /** "Open all": the members' threads in split panes, a grid from 4 (§4.6). */
  openMembers: {
    input: crewRef.extend({ members: z.array(z.string().max(64)).max(12).optional(), leadOnly: z.boolean().default(false) }),
    output: z.object({ opened: z.array(z.string()), error: z.string().nullable() }),
  },

  // --- §4.8 contract for other plugins (contractVersion in every answer) ---
  resolveMember: {
    input: z.object({ projectId: z.string().min(1), address: z.string().min(1).max(200) }),
    output: z.object({ contractVersion: z.number(), member: contractMember.nullable(), error: z.string().nullable() }),
  },
  sendToMember: {
    input: z.object({
      projectId: z.string().min(1),
      address: z.string().min(1).max(200),
      body: z.string().min(1).max(20_000),
      from: z.string().min(1).max(120),
      subject: z.string().max(200).optional(),
      correlationId: z.string().min(1).max(200),
    }),
    output: z.object({ contractVersion: z.number(), messageId: z.string().nullable(), status: z.string(), duplicate: z.boolean(), error: z.string().nullable() }),
  },
  listMembers: {
    input: z.object({ projectId: z.string().min(1), crew: z.string().max(64).optional() }),
    output: z.object({ contractVersion: z.number(), members: z.array(contractMember) }),
  },
  memberReply: {
    input: z.object({ messageId: z.string().min(1).max(64) }),
    output: z.object({
      contractVersion: z.number(),
      status: z.enum(["pending", "held", "running", "completed", "failed", "refused"]),
      text: z.string().nullable(),
      eventCursor: z.number().nullable(),
      threadId: z.string().nullable(),
    }),
  },

  /** Sidebar row icons and the Needs-you count, for every bound member thread. */
  rowStatuses: {
    input: z.object({}).default({}),
    output: z.object({
      rows: z.array(z.object({ threadId: z.string(), status: rowStatusSchema.nullable() })),
      needsYou: z.number(),
      /** BBP-95: errors and decisions counted apart, so the badge can tell them apart (red vs. amber). */
      errors: z.number().default(0),
      decisions: z.number().default(0),
      /** Needs you per project: the header counts every project, the panel shows one. */
      byProject: z.record(z.string(), z.number()).default({}),
    }),
  },
});

/** Realtime channel the panel refetches on. */
export const CREWS_CHANGED = "crews-changed";
/** Something about members' activity or messages changed; payload `{ at }`. */
export const ACTIVITY_CHANGED = "crew-activity";

export function messageDto(message: MessageRow): MessageDto {
  return {
    id: message.id,
    chainId: message.chainId,
    step: message.step,
    replyTo: message.replyTo,
    kind: message.kind,
    fromAddress: message.fromAddress,
    fromCrew: message.fromCrew,
    toAddress: message.toAddress,
    toCrew: message.toCrew,
    subject: message.subject,
    body: message.body,
    priority: message.priority,
    status: message.status,
    reason: message.reason,
    deliveryMode: message.deliveryMode,
    attempts: message.attempts,
    lastError: message.lastError,
    crossCrew: message.fromCrew !== null && message.toCrew !== null && message.fromCrew !== message.toCrew,
    openQuestion: message.toAddress === "human" && message.kind !== "info" && message.appendedTo === null && message.answeredAt === null,
    createdAt: message.createdAt,
    deliveredAt: message.deliveredAt,
  };
}

function activityDto(view: ActivityView): ActivityDto {
  return {
    key: view.key,
    address: view.address,
    lead: view.lead,
    crewName: view.crewName,
    threadId: view.threadId,
    status: view.status,
    thread: view.thread,
    activity: view.activity,
    needsYou: view.needsYou,
    question: view.question,
    held: view.held,
    diagnoses: view.diagnoses,
    rowStatus: view.rowStatus,
    openWork: view.openWork,
    context: view.context,
    graphRuns: [...view.graphRuns],
    graphQuestion: view.graphQuestion,
  };
}

function mergeDto(store: Store, merge: ReturnType<Store["getMerge"]> & object): MergeDto {
  return {
    id: merge.id,
    crew: store.getCrew(merge.crewId)?.name ?? merge.crewId,
    branch: merge.branch,
    base: merge.base,
    state: merge.state,
    reason: merge.reason,
    commitSha: merge.commitSha,
    mergedBy: merge.mergedBy,
    createdAt: merge.createdAt,
  };
}

/** BB's thread limit through its CLI — the SDK has no read access (see lib/capacity.ts). Cached for a minute. */
function createBbLimit(log: (text: string) => void): () => Promise<number | null> {
  let cached: { at: number; limit: number | null } | null = null;
  return async () => {
    if (cached && Date.now() - cached.at < 60_000) return cached.limit;
    const limit = await new Promise<number | null>((resolve) => {
      execFile(process.env.BB_CLI ?? "bb", ["concurrency-limit", "status", "--json"], { timeout: 5_000 }, (error, stdout) => {
        if (error) {
          log(`thread limit unreadable: ${error.message}`);
          resolve(null);
        } else resolve(parseLimitStatus(String(stdout)));
      });
    });
    cached = { at: Date.now(), limit };
    return limit;
  };
}

/** Coalesce bursts (a drain touches many rows) into one signal per tick. */
function debounced(fn: () => void, ms = 250): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [...MIGRATIONS]);
  const store = createStore(db);
  // Crew files from before provider/model moved onto the members: rewrite
  // them once, as a new file version, so they validate again.
  for (const crew of store.listCrews()) {
    const file = store.crewFile(crew.id);
    const rewritten = file ? inlineExecution(file.yaml) : null;
    if (rewritten !== null) {
      store.saveCrewFile(crew.projectId, crew.name, rewritten);
      bb.log.info(`crew ${crew.name}: moved provider/model onto each member (file v${file!.version + 1})`);
    }
  }
  const port = createSdkThreadPort(bb);

  // The catalogue is read at most once a minute: a plan runs it once per
  // provider, and nothing about installed providers changes that fast.
  let cached: { at: number; catalog: Catalog } | null = null;
  async function catalog(): Promise<Catalog | null> {
    if (cached && Date.now() - cached.at < 60_000) return cached.catalog;
    try {
      const all = await bb.sdk.providers.models({});
      const providers = new Map<string, Set<string>>();
      for (const provider of all.providers.filter((entry) => entry.available)) {
        const own = await bb.sdk.providers.models({ providerId: provider.id });
        providers.set(provider.id, new Set(own.models.flatMap((model) => [model.id, model.model])));
      }
      cached = { at: Date.now(), catalog: { providers } };
      return cached.catalog;
    } catch (error) {
      bb.log.warn(`Model catalogue unreadable, check skipped: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  // Skills per project: ~/.bb/skills, ~/.bb/skills-generated, ~/.claude/skills and the project's
  // own .bb/skills and .claude/skills; read at most once a minute, same reasoning as the model catalogue.
  const skillsCache = new Map<string, { at: number; catalog: SkillsCatalog }>();
  async function projectPath(projectId: string): Promise<string | null> {
    try {
      const project = await bb.sdk.projects.get({ projectId });
      const source = project.sources.find((entry) => entry.isDefault) ?? project.sources[0];
      return source?.path ?? null;
    } catch {
      return null;
    }
  }
  async function skills(projectId: string): Promise<SkillsCatalog | null> {
    const cached = skillsCache.get(projectId);
    if (cached && Date.now() - cached.at < 60_000) return cached.catalog;
    try {
      const catalog = await resolveSkillsCatalog({ homeDir: homedir(), projectPath: await projectPath(projectId) });
      skillsCache.set(projectId, { at: Date.now(), catalog });
      return catalog;
    } catch (error) {
      bb.log.warn(`Skills catalogue unreadable, check skipped: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  const publishActivity = debounced(() => bb.realtime.publish(ACTIVITY_CHANGED, { at: Date.now() }));
  const service = createCrewService({
    store,
    port,
    catalog,
    skills,
    // `outputSchema` is required (d.ts:15920–15925); the port narrows the shapes itself.
    tasks: createTasksRpcPort((method, input) =>
      bb.sdk.plugins.callRpc({ pluginId: "tasks", method, input: input as JsonValue, outputSchema: z.unknown() })),
    graphsRpc: createGraphsRpc((method, input) =>
      bb.sdk.plugins.callRpc({ pluginId: "graph-studio", method, input: input as JsonValue, outputSchema: z.unknown() })),
    bbLimit: createBbLimit((text) => bb.log.warn(text)),
    onActivity: publishActivity,
    onMessages: () => {
      messagesChanged();
      // A question to the human or a stopped loop changes the sender's state.
      void service.activity.refreshAll().catch(() => undefined);
    },
  });
  const publish = () => bb.realtime.publish(CREWS_CHANGED, { at: Date.now() });

  // Delivery and activity services share one wake-up: any thread event may
  // release a hold (there is no interaction.resolved event, d.ts:20627) and
  // may change a member's activity.
  let wake: (() => void) | null = null;
  const poke = () => wake?.();
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        wake = null;
        resolve();
      }
      wake = done;
      signal.addEventListener("abort", done);
    });
  const touched = new Set<string>();
  const messagesChanged = () => {
    publishActivity();
    poke();
  };

  bb.background.service("delivery", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          const changed = await service.delivery.drain();
          if (changed > 0) messagesChanged();
          // A noted handover completes once the old thread is idle (§3.3).
          if ((await service.lifecycle.tick()) > 0) {
            publish();
            messagesChanged();
          }
          const threads = [...touched];
          touched.clear();
          for (const threadId of threads) await service.activity.refreshThread(threadId);
        } catch (error) {
          bb.log.warn(`delivery pass failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        await sleep(10_000, signal);
      }
    },
  });
  bb.background.service("activity", {
    async start(signal) {
      // Initial reconcile via threads.get, then a slow safety net for what
      // no event reports (the read marker behind "Unread result").
      while (!signal.aborted) {
        try {
          await service.activity.refreshAll();
        } catch (error) {
          bb.log.warn(`activity reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 30_000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  });
  // Follow-ups and the dependency poll: every minute, idempotent (escalations
  // and satisfied dependencies are keyed, so a double run changes nothing).
  bb.background.schedule("follow-ups", "* * * * *", async () => {
    if ((await service.followUps()).length > 0) messagesChanged();
  });
  bb.background.schedule("dependencies", "* * * * *", async () => {
    if ((await service.pollDependencies()) > 0) messagesChanged();
  });

  for (const event of ["thread.idle", "thread.active", "thread.failed", "thread.archived", "thread.unarchived", "interaction.pending"] as const) {
    bb.events.on(event, ({ thread }) => {
      if (!store.memberByThread(thread.id)) return;
      touched.add(thread.id);
      poke();
    });
  }
  bb.events.on("message.dispatched", ({ entry }) => {
    if (store.memberByThread(entry.threadId)) poke();
  });

  // The confirmation form (§4.6 `slots.pendingInteraction`, renderer
  // "crew-confirm" in app.tsx) in the calling lead's thread.
  const confirm: Confirm = async (threadId, request) => {
    const result = await bb.ui.requestInput({
      threadId,
      rendererId: "crew-confirm",
      title: request.title,
      payload: { kind: request.kind, title: request.title, detail: request.detail },
      presentation: { label: { pending: `Waiting: ${request.title}`, completed: "Answered crew confirmation" }, icon: { glyph: "ShieldQuestion" } },
      describeSubmission: (value) => ({ title: (value as { confirmed?: boolean })?.confirmed === true ? "Confirmed" : "Declined" }),
    });
    return result.outcome === "submitted" && (result.value as { confirmed?: unknown })?.confirmed === true;
  };
  registerAgentTools(bb, service, { confirm });
  const dto = (crew: { id: string; projectId: string; name: string; fileVersion: number; status: CrewDto["status"]; updatedAt: number }) => ({
    id: crew.id,
    projectId: crew.projectId,
    name: crew.name,
    fileVersion: crew.fileVersion,
    status: crew.status,
    updatedAt: crew.updatedAt,
  });

  async function yamlFor(input: z.infer<typeof fileInput>): Promise<string> {
    if (input.yaml !== undefined) return input.yaml;
    if (!input.ref) throw new Error("Pass a crew name, template id or YAML.");
    return (await service.resolveFile(input.projectId, input.ref)).yaml;
  }

  function requireCrew(projectId: string, name: string) {
    const crew = store.findCrew(projectId, name);
    if (!crew) throw new AddressError(`No crew "${name}" in this project.`);
    return crew;
  }
  /** Refusals (AddressError, crew-file edit errors) become `error` in the answer; anything else is a real failure. */
  async function guarded<T>(run: () => T | Promise<T>, refuse: (error: string) => T): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AddressError || error instanceof CrewFileEditError || error instanceof ApplyRefused) return refuse(error.message);
      throw error;
    }
  }
  const changing = (run: () => Promise<z.infer<typeof lifecycleResult>>) =>
    guarded(async () => {
      try {
        return await run();
      } finally {
        publish();
        messagesChanged();
      }
    }, (error) => ({ results: [], problems: [], error }));
  void CONTRACT_VERSION;

  bb.rpc.register(rpcContract, {
    listCrews: async ({ projectId }) => {
      const crews = store.listCrews(projectId ?? undefined).map(dto);
      // Names only decorate the switch: a failing lookup must not hide the crews.
      const names = new Map<string, string>();
      try {
        for (const project of await bb.sdk.projects.list()) names.set(project.id, project.name);
      } catch {
        // fall through with ids
      }
      return { crews: crews.map((crew) => ({ ...crew, projectName: names.get(crew.projectId) ?? null })) };
    },
    getCrew: async ({ projectId, name }) => {
      const crew = store.findCrew(projectId, name);
      if (!crew) return { crew: null, members: [], links: [] };
      // BBP-79: listCrews decorates projectName for the switch; getCrew fed the
      // same dto() straight through, so a crew opened on its own (a directive, the
      // thread side panel) showed the project id in its title instead of its name.
      let projectName: string | null = null;
      try {
        projectName = (await bb.sdk.projects.get({ projectId })).name;
      } catch {
        // fall through with no name — decoration only
      }
      return { crew: { ...dto(crew), projectName }, members: await service.members(crew), links: store.listLinks(crew.id) };
    },
    plan: async (input) => {
      const { validation, items } = await service.plan(input.projectId, await yamlFor(input), input);
      return { problems: validation.problems, items };
    },
    apply: async (input) => {
      try {
        const outcome = await service.apply(input.projectId, await yamlFor(input), input);
        return { crew: dto(outcome.crew), problems: outcome.validation.problems, results: outcome.results };
      } finally {
        publish();
      }
    },
    stop: async ({ projectId, name, archive }) => {
      const crew = store.findCrew(projectId, name);
      if (!crew) return { crew: null };
      await service.stop(crew, { archive });
      publish();
      return { crew: dto(store.getCrew(crew.id)!) };
    },
    deleteCrew: async ({ projectId, name, threads, force }) => {
      const empty = { deleted: false, threads: [], rows: {}, warnings: [], blockers: [] as string[] };
      const crew = store.findCrew(projectId, name);
      if (!crew) return { ...empty, error: `No crew "${name}" in this project.` };
      try {
        const result = await service.delete(crew, { threads, force });
        return { deleted: true, threads: result.threads, rows: result.rows, warnings: result.warnings, blockers: [], error: null };
      } catch (error) {
        if (error instanceof DeleteRefused) return { ...empty, blockers: error.blockers, error: error.message };
        throw error;
      } finally {
        publish();
        messagesChanged();
      }
    },
    getCrewFile: ({ projectId, name }) => {
      const crew = store.findCrew(projectId, name);
      const file = crew ? store.crewFile(crew.id) : null;
      return { yaml: file?.yaml ?? null, version: file?.version ?? null };
    },
    saveCrewFile: async ({ projectId, yaml }) => {
      const { crew, validation } = await service.save(projectId, yaml);
      if (crew) publish();
      return { crew: crew ? dto(crew) : null, problems: validation.problems };
    },
    getActivity: async ({ projectId, name }) => {
      const crew = store.findCrew(projectId, name);
      return { members: crew ? (await service.activity.views(crew)).map(activityDto) : [] };
    },
    listMessages: ({ projectId, crew, chainId, status, crossCrew, limit }) => ({
      messages: service.log(projectId, { crew, chainId, status, crossCrew, limit }).map(messageDto),
    }),
    sendMessage: async ({ projectId, to, body, subject, crew, replyTo }) => {
      try {
        const rows = await service.send({ projectId, from: { kind: "human" }, to, body, subject, crew, replyTo });
        messagesChanged();
        return { messages: rows.map(messageDto), error: null };
      } catch (error) {
        if (error instanceof AddressError) return { messages: [], error: error.message };
        throw error;
      }
    },
    messageAction: async ({ id, action }) => {
      try {
        const row = action === "release" ? service.delivery.release(id) : service.delivery.discard(id);
        if (action === "release") await service.delivery.drain();
        messagesChanged();
        await service.activity.refreshAll();
        return { message: messageDto(store.getMessage(row.id)!), error: null };
      } catch (error) {
        if (error instanceof AddressError) return { message: null, error: error.message };
        throw error;
      }
    },
    stopChain: async ({ chainId }) => {
      const rows = service.delivery.stopChain(chainId);
      messagesChanged();
      await service.activity.refreshAll();
      return { stopped: rows.length };
    },
    projectOverview: async ({ projectId }) => {
      const crews = store.listCrews(projectId);
      const cards = [];
      for (const crew of crews) {
        const views = await service.activity.views(crew);
        const spec = service.models(crew).spec;
        const lead = store.listMembers(crew.id).find((member) => member.lead);
        const merge = store.listMerges({ crewId: crew.id }).at(-1) ?? null;
        const labelTasks = service.tasks
          ? await service.tasks.listByLabel(projectId, `crew-${crew.name}`).catch(() => [])
          : [];
        cards.push({
          name: crew.name,
          status: crew.status,
          summary: spec?.summary ?? "",
          task: spec?.task ?? null,
          branch: lead ? (store.memberEnv(lead.id)?.branch ?? null) : null,
          behind: await service.integration.behind(crew),
          merge: merge ? mergeDto(store, merge) : null,
          needsYou: views.filter((view) => view.needsYou.length > 0).length,
          members: views.map((view) => ({ key: view.key, lead: view.lead, activity: view.activity, needsYou: view.needsYou })),
          labelTasks,
          crossCrew: spec?.crossCrew ?? DEFAULT_POLICY.crossCrew,
        });
      }
      const leads = new Set(crews.flatMap((crew) => store.listMembers(crew.id).filter((member) => member.lead).map((member) => member.id)));
      const links = new Map<string, number>();
      for (const message of store.listMessages({ projectId, crossCrew: true, limit: 1000 })) {
        if (!message.fromMember || !message.toMember || !leads.has(message.fromMember) || !leads.has(message.toMember)) continue;
        const key = `${store.getCrew(message.fromCrew!)?.name}\u0000${store.getCrew(message.toCrew!)?.name}`;
        links.set(key, (links.get(key) ?? 0) + 1);
      }
      const byTask = new Map(crews.map((crew) => [service.models(crew).spec?.task ?? "", crew.name]));
      const reading = await service.limit();
      return {
        crews: cards,
        leadLinks: [...links].map(([key, count]) => {
          const [from, to] = key.split("\u0000") as [string, string];
          return { from, to, count };
        }),
        dependencies: crews.flatMap((crew) =>
          store.listDependencies(crew.id).map((row) => ({ crew: crew.name, task: row.taskKey, until: row.until, state: row.state, source: byTask.get(row.taskKey) ?? null })),
        ),
        threads: {
          limit: reading.limit,
          source: reading.source,
          running: await port.runningCount().catch(() => null),
          members: crews.filter((crew) => crew.status !== "stopped").reduce((sum, crew) => sum + store.listMembers(crew.id).length, 0),
        },
      };
    },
    listChannel: ({ projectId, name, since, limit }) => {
      const crew = store.findCrew(projectId, name);
      return { posts: crew ? service.channel.read(crew, { since, limit }) : [] };
    },
    postChannel: async ({ projectId, name, body, topic }) => {
      const crew = store.findCrew(projectId, name);
      if (!crew) return { post: null, error: `No crew "${name}".` };
      try {
        const { post } = service.channel.post(crew, { kind: "human" }, body, topic);
        await service.flush();
        messagesChanged();
        return { post, error: null };
      } catch (error) {
        if (error instanceof AddressError) return { post: null, error: error.message };
        throw error;
      }
    },
    listWork: ({ projectId, name, all }) => {
      const crew = store.findCrew(projectId, name);
      if (!crew) return { items: [] };
      return {
        items: service.queue.list(crew, { all }).map((item) => ({
          id: item.id,
          title: item.title,
          body: item.body,
          owner: item.ownerMember ? (store.getMember(item.ownerMember)?.address ?? null) : null,
          state: item.state,
          tier: item.tier,
          dueAt: item.dueAt,
          taskKey: item.taskKey,
          closureNote: item.closureNote,
          rung: store.highestRung("work", `${item.id}#${item.epoch}`),
        })),
      };
    },
    listMerges: ({ projectId, all }) => ({
      merges: store.listMerges({ projectId, states: all ? undefined : ["open", "returned"] }).map((merge) => mergeDto(store, merge)),
    }),
    mergeAction: async ({ id, action, note }) => {
      try {
        const merge = action === "approve" ? await service.integration.approve(id) : await service.integration.reject(id, note);
        await service.flush();
        await service.activity.refreshAll(merge.projectId);
        messagesChanged();
        return { merge: mergeDto(store, merge), error: action === "approve" && merge.state !== "merged" ? merge.reason : null };
      } catch (error) {
        if (error instanceof AddressError) return { merge: null, error: error.message };
        throw error;
      }
    },
    memberOfThread: ({ threadId }) => {
      const member = store.memberByThread(threadId);
      const crew = member ? store.getCrew(member.crewId) : null;
      const binding = member ? store.currentBinding(member.id) : null;
      if (!member || !crew || !binding) return { member: null };
      const lead = store.listMembers(crew.id).find((entry) => entry.lead);
      return {
        member: {
          key: member.key,
          address: member.address,
          crew: crew.name,
          projectId: crew.projectId,
          shift: binding.shift,
          lead: member.lead,
          handover: store.activeHandover(member.id)?.state ?? null,
          leadThreadId: lead ? (store.currentBinding(lead.id)?.threadId ?? null) : null,
        },
      };
    },
    snapshot: ({ projectId, name, label }) =>
      guarded(() => {
        const { id, data } = service.lifecycle.snapshot(requireCrew(projectId, name), label);
        return { id: id as string | null, bindings: data.bindings.length, work: data.work.length, messages: data.messages.length, error: null as string | null };
      }, (error) => ({ id: null, bindings: 0, work: 0, messages: 0, error })),
    listSnapshots: ({ projectId, name }) => {
      const crew = store.findCrew(projectId, name);
      return {
        snapshots: crew
          ? store.listSnapshots(crew.id).map((row) => ({ id: row.id, label: row.label, createdAt: row.createdAt, fileVersion: (JSON.parse(row.json) as { fileVersion: number }).fileVersion }))
          : [],
      };
    },
    restore: ({ projectId, id }) =>
      changing(async () => {
        const snapshot = store.getSnapshot(id);
        if (!snapshot || store.getCrew(snapshot.crewId)?.projectId !== projectId) throw new AddressError(`No snapshot "${id}" in this project.`);
        const report = await service.lifecycle.restore(id);
        return { results: report.outcome.results, problems: report.outcome.validation.problems, error: null };
      }),
    reset: ({ projectId, name, member, mode }) =>
      changing(async () => ({ results: [await service.lifecycle.reset(requireCrew(projectId, name), member, mode)], problems: [], error: null })),
    handover: ({ projectId, name, member, brief }) =>
      guarded(async () => {
        const { handover } = await service.lifecycle.handover(requireCrew(projectId, name), member, { brief });
        publish();
        messagesChanged();
        return { handover: handover.id as string | null, state: handover.state as string | null, error: null as string | null };
      }, (error) => ({ handover: null, state: null, error })),
    attachCandidates: async ({ projectId }) => ({
      threads: (await service.lifecycle.candidates(projectId)).map((thread) => ({ id: thread.id, title: thread.title, status: thread.status, providerId: thread.providerId })),
    }),
    attach: ({ projectId, name, member, threadId, replace }) =>
      changing(async () => {
        const result = await service.lifecycle.attach(requireCrew(projectId, name), threadId, member, { replace });
        await service.flush();
        return { results: [result], problems: [], error: null };
      }),
    detach: ({ projectId, name, member }) =>
      guarded(async () => {
        const { threadId } = await service.lifecycle.detach(requireCrew(projectId, name), member);
        publish();
        return { threadId: threadId as string | null, error: null as string | null };
      }, (error) => ({ threadId: null, error })),
    addMember: ({ projectId, name, confirmFull, ...member }) =>
      changing(async () => {
        const outcome = await service.lifecycle.addMember(requireCrew(projectId, name), member, { confirmFull });
        return { results: outcome.results, problems: outcome.validation.problems, error: null };
      }),
    removeMember: ({ projectId, name, member }) =>
      changing(async () => {
        const outcome = await service.lifecycle.removeMember(requireCrew(projectId, name), member);
        return { results: outcome.results, problems: outcome.validation.problems, error: null };
      }),
    importFile: async ({ projectId, yaml }) => {
      const imported = await service.lifecycle.importFile(projectId, yaml);
      if (imported.crew) publish();
      return { crew: imported.crew ? dto(imported.crew) : null, changed: imported.changed, problems: imported.validation.problems, items: imported.items };
    },
    openMembers: ({ projectId, name, members, leadOnly }) =>
      guarded(async () => {
        const crew = requireCrew(projectId, name);
        const wanted = members ? new Set(members) : null;
        const threads = store
          .listMembers(crew.id)
          .filter((member) => (!wanted || wanted.has(member.key)) && (!leadOnly || member.lead))
          .sort((a, b) => Number(b.lead) - Number(a.lead))
          .flatMap((member) => {
            const binding = store.currentBinding(member.id);
            return binding ? [binding.threadId] : [];
          });
        const splits = openLayout(threads.length);
        const opened: string[] = [];
        for (const [index, threadId] of threads.entries()) {
          await port.open(threadId, splits[index]!);
          opened.push(threadId);
        }
        return { opened, error: null as string | null };
      }, (error) => ({ opened: [], error })),
    resolveMember: ({ projectId, address }) => service.contract.resolveMember(projectId, address),
    sendToMember: async (input) => {
      const result = await service.contract.sendToMember(input);
      messagesChanged();
      return { ...result, status: String(result.status) };
    },
    listMembers: ({ projectId, crew }) => service.contract.listMembers(projectId, crew),
    memberReply: ({ messageId }) => service.contract.memberReply(messageId),
    rowStatuses: () => {
      const live = new Set(store.listCrews().flatMap((crew) => store.listMembers(crew.id).map((member) => member.id)));
      const views = liveViews(service.activity.cached(), live);
      const { errors, decisions } = reasonCounts(views.flatMap((view) => view.needsYou));
      return {
        rows: views.map((view) => ({ threadId: view.threadId!, status: view.rowStatus })),
        needsYou: views.filter((view) => view.needsYou.length > 0).length,
        errors,
        decisions,
        byProject: views.reduce<Record<string, number>>((counts, view) => {
          if (view.needsYou.length > 0) counts[view.projectId] = (counts[view.projectId] ?? 0) + 1;
          return counts;
        }, {}),
      };
    },
  });

  /** `--project` takes an id or a name; otherwise the calling thread's project. */
  async function resolveProject(ref: string | null, ctx: CliContext): Promise<string | null> {
    if (!ref) return ctx.projectId ?? null;
    const projects = await bb.sdk.projects.list();
    const match = projects.find((project) => project.id === ref) ?? projects.find((project) => project.name === ref);
    return match?.id ?? null;
  }

  bb.cli.register({
    name: "crew",
    summary: "Build and run a persistent agent team (crew) from a crew file",
    commands: CLI_COMMANDS.map((command) => ({ ...command })),
    run: async (argv, ctx) => {
      const result = await runCli(service, argv, { cwd: ctx.cwd, projectId: ctx.projectId, threadId: ctx.threadId }, resolveProject);
      if (["apply", "stop", "delete", "restore", "reset", "handover", "add-member", "remove-member", "attach", "detach", "import"].includes(argv[0] ?? "")) {
        publish();
        poke();
      }
      if (["send", "broadcast", "release", "discard", "stop-chain", "apply", "stop", "delete", "channel", "work", "approve", "reject", "tick", "restore", "reset", "handover", "add-member", "remove-member", "attach"].includes(argv[0] ?? "")) {
        messagesChanged();
        await service.activity.refreshAll().catch(() => undefined);
      }
      return result;
    },
  });

  bb.log.info("crew loaded");
}

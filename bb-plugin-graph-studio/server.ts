// bb-plugin-graph-studio — backend.
//
// Owns: the graph library, run execution, and durability. The graph model,
// layout, runtime and checkpointer live in lib/ so they stay testable without
// a running server.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { Command } from "@langchain/langgraph";
import {
  END_NODE,
  START_NODE,
  edgeSchema,
  emptyRunState,
  fieldSchema,
  graphSchema,
  memberNodes,
  nodeExecution,
  spawnExecution,
  validateGraph,
  type Graph,
  type RunState,
} from "./lib/graph";
import {
  farewellMessage,
  interruptibleWorkers,
  orphanedWorkers,
} from "./lib/orphans";
import { compileGraph, GuardStop, type RuntimeHost } from "./lib/runtime";
import { GRAPH_STUDIO_ICON } from "./lib/icon";
import {
  createCrewClient,
  memberCorrelationId,
  memberProblems,
  type CallRpc,
} from "./lib/crew";
import {
  describeAttempt,
  describeGraph,
  describeLibrary,
  runTotal,
} from "./lib/describe";
import { checkModels, type WantedModel } from "./lib/model-check";
import { SqliteCheckpointer } from "./lib/checkpointer";
import { MIGRATIONS, createStore, type RunRow, type RunStatus } from "./lib/store";
import { RENAMED_TEMPLATES, TEMPLATES, searchGraphs } from "./lib/templates";
import { whileWorkspaceBusy } from "./lib/workspace";
import { ACTIVITY_EVENT_TYPES, describeActivity } from "./lib/activity";
import {
  answerRefusal,
  answerSource,
  approvalMessage,
  approvalSettledMessage,
  type AnswerSource,
  type MessagePart,
} from "./lib/approval";

const problemSchema = z.object({
  level: z.enum(["error", "warning"]),
  message: z.string(),
});

const nodeRunSchema = z.object({
  id: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  attempt: z.number(),
  status: z.enum(["running", "done", "failed", "skipped"]),
  childThreadId: z.string().nullable(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  /**
   * What the worker is doing right now; null when it is not running, or when
   * it has done nothing describable yet. Not stored: this is a reading of the
   * present, and a run reopened tomorrow must not show yesterday's last tool
   * call as if it were still happening.
   */
  activity: z.string().nullable(),
});

const runStateSchema = z.object({
  input: z.string(),
  outputs: z.record(z.string(), z.string()),
  fields: z
    .record(
      z.string(),
      z.record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
      ),
    )
    .default({}),
  /** Branch results of a dynamic fan-out, per node id. */
  collected: z
    .record(
      z.string(),
      z.array(z.object({ visit: z.number(), text: z.string() })),
    )
    .default({}),
  /** Why a node gave up, for nodes that route their failure onward. */
  errors: z.record(z.string(), z.string()).default({}),
  /** The fanned-out element of one instance; empty outside a fan-out. */
  item: z.string().default(""),
  visits: z.record(z.string(), z.number()),
  steps: z.number(),
});

const runSchema = z.object({
  id: z.string(),
  graphId: z.string(),
  graph: graphSchema,
  threadId: z.string().nullable(),
  projectId: z.string().nullable(),
  input: z.string(),
  status: z.enum(["running", "stopping", "waiting-human", "done", "failed", "stopped"]),
  state: runStateSchema,
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  nodeRuns: z.array(nodeRunSchema),
  /** Set while the run sits on a human node. */
  pendingQuestion: z
    .object({ nodeId: z.string(), label: z.string(), question: z.string() })
    .nullable(),
});

export type RunDto = z.infer<typeof runSchema>;
export type NodeRunDto = z.infer<typeof nodeRunSchema>;

export const rpcContract = defineRpcContract({
  listGraphs: {
    input: z.null(),
    output: z.object({
      graphs: z.array(graphSchema),
      templates: z.array(graphSchema),
    }),
  },
  getGraph: {
    input: z.object({ id: z.string() }),
    output: z.object({
      graph: graphSchema.nullable(),
      problems: z.array(problemSchema),
    }),
  },
  saveGraph: {
    input: z.object({
      graph: graphSchema,
      /**
       * The thread the editor is open in. Only member nodes need it: their
       * addresses mean something only inside that thread's project.
       */
      threadId: z.string().nullable().default(null),
    }),
    output: z.object({ graph: graphSchema, problems: z.array(problemSchema) }),
  },
  deleteGraph: {
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  cloneTemplate: {
    input: z.object({ templateId: z.string(), id: z.string(), name: z.string() }),
    output: z.object({ graph: graphSchema }),
  },
  startRun: {
    input: z.object({
      graphId: z.string(),
      input: z.string().trim().min(1).max(8000),
      threadId: z.string().nullable().default(null),
      projectId: z.string().nullable().default(null),
    }),
    output: z.object({ run: runSchema }),
  },
  getRun: {
    input: z.object({ id: z.string() }),
    output: z.object({ run: runSchema.nullable() }),
  },
  listRuns: {
    input: z.object({ threadId: z.string().nullable().default(null) }),
    output: z.object({ runs: z.array(runSchema) }),
  },
  answerHuman: {
    input: z.object({
      runId: z.string(),
      answer: z.string().max(4000),
      /** The approval the panel showed; guards against answering a newer one. */
      nodeId: z.string().optional(),
    }),
    output: z.object({ run: runSchema.nullable() }),
  },
  stopRun: {
    input: z.object({ runId: z.string() }),
    output: z.object({ run: runSchema.nullable() }),
  },
  /** Skills available in a thread's project/environment, for the node editor. */
  listSkills: {
    input: z.object({ threadId: z.string().nullable().default(null) }),
    output: z.object({
      skills: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string().nullable(),
          scope: z.string(),
        }),
      ),
      error: z.string().nullable(),
    }),
  },
  /**
   * Crew members in a thread's project, for the member node's picker. Never
   * throws: without Crew the editor still takes a typed address, and the save
   * check says what is wrong with it.
   */
  listCrewMembers: {
    input: z.object({ threadId: z.string().nullable().default(null) }),
    output: z.object({
      members: z.array(
        z.object({ address: z.string(), role: z.string(), activity: z.string() }),
      ),
      error: z.string().nullable(),
    }),
  },
  /** Points a run could be restarted from — one per pending superstep. */
  listCheckpoints: {
    input: z.object({ runId: z.string() }),
    output: z.object({
      checkpoints: z.array(
        z.object({
          checkpointId: z.string(),
          /** Node ids that were still to run at this point. */
          next: z.array(z.string()),
          doneCount: z.number(),
        }),
      ),
    }),
  },
  rerunFrom: {
    input: z.object({ runId: z.string(), checkpointId: z.string() }),
    output: z.object({ run: runSchema.nullable() }),
  },
  exportGraph: {
    input: z.object({ id: z.string() }),
    output: z.object({ filename: z.string(), json: z.string() }),
  },
  importGraph: {
    input: z.object({ json: z.string().max(500_000), overwrite: z.boolean().default(false) }),
    output: z.object({ graph: graphSchema }),
  },
});

/**
 * The on-disk shape. Versioned so a file written today stays readable, and
 * stripped of timestamps because those belong to the row, not the document.
 */
export const GRAPH_FILE_VERSION = 1 as const;

/**
 * Drop every value the schema would fill in anyway.
 *
 * An export that writes out each default is 156 lines where 84 would do, and
 * the noise is not free: a graph file lives in a repo, gets read in review and
 * diffed against the next version, and `"providerId": null` on every node
 * buries the one line that actually changed. Parsing is unaffected — the
 * schema puts the defaults back.
 */
function withoutDefaults<T extends Record<string, unknown>>(
  value: T,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (JSON.stringify(entry) === JSON.stringify(defaults[key])) continue;
    result[key] = entry;
  }
  return result;
}

export function toGraphFile(graph: Graph): string {
  const { createdAt: _created, updatedAt: _updated, ...document } = graph;
  // Defaults taken from the schema itself rather than written out here, so
  // this cannot drift from what a parse would actually produce.
  const graphDefaults = graphSchema.parse({
    id: "x",
    name: "x",
    nodes: [{ id: "n", label: "n" }],
    edges: [],
  });
  const nodeDefaults = graphDefaults.nodes[0]!;
  const edgeDefaults = edgeSchema.parse({ from: "a", to: "b" });
  const fieldDefaults = fieldSchema.parse({ name: "f" });

  const compact = {
    ...withoutDefaults(document, graphDefaults),
    // id and name are identity, never omitted even if they matched a default.
    id: document.id,
    name: document.name,
    nodes: document.nodes.map((node) => ({
      ...withoutDefaults(node, nodeDefaults),
      id: node.id,
      label: node.label,
      ...(node.fields.length > 0
        ? {
            fields: node.fields.map((field) => ({
              ...withoutDefaults(field, fieldDefaults),
              name: field.name,
            })),
          }
        : {}),
    })),
    edges: document.edges.map((edge) => ({
      ...withoutDefaults(edge, edgeDefaults),
      from: edge.from,
      to: edge.to,
    })),
  };
  return `${JSON.stringify({ version: GRAPH_FILE_VERSION, graph: compact }, null, 2)}\n`;
}

export function fromGraphFile(json: string): Graph {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("The file is not valid JSON.");
  }
  const envelope = z
    .object({ version: z.number(), graph: z.unknown() })
    .safeParse(parsed);
  // A bare graph object is accepted too, so a hand-written file works.
  const candidate = envelope.success ? envelope.data.graph : parsed;
  if (envelope.success && envelope.data.version > GRAPH_FILE_VERSION) {
    throw new Error(
      `The file is version ${envelope.data.version}; this plugin only knows ${GRAPH_FILE_VERSION}.`,
    );
  }
  const graph = graphSchema.safeParse(candidate);
  if (!graph.success) {
    const first = graph.error.issues[0];
    throw new Error(
      `Graph invalid${first ? ` (${first.path.join(".")}: ${first.message})` : ""}.`,
    );
  }
  return graph.data;
}

export default function graphStudio(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = createStore(db);
  const checkpointer = new SqliteCheckpointer(db);

  // Templates are shipped code, not stored rows: seeding them would freeze a
  // stale copy in the database the moment a template is improved. They are
  // exposed read-only and cloned under a new id to edit. Template ids are
  // therefore reserved — drop any row that squats on one.
  for (const template of TEMPLATES) {
    if (store.getGraph(template.id)) store.deleteGraph(template.id);
  }

  /** User graphs first, then the read-only shipped templates. */
  function resolveGraph(id: string): Graph | null {
    const stored = store.getGraph(id);
    // A stored row wins, which is right for a clone but wrong when the id is a
    // template's: then an improvement to the shipped template is invisible and
    // the old copy keeps running. `importGraph` refuses such an id, but a row
    // written *before* a template of that name existed slips past — which is
    // exactly how `gedanke-zu-konzept` and `konzept-wellen` came to shadow
    // themselves. Not resolved silently in either direction: the row still
    // wins, and the log says so.
    if (stored && TEMPLATES.some((entry) => entry.id === id)) {
      bb.log.warn(
        `Graph "${id}" exists as a saved row AND as a template; the saved one wins. Delete it to use the template again.`,
      );
    }
    const template = TEMPLATES.find((entry) => entry.id === id);
    if (stored || template) return stored ?? template!;

    // Nothing under that id — it may be one the library shipped before the
    // templates were renamed. A subgraph node stores its target as a plain id
    // and looks it up here, so without this a graph somebody saved would fail
    // at the node instead of at import.
    const renamed = RENAMED_TEMPLATES[id];
    if (!renamed) return null;
    bb.log.warn(
      `Graph "${id}" was renamed to "${renamed}"; resolving the new one. Update the reference to keep it working.`,
    );
    return store.getGraph(renamed) ?? TEMPLATES.find((e) => e.id === renamed) ?? null;
  }

  /** The whole library, in the order `resolveGraph` searches it. */
  function libraryGraphs(): Graph[] {
    return [...store.listGraphs(), ...TEMPLATES];
  }

  const publish = () => bb.realtime.publish("graph-studio", {});

  const crew = createCrewClient(((args) =>
    bb.sdk.plugins.callRpc(args as never)) as CallRpc);

  /** Member node ids of a graph and the graphs it embeds. */
  const memberIdsOf = (graph: Graph): Set<string> =>
    new Set(memberNodes(graph, resolveGraph).map((node) => node.id));

  /** The project a thread belongs to; null when there is no thread or it cannot be read. */
  async function projectOfThread(threadId: string | null): Promise<string | null> {
    if (!threadId) return null;
    try {
      return (await bb.sdk.threads.get({ threadId })).projectId ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Refuse a graph whose member nodes cannot run: Crew missing, or a member
   * it does not know. Thrown, not returned as a finding, because the one
   * outcome this must rule out is a graph that looks fine and then runs
   * without its crew.
   */
  async function assertMembersReachable(graph: Graph, projectId: string | null) {
    const problems = await memberProblems(graph, resolveGraph, crew, projectId);
    if (problems.length > 0) {
      const text = problems.join("; ");
      throw new Error(`Member nodes cannot run: ${text}${text.endsWith(".") ? "" : "."}`);
    }
  }

  /** Interrupt payloads, keyed by run. Rebuilt from the graph on resume. */
  const pending = new Map<
    string,
    { nodeId: string; label: string; question: string }
  >();
  /** Runs whose stop was requested; checked between nodes. */
  const stopping = new Set<string>();

  /**
   * Per-run claim: exactly one driver continues a run (BBP-16).
   *
   * Each loaded instance of this plugin is its own driver. A plugin reload
   * does not end the promises of the previous instance, and a slow server
   * restart re-runs resume-orphans while the previous process may have
   * driven the run seconds before — both were seen resuming the same run
   * twice. The claim lives in the database, so it holds across instances
   * and processes; the heartbeat lets a successor take over from a driver
   * that died without releasing.
   */
  const driverId = `drv_${randomUUID().slice(0, 12)}`;
  /** Runs this instance drives right now, with their heartbeat timer. */
  const driving = new Map<string, ReturnType<typeof setInterval>>();
  /**
   * Runs this instance was driving and gave up — its claim was lost or the
   * plugin is being disposed. Checked like a stop at every node boundary,
   * but writes nothing: the run belongs to someone else now.
   */
  const lost = new Set<string>();
  let disposed = false;
  /**
   * Workers a takeover found still alive, by run and node, oldest attempt
   * first (BBP-20). The node's replay picks its entry up in `onNodeStart`
   * and awaits that thread instead of spawning a new one.
   */
  const reattach = new Map<string, Map<string, Array<{ nodeRunId: string; threadId: string }>>>();
  /** Attempts handed an adopted worker, waiting for `adoptedThread` to collect it. */
  const adopted = new Map<string, string>();
  const halted = (runId: string) => stopping.has(runId) || lost.has(runId);

  /** Take the run, or say who has it. Synchronous from check to claim. */
  function claim(runId: string): boolean {
    if (disposed || driving.has(runId)) return false;
    if (!store.claimRun(runId, driverId, Date.now(), CLAIM_EXPIRY_MS)) return false;
    lost.delete(runId);
    const timer = setInterval(() => {
      let held = false;
      try {
        held = store.heartbeatRun(runId, driverId, Date.now());
      } catch {
        // A closed database after dispose: the claim is gone either way.
      }
      if (!held) abandon(runId, "its claim was taken over");
    }, CLAIM_HEARTBEAT_MS);
    // A heartbeat must not keep a test process or a shutting-down host alive.
    (timer as { unref?: () => void }).unref?.();
    driving.set(runId, timer);
    return true;
  }

  function unclaim(runId: string) {
    const timer = driving.get(runId);
    if (timer) clearInterval(timer);
    driving.delete(runId);
    try {
      store.releaseRun(runId, driverId);
    } catch {
      // Closed database: the expiry releases it.
    }
  }

  /** Stop driving without touching the run's status. */
  function abandon(runId: string, why: string) {
    if (!driving.has(runId) || lost.has(runId)) return;
    bb.log.warn(`[run ${runId}] Driver ${driverId} stops driving: ${why}.`);
    lost.add(runId);
    const timer = driving.get(runId);
    if (timer) clearInterval(timer);
    for (const controller of stopWaiters.get(runId) ?? []) controller.abort();
  }
  /**
   * The waits a run currently holds, keyed by run, aborted when its stop is
   * requested. `threads.wait` honours the signal on its next poll — 250 ms in
   * practice — so a stop reaches every waiting node almost immediately,
   * whatever the six-hour timeout of the wait itself says. Without this, a
   * worker that ignores being interrupted would hold its node hostage until
   * the timeout.
   */
  const stopWaiters = new Map<string, Set<AbortController>>();
  const trackStop = (runId: string): AbortController => {
    let waiters = stopWaiters.get(runId);
    if (!waiters) {
      waiters = new Set();
      stopWaiters.set(runId, waiters);
    }
    const controller = new AbortController();
    waiters.add(controller);
    return controller;
  };
  const untrackStop = (runId: string, controller: AbortController) => {
    const waiters = stopWaiters.get(runId);
    if (!waiters) return;
    waiters.delete(controller);
    if (waiters.size === 0) stopWaiters.delete(runId);
  };
  /**
   * Approvals posted into the thread that started the run, keyed by run. Only
   * these owe the chat a closing note when they are settled elsewhere. In
   * memory like `pending`: after a reload the note is skipped, and the tool
   * still refuses an answer to a settled approval.
   */
  const announced = new Map<string, { threadId: string; label: string }>();

  /** Best effort: a message that cannot be delivered must not stall a run. */
  async function postToThread(runId: string, threadId: string, input: MessagePart[]) {
    try {
      // `queue-if-active`: the starting thread may still be in the turn that
      // started the run, and a steer would cut that turn short.
      await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input });
    } catch (cause) {
      bb.log.warn(
        `[run ${runId}] Could not post to thread ${threadId}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }

  /** Ask in the starting thread. Only human nodes: a dialogue has its own worker. */
  function announceApproval(
    row: RunRow,
    ask: { nodeId: string; label: string; question: string },
  ) {
    if (!row.threadId) return;
    const node = row.graph.nodes.find((entry) => entry.id === ask.nodeId);
    if (node?.kind !== "human") return;
    announced.set(row.id, { threadId: row.threadId, label: ask.label });
    void postToThread(
      row.id,
      row.threadId,
      approvalMessage({ runId: row.id, graphName: row.graph.name, ...ask }),
    );
  }

  /** Close the chat's approval when it was settled anywhere but the chat. */
  function settleAnnouncement(
    runId: string,
    outcome:
      | { kind: "answered"; answer: string; source: AnswerSource }
      | { kind: "stopped" },
  ) {
    const entry = announced.get(runId);
    if (!entry) return;
    announced.delete(runId);
    if (outcome.kind === "answered" && outcome.source === "chat") return;
    void postToThread(
      runId,
      entry.threadId,
      approvalSettledMessage({ runId, label: entry.label, outcome }),
    );
  }

  /**
   * The current activity line per node_run, in memory only.
   *
   * Deliberately not a column: it is true for a few seconds, it is derivable
   * from the worker thread at any time, and a stored copy would come back on
   * reload as a claim about the present that nobody is checking any more.
   */
  const activity = new Map<string, string>();
  /** One poll timer per running run. */
  const watchers = new Map<string, ReturnType<typeof setInterval>>();

  /** How often a driver renews its claim on a run, and how often orphans are swept. */
  const CLAIM_HEARTBEAT_MS = 10_000;
  /** A claim not renewed for this long belongs to a driver that died. */
  const CLAIM_EXPIRY_MS = 60_000;

  /** How often a member node asks Crew whether its answer is there. */
  const MEMBER_POLL_MS = 2_000;

  /** How often a running run asks its workers what they are doing. */
  const ACTIVITY_POLL_MS = 3_000;

  /**
   * Read the activity of every worker this run has in flight.
   *
   * A run has one worker per running node — typically one, at most `maxFanOut`
   * — so this is a handful of calls every few seconds, and only while
   * something is actually running. Publishes only on a change: a node that
   * spends two minutes in the same tool call must not re-render the canvas
   * forty times to say so.
   */
  async function pollActivity(runId: string) {
    if (disposed) return; // the database may already be closed
    const rows = store.listNodeRuns(runId);
    let changed = false;
    // Attempts that have finished since the last poll: their line described
    // something that is over, and leaving it would freeze the last tool call
    // under a node that is long done.
    for (const row of rows) {
      if (row.status !== "running" && activity.delete(row.id)) changed = true;
    }
    const running = rows.filter(
      (row) => row.status === "running" && row.childThreadId !== null,
    );
    await Promise.all(
      running.map(async (row) => {
        try {
          const events = await bb.sdk.threads.events.list({
            threadId: row.childThreadId!,
            types: ACTIVITY_EVENT_TYPES,
            order: "desc",
            limit: "1",
          });
          const line = describeActivity(events[0]?.data);
          // Null means the newest event said nothing a reader could use —
          // keep what was there rather than blanking a line that was true.
          if (line === null || activity.get(row.id) === line) return;
          activity.set(row.id, line);
          changed = true;
        } catch (cause) {
          // A nicety must never disturb a run. One line at debug level,
          // because a worker that is being archived will fail this call and
          // that is not worth a warning every three seconds.
          bb.log.debug(
            `Activity of ${row.childThreadId} unreadable: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        }
      }),
    );
    if (changed) publish();
  }

  function watchActivity(runId: string) {
    if (watchers.has(runId)) return;
    const timer = setInterval(() => {
      void pollActivity(runId);
    }, ACTIVITY_POLL_MS);
    // Node keeps the process alive for a pending interval; a poll timer is not
    // a reason to stay up.
    timer.unref?.();
    watchers.set(runId, timer);
  }

  function unwatchActivity(runId: string) {
    const timer = watchers.get(runId);
    if (timer) clearInterval(timer);
    watchers.delete(runId);
    if (disposed) return; // the database may already be closed
    for (const row of store.listNodeRuns(runId)) activity.delete(row.id);
  }

  function toDto(runId: string): RunDto | null {
    const row = store.getRun(runId);
    if (!row) return null;
    return {
      ...row,
      state: row.state as RunState,
      nodeRuns: store
        .listNodeRuns(runId)
        .map((nodeRun) => ({
          ...nodeRun,
          activity: activity.get(nodeRun.id) ?? null,
        })),
      pendingQuestion: pending.get(runId) ?? null,
    };
  }

  /**
   * What a worker thread consumed, from BB's own accounting.
   *
   * Returns nulls rather than zeros whenever the answer is not knowable — no
   * thread, no usage event, a provider that does not report. A zero would
   * claim the node was free, and an inspector cannot tell an honest zero from
   * a missing measurement afterwards.
   */
  async function tokenUsage(
    threadId: string | null,
  ): Promise<{ inputTokens: number | null; outputTokens: number | null }> {
    const none = { inputTokens: null, outputTokens: null };
    if (!threadId) return none;
    try {
      // Descending, limit 1: the last event carries the running total for the
      // whole thread, so earlier ones would double-count if summed.
      const events = await bb.sdk.threads.events.list({
        threadId,
        types: ["thread/tokenUsage/updated"],
        order: "desc",
        limit: "1",
      });
      const last = events[0];
      if (!last) return none;
      const total = (
        last.data as {
          tokenUsage?: { total?: { inputTokens?: number; outputTokens?: number } };
        }
      ).tokenUsage?.total;
      if (!total) return none;
      return {
        inputTokens: total.inputTokens ?? null,
        outputTokens: total.outputTokens ?? null,
      };
    } catch (cause) {
      // Accounting must never fail a node that did its work.
      bb.log.warn(
        `Usage of ${threadId} unreadable: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      return none;
    }
  }

  function makeHost(
    runId: string,
    parentThreadId: string | null,
    projectId: string | null,
  ): RuntimeHost {
    return {
      async spawn({ prompt, title, execution }) {
        if (halted(runId)) throw new GuardStop("The run was stopped.");
        if (!parentThreadId) {
          throw new Error("A run needs a parent thread.");
        }
        // Reuse the parent's environment so workers land in the same
        // worktree the user is looking at, not a fresh checkout.
        const parent = await bb.sdk.threads.get({ threadId: parentThreadId });
        if (!parent.environmentId) {
          throw new Error(
            `Parent thread ${parentThreadId} has no environment a worker could inherit.`,
          );
        }
        // Read out once: inside the retry closure TypeScript can no longer
        // rely on the check above.
        const environmentId = parent.environmentId;
        const projectIdForChild = projectId ?? parent.projectId;
        // A node without its own selection inherits the parent's provider. It
        // has to be named explicitly — omitting it makes BB reach for project
        // and catalog defaults instead. See `spawnExecution`.
        const chosen = spawnExecution(execution, parent.providerId);
        // BB does not accept a model without its provider, and provenance only
        // describes what the graph actually decided.
        const executionArgs =
          chosen === null
            ? {}
            : {
                providerId: chosen.providerId,
                ...(chosen.model !== null ? { model: chosen.model } : {}),
                ...(chosen.reasoningLevel
                  ? { reasoningLevel: chosen.reasoningLevel }
                  : {}),
                ...(chosen.serviceTier
                  ? { serviceTier: chosen.serviceTier }
                  : {}),
                ...(chosen.explicit
                  ? {
                      executionInputSources: {
                        providerId: "explicit" as const,
                        model: "explicit" as const,
                        ...(chosen.reasoningLevel
                          ? { reasoningLevel: "explicit" as const }
                          : {}),
                        ...(chosen.serviceTier
                          ? { serviceTier: "explicit" as const }
                          : {}),
                      },
                    }
                  : {}),
              };
        // BB releases the previous worker's hold on the environment a moment
        // after that thread reports `idle`, so a node that spawns the next
        // worker right away is refused with 409 `workspace_busy`. Wait that gap
        // out instead of failing the node — see lib/workspace.ts.
        const child = await whileWorkspaceBusy(
          () =>
            bb.sdk.threads.spawn({
              prompt,
              title,
              visibility: "visible",
              origin: "plugin",
              parentThreadId,
              projectId: projectIdForChild,
              environment: { type: "reuse", environmentId },
              ...executionArgs,
            }),
          {
            onWait: (attempt, waitedMs) =>
              bb.log.info(
                `Working copy still busy, waiting for it to free up (attempt ${attempt}, ${waitedMs} ms).`,
              ),
          },
        );
        return child.id;
      },
      async awaitThread(threadId) {
        if (halted(runId)) throw new GuardStop("The run was stopped.");
        // `wait` is race-free: it resolves immediately if the thread already
        // reached the status, so a fast child cannot slip past a listener.
        // The six hours are the ceiling, not the plan: the signal aborts the
        // wait the moment the run's stop is requested, so a stop is felt here
        // within moments instead of hiding behind the whole wait. That is the
        // belt to `requestStop`'s braces — it interrupts the worker itself,
        // but a thread that ignores even that must not hold the run hostage.
        const controller = trackStop(runId);
        let output: string;
        try {
          await bb.sdk.threads.wait({
            threadId,
            status: "idle",
            timeoutMs: 1000 * 60 * 60 * 6,
            signal: controller.signal,
          });
          // Idle can be the interruption's doing: a worker stopped mid-turn
          // is idle with a half-finished answer. Say the stop rather than
          // collect that as a result.
          if (halted(runId)) throw new GuardStop("The run was stopped.");
          output = (await bb.sdk.threads.output({ threadId })).output ?? "";
        } catch (cause) {
          // An abort surfaces as whatever the transport makes of it; what
          // matters is that we asked for it, not how it reads.
          if (controller.signal.aborted) {
            throw new GuardStop("The run was stopped.");
          }
          throw cause;
        } finally {
          untrackStop(runId, controller);
        }
        if (output.trim() === "") {
          throw new Error(`Thread ${threadId} returned no result.`);
        }
        return output;
      },
      async sendMessage(threadId: string, text: string) {
        if (halted(runId)) throw new GuardStop("The run was stopped.");
        await bb.sdk.threads.send({
          threadId,
          mode: "start",
          input: [{ type: "text", text, mentions: [] }],
        });
        // The caller now waits for `idle`, and a thread that has not picked
        // the message up yet is *still* idle — so without this the next wait
        // returns instantly and hands back the previous answer. Waiting for
        // the turn to start closes that window. A timeout here is not fatal:
        // the answer check downstream catches a thread that never moved.
        try {
          await bb.sdk.threads.wait({
            threadId,
            status: "active",
            timeoutMs: 1000 * 60 * 2,
          });
        } catch {
          bb.log.info(`[run ${runId}] Thread ${threadId} never became active.`);
        }
      },
      async sendToMember({ nodeId, visit, attempt, address, body }) {
        if (halted(runId)) throw new GuardStop("The run was stopped.");
        const project = projectId ?? (await projectOfThread(parentThreadId));
        if (!project) {
          throw new Error(
            `A member node needs the run's project to find "${address}" in; this run has none.`,
          );
        }
        // Asked every time, not only at start: a member may have been removed
        // or its crew stopped since. Failing here is the whole point — the
        // node must never fall back to a fresh thread.
        const found = await crew.resolveMember(project, address);
        if (!found.member) {
          throw new Error(
            `Crew does not know the member "${address}" in this project${found.error ? `: ${found.error}` : "."}`,
          );
        }
        // Read per send, not per drive: a resume must find the generation the
        // crashed driver sent under, and only `rerunFrom` changes it.
        const key = { runId, gen: store.rerunGeneration(runId), nodeId, visit, attempt };
        const known = store.getMemberCall(key);
        if (known) {
          // A resume after a crash: the message is out, the answer is what is
          // missing. Sending again would give the member the task twice.
          bb.log.info(
            `[run ${runId}] ${nodeId} gen ${key.gen} visit ${visit} attempt ${attempt}: message ${known.messageId} was already sent to ${address}; waiting for its answer.`,
          );
          return { messageId: known.messageId, threadId: found.member.threadId };
        }
        const run = store.getRun(runId);
        const label =
          memberNodes(run?.graph ?? { nodes: [] } as never, resolveGraph).find(
            (node) => node.id === nodeId,
          )?.label ?? nodeId;
        const sent = await crew.sendToMember({
          projectId: project,
          address,
          body,
          subject: `${run?.graph.name ?? "Graph Studio"} · ${label}`.slice(0, 200),
          correlationId: memberCorrelationId(key),
        });
        if (!sent.messageId) {
          throw new Error(
            `Crew refused the message to "${address}"${sent.error ? `: ${sent.error}` : ` (${sent.status}).`}`,
          );
        }
        store.recordMemberCall(key, sent.messageId);
        return { messageId: sent.messageId, threadId: found.member.threadId };
      },
      async awaitMemberReply({ nodeId, visit, attempt, messageId }) {
        const controller = trackStop(runId);
        const deadline = Date.now() + 1000 * 60 * 60 * 6;
        let heldSaid = false;
        try {
          for (;;) {
            if (halted(runId) || controller.signal.aborted) {
              throw new GuardStop("The run was stopped.");
            }
            const reply = await crew.memberReply(messageId, controller.signal);
            if (reply.status === "completed") {
              store.setMemberCursor(
                { runId, gen: store.rerunGeneration(runId), nodeId, visit, attempt },
                reply.eventCursor,
              );
              const text = reply.text ?? "";
              if (text.trim() === "") {
                throw new Error(`The member answered message ${messageId} with nothing.`);
              }
              return { text, threadId: reply.threadId };
            }
            if (reply.status === "failed" || reply.status === "refused") {
              throw new Error(
                `The member's answer to message ${messageId} ${reply.status === "failed" ? "failed" : "was refused"}${reply.text ? `: ${reply.text}` : "."}`,
              );
            }
            if (reply.status === "held" && !heldSaid) {
              heldSaid = true;
              bb.log.info(
                `[run ${runId}] Message ${messageId} is held by Crew${reply.text ? ` (${reply.text})` : ""}; waiting.`,
              );
            }
            if (Date.now() > deadline) {
              throw new Error(`No answer to message ${messageId} within six hours.`);
            }
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, MEMBER_POLL_MS);
              controller.signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                { once: true },
              );
            });
          }
        } catch (cause) {
          if (controller.signal.aborted) throw new GuardStop("The run was stopped.");
          throw cause;
        } finally {
          untrackStop(runId, controller);
        }
      },
      async loadDialog(nodeId: string, visit: number) {
        return store.getDialog(runId, nodeId, visit);
      },
      async saveDialog(
        nodeId: string,
        visit: number,
        session: { threadId: string; turns: number },
      ) {
        store.saveDialog(runId, nodeId, visit, session);
      },
      async onNodeThread(nodeRunId: string, threadId: string) {
        if (lost.has(runId)) return;
        store.attachThread(nodeRunId, threadId);
        publish();
      },
      async onNodeStart(nodeId: string) {
        if (lost.has(runId)) throw new GuardStop("The run is driven elsewhere.");
        // A dialogue node re-enters this hook on every interrupt replay, but
        // it is one conversation. Reuse the open row, or the run history would
        // count each answered question as another attempt.
        const graph = store.getRun(runId)?.graph;
        const kind = graph?.nodes.find((node) => node.id === nodeId)?.kind;
        // A member node reuses the row a crash left open, too: after the
        // resume it is the same delivery, not a second attempt.
        if (kind === "dialog" || (graph && memberIdsOf(graph).has(nodeId))) {
          const open = store.findRunningNodeRun(runId, nodeId);
          if (open) return open.id;
        }
        // An agent attempt whose worker outlived its driver: the same attempt
        // continues on the same row, so no Abandoned entry and no new spawn.
        const waiting = reattach.get(runId)?.get(nodeId);
        const kept = waiting?.shift();
        if (kept) {
          adopted.set(kept.nodeRunId, kept.threadId);
          bb.log.info(
            `[run ${runId}] ${nodeId}: re-attached to worker ${kept.threadId}; waiting for its result.`,
          );
          return kept.nodeRunId;
        }
        const id = randomUUID();
        store.insertNodeRun({
          id,
          runId,
          nodeId,
          attempt: store.countAttempts(runId, nodeId) + 1,
          status: "running",
          childThreadId: null,
          output: null,
          error: null,
          startedAt: Date.now(),
          endedAt: null,
          inputTokens: null,
          outputTokens: null,
        });
        publish();
        return id;
      },
      adoptedThread(nodeRunId: string) {
        const threadId = adopted.get(nodeRunId) ?? null;
        adopted.delete(nodeRunId);
        return threadId;
      },
      async onNodeFinish(nodeRunId, patch) {
        // An abandoned attempt stays open: the successor resumes exactly
        // this row, and closing it here would make the resume a new attempt.
        if (lost.has(runId)) return;
        const graph = store.getRun(runId)?.graph;
        const nodeId = store
          .listNodeRuns(runId)
          .find((row) => row.id === nodeRunId)?.nodeId;
        // A member's thread counts tokens for its whole life, across runs and
        // other people's messages. Its total is not what this node cost, and
        // "unknown" is the honest reading.
        const member = graph !== undefined && nodeId !== undefined && memberIdsOf(graph).has(nodeId);
        store.updateNodeRun(nodeRunId, {
          ...patch,
          endedAt: Date.now(),
          // The worker is idle at this point, so its last usage event is the
          // final one for this node. Read here rather than live: a node is
          // billed once it is done, and polling a running thread would add
          // traffic per superstep for a number nobody can act on yet.
          ...(member
            ? { inputTokens: null, outputTokens: null }
            : await tokenUsage(patch.childThreadId)),
        });
        publish();
      },
      async onStateChange(state) {
        if (lost.has(runId)) return;
        const row = store.getRun(runId);
        if (!row) return;
        store.updateRun(
          runId,
          { status: row.status, state, error: row.error },
          Date.now(),
        );
        publish();
      },
      log: (message) => bb.log.info(`[run ${runId}] ${message}`),
    };
  }

  /**
   * Nodes whose explicit model the executing machine does not offer, as ready
   * sentences. Fail-closed on a definite mismatch, fail-open (with a logged
   * warning) when a catalogue cannot answer: a provider hiccup must not stop a
   * run that would otherwise work.
   */
  async function unknownModels(
    graph: Graph,
    parentThreadId: string | null,
  ): Promise<string[]> {
    const wanted: WantedModel[] = [];
    for (const node of graph.nodes) {
      const execution = nodeExecution(node);
      if (execution) {
        wanted.push({ label: node.label, providerId: execution.providerId, model: execution.model });
      }
    }
    if (wanted.length === 0 || !parentThreadId) return [];

    let environmentId: string | null;
    try {
      // Workers spawn into the parent thread's environment, so that is the
      // machine whose catalogue counts — a remote host may offer other models.
      environmentId = (await bb.sdk.threads.get({ threadId: parentThreadId })).environmentId ?? null;
    } catch (cause) {
      bb.log.warn(
        `Parent thread unreadable, model check skipped: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      return [];
    }
    if (!environmentId) return [];
    const envId = environmentId;

    // One request per provider: without `providerId` BB answers with the
    // default provider's catalogue only (BBP-21).
    const { problems, warnings } = await checkModels(wanted, (providerId) =>
      bb.sdk.providers.models({ environmentId: envId, providerId }),
    );
    for (const warning of warnings) bb.log.warn(`Model check: ${warning}`);
    return problems;
  }

  /**
   * Drive a run to its next stopping point: completion, a human node, a guard,
   * or a failure. Runs in the background; the UI follows over realtime.
   */
  async function drive(
    runId: string,
    resume?: string,
    fromCheckpointId?: string,
    claimedNote?: string,
  ): Promise<boolean> {
    const row = store.getRun(runId);
    if (!row) return false;
    if (!claim(runId)) {
      const holder = store.getDriver(runId)?.driverId;
      // Debug, not info: the orphan sweep asks every few seconds, and a run
      // that is in good hands elsewhere is the normal case.
      bb.log.debug(
        `[run ${runId}] Not driven by ${driverId}: ${
          driving.has(runId) ? "already driving it" : `claimed by ${holder ?? "another driver"}`
        }.`,
      );
      return false;
    }
    if (claimedNote) {
      bb.log.info(`${claimedNote} (driver ${driverId})`);
      await settleAbandonedAttempts(row);
    }
    try {
      await driveClaimed(row, resume, fromCheckpointId);
    } finally {
      await releaseUnclaimedWorkers(runId);
      unclaim(runId);
      lost.delete(runId);
    }
    return true;
  }

  /**
   * Sort what the previous driver left mid-flight before taking a run over.
   *
   * An agent node is replayed by LangGraph on resume. Its worker may well
   * still be working, or be finished with an answer nobody collected — then
   * the replay re-attaches to it (see `reattach`) and the node runs once
   * (BBP-20). Only a worker that is really lost — no thread id, thread gone,
   * archived, deleted, errored, being stopped, or idle without an answer —
   * gets its attempt closed and the node runs again with a fresh worker.
   * Member and dialogue nodes are left alone: they resume their open row and
   * thread on purpose.
   */
  async function settleAbandonedAttempts(row: RunRow) {
    const members = memberIdsOf(row.graph);
    const dialogs = new Set(
      row.graph.nodes.filter((node) => node.kind === "dialog").map((node) => node.id),
    );
    const open = store
      .listNodeRuns(row.id)
      .filter(
        (entry) =>
          entry.status === "running" && !members.has(entry.nodeId) && !dialogs.has(entry.nodeId),
      )
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    const kept = new Map<string, Array<{ nodeRunId: string; threadId: string }>>();
    let closed = 0;
    for (const entry of open) {
      const lostBecause = entry.childThreadId
        ? await whyWorkerLost(entry.childThreadId)
        : "it never got a worker thread";
      if (lostBecause === null) {
        const list = kept.get(entry.nodeId) ?? [];
        list.push({ nodeRunId: entry.id, threadId: entry.childThreadId! });
        kept.set(entry.nodeId, list);
        continue;
      }
      closed += 1;
      store.updateNodeRun(entry.id, {
        status: "failed",
        childThreadId: entry.childThreadId,
        output: null,
        error: `Abandoned when its driver went away (${lostBecause}); the node runs again.`,
        endedAt: Date.now(),
      });
      if (entry.childThreadId) await stopWorker(row.id, entry.childThreadId);
    }
    if (kept.size > 0) reattach.set(row.id, kept);
    else reattach.delete(row.id);
    if (closed > 0) publish();
  }

  /** Null when the worker can still deliver its answer; otherwise why not. */
  async function whyWorkerLost(threadId: string): Promise<string | null> {
    let thread: { status?: string; archivedAt?: number | null; deletedAt?: number | null };
    try {
      thread = (await bb.sdk.threads.get({ threadId })) as typeof thread;
    } catch (cause) {
      return `worker ${threadId} is missing: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    if (thread.deletedAt) return `worker ${threadId} was deleted`;
    if (thread.archivedAt) return `worker ${threadId} was archived`;
    switch (thread.status) {
      case "active":
      case "pending":
      case "starting":
        return null;
      case "idle": {
        // Finished while nobody was waiting: worth taking only if it left an
        // answer — an empty one would just fail the adopted attempt instead.
        try {
          const { output } = await bb.sdk.threads.output({ threadId });
          return (output ?? "").trim() === "" ? `worker ${threadId} is idle without a result` : null;
        } catch {
          return `worker ${threadId} has no readable result`;
        }
      }
      default:
        return `worker ${threadId} is ${thread.status ?? "in an unknown state"}`;
    }
  }

  async function stopWorker(runId: string, threadId: string) {
    try {
      await bb.sdk.threads.stop({ threadId });
      bb.log.info(`[run ${runId}] Interrupted abandoned worker ${threadId}.`);
    } catch (cause) {
      bb.log.warn(
        `[run ${runId}] Could not interrupt abandoned worker ${threadId}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }

  /**
   * Kept workers the replay never asked for — the run ended or took another
   * path first. Their rows would otherwise stay `running` for good. Skipped
   * when this driver lost the run: the successor owns those rows now.
   */
  async function releaseUnclaimedWorkers(runId: string) {
    const left = reattach.get(runId);
    reattach.delete(runId);
    if (!left || lost.has(runId) || disposed) return;
    for (const entry of [...left.values()].flat()) {
      adopted.delete(entry.nodeRunId);
      store.updateNodeRun(entry.nodeRunId, {
        status: "failed",
        childThreadId: entry.threadId,
        output: null,
        error: "Abandoned: the resumed run did not come back to this node.",
        endedAt: Date.now(),
      });
      await stopWorker(runId, entry.threadId);
      publish();
    }
  }

  async function driveClaimed(
    row: RunRow,
    resume?: string,
    fromCheckpointId?: string,
  ) {
    const runId = row.id;
    const host = makeHost(runId, row.threadId, row.projectId);

    // Models are named in the graph but resolved on the machine that runs it.
    // A graph imported from elsewhere — or one authored while another provider
    // was installed — can name a model this host does not have, and BB would
    // quietly fall back to the inherited one. A silent downgrade is the worst
    // outcome here: the run looks right and costs or capability differ.
    const unknown = await unknownModels(row.graph, row.threadId);
    if (unknown.length > 0) {
      store.updateRun(
        runId,
        {
          status: "failed",
          state: row.state as RunState,
          error: `Unknown model choice: ${unknown.join("; ")}`,
        },
        Date.now(),
      );
      publish();
      return;
    }

    const app = compileGraph(row.graph, host, checkpointer, resolveGraph);
    // From here on there are workers to ask. Started before `invoke`, stopped
    // in the `finally` below, so no run can leave a timer behind.
    watchActivity(runId);
    const config = {
      configurable: {
        thread_id: runId,
        ...(fromCheckpointId ? { checkpoint_id: fromCheckpointId } : {}),
      },
      recursionLimit: 200,
    };

    try {
      // `null` means "continue from the checkpoint named in the config" —
      // LangGraph replays the pending nodes and leaves finished ones alone.
      const input =
        fromCheckpointId !== undefined
          ? null
          : resume === undefined
            ? { ...emptyRunState(row.input), ...(row.state as RunState) }
            : new Command({ resume });
      const result = (await app.invoke(input as never, config)) as RunState & {
        __interrupt__?: Array<{ value: unknown }>;
      };
      // Abandoned mid-way: the successor writes the outcome, not us.
      if (lost.has(runId)) return;

      const headConfig = { configurable: { thread_id: runId } };
      const interrupts = (await app.getState(headConfig)).tasks.flatMap(
        (task) => task.interrupts ?? [],
      );
      if (interrupts.length > 0) {
        // A stop that arrived while the graph was finding its interrupt is
        // still a stop: parking the run at a question nobody will answer
        // would strand it in `waiting-human` despite the request.
        if (stopping.has(runId)) {
          store.updateRun(
            runId,
            { status: "stopped", state: result, error: null },
            Date.now(),
          );
          publish();
          await farewellWorkers(runId, "stopped", null);
          return;
        }
        const value = interrupts[0]!.value as {
          nodeId: string;
          label: string;
          question: string;
        };
        pending.set(runId, value);
        store.updateRun(
          runId,
          { status: "waiting-human", state: result, error: null },
          Date.now(),
        );
        publish();
        announceApproval(row, value);
        return;
      }

      pending.delete(runId);
      store.updateRun(
        runId,
        {
          status: stopping.has(runId) ? "stopped" : "done",
          state: result,
          error: null,
        },
        Date.now(),
      );
    } catch (cause) {
      if (lost.has(runId)) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      const status: RunStatus =
        cause instanceof GuardStop || stopping.has(runId) ? "stopped" : "failed";
      const current = store.getRun(runId);
      store.updateRun(
        runId,
        { status, state: current?.state ?? {}, error: message },
        Date.now(),
      );
      bb.log.warn(`Run ${runId} ended: ${message}`);
      await farewellWorkers(runId, status, message);
    } finally {
      unwatchActivity(runId);
      // An abandoned run's stop flag and waiters are not this driver's to
      // clear, and a disposed instance must not publish on a stale handle.
      if (!lost.has(runId)) {
        stopping.delete(runId);
        stopWaiters.delete(runId);
        publish();
      }
    }
  }

  /** One implementation behind RPC, CLI and the agent tools. */
  async function startRun(args: {
    graphId: string;
    input: string;
    threadId: string | null;
    projectId: string | null;
  }): Promise<string> {
    const graph = resolveGraph(args.graphId);
    if (!graph) throw new Error(`Unknown graph ${args.graphId}`);
    if (!args.threadId) {
      throw new Error(
        "A run needs a parent thread whose environment the workers inherit.",
      );
    }
    const errors = validateGraph(graph, resolveGraph).filter(
      (problem) => problem.level === "error",
    );
    if (errors.length > 0) {
      throw new Error(
        `Graph is not runnable: ${errors.map((e) => e.message).join(" ")}`,
      );
    }
    await assertMembersReachable(
      graph,
      args.projectId ?? (await projectOfThread(args.threadId)),
    );
    const now = Date.now();
    const runId = `run_${randomUUID().slice(0, 12)}`;
    store.insertRun({
      id: runId,
      graphId: args.graphId,
      graph,
      threadId: args.threadId,
      projectId: args.projectId,
      input: args.input,
      status: "running",
      state: emptyRunState(args.input),
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    publish();
    void drive(runId);
    return runId;
  }

  /**
   * Synchronous from the check to the status change, so of two answers racing
   * in from chat and panel exactly one resumes the run; the other is refused.
   */
  function answerHuman(
    runId: string,
    answer: string,
    via: { source: AnswerSource; nodeId?: string } = { source: "elsewhere" },
  ) {
    const row = store.getRun(runId);
    if (!row) throw new Error(`No run ${runId}.`);
    const refusal = answerRefusal({
      status: row.status,
      pendingNodeId: pending.get(runId)?.nodeId ?? null,
      expectedNodeId: via.nodeId,
    });
    if (refusal) throw new Error(refusal);
    pending.delete(runId);
    settleAnnouncement(runId, { kind: "answered", answer, source: via.source });
    store.updateRun(
      runId,
      { status: "running", state: row.state, error: null },
      Date.now(),
    );
    publish();
    void drive(runId, answer);
  }

  /** Restart points of a run: one per superstep that still had work pending. */
  async function listCheckpointsFor(row: RunRow): Promise<{
    checkpoints: Array<{ checkpointId: string; next: string[]; doneCount: number }>;
  }> {
    const host = makeHost(row.id, row.threadId, row.projectId);
    const app = compileGraph(row.graph, host, checkpointer, resolveGraph);
    const checkpoints: Array<{
      checkpointId: string;
      next: string[];
      doneCount: number;
    }> = [];
    for await (const snapshot of app.getStateHistory({
      configurable: { thread_id: row.id },
    })) {
      const next = [...snapshot.next].filter(
        (id) => id !== START_NODE && id !== END_NODE,
      );
      if (next.length === 0) continue;
      const id = snapshot.config.configurable?.checkpoint_id;
      if (typeof id !== "string") continue;
      const values = snapshot.values as Partial<RunState>;
      checkpoints.push({
        checkpointId: id,
        next,
        doneCount: Object.keys(values.outputs ?? {}).length,
      });
    }
    return { checkpoints };
  }

  function rerunFrom(runId: string, checkpointId: string) {
    const row = store.getRun(runId);
    if (!row) throw new Error(`No run ${runId}.`);
    if (row.status === "running" || row.status === "stopping") {
      throw new Error(
        row.status === "stopping"
          ? "That run is still stopping. Give it a moment, then retry."
          : "That run is in progress. Stop it first, then retry.",
      );
    }
    stopping.delete(runId);
    pending.delete(runId);
    // A rerun replays the graph and asks again if it reaches the node again.
    announced.delete(runId);
    // A new generation, so member nodes on the replayed path send anew
    // instead of finding the earlier delivery in the ledger (BBP-15).
    store.bumpRerunGeneration(runId);
    store.updateRun(
      runId,
      { status: "running", state: row.state, error: null },
      Date.now(),
    );
    publish();
    void drive(runId, undefined, checkpointId);
  }

  /**
   * The user's stop, made effective immediately.
   *
   * Between nodes the flag alone is enough — the next spawn refuses. But a
   * run's workers can each sit in a turn of their own, and waiting for those
   * to finish would keep the run `running` (and the workers burning) for as
   * long as the longest of them. So a stop does three things in one breath:
   * it marks the run `stopping` — visible in the panel, and persisted, so a
   * reload honours the wish instead of resurrecting the run —, it aborts the
   * waits the run's nodes are held in, and it interrupts the workers
   * themselves. What is still in flight then ends as a failed node, and
   * `drive`'s catch settles the run as `stopped`.
   */
  function requestStop(runId: string) {
    stopping.add(runId);
    for (const controller of stopWaiters.get(runId) ?? []) controller.abort();
    const row = store.getRun(runId);
    if (!row) return;
    if (row.status === "waiting-human") {
      pending.delete(runId);
      settleAnnouncement(runId, { kind: "stopped" });
      store.updateRun(
        runId,
        { status: "stopped", state: row.state, error: null },
        Date.now(),
      );
      publish();
      // Nothing is driving this run any more, so nobody else will say it.
      // A run that is still `running` reaches `drive`'s catch instead.
      void farewellWorkers(runId, "stopped", null);
      return;
    }
    if (row.status === "running" || row.status === "stopping") {
      store.updateRun(
        runId,
        { status: "stopping", state: row.state, error: row.error },
        Date.now(),
      );
      publish();
      void interruptWorkers(runId);
    }
  }

  /**
   * Interrupt the workers a run has in flight, so a stop reaches them
   * mid-turn instead of waiting out work nobody will collect. `threads.stop`
   * cuts the active turn and stops the thread's runtime; the goodbye that
   * `farewellWorkers` sends afterwards still reaches the thread, so a worker
   * that had something worth keeping can write it down. Best effort per
   * thread: a worker that cannot be interrupted must not block the stop —
   * the aborted waits and the between-nodes flag are what make it certain.
   */
  function membersOfRun(runId: string): Set<string> {
    const row = store.getRun(runId);
    return row ? memberIdsOf(row.graph) : new Set();
  }

  async function interruptWorkers(runId: string) {
    await Promise.all(
      interruptibleWorkers(store.listNodeRuns(runId), membersOfRun(runId)).map(async (threadId) => {
        try {
          await bb.sdk.threads.stop({ threadId });
          bb.log.info(`[run ${runId}] Interrupted worker ${threadId}.`);
        } catch (cause) {
          bb.log.warn(
            `[run ${runId}] Could not interrupt worker ${threadId}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        }
      }),
    );
  }

  /**
   * Tell the workers a run leaves behind that it is over. See lib/orphans.ts
   * for who counts as left behind and why they are told rather than stopped.
   *
   * `steer-if-active`: an idle worker — the dialogue thread waiting for an
   * answer — gets the message as a new turn; one still mid-turn is steered
   * rather than queued behind work it should no longer finish. Best effort
   * per thread: a goodbye that cannot be delivered must not mask the failure
   * that ended the run.
   */
  async function farewellWorkers(
    runId: string,
    status: "failed" | "stopped",
    error: string | null,
  ) {
    const threads = orphanedWorkers(
      store.listNodeRuns(runId),
      store.listDialogs(runId),
      membersOfRun(runId),
    );
    if (threads.length === 0) return;
    const text = farewellMessage(status, error);
    await Promise.all(
      threads.map(async (threadId) => {
        try {
          await bb.sdk.threads.send({
            threadId,
            mode: "steer-if-active",
            input: [{ type: "text", text, mentions: [] }],
          });
          bb.log.info(`[run ${runId}] Told worker ${threadId} that the run ended.`);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          bb.log.warn(
            `[run ${runId}] Could not tell worker ${threadId} that the run ended: ${message}`,
          );
        }
      }),
    );
  }

  bb.rpc.register(rpcContract, {
    listGraphs: () => ({
      graphs: [...store.listGraphs(), ...TEMPLATES],
      templates: TEMPLATES,
    }),
    getGraph: ({ id }) => {
      const graph = resolveGraph(id);
      return { graph, problems: graph ? validateGraph(graph, resolveGraph) : [] };
    },
    saveGraph: async ({ graph, threadId }) => {
      await assertMembersReachable(graph, await projectOfThread(threadId));
      const saved = store.saveGraph(graph, Date.now());
      publish();
      return { graph: saved, problems: validateGraph(saved, resolveGraph) };
    },
    deleteGraph: ({ id }) => {
      store.deleteGraph(id);
      publish();
      return { ok: true };
    },
    cloneTemplate: ({ templateId, id, name }) => {
      const template = TEMPLATES.find((entry) => entry.id === templateId);
      if (!template) throw new Error(`Unknown template ${templateId}`);
      if (resolveGraph(id)) {
        throw new Error(`A graph "${id}" already exists.`);
      }
      const graph = store.saveGraph(
        { ...template, id, name, createdAt: 0 },
        Date.now(),
      );
      publish();
      return { graph };
    },
    startRun: async ({ graphId, input, threadId, projectId }) => {
      const runId = await startRun({ graphId, input, threadId, projectId });
      return { run: toDto(runId)! };
    },
    getRun: ({ id }) => ({ run: toDto(id) }),
    listRuns: ({ threadId }) => {
      const rows = threadId ? store.listRunsByThread(threadId) : store.listRuns();
      return {
        runs: rows.flatMap((row) => {
          const dto = toDto(row.id);
          return dto ? [dto] : [];
        }),
      };
    },
    answerHuman: ({ runId, answer, nodeId }) => {
      answerHuman(runId, answer, { source: "panel", nodeId });
      return { run: toDto(runId) };
    },
    stopRun: ({ runId }) => {
      requestStop(runId);
      return { run: toDto(runId) };
    },
    listSkills: async ({ threadId }) => {
      // Skills are resolved per project + environment, so they need a thread
      // for context. A failure here is informational: the editor still lets
      // the user type a skill id by hand.
      if (!threadId) return { skills: [], error: "No thread selected." };
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        const { skills } = await bb.sdk.skills.list({
          projectId: thread.projectId,
          environmentId: thread.environmentId ?? null,
        });
        return {
          skills: skills.map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            scope: skill.scope,
          })),
          error: null,
        };
      } catch (cause) {
        return {
          skills: [],
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
    },
    listCrewMembers: async ({ threadId }) => {
      const projectId = await projectOfThread(threadId);
      if (!projectId) return { members: [], error: "No project selected." };
      try {
        const { members } = await crew.listMembers(projectId);
        return {
          members: members.map((member) => ({
            address: member.address,
            role: member.role,
            activity: member.activity,
          })),
          error: null,
        };
      } catch (cause) {
        return {
          members: [],
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
    },
    listCheckpoints: async ({ runId }) => {
      const row = store.getRun(runId);
      if (!row) return { checkpoints: [] };
      return listCheckpointsFor(row);
    },
    rerunFrom: ({ runId, checkpointId }) => {
      rerunFrom(runId, checkpointId);
      return { run: toDto(runId) };
    },
    exportGraph: ({ id }) => {
      const graph = resolveGraph(id);
      if (!graph) throw new Error(`Unknown graph ${id}`);
      return { filename: `${graph.id}.graph.json`, json: toGraphFile(graph) };
    },
    importGraph: ({ json, overwrite }) => {
      const graph = fromGraphFile(json);
      if (TEMPLATES.some((entry) => entry.id === graph.id)) {
        throw new Error(
          `"${graph.id}" is a shipped template. Give the import a different id.`,
        );
      }
      if (!overwrite && store.getGraph(graph.id)) {
        throw new Error(
          `A graph "${graph.id}" already exists. Confirm overwriting explicitly.`,
        );
      }
      const saved = store.saveGraph(graph, Date.now());
      publish();
      return { graph: saved };
    },
  });

  const CLI_COMMANDS = [
      {
        name: "graphs",
        summary: "List graphs, optionally filtered",
        usage: "bb graph-studio graphs [search]",
      },
      {
        name: "show",
        summary: "Show a graph and what the check says",
        usage: "bb graph-studio show <graph-id>",
      },
      {
        name: "run",
        summary: "Start a run",
        usage: 'bb graph-studio run <graph-id> "<task>"',
      },
      { name: "runs", summary: "List runs", usage: "bb graph-studio runs" },
      {
        name: "status",
        summary: "Show one run in detail",
        usage: "bb graph-studio status <run-id>",
      },
      {
        name: "answer",
        summary: "Answer a waiting approval",
        usage: 'bb graph-studio answer <run-id> "<answer>"',
      },
      { name: "stop", summary: "Stop a run", usage: "bb graph-studio stop <run-id>" },
      {
        name: "checkpoints",
        summary: "Show a run's checkpoints",
        usage: "bb graph-studio checkpoints <run-id>",
      },
      {
        name: "rerun",
        summary: "Resume a run from a checkpoint",
        usage: "bb graph-studio rerun <run-id> <checkpoint-id>",
      },
      {
        name: "delete",
        summary: "Delete a graph of your own (templates stay)",
        usage: "bb graph-studio delete <graph-id>",
      },
      {
        name: "export",
        summary: "Write a graph as JSON to stdout",
        usage: "bb graph-studio export <graph-id> > my-graph.graph.json",
      },
      {
        name: "import",
        summary: "Read a graph from a JSON file",
        usage: "bb graph-studio import <file.json> [--overwrite]",
      },
  ];

  /** The command list as text — what `help` prints and what a wrong command earns. */
  const usageText = [
    "bb graph-studio <command>",
    "",
    ...CLI_COMMANDS.map((entry) => `  ${entry.usage.padEnd(56)} ${entry.summary}`),
    "",
    // The best way to start a run is the one the command list cannot show,
    // because it is not a command. A run's nodes are fresh threads: whatever
    // was settled in a conversation reaches them only if somebody writes it
    // into the task. The agent in that conversation can do it and start the
    // run itself — and `--help` is where someone looks for what is possible,
    // at no cost in the panel, where vertical space is the scarce thing.
    "A run's task is the only context it gets — its nodes are fresh threads and",
    "cannot see your conversation. Rather than retyping what was settled, ask the",
    "agent in that thread; it reads all of it and starts the run itself:",
    "",
    '  "Summarise what we settled here and start concept-domain with it"',
    "",
    "New flows are designed the same way, in natural language, in a chat:",
    "",
    '  /graph-studio Build me a flow that reviews a change, loops until clean,',
    "                and asks me before merging",
  ].join("\n");

  bb.cli.register({
    name: "graph-studio",
    summary: "Build graphs and steer runs (cycles, routing, approvals)",
    commands: CLI_COMMANDS,
    run: async (argv: string[], ctx) => {
      const [command, ...rest] = argv;
      const ok = (stdout: string) => ({ exitCode: 0, stdout: `${stdout}\n` });
      const fail = (stderr: string) => ({ exitCode: 1, stderr: `${stderr}\n` });

      switch (command) {
        // Without this, the "see --help" hint below led into the same error
        // it was pointing away from.
        case undefined:
        case "help":
        case "--help":
        case "-h": {
          return ok(usageText);
        }
        case "graphs": {
          const term = rest.join(" ");
          const found = searchGraphs(libraryGraphs(), term);
          // A search that finds nothing says so, and says what it looked for.
          // An empty listing reads as an empty library.
          if (found.length === 0) {
            return ok(`No graph matches "${term}".`);
          }
          return ok(describeLibrary(found));
        }
        case "show": {
          const graph = rest[0] ? resolveGraph(rest[0]) : null;
          if (!graph) return fail("Graph not found.");
          return ok(describeGraph(graph, validateGraph(graph, resolveGraph)));
        }
        case "run": {
          const [graphId, ...task] = rest;
          if (!graphId || task.length === 0) {
            return fail('Usage: bb graph-studio run <graph-id> "<task>"');
          }
          let runIdStarted: string;
          try {
            runIdStarted = await startRun({
            graphId,
            input: task.join(" "),
            threadId: ctx.threadId ?? null,
            projectId: ctx.projectId ?? null,
            });
          } catch (cause) {
            return fail(cause instanceof Error ? cause.message : String(cause));
          }
          return ok(`Run started: ${runIdStarted}`);
        }
        case "runs": {
          return ok(
            store
              .listRuns(20)
              .map((row) => `${row.id}  ${row.status.padEnd(14)} ${row.graphId}`)
              .join("\n") || "No runs.",
          );
        }
        case "status": {
          const dto = rest[0] ? toDto(rest[0]) : null;
          if (!dto) return fail("Run not found.");
          const lines = [
            `${dto.id}  ${dto.status}`,
            `Graph: ${dto.graph.name}`,
            `Task: ${dto.input}`,
            dto.error ? `Error: ${dto.error}` : "",
            "",
            ...dto.nodeRuns.map((node) => describeAttempt(node, Date.now())),
            // The run total answers the question the per-node lines raise.
            // Empty when nothing was measured, and then the blank line and the
            // heading go away with it.
            ...(runTotal(dto.nodeRuns) ? ["", runTotal(dto.nodeRuns)] : []),
            dto.pendingQuestion
              ? `\nWaiting for an answer: ${dto.pendingQuestion.question}`
              : "",
          ];
          return ok(lines.filter(Boolean).join("\n"));
        }
        case "answer": {
          const [runId, ...answer] = rest;
          if (!runId) return fail("Usage: bb graph-studio answer <run-id> <answer>");
          const row = store.getRun(runId);
          try {
            answerHuman(runId, answer.join(" "), {
              source: answerSource(ctx.threadId, row?.threadId ?? null),
            });
          } catch (cause) {
            return fail(cause instanceof Error ? cause.message : String(cause));
          }
          return ok("Answer taken.");
        }
        case "stop": {
          if (!rest[0]) return fail("Usage: bb graph-studio stop <run-id>");
          requestStop(rest[0]);
          return ok("Stopping the run.");
        }
        case "checkpoints": {
          const runId = rest[0];
          if (!runId) return fail("Usage: bb graph-studio checkpoints <run-id>");
          const row = store.getRun(runId);
          if (!row) return fail("Run not found.");
          const { checkpoints } = await listCheckpointsFor(row);
          if (checkpoints.length === 0) return ok("No checkpoints.");
          const labelOf = (id: string) =>
            row.graph.nodes.find((node) => node.id === id)?.label ?? id;
          return ok(
            checkpoints
              .map(
                (entry) =>
                  `${entry.checkpointId}  before ${entry.next.map(labelOf).join(", ")}  (${entry.doneCount} ${entry.doneCount === 1 ? "result" : "results"} available)`,
              )
              .join("\n"),
          );
        }
        case "rerun": {
          const [runId, checkpointId] = rest;
          if (!runId || !checkpointId) {
            return fail("Usage: bb graph-studio rerun <run-id> <checkpoint-id>");
          }
          try {
            rerunFrom(runId, checkpointId);
          } catch (cause) {
            return fail(cause instanceof Error ? cause.message : String(cause));
          }
          return ok(`Run ${runId} resumes from ${checkpointId}.`);
        }
        case "delete": {
          const id = rest[0];
          if (!id) return fail("Usage: bb graph-studio delete <graph-id>");
          if (TEMPLATES.some((entry) => entry.id === id)) {
            return fail(`"${id}" is a shipped template and stays.`);
          }
          if (!store.getGraph(id)) return fail(`No graph of your own called "${id}".`);
          store.deleteGraph(id);
          publish();
          return ok(`Deleted: ${id}`);
        }
        case "export": {
          const graph = rest[0] ? resolveGraph(rest[0]) : null;
          if (!graph) return fail("Graph not found.");
          // Raw JSON on stdout so it can be redirected straight into the repo.
          return { exitCode: 0, stdout: toGraphFile(graph) };
        }
        case "import": {
          const file = rest.find((arg) => !arg.startsWith("--"));
          if (!file) {
            return fail("Usage: bb graph-studio import <file.json> [--overwrite]");
          }
          let json: string;
          try {
            json = await readFile(resolve(file), "utf8");
          } catch (cause) {
            return fail(
              `File unreadable: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
          }
          try {
            const graph = fromGraphFile(json);
            if (TEMPLATES.some((entry) => entry.id === graph.id)) {
              return fail(
                `"${graph.id}" is a shipped template. Give the import a different id.`,
              );
            }
            if (!rest.includes("--overwrite") && store.getGraph(graph.id)) {
              return fail(
                `A graph "${graph.id}" already exists. Replace it with --overwrite.`,
              );
            }
            const saved = store.saveGraph(graph, Date.now());
            publish();
            return ok(`Imported: ${saved.id} (${saved.nodes.length} nodes)`);
          } catch (cause) {
            return fail(cause instanceof Error ? cause.message : String(cause));
          }
        }
        default:
          // "bb graph-studio build me a flow that …" is a sentence, not a
          // command. The CLI cannot write a graph — an agent can, so the
          // answer points there instead of at the command list.
          if (argv.length > 2) {
            return fail(
              `"${argv.join(" ")}" reads like a request, not a command.\nDesign flows in a chat:\n\n  /graph-studio ${argv.join(" ")}\n\nCommands: bb graph-studio --help`,
            );
          }
          return fail(`Unknown command "${command}".\n\n${usageText}`);
      }
    },
  });

  // Reading tools. Without them a model can start a graph whose id it already
  // knows, but cannot find out which graphs exist or what one does — the
  // description sits in the CLI, reachable only by whoever knows the CLI.
  bb.agents.registerTool({
    name: "graph_studio_graphs",
    description:
      "List the Graph Studio library: one line per graph with its id, node count and name. Use this before graph_studio_describe or graph_studio_run.",
    parameters: z.object({}),
    execute: async () => describeLibrary(libraryGraphs()),
  });

  bb.agents.registerTool({
    name: "graph_studio_describe",
    description:
      "Describe one Graph Studio graph: purpose, nodes with their kind, skills and declared fields, all edges with their routing conditions, and the validator's findings. Use this to talk about what a graph does before running it.",
    parameters: z.object({ graphId: z.string() }),
    execute: async ({ graphId }) => {
      const graph = resolveGraph(graphId);
      if (!graph) {
        // Naming the alternatives beats "not found": the usual cause is a
        // guessed id, and the list is the answer to the next question anyway.
        return `No graph "${graphId}". Available:\n${describeLibrary(libraryGraphs())}`;
      }
      return describeGraph(graph, validateGraph(graph, resolveGraph));
    },
  });

  bb.agents.registerTool({
    name: "graph_studio_run",
    /**
     * The description is the only thing the calling model reads, so it says
     * the part that decides whether the run is any good: `input` is all the
     * graph will ever know. Its workers are fresh threads — they do not see
     * this conversation, its attachments or what was decided in it, and the
     * nodes after the first see only what the first one wrote. Everything has
     * to pass through here.
     */
    description:
      "Start a Graph Studio run: executes a stored graph whose nodes spawn BB threads (member nodes use a Crew member's existing thread instead). Supports cycles, conditional routing and human approval nodes.\n\nIMPORTANT: `input` is the only context the run gets. Its workers are fresh threads with no sight of this conversation, its attachments, or anything decided in it — and every node after the first reads only what the first one produced. So do not pass the user's last sentence: write out what the run needs to know. State the task, the constraints agreed here, what was already ruled out and why, and the paths of any files that matter (attachments included — quote what is relevant, workers cannot open them). Up to 8000 characters, and using them is usually right.",
    parameters: z.object({
      graphId: z.string(),
      input: z.string().min(1).max(8000),
    }),
    // The thread and project come from the call's own context. They used to be
    // a parameter, which asked the model for its own thread id: get it wrong
    // or leave it out and the run failed on "a run needs a parent thread" —
    // after the model had already written the input.
    execute: async ({ graphId, input }, ctx) => {
      const startedId = await startRun({
        graphId,
        input,
        threadId: ctx.threadId,
        projectId: ctx.projectId,
      });
      // The directive renders the run live in the reply — its status, the
      // question it waits on and an answer box — and keeps the final picture
      // in the conversation afterwards.
      return `Run ${startedId} started.\n\nPut this line into your reply exactly once, on its own line and outside any code block, so the user can watch the run in the chat. Do not repeat it in later replies, also not when the run's status changes: the run stays visible above the composer.\n::graph-run{run="${startedId}"}`;
    },
  });

  /*
    Writing graphs from the chat. The studio is for reviewing and adjusting;
    authoring is meant to happen in natural language — "/graph-studio build me
    a flow that …" — with the agent reading a similar graph, writing the JSON,
    and saving it through here. The validator's findings come back in the
    result, so the agent fixes its own mistakes before the user sees them.
  */
  bb.agents.registerTool({
    name: "graph_studio_get",
    description:
      "Return one Graph Studio graph as JSON (the same format graph_studio_save accepts). Read a similar graph or template first when writing a new one, and read the current graph before changing it — save replaces the whole graph.",
    parameters: z.object({ graphId: z.string() }),
    execute: async ({ graphId }) => {
      const graph = resolveGraph(graphId);
      if (!graph) {
        return `No graph "${graphId}". Available:\n${describeLibrary(libraryGraphs())}`;
      }
      return toGraphFile(graph);
    },
  });

  bb.agents.registerTool({
    name: "graph_studio_save",
    description: [
      "Create or replace a Graph Studio graph from JSON, then report the validator's findings. Fix every error and save again before telling the user it is done.",
      "",
      "Shape (defaults may be left out): { id: lowercase-kebab, name, description, example: a real task in the user's words, nodes: [...], edges: [...] }.",
      "Node: { id, label, kind: agent | dialog | human | note | subgraph | member, prompt, skills: [skill ids], fields: [{ name, type: string|number|boolean|enum|list, options?: [..] }], maxVisits, maxAttempts, onError: stop|route, routing: first|every, providerId + model (both or neither; leave out to inherit the thread's model), graphId (subgraph only: the graph it imports), member (member only: 'member@crew') }.",
      "kind member: the step goes to a persistent member of a crew (plugin Crew) instead of a fresh thread — same prompt, fields and routing as an agent node, but no providerId/model/skills (the crew file sets those). Saving is refused when Crew is not installed or the member is unknown in this project; the template owner-check-loop shows the shape.",
      "Prompts read {{input}} (the run's task) and {{node_id}} (an earlier node's result).",
      "Edge: { from, to, when?: { source: output|field, key, op: contains|notContains|equals|matches|visitsBelow|failed|succeeded|always, value }, fanOutOver?: 'node.listField', handoffFrom?: 'node.field' }. Start is \"__start__\", End is \"__end__\". An edge back to an earlier node makes a cycle; give the looping node a maxVisits.",
      "Shipped templates cannot be overwritten — save under a new id. Set overwrite: true to replace an existing graph of the user's.",
    ].join("\n"),
    parameters: z.object({
      json: z.string().min(2).max(200_000),
      overwrite: z.boolean().optional(),
    }),
    execute: async ({ json, overwrite }, ctx) => {
      let graph: Graph;
      try {
        graph = fromGraphFile(json);
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
      if (TEMPLATES.some((entry) => entry.id === graph.id)) {
        return `"${graph.id}" is a shipped template. Save it under a different id.`;
      }
      try {
        await assertMembersReachable(graph, ctx.projectId ?? null);
      } catch (cause) {
        return `Not saved. ${cause instanceof Error ? cause.message : String(cause)}`;
      }
      const existing = store.getGraph(graph.id);
      if (existing && !overwrite) {
        return `A graph "${graph.id}" already exists. Read it with graph_studio_get, then save with overwrite: true — or choose another id.`;
      }
      // Positions the author dragged in the studio survive an agent's edit
      // unless the new JSON brings its own.
      if (existing && Object.keys(graph.positions).length === 0) {
        graph = {
          ...graph,
          positions: Object.fromEntries(
            Object.entries(existing.positions ?? {}).filter(
              ([id]) => id === START_NODE || id === END_NODE || graph.nodes.some((node) => node.id === id),
            ),
          ),
        };
      }
      const saved = store.saveGraph(graph, Date.now());
      publish();
      const problems = validateGraph(saved, resolveGraph);
      const errors = problems.filter((problem) => problem.level === "error");
      return [
        `${existing ? "Replaced" : "Saved"} ${saved.id} (${saved.nodes.length} nodes, ${saved.edges.length} edges).`,
        errors.length > 0
          ? `Not runnable yet — ${errors.length} error(s):\n${errors.map((problem) => `- ${problem.message}`).join("\n")}`
          : "Runnable.",
        ...problems
          .filter((problem) => problem.level === "warning")
          .map((problem) => `- warning: ${problem.message}`),
        "",
        "The user can review it in Graph Studio (panel → Edit), or run it with graph_studio_run.",
      ].join("\n");
    },
  });

  // "#" in the composer lists the graphs; a picked one reaches the agent as
  // its description, so "#review-flow run it on the auth change" needs no id.
  bb.ui.registerMentionProvider({
    id: "graphs",
    label: "Graph Studio",
    triggers: ["#"],
    search: ({ query }) =>
      searchGraphs(libraryGraphs(), query)
        .slice(0, 12)
        .map((graph) => ({
          id: graph.id,
          title: graph.name,
          subtitle: graph.example || `${graph.nodes.length} nodes`,
          // Registered by the app bundle (components/graph-studio-icon.tsx);
          // the host falls back to the branding icon when it is not loaded.
          icon: GRAPH_STUDIO_ICON,
        })),
    resolve: (itemId) => {
      const graph = resolveGraph(itemId);
      if (!graph) throw new Error(`Graph Studio has no graph "${itemId}".`);
      return {
        context: [
          `The user refers to the Graph Studio graph "${graph.id}".`,
          describeGraph(graph, validateGraph(graph, resolveGraph)),
          "Use graph_studio_run to run it, graph_studio_get and graph_studio_save to change it.",
        ].join("\n\n"),
      };
    },
  });

  // The chat's way to answer an approval the run posted into it. Without a
  // tool the agent would have to know the CLI, and a guessed command is how
  // an answer ends up nowhere.
  bb.agents.registerTool({
    name: "graph_studio_answer",
    description:
      "Answer a Graph Studio run that is waiting at a human approval node, and let it continue. Use it only with what the user decided — never approve or answer on your own. Pass the runId and nodeId from the approval message and the user's answer in their own words. If the approval was already answered elsewhere, the tool says so; tell the user instead of retrying.",
    parameters: z.object({
      runId: z.string(),
      nodeId: z.string().optional(),
      answer: z.string().min(1).max(4000),
    }),
    execute: async ({ runId, nodeId, answer }, ctx) => {
      const row = store.getRun(runId);
      if (!row) return `No run ${runId}.`;
      try {
        answerHuman(runId, answer, {
          source: answerSource(ctx.threadId, row.threadId),
          nodeId,
        });
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
      return `Answer taken; run ${runId} continues.`;
    },
  });

  bb.agents.registerTool({
    name: "graph_studio_status",
    description: "Read the state of a Graph Studio run, including per-node results.",
    parameters: z.object({ runId: z.string() }),
    execute: async ({ runId }) => {
      const dto = toDto(runId);
      if (!dto) return `No run ${runId}.`;
      const nodes = dto.nodeRuns
        .map((node) => `${node.nodeId}: ${node.status}`)
        .join(", ");
      return `${dto.id} is ${dto.status}. Nodes: ${nodes || "none yet"}.${
        dto.pendingQuestion ? ` Waiting for: ${dto.pendingQuestion.question}` : ""
      }`;
    },
  });

  // An open panel fetches the library once on mount and then only on a
  // realtime event. A reload changes the shipped templates under it without
  // producing one, so the panel keeps showing the previous list until it is
  // reopened — which looks exactly like the new template failing to load.
  // One publish on load closes that gap.
  publish();

  // A plugin reload leaves runs marked `running` with nobody driving them.
  // The checkpointer holds their position, so they can simply be resumed.
  // Runs marked `stopping` are the other case: their stop was requested but
  // not finished when the plugin went down. A reload is not a change of mind
  // — the wish is honoured by settling them as `stopped` and interrupting
  // whatever of their workers survived the reload. The checkpoint stays, so
  // `rerunFrom` remains possible afterwards.
  bb.background.service("resume-orphans", {
    // Sweeps once on load, then every heartbeat until the host aborts. The
    // repeat is what lets a run whose claim is still held by a dying driver
    // — a reload's predecessor, a crashed process — be taken over once that
    // claim is released or expires, instead of staying `running` forever.
    // A service that returns early is reported as stopped, so the wait is
    // also what keeps the plugin's status honest.
    start(signal: AbortSignal) {
      const sweep = () => {
        if (disposed || signal.aborted) return;
        for (const row of store.listRunsByStatus("stopping")) {
          if (!store.claimRun(row.id, driverId, Date.now(), CLAIM_EXPIRY_MS)) continue;
          if (driving.has(row.id)) continue;
          bb.log.info(`Settling stopped run ${row.id} after reload.`);
          store.updateRun(
            row.id,
            { status: "stopped", state: row.state, error: row.error },
            Date.now(),
          );
          store.releaseRun(row.id, driverId);
          publish();
          void interruptWorkers(row.id).then(() =>
            farewellWorkers(row.id, "stopped", row.error),
          );
        }
        for (const row of store.listRunsByStatus("running")) {
          if (driving.has(row.id)) continue;
          void drive(row.id, undefined, undefined, `Resuming run ${row.id} after reload.`);
        }
      };
      sweep();
      const timer = setInterval(sweep, CLAIM_HEARTBEAT_MS);
      (timer as { unref?: () => void }).unref?.();
      return new Promise<void>((resolve) => {
        const done = () => {
          clearInterval(timer);
          resolve();
        };
        if (signal.aborted) return done();
        signal.addEventListener("abort", done, { once: true });
      });
    },
  });

  // On reload or disable the old instance's promises live on. Left alone,
  // they keep walking their runs next to the successor — the double resume
  // of BBP-16. Give every claim back now, so the successor's sweep takes the
  // runs over at once instead of after the expiry.
  bb.onDispose(() => {
    disposed = true;
    for (const timer of watchers.values()) clearInterval(timer);
    watchers.clear();
    for (const runId of [...driving.keys()]) {
      abandon(runId, "the plugin is reloading");
      unclaim(runId);
    }
  });
}

export { START_NODE, END_NODE };
export type { Graph };

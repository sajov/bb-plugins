// One service behind the CLI and the RPC, so `bb crew apply` and the panel
// can never behave differently. Pure over its dependencies.
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createActivityTracker, type ActivityView } from "./activity";
import { limitLine, plannedThreads, readLimit } from "./capacity";
import { createChannel } from "./channel";
import { createContract } from "./contract";
import { createLifecycle } from "./lifecycle";
import { createDelivery, type Sender } from "./delivery";
import { createDependencies, type TasksPort } from "./dependencies";
import { buildDirectory, formatDirectory } from "./directory";
import { type GraphsRpc, runToCompletion, type RunOutcome, type RunToCompletionOptions } from "./graphs";
import { createIntegration, createLocalGit, type GitBackend, type RemoteGitFactory } from "./integration";
import { createJournal } from "./journal";
import { createCrewModels } from "./policy";
import { createQueue } from "./queue";
import { serializeCrew, validateCrew, type Catalog, type GraphsCatalog, type Problem, type SkillsCatalog, type Validation } from "./spec";
import type { CrewRow, MessageFilter, MessageRow, Store } from "./store";
import {
  apply,
  describeMembers,
  plan,
  stop,
  type ApplyOutcome,
  type MemberView,
  type PlanItem,
  type StopResult,
  type SyncContext,
} from "./sync";
import { findTemplate, TEMPLATES } from "./templates";
import type { ThreadPort } from "./thread-port";

export type DeleteThreadsMode = "archive" | "delete" | "keep";
export const DELETE_THREADS_MODES: readonly DeleteThreadsMode[] = ["archive", "delete", "keep"];
/** The keys `spawn`, `attach` and `reset` write into a member thread's plugin metadata. */
export const CREW_METADATA_KEYS = ["crew", "crewId", "member", "address", "shift", "opId", "lead", "retired"] as const;

export type DeleteThreadResult = {
  key: string;
  threadId: string;
  shift: number;
  retired: boolean;
  outcome: "archived" | "already-archived" | "deleted" | "kept" | "missing" | "failed";
  /** Sub-threads deleted before this one (`--threads delete`). */
  children: number;
  error: string | null;
};
export type DeleteResult = { crew: string; threads: DeleteThreadResult[]; rows: Record<string, number>; warnings: string[] };

/** `bb crew delete` said no; `blockers` name what a `--force` would override (empty = not overridable). */
export class DeleteRefused extends Error {
  constructor(
    message: string,
    readonly blockers: string[] = [],
  ) {
    super(message);
  }
}

export type CrewFileSource = { yaml: string; source: "file" | "stored" | "template"; label: string };

export type ServiceDeps = {
  store: Store;
  port: ThreadPort;
  /** Provider catalogue for the unknown-model warning; null skips the check. */
  catalog?: () => Promise<Catalog | null>;
  /** Known skill names (global, project, BB global) for the unknown-skill warning; null skips the check. */
  skills?: (projectId: string) => Promise<SkillsCatalog | null>;
  /** Graph Studio's RPC bridge (BBP-30) for the unknown-graph warning and crew_graph_run; null disables both. */
  graphsRpc?: GraphsRpc | null;
  readText?: (path: string) => Promise<string>;
  newId?: () => string;
  newMessageId?: (prefix: "msg" | "ch") => string;
  now?: () => number;
  /** A member's activity view changed. */
  onActivity?: (view: ActivityView) => void;
  /** Messages were written (any sender: CLI, RPC or an agent tool). */
  onMessages?: () => void;
  /** Merges and rebases; default is plain git on this machine. */
  git?: GitBackend;
  /** Git for worktrees on other hosts (BBP-14); defaults to the "not available" stub. */
  remoteGit?: RemoteGitFactory;
  /** The BB Tasks plugin; null = `done`/`comment:` dependencies and labels are not checked. */
  tasks?: TasksPort | null;
  /** BB's thread limit, if it can be read (see lib/capacity.ts). */
  bbLimit?: () => Promise<number | null>;
  /** Ids for work items, channel posts, merge requests, snapshots and handovers. */
  newShortId?: (prefix: "wi" | "cm" | "mr" | "snap" | "ho") => string;
};

export type CrewService = ReturnType<typeof createCrewService>;

export function createCrewService(deps: ServiceDeps) {
  const ctx: SyncContext = {
    store: deps.store,
    port: deps.port,
    journal: createJournal(deps.store, deps.newId),
    // A lead's kickoff brief carries a short directory of the other crews (§3.9.3).
    directoryFor: (projectId: string, crewName: string) => formatDirectory(buildDirectory(deps.store, models, projectId), crewName).join("\n"),
  };
  const readText = deps.readText ?? ((path: string) => readFile(path, "utf8"));
  const catalog = async () => (deps.catalog ? await deps.catalog().catch(() => null) : null);
  const skillsCatalog = async (projectId: string) => (deps.skills ? await deps.skills(projectId).catch(() => null) : null);
  const graphsCatalog = async (): Promise<GraphsCatalog | null> => {
    if (!deps.graphsRpc) return null;
    try {
      const list = await deps.graphsRpc.listGraphs();
      return { names: new Set(list.map((graph) => graph.id)) };
    } catch {
      return null;
    }
  };
  const models = createCrewModels(deps.store);
  const store = deps.store;
  const limit = () => readLimit(store, deps.bbLimit ?? null);
  const delivery = createDelivery({
    store,
    port: deps.port,
    models,
    now: deps.now,
    newId: deps.newMessageId,
    capacity: async () => ({ limit: (await limit()).limit, running: await deps.port.runningCount() }),
  });
  const shortId = deps.newShortId;
  const queue = createQueue({ store, models, delivery, now: deps.now, newId: shortId ? () => shortId("wi") : undefined });
  const channel = createChannel({ store, delivery, newId: shortId ? () => shortId("cm") : undefined });
  const dependencies = createDependencies({ store, models, delivery, tasks: deps.tasks ?? null });
  const integration = createIntegration({
    store,
    port: deps.port,
    models,
    delivery,
    git: deps.git ?? createLocalGit(),
    remote: deps.remoteGit,
    newId: shortId ? () => shortId("mr") : undefined,
    onMerged: async () => {
      await dependencies.poll({ onlyMerged: true });
    },
  });
  const activity = createActivityTracker({
    store,
    port: deps.port,
    onChange: deps.onActivity,
    now: deps.now,
    graphsRpc: deps.graphsRpc,
    extras: (crew, member) => {
      const open = member.lead ? integration.awaitingHuman(crew.id)[0] : undefined;
      return {
        mergeRequest: open
          ? `Merge request ${open.id} (${open.state}): ${open.branch} → ${open.base}${open.reason ? ` — ${open.reason}` : ""}. bb crew approve ${open.id} | bb crew reject ${open.id}`
          : null,
        escalated: queue.escalatedToHuman(member).length,
      };
    },
  });

  const contract = createContract({ store, port: deps.port, delivery, activity, models });

  /** Write rows, hand them to delivery, tell the server. */
  async function flush(): Promise<void> {
    await delivery.drain().catch(() => 0);
    deps.onMessages?.();
  }

  /** Non-waking note to the leads of the other running crews: the directory changed (§3.9.3). */
  function directoryChanged(crew: CrewRow, what: string): void {
    for (const other of store.listCrews(crew.projectId)) {
      if (other.id === crew.id || (other.status !== "running" && other.status !== "degraded")) continue;
      const lead = store.listMembers(other.id).find((member) => member.lead);
      if (!lead) continue;
      delivery.send({
        projectId: crew.projectId,
        from: { kind: "system" },
        to: lead.address,
        kind: "system",
        subject: `Directory: crew ${crew.name} ${what}`,
        body: `Crew ${crew.name} ${what}. crew_directory lists all crews of the project.`,
        crew: other.name,
      });
    }
  }

  /** Warnings that depend on the project, not on the file alone (§3.9, §3.9.5). */
  async function projectProblems(projectId: string, validation: Validation): Promise<{ problems: Problem[]; limit: string }> {
    const problems: Problem[] = [];
    const spec = validation.spec;
    if (!spec) return { problems, limit: "" };
    const line = limitLine(plannedThreads(store, projectId, spec.name, validation.members.length), await limit());
    if (line.over) problems.push({ level: "warning", code: "thread-limit", message: line.text });
    if (spec.environment.type === "reuse") {
      const shared = store
        .listCrews(projectId)
        .filter((crew) => crew.name !== spec.name && crew.status !== "stopped" && models(crew).spec?.environment.type === "reuse");
      if (shared.length > 0) {
        problems.push({
          level: "warning",
          code: "shared-environment",
          message: `environment: reuse — crews ${shared.map((crew) => crew.name).join(", ")} write the same environment too; give each crew its own worktree`,
        });
      }
    }
    return { problems, limit: line.text };
  }

  /** BB picks worktree branch names, so apply reads each member's branch back and keeps it. */
  async function recordEnvironments(crew: CrewRow): Promise<void> {
    for (const member of store.listMembers(crew.id)) await integration.locate(member, true).catch(() => null);
  }

  /** Messages matching the filter, newest last. */
  function log(projectId: string, filter: Omit<MessageFilter, "projectId"> & { crew?: string } = {}): MessageRow[] {
    const crew = filter.crew ? deps.store.findCrew(projectId, filter.crew) : null;
    if (filter.crew && !crew) throw new Error(`No crew "${filter.crew}" in this project.`);
    return deps.store.listMessages({ ...filter, projectId, crewId: crew?.id ?? filter.crewId });
  }

  async function validate(projectId: string, yaml: string, confirmFull = false): Promise<Validation> {
    return validateCrew(yaml, { catalog: await catalog(), skills: await skillsCatalog(projectId), graphs: await graphsCatalog(), confirmFull });
  }

  const service = {
    ctx,
    models,
    contract,
    delivery,
    activity,
    queue,
    channel,
    integration,
    dependencies,
    flush,
    log,
    limit,
    directory: (projectId: string) => buildDirectory(store, models, projectId),
    graphs: {
      /**
       * Run a graph-studio graph to completion for crew_graph_run (BBP-30),
       * recording it in `graph_runs` as it starts and as its status changes
       * (BBP-31), linked to the member and crew that started it. Rejects when
       * no graphsRpc is configured.
       */
      run(
        args: { graphId: string; input: string; threadId: string; projectId: string | null; crewId: string; memberId: string },
        options: RunToCompletionOptions = {},
      ): Promise<RunOutcome> {
        if (!deps.graphsRpc) return Promise.reject(new Error("graph-studio is not available here."));
        return runToCompletion(deps.graphsRpc, args, {
          ...options,
          onStart: (run) => {
            store.insertGraphRun({ runId: run.id, crewId: args.crewId, memberId: args.memberId, graphId: args.graphId, status: run.status });
            options.onStart?.(run);
          },
          onPoll: (run) => {
            store.updateGraphRunStatus(run.id, run.status);
            options.onPoll?.(run);
          },
        });
      },
      /** bb crew stop: cancel every open run of this crew via graph-studio's stopRun. Best-effort. */
      async cancelOpen(crewId: string): Promise<number> {
        if (!deps.graphsRpc) return 0;
        let cancelled = 0;
        for (const row of store.listOpenGraphRunsForCrew(crewId)) {
          try {
            await deps.graphsRpc.stopRun(row.runId);
            cancelled += 1;
          } catch {
            // best-effort: the run may already be gone or graph-studio unreachable.
          }
          store.updateGraphRunStatus(row.runId, "stopped");
        }
        return cancelled;
      },
      /** bb crew delete --threads delete: every worker thread any run of this crew ever spawned. BB does not delete these on its own (they are not parented under the member's thread). */
      async workerThreadIds(crewId: string): Promise<string[]> {
        if (!deps.graphsRpc) return [];
        const ids: string[] = [];
        for (const row of store.listGraphRunsForCrew(crewId)) {
          try {
            const run = await deps.graphsRpc.getRun(row.runId);
            if (run) ids.push(...run.childThreadIds);
          } catch {
            // best-effort: skip runs graph-studio can no longer report on.
          }
        }
        return ids;
      },
    },
    /** One follow-up sweep (schedule: every minute). */
    async followUps() {
      const fired = await queue.followUps();
      if (fired.length > 0) await flush();
      return fired;
    },
    /** One dependency poll (schedule: every minute). */
    async pollDependencies() {
      const count = await dependencies.poll();
      if (count > 0) await flush();
      return count;
    },
    /** Send and hand the new rows to delivery straight away. */
    async send(input: Parameters<typeof delivery.send>[0]): Promise<MessageRow[]> {
      const rows = delivery.send(input);
      await delivery.drain();
      deps.onMessages?.();
      return rows.map((row) => deps.store.getMessage(row.id)!);
    },
    /** The member bound to a thread, verified against the bindings. */
    memberOfThread(threadId: string): Extract<Sender, { kind: "member" }> | null {
      const member = deps.store.memberByThread(threadId);
      const crew = member ? deps.store.getCrew(member.crewId) : null;
      return member && crew ? { kind: "member", member, crew } : null;
    },
    /** Members currently on Needs you, across the project's crews. */
    async needs(projectId: string): Promise<ActivityView[]> {
      return (await activity.refreshAll(projectId)).filter((view) => view.needsYou.length > 0);
    },
    validate,
    templates: () => TEMPLATES,
    listCrews: (projectId: string): CrewRow[] => deps.store.listCrews(projectId),
    findCrew: (projectId: string, name: string) => deps.store.findCrew(projectId, name),

    /**
     * `<crew|file>`: a path that ends in .yaml/.yml (or contains a slash) is a
     * file; otherwise a stored crew of this project; otherwise a template.
     */
    async resolveFile(projectId: string, ref: string, cwd?: string): Promise<CrewFileSource> {
      const looksLikePath = /\.ya?ml$/i.test(ref) || ref.includes("/");
      if (looksLikePath) {
        const path = isAbsolute(ref) ? ref : resolve(cwd ?? process.cwd(), ref);
        return { yaml: await readText(path), source: "file", label: path };
      }
      const crew = deps.store.findCrew(projectId, ref);
      const stored = crew ? deps.store.crewFile(crew.id) : null;
      if (stored) return { yaml: stored.yaml, source: "stored", label: `${ref} v${stored.version}` };
      const template = findTemplate(ref);
      if (template) return { yaml: serializeCrew(template.spec), source: "template", label: `template ${ref}` };
      throw new Error(`No crew, template or file named "${ref}".`);
    },

    async plan(projectId: string, yaml: string, options: { fresh?: string[]; confirmFull?: boolean } = {}) {
      const validation = await validate(projectId, yaml, options.confirmFull);
      const items: PlanItem[] = validation.spec ? await plan(ctx, projectId, validation, options) : [];
      const extra = await projectProblems(projectId, validation);
      const crew = validation.spec ? store.findCrew(projectId, validation.spec.name) : null;
      const behind = crew ? await integration.behind(crew) : null;
      const remote = validation.spec ? await integration.remoteHosts(projectId, crew, validation.members) : [];
      return { validation: { ...validation, problems: [...validation.problems, ...extra.problems] }, items, limit: extra.limit, behind, remote };
    },

    async apply(
      projectId: string,
      yaml: string,
      options: { fresh?: string[]; confirmFull?: boolean } = {},
    ): Promise<ApplyOutcome & { validation: Validation; limit: string; remote: string[] }> {
      const validation = await validate(projectId, yaml, options.confirmFull);
      const before = validation.spec ? store.findCrew(projectId, validation.spec.name)?.status ?? null : null;
      const outcome = await apply(ctx, { projectId, yaml, validation, fresh: options.fresh });
      await recordEnvironments(outcome.crew);
      dependencies.sync(outcome.crew);
      if (before !== "running" && outcome.crew.status !== "stopped") directoryChanged(outcome.crew, "started");
      const extra = await projectProblems(projectId, validation);
      // Messages held while the crew was stopped can go now.
      await flush();
      const remote = await integration.remoteHosts(projectId, outcome.crew, validation.members);
      return { ...outcome, validation: { ...validation, problems: [...validation.problems, ...extra.problems] }, limit: extra.limit, remote };
    },

    async stop(crew: CrewRow, options: { archive?: boolean } = {}): Promise<StopResult[]> {
      const results = await stop(ctx, crew, options);
      await service.graphs.cancelOpen(crew.id).catch(() => 0);
      directoryChanged(crew, options.archive ? "stopped and archived" : "stopped");
      await flush();
      return results;
    },

    /** What keeps a crew from being deleted without `--force`: other crews waiting for its task, its open merge requests. */
    deleteBlockers(crew: CrewRow): string[] {
      const blockers: string[] = [];
      const task = models(crew).spec?.task ?? null;
      if (task) {
        for (const other of store.listCrews(crew.projectId)) {
          if (other.id === crew.id) continue;
          for (const dependency of store.listDependencies(other.id)) {
            if (dependency.state === "open" && dependency.taskKey === task) {
              blockers.push(`crew ${other.name} waits for ${task} until ${dependency.until}`);
            }
          }
        }
      }
      for (const merge of store.listMerges({ crewId: crew.id, states: ["open", "returned"] })) {
        blockers.push(`merge request ${merge.id} (${merge.state}): ${merge.branch} → ${merge.base}`);
      }
      return blockers;
    },

    /**
     * Remove a stopped crew: its threads as `threads` says, then every row of
     * it in one transaction. Thread work comes first and is idempotent (a
     * missing thread is fine), so a failure there leaves the rows in place
     * and the delete can simply be run again.
     */
    async delete(crew: CrewRow, options: { threads?: DeleteThreadsMode; force?: boolean } = {}): Promise<DeleteResult> {
      const mode = options.threads ?? "archive";
      if (crew.status !== "stopped") {
        throw new DeleteRefused(`Crew ${crew.name} is ${crew.status}; run \`bb crew stop ${crew.name}\` first.`);
      }
      const warnings: string[] = [];
      const blockers = service.deleteBlockers(crew);
      if (blockers.length > 0 && !options.force) {
        throw new DeleteRefused(`Crew ${crew.name} is still needed:\n${blockers.map((line) => `- ${line}`).join("\n")}\nPass --force to delete it anyway.`, blockers);
      }
      for (const line of blockers) warnings.push(`forced past: ${line}`);

      // Lead last: the other members' threads are its children.
      const bound = [...store.crewThreads(crew.id)].sort((a, b) => Number(a.lead) - Number(b.lead));
      const done = new Set<string>();
      const results: DeleteThreadResult[] = [];
      /** Depth-first, so BB never deletes a parent whose children would be orphaned. */
      async function deleteTree(threadId: string): Promise<number> {
        let count = 0;
        for (const child of await deps.port.children(threadId)) {
          if (done.has(child)) continue;
          count += (await deleteTree(child)) + 1;
        }
        await deps.port.delete(threadId);
        done.add(threadId);
        return count;
      }
      for (const entry of bound) {
        if (done.has(entry.threadId)) continue;
        const result: DeleteThreadResult = { key: entry.key, threadId: entry.threadId, shift: entry.shift, retired: entry.retired, outcome: "missing", children: 0, error: null };
        results.push(result);
        try {
          const thread = await deps.port.get(entry.threadId);
          if (!thread) {
            done.add(entry.threadId);
            continue;
          }
          if (mode === "archive") {
            if (thread.archived) result.outcome = "already-archived";
            else {
              await deps.port.archive(entry.threadId);
              result.outcome = "archived";
            }
          } else if (mode === "delete") {
            result.children = await deleteTree(entry.threadId);
            result.outcome = "deleted";
          } else {
            await deps.port.setMetadata(entry.threadId, {}, [...CREW_METADATA_KEYS]);
            result.outcome = "kept";
          }
          done.add(entry.threadId);
        } catch (error) {
          result.outcome = "failed";
          result.error = error instanceof Error ? error.message : String(error);
        }
      }
      const failed = results.filter((result) => result.outcome === "failed");
      if (failed.length > 0) {
        throw new DeleteRefused(
          `Crew ${crew.name} was not deleted: ${failed.length} thread(s) failed (${failed.map((result) => `${result.threadId}: ${result.error}`).join("; ")}). Nothing was removed from the database; run the delete again.`,
        );
      }
      // BBP-31: graph run worker threads are graph-studio's own threads, not
      // BB children of the member's thread, so `deleteTree` above never finds
      // them — look them up and delete them explicitly.
      if (mode === "delete") {
        const workerThreads = await service.graphs.workerThreadIds(crew.id).catch(() => []);
        let deletedWorkers = 0;
        for (const threadId of workerThreads) {
          if (done.has(threadId)) continue;
          done.add(threadId);
          try {
            await deps.port.delete(threadId);
            deletedWorkers += 1;
          } catch (error) {
            warnings.push(`graph run worker thread ${threadId} was not deleted: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (deletedWorkers > 0) warnings.push(`deleted ${deletedWorkers} graph run worker thread(s)`);
      }
      const rows = store.deleteCrewRows(crew.id);
      directoryChanged(crew, "was deleted");
      await flush();
      return { crew: crew.name, threads: results, rows, warnings };
    },

    async members(crew: CrewRow): Promise<MemberView[]> {
      return describeMembers(ctx, crew);
    },

    /** Store a crew file without applying it. Invalid files are refused. */
    async save(projectId: string, yaml: string) {
      const validation = await validate(projectId, yaml, true);
      if (!validation.spec || validation.problems.some((problem) => problem.level === "error" && problem.code !== "full-unconfirmed")) {
        return { crew: null, validation };
      }
      const { crew } = deps.store.saveCrewFile(projectId, validation.spec.name, yaml);
      return { crew, validation };
    },
  };
  const lifecycle = createLifecycle({
    ctx,
    models,
    delivery,
    queue,
    apply: (projectId, yaml, options) => service.apply(projectId, yaml, options),
    plan: (projectId, yaml) => service.plan(projectId, yaml),
    validate,
    newId: shortId ? (prefix) => shortId(prefix) : undefined,
  });
  return { ...service, lifecycle };
}

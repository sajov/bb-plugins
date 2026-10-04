// Dependencies between crews (§3.9.2): `waitsFor: [{ task, until }]`.
//
// BB Tasks has no dependencies and no server-side change feed, so the plugin
// keeps them in `crew_dependencies` and polls once a minute — only for open
// rows. `merged` is answered from the plugin's own merge requests (no RPC),
// `done` from the task status, `comment:<keyword>` from the task comments.
//
// Exactly one waking message per fulfilment: `satisfyDependency` flips the
// row with `WHERE state = 'open'`, and only the call that flipped it sends.
//
// Tasks RPC (verified in the built-in tasks plugin, bb-app
// server/dist/builtin-plugins/tasks/dist/server.js): `getTaskByKey({taskKey})
// → {task|null}` with `id, projectId, status, labelIds`; `listComments({taskId})
// → {comments:[{body}]}`; `listLabels({projectId}) → {labels}`;
// `createLabel({projectId, name, color}) → {label}`; `updateTask({taskId,
// labelIds})`. Labels belong to a tracker project and must exist before they
// can be set, so the label is created on first use. If any of that fails the
// label is skipped and the reason stored — the dependency itself still works.
import type { Delivery } from "./delivery";
import type { CrewModels } from "./policy";
import type { CrewRow, DependencyRow, MemberRow, Store } from "./store";

export type TaskInfo = { id: string; projectId: string; status: string; labelIds: string[] };

export type LabelledTask = { key: string; title: string; status: string };

export interface TasksPort {
  getTask(key: string): Promise<TaskInfo | null>;
  comments(taskId: string): Promise<string[]>;
  /** Id of the label with this name in the tracker project, created when missing. */
  ensureLabel(projectId: string, name: string): Promise<string>;
  setLabels(taskId: string, labelIds: string[]): Promise<void>;
  /** Tasks of the tracker project carrying this label by name (BBP-84); empty when the label doesn't exist. */
  listByLabel(projectId: string, labelName: string): Promise<LabelledTask[]>;
}

export const labelFor = (taskKey: string) => `wartet-auf:${taskKey}`;

export type DependenciesDeps = { store: Store; models: CrewModels; delivery: Delivery; tasks: TasksPort | null };
export type Dependencies = ReturnType<typeof createDependencies>;

export function createDependencies(deps: DependenciesDeps) {
  const { store, models, delivery } = deps;

  function lead(crew: CrewRow): MemberRow | null {
    return store.listMembers(crew.id).find((member) => member.lead) ?? null;
  }

  /** Crews of the project whose crew file names this task. */
  function crewsWithTask(projectId: string, taskKey: string): CrewRow[] {
    return store.listCrews(projectId).filter((crew) => models(crew).spec?.task === taskKey);
  }

  async function fulfilled(crew: CrewRow, dependency: DependencyRow): Promise<string | null> {
    if (dependency.until === "merged") {
      const sources = crewsWithTask(crew.projectId, dependency.taskKey).filter((source) => source.id !== crew.id);
      for (const source of sources) {
        const merged = store.listMerges({ crewId: source.id, states: ["merged"] }).at(-1);
        if (merged) return `crew ${source.name} merged ${merged.branch} into ${merged.base} (commit ${merged.commitSha?.slice(0, 10)})`;
      }
      return null;
    }
    if (!deps.tasks) return null;
    const task = await deps.tasks.getTask(dependency.taskKey);
    if (!task) return null;
    if (dependency.until === "done") return task.status === "done" ? `task ${dependency.taskKey} is done` : null;
    const keyword = dependency.until.slice("comment:".length).trim().toLowerCase();
    const comments = await deps.tasks.comments(task.id);
    return comments.some((body) => body.toLowerCase().includes(keyword)) ? `a comment on ${dependency.taskKey} says "${keyword}"` : null;
  }

  /** `wartet-auf:<KEY>` on the waiting crew's own task, once; failures are stored, not retried every minute. */
  async function label(crew: CrewRow, dependency: DependencyRow): Promise<void> {
    if (dependency.labelState !== null || !deps.tasks) return;
    const own = models(crew).spec?.task;
    if (!own) {
      store.setDependencyLabel(crew.id, dependency.taskKey, dependency.until, "skipped", "the waiting crew has no task");
      return;
    }
    try {
      const task = await deps.tasks.getTask(own);
      if (!task) throw new Error(`task ${own} not found`);
      const labelId = await deps.tasks.ensureLabel(task.projectId, labelFor(dependency.taskKey));
      if (!task.labelIds.includes(labelId)) await deps.tasks.setLabels(task.id, [...task.labelIds, labelId]);
      store.setDependencyLabel(crew.id, dependency.taskKey, dependency.until, "set", null);
    } catch (error) {
      store.setDependencyLabel(crew.id, dependency.taskKey, dependency.until, "skipped", `label not set: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
    }
  }

  async function checkOne(crew: CrewRow, dependency: DependencyRow): Promise<boolean> {
    await label(crew, dependency);
    const why = await fulfilled(crew, dependency).catch(() => null);
    if (!why) return false;
    if (!store.satisfyDependency(crew.id, dependency.taskKey, dependency.until, why)) return false;
    const crewLead = lead(crew);
    if (!crewLead) return true;
    const base = models(crew).spec?.baseBranch ?? "main";
    delivery.send({
      projectId: crew.projectId,
      from: { kind: "system" },
      to: crewLead.address,
      subject: `Dependency fulfilled: ${dependency.taskKey} ${dependency.until}`,
      body: [
        `Your crew waited for ${dependency.taskKey} until ${dependency.until}: ${why}.`,
        dependency.until === "merged"
          ? `Rebase your crew branch onto ${base} now: call crew_rebase (or have the branch owner do it), then carry on.`
          : "Carry on with the work that waited for it.",
      ].join("\n"),
      crew: crew.name,
    });
    return true;
  }

  return {
    /** Mirror the crew file's waitsFor into the table (on apply). */
    sync(crew: CrewRow): DependencyRow[] {
      return store.syncDependencies(crew.id, models(crew).spec?.waitsFor ?? []);
    },
    /** One poll over the open dependencies of running crews; returns how many were fulfilled. */
    async poll(filter: { projectId?: string; onlyMerged?: boolean } = {}): Promise<number> {
      let count = 0;
      for (const crew of store.listCrews(filter.projectId)) {
        if (crew.status !== "running" && crew.status !== "degraded") continue;
        for (const dependency of store.listDependencies(crew.id)) {
          if (dependency.state !== "open") continue;
          if (filter.onlyMerged && dependency.until !== "merged") continue;
          if (await checkOne(crew, dependency)) count += 1;
        }
      }
      return count;
    },
    open(crewId: string): DependencyRow[] {
      return store.listDependencies(crewId).filter((row) => row.state === "open");
    },
  };
}

/** The tasks plugin over `bb.sdk.plugins.callRpc`. */
export function createTasksRpcPort(callRpc: (method: string, input: unknown) => Promise<unknown>): TasksPort {
  return {
    async getTask(key) {
      const result = (await callRpc("getTaskByKey", { taskKey: key })) as { task: TaskInfo | null };
      return result.task ? { id: result.task.id, projectId: result.task.projectId, status: result.task.status, labelIds: result.task.labelIds ?? [] } : null;
    },
    async comments(taskId) {
      const result = (await callRpc("listComments", { taskId })) as { comments: { body: string }[] };
      return result.comments.map((comment) => comment.body);
    },
    async ensureLabel(projectId, name) {
      const listed = (await callRpc("listLabels", { projectId })) as { labels?: { id: string; name: string }[] };
      const found = (listed.labels ?? []).find((entry) => entry.name === name);
      if (found) return found.id;
      const created = (await callRpc("createLabel", { projectId, name, color: "yellow" })) as { label: { id: string } };
      return created.label.id;
    },
    async setLabels(taskId, labelIds) {
      await callRpc("updateTask", { taskId, labelIds });
    },
    async listByLabel(projectId, labelName) {
      const listed = (await callRpc("listLabels", { projectId })) as { labels?: { id: string; name: string }[] };
      const label = (listed.labels ?? []).find((entry) => entry.name === labelName);
      if (!label) return [];
      const result = (await callRpc("listTasks", { projectId, labelIds: [label.id], limit: 500 })) as {
        tasks: { key: string; title: string; status: string }[];
      };
      return result.tasks.map((task) => ({ key: task.key, title: task.title, status: task.status }));
    },
  };
}

/** Test double for the tasks plugin. */
export function createFakeTasks() {
  const tasks = new Map<string, TaskInfo & { title?: string; comments: string[] }>();
  const labels = new Map<string, string>();
  const calls: string[] = [];
  const port: TasksPort & { tasks: typeof tasks; labels: typeof labels; calls: string[]; failLabels: boolean } = {
    tasks,
    labels,
    calls,
    failLabels: false,
    async getTask(key) {
      calls.push(`getTask ${key}`);
      const task = tasks.get(key);
      return task ? { id: task.id, projectId: task.projectId, status: task.status, labelIds: [...task.labelIds] } : null;
    },
    async comments(taskId) {
      calls.push(`comments ${taskId}`);
      return [...tasks.values()].find((task) => task.id === taskId)?.comments ?? [];
    },
    async ensureLabel(projectId, name) {
      calls.push(`ensureLabel ${name}`);
      if (port.failLabels) throw new Error("labels unavailable");
      const key = `${projectId}:${name}`;
      if (!labels.has(key)) labels.set(key, `lbl_${labels.size + 1}`);
      return labels.get(key)!;
    },
    async setLabels(taskId, labelIds) {
      calls.push(`setLabels ${taskId}`);
      const task = [...tasks.values()].find((entry) => entry.id === taskId);
      if (task) task.labelIds = [...labelIds];
    },
    async listByLabel(projectId, labelName) {
      calls.push(`listByLabel ${labelName}`);
      const labelId = labels.get(`${projectId}:${labelName}`);
      if (!labelId) return [];
      return [...tasks.entries()]
        .filter(([, task]) => task.projectId === projectId && task.labelIds.includes(labelId))
        .map(([key, task]) => ({ key, title: task.title ?? key, status: task.status }));
    },
  };
  return port;
}

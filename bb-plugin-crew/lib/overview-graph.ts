// Fullscreen overview diagram (BBP-71): pure data shaping, no React, no
// @xyflow/react — so the layout/filter/mapping logic is unit-testable
// without rendering anything. Components under ../components turn this into
// nodes and edges for @xyflow/react, styled to match the reference look —
// an own copy, with no import or runtime dependency on the sibling plugin.
//
// Source data is one `OverviewDto` per project (server.ts's `projectOverview`
// RPC), already the shape the single-project board uses — the fullscreen
// diagram just draws several of them side by side, framed by project, with
// task nodes derived from each crew's own ticket and its open dependencies.

import { DEFAULT_POLICY, effectiveCrossCrew, type CrossCrew } from "./policy";
import { hasErrorReason } from "./topology";

export type OverviewProject = { id: string; name: string };

/** The subset of `OverviewDto` the diagram reads — see server.ts's `overviewSchema`. */
export type OverviewSource = {
  crews: ReadonlyArray<{
    name: string;
    status: string;
    summary: string;
    task: string | null;
    branch: string | null;
    needsYou: number;
    members: ReadonlyArray<{ key: string; lead: boolean; activity: string; needsYou?: readonly string[] }>;
    /** BB tasks carrying the label `crew-<name>` — the source of truth for factory crews, which never set `task` (BBP-84). */
    labelTasks?: ReadonlyArray<{ key: string; title: string; status: string }>;
    /** The crew.yaml's `crossCrew` policy (BBP-97): who may cross-talk, before any traffic exists. Falls back to the spec default, "leads". */
    crossCrew?: CrossCrew;
  }>;
  leadLinks: ReadonlyArray<{ from: string; to: string; count: number }>;
  dependencies: ReadonlyArray<{ crew: string; task: string; until: string; state: string; source: string | null }>;
};

export type CrewNode = {
  kind: "crew";
  id: string;
  projectId: string;
  name: string;
  status: string;
  branch: string | null;
  task: string | null;
  members: ReadonlyArray<{ key: string; lead: boolean; activity: string; needsYou?: readonly string[] }>;
  needsYou: number;
  /** BBP-95: a real failure anywhere in the crew outranks a mere decision — red vs. amber. */
  needsYouSeverity: "error" | "decision" | null;
};

export type TaskNode = {
  kind: "task";
  id: string;
  projectId: string;
  key: string;
  title: string;
  done: boolean;
};

export type OverviewNode = CrewNode | TaskNode;

export type TaskCrewEdge = { kind: "task-crew"; id: string; from: string; to: string; active: boolean };
/** `active` is traffic (`count` > 0, drawn blue/animated); otherwise it is merely an allowed, idle path (grey dashed). */
export type LeadLeadEdge = { kind: "lead-lead"; id: string; from: string; to: string; count: number; active: boolean };
export type OverviewEdge = TaskCrewEdge | LeadLeadEdge;

/** A project's cluster on the top zoom level: how many crews, how many run, how many wait on you. */
export type ProjectSummary = OverviewProject & { crewCount: number; taskCount: number; runningCount: number; needsYouCount: number; errorCount: number };

export type OverviewGraph = {
  projects: ReadonlyArray<ProjectSummary>;
  nodes: OverviewNode[];
  edges: OverviewEdge[];
};

export const crewNodeId = (projectId: string, crewName: string): string => `crew:${projectId}:${crewName}`;
export const taskNodeId = (projectId: string, taskKey: string): string => `task:${projectId}:${taskKey}`;

/** A crew counts as "active" (running work) for the task→crew edge's animation. */
function crewActive(status: string, members: ReadonlyArray<{ activity: string }>): boolean {
  return status === "running" || members.some((member) => member.activity === "working");
}

/** States that mean the dependency/task is settled, not open work. */
const DONE_STATES = new Set(["done", "merged", "satisfied"]);

/** BB task statuses that mean the ticket is settled (§3.9: done or canceled). */
const DONE_TASK_STATUSES = new Set(["done", "canceled"]);

/**
 * Nodes and edges for every project given, pure and order-stable (projects
 * in input order, then crews, then tasks). Call once per fetch; re-call on
 * live updates since nothing here is memoised.
 */
export function buildOverviewGraph(projects: ReadonlyArray<OverviewProject>, overviews: ReadonlyMap<string, OverviewSource>): OverviewGraph {
  const nodes: OverviewNode[] = [];
  const edges: OverviewEdge[] = [];
  const projectSummaries: ProjectSummary[] = [];

  for (const project of projects) {
    const overview = overviews.get(project.id);
    if (!overview) {
      projectSummaries.push({ ...project, crewCount: 0, taskCount: 0, runningCount: 0, needsYouCount: 0, errorCount: 0 });
      continue;
    }
    const taskIds = new Map<string, TaskNode>();
    const ensureTask = (key: string, done: boolean, title?: string): TaskNode => {
      const id = taskNodeId(project.id, key);
      const existing = taskIds.get(id);
      if (existing) {
        if (done) existing.done = true;
        if (title) existing.title = title;
        return existing;
      }
      const node: TaskNode = { kind: "task", id, projectId: project.id, key, title: title ?? key, done };
      taskIds.set(id, node);
      return node;
    };

    for (const crew of overview.crews) {
      const id = crewNodeId(project.id, crew.name);
      nodes.push({
        kind: "crew",
        id,
        projectId: project.id,
        name: crew.name,
        status: crew.status,
        branch: crew.branch,
        task: crew.task,
        members: crew.members,
        needsYou: crew.needsYou,
        needsYouSeverity: hasErrorReason(crew.members.flatMap((member) => member.needsYou ?? [])) ? "error" : crew.needsYou > 0 ? "decision" : null,
      });
      if (crew.task) {
        const task = ensureTask(crew.task, false);
        edges.push({ kind: "task-crew", id: `${task.id}->${id}`, from: task.id, to: id, active: crewActive(crew.status, crew.members) });
      }

      for (const labelTask of crew.labelTasks ?? []) {
        const task = ensureTask(labelTask.key, DONE_TASK_STATUSES.has(labelTask.status), labelTask.title);
        const edgeId = `${task.id}->${id}`;
        if (edges.some((edge) => edge.id === edgeId)) continue;
        edges.push({ kind: "task-crew", id: edgeId, from: task.id, to: id, active: labelTask.status === "in_progress" });
      }
    }

    for (const dependency of overview.dependencies) {
      const crewId = crewNodeId(project.id, dependency.crew);
      if (!nodes.some((node) => node.id === crewId)) continue;
      const done = DONE_STATES.has(dependency.state);
      const task = ensureTask(dependency.task, done);
      const edgeId = `${task.id}->${crewId}:dep`;
      if (!edges.some((edge) => edge.id === edgeId)) {
        edges.push({ kind: "task-crew", id: edgeId, from: task.id, to: crewId, active: dependency.state === "open" });
      }
    }

    for (const task of taskIds.values()) nodes.push(task);

    // BBP-97: a lead↔lead edge exists wherever the crews' `crossCrew` policies allow it (the
    // stricter of the two wins), not only once traffic happens to have occurred. Traffic from
    // `leadLinks` (either direction) turns an allowed-but-idle edge into an active one.
    const traffic = new Map<string, number>();
    for (const link of overview.leadLinks) {
      const key = [link.from, link.to].sort().join("\u0000");
      traffic.set(key, (traffic.get(key) ?? 0) + link.count);
    }
    for (let i = 0; i < overview.crews.length; i++) {
      for (let j = i + 1; j < overview.crews.length; j++) {
        const a = overview.crews[i]!;
        const b = overview.crews[j]!;
        if (effectiveCrossCrew(a.crossCrew ?? DEFAULT_POLICY.crossCrew, b.crossCrew ?? DEFAULT_POLICY.crossCrew) === "none") continue;
        const from = crewNodeId(project.id, a.name);
        const to = crewNodeId(project.id, b.name);
        const count = traffic.get([a.name, b.name].sort().join("\u0000")) ?? 0;
        edges.push({ kind: "lead-lead", id: `${from}<->${to}`, from, to, count, active: count > 0 });
      }
    }

    projectSummaries.push({
      ...project,
      crewCount: overview.crews.length,
      taskCount: taskIds.size,
      runningCount: overview.crews.filter((crew) => crew.status === "running").length,
      needsYouCount: overview.crews.filter((crew) => crew.needsYou > 0).length,
      // BBP-95: crews with a real failure, counted apart from those that only wait on a decision.
      errorCount: overview.crews.filter((crew) => hasErrorReason(crew.members.flatMap((member) => member.needsYou ?? []))).length,
    });
  }

  return { projects: projectSummaries, nodes, edges };
}

// ---------------------------------------------------------------------------
// Filtering (project chips, Crews/Tasks/Done toggles, search)

export type OverviewFilters = {
  /** `null` means every project (the chips' default). */
  projectIds: ReadonlySet<string> | null;
  showCrews: boolean;
  showTasks: boolean;
  showDone: boolean;
  search: string;
};

export const DEFAULT_OVERVIEW_FILTERS: OverviewFilters = {
  projectIds: null,
  showCrews: true,
  showTasks: true,
  showDone: true,
  search: "",
};

export type FilteredOverview = {
  /** Node ids to render. */
  visible: ReadonlySet<string>;
  /** Node ids whose text matched the search — highlighted. */
  matched: ReadonlySet<string>;
  /** Matched node ids, for `fitView`/focus; empty when the search is empty or matches nothing. */
  focus: readonly string[];
};

function nodeText(node: OverviewNode): string {
  if (node.kind === "crew") return [node.name, node.branch ?? "", ...node.members.map((member) => member.key)].join(" ");
  return [node.key, node.title].join(" ");
}

/** Applies the project chips, the three toggles and the search box to a built graph. */
export function filterOverviewGraph(graph: OverviewGraph, filters: OverviewFilters): FilteredOverview {
  const search = filters.search.trim().toLowerCase();
  const visible = new Set<string>();
  const matched = new Set<string>();

  for (const node of graph.nodes) {
    if (filters.projectIds !== null && !filters.projectIds.has(node.projectId)) continue;
    if (node.kind === "crew" && !filters.showCrews) continue;
    if (node.kind === "task") {
      if (!filters.showTasks) continue;
      if (node.done && !filters.showDone) continue;
    }
    visible.add(node.id);
    if (search !== "" && nodeText(node).toLowerCase().includes(search)) matched.add(node.id);
  }

  return { visible, matched, focus: search === "" ? [] : [...matched] };
}

/** Edges whose endpoints are both visible — draw nothing dangling off a hidden node. */
export function visibleOverviewEdges(graph: OverviewGraph, visible: ReadonlySet<string>): OverviewEdge[] {
  return graph.edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to));
}

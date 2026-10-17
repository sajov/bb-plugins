// The Canvas plugin's own tree (BBP-189): every thread BB lists, chat threads
// included, under Agents → its project. Pure mapping from `threads.list` rows,
// so it is testable without the SDK; turns load lazily per thread elsewhere.
import { EMPTY_LAYER, withRoots, mergeLayers, projectNodeId, type CanvasLayer } from "./layer";
import { threadNodeId } from "./canvas-threads";
import type { CanvasNode, CanvasStatus } from "./types";

/** The fields of a `threads.list` row the tree reads. */
export type ThreadListItem = {
  id: string;
  projectId: string;
  title: string | null;
  titleFallback: string | null;
  status: string;
  providerId: string;
  archivedAt: number | null;
  updatedAt: number;
  /** The thread's working branch, when its environment has one. */
  environmentBranchName?: string | null;
};

/** `gitRemoteUrl`: the project's repository, for its dashboard. */
export type ProjectLike = { id: string; name: string; gitRemoteUrl?: string | null };

const STATUS: Record<string, CanvasStatus> = {
  active: "running",
  pending: "running",
  starting: "running",
  error: "failed",
  idle: "idle",
};

/** The status a thread card shows, from the raw `threads.list` status. */
export const threadStatus = (status: string): CanvasStatus => STATUS[status] ?? "idle";

function threadNode(thread: ThreadListItem): CanvasNode {
  return {
    id: threadNodeId(thread.id),
    kind: "thread",
    label: thread.title?.trim() || thread.titleFallback?.trim() || "Thread",
    status: threadStatus(thread.status),
    parentId: projectNodeId(thread.projectId),
    meta: { threadId: thread.id, state: thread.status, provider: thread.providerId, ...(thread.environmentBranchName ? { branch: thread.environmentBranchName } : {}) },
  };
}

/** A project without threads is left out; a thread whose project is not in
 *  `projects` still shows, under a project named by its id. */
export function threadTree(projects: readonly ProjectLike[], threads: readonly ThreadListItem[]): CanvasLayer {
  if (threads.length === 0) return EMPTY_LAYER;
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const byProject = new Map<string, ThreadListItem[]>();
  for (const thread of threads) byProject.set(thread.projectId, [...(byProject.get(thread.projectId) ?? []), thread]);
  return mergeLayers(
    ...[...byProject].map(([projectId, own]) =>
      withRoots(projectId, names.get(projectId) ?? projectId, {
        nodes: [...own].sort((a, b) => b.updatedAt - a.updatedAt).map(threadNode),
        edges: [],
        expanded: [],
      }),
    ),
  );
}

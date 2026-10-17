// What a provider (crew, graph-studio, threads) hands the canvas: its nodes,
// the edges beyond the tree, and which of its nodes start out open. Providers
// hang their top nodes under `projectNodeId(projectId)`; the page adds the
// `agents` and `project` roots with `withRoots`.
import type { CanvasEdge, CanvasNode } from "./types";

export type CanvasLayer = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Node ids open on first render; everything else starts collapsed. */
  expanded: string[];
};

export const EMPTY_LAYER: CanvasLayer = { nodes: [], edges: [], expanded: [] };

export const AGENTS_NODE_ID = "agents";

export const projectNodeId = (projectId: string): string => `project:${projectId}`;

/** First provider wins on a duplicate node id, so a later layer cannot relabel an earlier one's node. */
export function mergeLayers(...layers: CanvasLayer[]): CanvasLayer {
  const seen = new Set<string>();
  const nodes: CanvasNode[] = [];
  for (const layer of layers) for (const node of layer.nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    nodes.push(node);
  }
  return {
    nodes,
    edges: layers.flatMap((layer) => layer.edges),
    expanded: [...new Set(layers.flatMap((layer) => layer.expanded))],
  };
}

export function withRoots(projectId: string, projectLabel: string, layer: CanvasLayer): CanvasLayer {
  const project = projectNodeId(projectId);
  return mergeLayers(
    {
      nodes: [
        { id: AGENTS_NODE_ID, kind: "agents", label: "Agents", parentId: null },
        { id: project, kind: "project", label: projectLabel, parentId: AGENTS_NODE_ID },
      ],
      edges: [],
      expanded: [AGENTS_NODE_ID, project],
    },
    layer,
  );
}

/** The project a crew's node hangs under — with several projects on one
 *  canvas, a crew name alone no longer says which one it belongs to. */
export function projectOfCrew(nodes: readonly CanvasNode[], crew: string): string | null {
  const prefix = projectNodeId("");
  const node = nodes.find((candidate) => candidate.kind === "crew" && (candidate.meta?.crew ?? candidate.label) === crew);
  return node?.parentId?.startsWith(prefix) ? node.parentId.slice(prefix.length) : null;
}

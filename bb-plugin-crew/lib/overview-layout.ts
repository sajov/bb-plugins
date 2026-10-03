// Auto-layout for the fullscreen overview diagram (BBP-71): one frame per
// project, crews in a row, their tasks in a row above. Pure geometry so it
// is testable without @xyflow/react or a DOM.
import type { OverviewGraph, OverviewNode } from "./overview-graph";

export const CREW_W = 220;
export const CREW_H = 92;
export const TASK_W = 180;
export const TASK_H = 56;
export const GAP_X = 32;
export const GAP_Y = 48;
export const FRAME_PAD = 28;
export const FRAME_HEADER = 36;
export const FRAME_GAP = 56;

export type PlacedNode = { id: string; x: number; y: number; width: number; height: number; node: OverviewNode };
export type PlacedFrame = { projectId: string; x: number; y: number; width: number; height: number };
export type OverviewLayout = { frames: PlacedFrame[]; placed: PlacedNode[]; width: number; height: number };

/**
 * Places the nodes of each project (tasks on top, crews below, both left to
 * right) inside a labelled frame, frames laid left to right. Only nodes
 * whose id is in `visible` are placed — a filtered-out node takes no room.
 */
export function layoutOverview(graph: OverviewGraph, visible: ReadonlySet<string>): OverviewLayout {
  const frames: PlacedFrame[] = [];
  const placed: PlacedNode[] = [];
  let cursorX = 0;
  let maxHeight = 0;

  for (const project of graph.projects) {
    const tasks = graph.nodes.filter((node): node is Extract<OverviewNode, { kind: "task" }> => node.kind === "task" && node.projectId === project.id && visible.has(node.id));
    const crews = graph.nodes.filter((node): node is Extract<OverviewNode, { kind: "crew" }> => node.kind === "crew" && node.projectId === project.id && visible.has(node.id));
    if (tasks.length === 0 && crews.length === 0) continue;

    const taskRowWidth = tasks.length > 0 ? tasks.length * TASK_W + (tasks.length - 1) * GAP_X : 0;
    const crewRowWidth = crews.length > 0 ? crews.length * CREW_W + (crews.length - 1) * GAP_X : 0;
    const innerWidth = Math.max(taskRowWidth, crewRowWidth, 1);
    const innerHeight = (tasks.length > 0 ? TASK_H + GAP_Y : 0) + (crews.length > 0 ? CREW_H : 0);

    const frameX = cursorX;
    const frameY = 0;
    const frameWidth = innerWidth + FRAME_PAD * 2;
    const frameHeight = innerHeight + FRAME_PAD * 2 + FRAME_HEADER;
    frames.push({ projectId: project.id, x: frameX, y: frameY, width: frameWidth, height: frameHeight });

    tasks.forEach((task, index) => {
      placed.push({ id: task.id, x: frameX + FRAME_PAD + index * (TASK_W + GAP_X), y: frameY + FRAME_HEADER + FRAME_PAD, width: TASK_W, height: TASK_H, node: task });
    });
    const crewY = frameY + FRAME_HEADER + FRAME_PAD + (tasks.length > 0 ? TASK_H + GAP_Y : 0);
    crews.forEach((crew, index) => {
      placed.push({ id: crew.id, x: frameX + FRAME_PAD + index * (CREW_W + GAP_X), y: crewY, width: CREW_W, height: CREW_H, node: crew });
    });

    cursorX += frameWidth + FRAME_GAP;
    maxHeight = Math.max(maxHeight, frameHeight);
  }

  return { frames, placed, width: Math.max(cursorX - FRAME_GAP, 0), height: maxHeight };
}

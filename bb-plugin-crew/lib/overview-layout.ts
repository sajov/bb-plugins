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
/** BBP-83: a frame wraps its crews (and tasks) after this many, so a busy project is a block, not a strip. */
export const MAX_CREWS_PER_ROW = 3;
/** Frames wrap onto a new row past this width, so the top level stays readable when fitted. */
export const MAX_ROW_WIDTH = 2400;

export type PlacedNode = { id: string; x: number; y: number; width: number; height: number; node: OverviewNode };
export type PlacedFrame = { projectId: string; x: number; y: number; width: number; height: number };
export type OverviewLayout = { frames: PlacedFrame[]; placed: PlacedNode[]; width: number; height: number };

function rowsOf(count: number): number {
  return Math.ceil(count / MAX_CREWS_PER_ROW);
}

/**
 * Places the nodes of each project (tasks on top, crews below, each wrapped
 * after MAX_CREWS_PER_ROW) inside a labelled frame; frames run left to right
 * and wrap past MAX_ROW_WIDTH. Only nodes whose id is in `visible` are
 * placed — a filtered-out node takes no room.
 */
export function layoutOverview(graph: OverviewGraph, visible: ReadonlySet<string>): OverviewLayout {
  const frames: PlacedFrame[] = [];
  const placed: PlacedNode[] = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  let width = 0;

  for (const project of graph.projects) {
    const tasks = graph.nodes.filter((node): node is Extract<OverviewNode, { kind: "task" }> => node.kind === "task" && node.projectId === project.id && visible.has(node.id));
    const crews = graph.nodes.filter((node): node is Extract<OverviewNode, { kind: "crew" }> => node.kind === "crew" && node.projectId === project.id && visible.has(node.id));
    if (tasks.length === 0 && crews.length === 0) continue;

    const taskCols = Math.min(tasks.length, MAX_CREWS_PER_ROW);
    const crewCols = Math.min(crews.length, MAX_CREWS_PER_ROW);
    const taskBlockHeight = tasks.length > 0 ? rowsOf(tasks.length) * (TASK_H + GAP_Y) : 0;
    const crewBlockHeight = crews.length > 0 ? rowsOf(crews.length) * CREW_H + (rowsOf(crews.length) - 1) * GAP_Y : 0;
    const innerWidth = Math.max(taskCols * TASK_W + Math.max(taskCols - 1, 0) * GAP_X, crewCols * CREW_W + Math.max(crewCols - 1, 0) * GAP_X, 1);
    const frameWidth = innerWidth + FRAME_PAD * 2;
    const frameHeight = taskBlockHeight + crewBlockHeight + FRAME_PAD * 2 + FRAME_HEADER;

    if (cursorX > 0 && cursorX + frameWidth > MAX_ROW_WIDTH) {
      cursorX = 0;
      cursorY += rowHeight + FRAME_GAP;
      rowHeight = 0;
    }
    const frameX = cursorX;
    const frameY = cursorY;
    frames.push({ projectId: project.id, x: frameX, y: frameY, width: frameWidth, height: frameHeight });

    const innerX = frameX + FRAME_PAD;
    const innerY = frameY + FRAME_HEADER + FRAME_PAD;
    tasks.forEach((task, index) => {
      const col = index % MAX_CREWS_PER_ROW;
      const row = Math.floor(index / MAX_CREWS_PER_ROW);
      placed.push({ id: task.id, x: innerX + col * (TASK_W + GAP_X), y: innerY + row * (TASK_H + GAP_Y), width: TASK_W, height: TASK_H, node: task });
    });
    crews.forEach((crew, index) => {
      const col = index % MAX_CREWS_PER_ROW;
      const row = Math.floor(index / MAX_CREWS_PER_ROW);
      placed.push({ id: crew.id, x: innerX + col * (CREW_W + GAP_X), y: innerY + taskBlockHeight + row * (CREW_H + GAP_Y), width: CREW_W, height: CREW_H, node: crew });
    });

    cursorX += frameWidth + FRAME_GAP;
    rowHeight = Math.max(rowHeight, frameHeight);
    width = Math.max(width, frameX + frameWidth);
  }

  return { frames, placed, width, height: frames.length > 0 ? cursorY + rowHeight : 0 };
}

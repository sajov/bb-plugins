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

/**
 * Places the nodes of each project (tasks on top, crews below, each wrapped
 * after MAX_CREWS_PER_ROW) inside a labelled frame; frames run left to right
 * and wrap past MAX_ROW_WIDTH. Only nodes whose id is in `visible` are
 * placed — a filtered-out node takes no room.
 */
export type NodeSize = { width: number; height: number };

export function layoutOverview(graph: OverviewGraph, visible: ReadonlySet<string>, sizes: ReadonlyMap<string, NodeSize> = new Map()): OverviewLayout {
  const frames: PlacedFrame[] = [];
  const placed: PlacedNode[] = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  let width = 0;

  /** Rows of up to MAX_CREWS_PER_ROW boxes; a row is as tall as its tallest box. */
  const placeRows = <T extends OverviewNode>(nodes: T[], base: NodeSize, x0: number, y0: number) => {
    let y = y0;
    let blockWidth = 0;
    for (let start = 0; start < nodes.length; start += MAX_CREWS_PER_ROW) {
      let x = x0;
      let tallest = 0;
      for (const node of nodes.slice(start, start + MAX_CREWS_PER_ROW)) {
        const size = sizes.get(node.id) ?? base;
        placed.push({ id: node.id, x, y, width: size.width, height: size.height, node });
        x += size.width + GAP_X;
        tallest = Math.max(tallest, size.height);
      }
      blockWidth = Math.max(blockWidth, x - GAP_X - x0);
      y += tallest + GAP_Y;
    }
    return { width: blockWidth, height: nodes.length > 0 ? y - y0 : 0 };
  };

  for (const project of graph.projects) {
    const tasks = graph.nodes.filter((node): node is Extract<OverviewNode, { kind: "task" }> => node.kind === "task" && node.projectId === project.id && visible.has(node.id));
    const crews = graph.nodes.filter((node): node is Extract<OverviewNode, { kind: "crew" }> => node.kind === "crew" && node.projectId === project.id && visible.has(node.id));
    if (tasks.length === 0 && crews.length === 0) continue;

    // Placed at the origin first: the frame's size decides whether it wraps onto a new row.
    const first = placed.length;
    const taskBlock = placeRows(tasks, { width: TASK_W, height: TASK_H }, 0, 0);
    const crewBlock = placeRows(crews, { width: CREW_W, height: CREW_H }, 0, taskBlock.height);
    const frameWidth = Math.max(taskBlock.width, crewBlock.width, 1) + FRAME_PAD * 2;
    const frameHeight = taskBlock.height + crewBlock.height - (crews.length > 0 || tasks.length > 0 ? GAP_Y : 0) + FRAME_PAD * 2 + FRAME_HEADER;

    if (cursorX > 0 && cursorX + frameWidth > MAX_ROW_WIDTH) {
      cursorX = 0;
      cursorY += rowHeight + FRAME_GAP;
      rowHeight = 0;
    }
    frames.push({ projectId: project.id, x: cursorX, y: cursorY, width: frameWidth, height: frameHeight });
    for (const node of placed.slice(first)) {
      node.x += cursorX + FRAME_PAD;
      node.y += cursorY + FRAME_HEADER + FRAME_PAD;
    }

    cursorX += frameWidth + FRAME_GAP;
    rowHeight = Math.max(rowHeight, frameHeight);
    width = Math.max(width, frames[frames.length - 1]!.x + frameWidth);
  }

  return { frames, placed, width, height: frames.length > 0 ? cursorY + rowHeight : 0 };
}

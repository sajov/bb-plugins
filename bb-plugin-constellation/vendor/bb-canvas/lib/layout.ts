// A left-to-right tree layout: pure and DOM-free, so the same function lays
// out a preview in a test and a live canvas on screen, and can be unit tested
// without a browser.
//
// Depth becomes a column, not a row — the opposite of graph-studio's
// top-to-bottom `layoutGraph` — because the view this feeds is a navigation
// tree read left to right (agents → project → crew → member → …), not a
// flow chart. Siblings (several members, several run steps) stack as rows
// within their shared column.
import { selectedPathEdges } from "./selected-path";
import type { CanvasEdge, CanvasEdgeState, CanvasFrame, CanvasNode } from "./types";
import { sizeOfNode, TIER_SIZE } from "./tiers";

/** Card tier's size, kept as the default export for callers that still want
 *  one constant (tests, the back-edge lane) — every node's own size now
 *  comes from `sizeOfNode(node)` instead. */
export const NODE_WIDTH = TIER_SIZE.card.width;
export const NODE_HEIGHT = TIER_SIZE.card.height;
export const COLUMN_GAP = 44;
export const ROW_GAP = 16;
export const MARGIN = 24;
/** How far a back edge's arc bows out past the right edge of its column. */
const BACK_EDGE_LANE = 32;
/** Space between a frame's box and the cards it encloses. */
export const FRAME_PADDING = 16;
/** Room above a frame's first card for its label, kept free in the layout so
 *  neither the label nor the frame reach into the cards above (BBP-191). */
export const FRAME_HEAD = 22;
/** BBP-303 flow: gap between two steps of a flow, and between two lanes. */
export const FLOW_GAP = 40;
export const LANE_GAP = 18;
/** How far a step's own activity (turns, tool calls) is indented below it. */
export const FLOW_INDENT = 24;

/** A flow block, relative to the flow node's right edge (x) and centre (y). */
type FlowBlock = { nodes: { id: string; x: number; y: number }[]; minY: number; maxY: number; width: number; parents: Map<string, string> };

export type PlacedNode = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  column: number;
};

export type PlacedEdge = {
  from: string;
  to: string;
  variant: CanvasEdge["variant"];
  /** SVG path, ready for an `<svg><path/></svg>` or React Flow's `BaseEdge`. */
  path: string;
  label: string;
  /** A back reference bows out to the right instead of running straight down
   *  through the nodes in between. */
  isBack: boolean;
  /** Undefined draws the plain `--border` line from before BBP-146. */
  state?: CanvasEdgeState;
  relation?: boolean;
  emphasis?: CanvasEdge["emphasis"];
  /** Junction points the edge passes (BBP-303): where a flow splits, decides
   *  or joins, so structure reads without cards of its own. */
  junctions?: readonly Junction[];
};

export type Junction = { x: number; y: number; kind: "split" | "decision" | "join" };

/** How far from the card a split or join point sits. */
const JUNCTION_OFFSET = 12;

/** A frame's bounding box: the padded rectangle around its member cards. */
export type PlacedFrame = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TreeLayout = {
  positions: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
  /** Only present when a `frames` argument was given — absent, not empty, so
   *  a caller that never passed frames sees exactly the shape it did before
   *  BBP-165 (negative criterion 1). */
  frames?: PlacedFrame[];
};

/**
 * `nodes` is the full set a provider knows about; only the ones `expanded`
 * actually reveals end up in `positions` — a collapsed node's subtree is left
 * out of the layout entirely rather than placed off-screen.
 *
 * `edges` declares everything beyond the tree itself (back references,
 * messages); the parent/child line for every visible node is drawn
 * automatically and needs no entry here. An edge touching a node that is not
 * currently visible is dropped along with it.
 *
 * `selectedId` (BBP-220) highlights the flow edges from the root down to it
 * with `"selected-path"`, unless a given edge is already `"now"` — a running
 * child takes precedence over the selection.
 */
export function layoutTree(
  nodes: readonly CanvasNode[],
  expanded: ReadonlySet<string>,
  edges: readonly CanvasEdge[] = [],
  frames?: readonly CanvasFrame[],
  selectedId?: string | null,
): TreeLayout {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  // A parent id absent from the node set roots its node instead of vanishing
  // it or throwing — a provider that forgot one ancestor must not take the
  // rest of the tree down with it.
  const parentOf = (node: CanvasNode): string | null =>
    node.parentId !== null && byId.has(node.parentId) ? node.parentId : null;

  const childrenOf = new Map<string | null, CanvasNode[]>();
  for (const node of nodes) {
    const key = parentOf(node);
    const list = childrenOf.get(key) ?? [];
    list.push(node);
    childrenOf.set(key, list);
  }

  const columnOf = new Map<string, number>();
  const parentIdOf = new Map<string, string | null>();
  const order: string[] = [];
  // BBP-303: an open node marked `meta.flow` (a graph run) lays its children
  // out as a flow — left to right by `meta.layer`, stacked by `meta.lane` —
  // instead of as a tree column; each child's own open activity sits
  // indented below it.
  const flows = new Map<string, FlowBlock>();

  const visit = (parentId: string | null, column: number) => {
    for (const node of childrenOf.get(parentId) ?? []) {
      columnOf.set(node.id, column);
      parentIdOf.set(node.id, parentId);
      order.push(node.id);
      if (!expanded.has(node.id)) continue;
      if (node.meta?.flow === true && (childrenOf.get(node.id)?.length ?? 0) > 0) flows.set(node.id, flowBlock(node.id));
      else visit(node.id, column + 1);
    }
  };

  function flowBlock(flowId: string): FlowBlock {
    const steps = childrenOf.get(flowId) ?? [];
    const layerOf = (node: CanvasNode, index: number) => (typeof node.meta?.layer === "number" ? node.meta.layer : index);
    const laneOf = (node: CanvasNode) => (typeof node.meta?.lane === "number" ? node.meta.lane : 0);
    const layers = new Map<number, CanvasNode[]>();
    steps.forEach((node, index) => layers.set(layerOf(node, index), [...(layers.get(layerOf(node, index)) ?? []), node]));
    const block: FlowBlock = { nodes: [], minY: 0, maxY: 0, width: 0, parents: new Map() };
    let x = 0;
    for (const layer of [...layers.keys()].sort((a, b) => a - b)) {
      const lanes = layers.get(layer)!.sort((a, b) => laneOf(a) - laneOf(b));
      // Each lane: the step card, and below it its own open activity.
      const stacks = lanes.map((node) => {
        const size = sizeOfNode(node);
        const sub = expanded.has(node.id) ? subtree(node) : null;
        return { node, size, sub, height: size.height + (sub ? 10 + sub.height : 0), width: Math.max(size.width, sub ? FLOW_INDENT + sub.width : 0) };
      });
      // Card centres stacked, then shifted so their mean sits on the flow's
      // centre line: a one-lane layer stays on it, whatever opens below.
      let top = 0;
      const centres = stacks.map((stack) => {
        const centre = top + stack.size.height / 2;
        top += stack.height + LANE_GAP;
        return centre;
      });
      const shift = centres.reduce((sum, c) => sum + c, 0) / centres.length;
      stacks.forEach((stack, index) => {
        const cardTop = centres[index]! - shift - stack.size.height / 2;
        block.nodes.push({ id: stack.node.id, x, y: cardTop });
        block.parents.set(stack.node.id, flowId);
        block.minY = Math.min(block.minY, cardTop);
        block.maxY = Math.max(block.maxY, cardTop + stack.height);
        if (stack.sub) {
          for (const placedSub of stack.sub.nodes) block.nodes.push({ id: placedSub.id, x: x + FLOW_INDENT + placedSub.x, y: cardTop + stack.size.height + 10 + placedSub.y });
          for (const [child, parent] of stack.sub.parents) block.parents.set(child, parent);
        }
      });
      x += Math.max(...stacks.map((stack) => stack.width)) + FLOW_GAP;
    }
    block.width = Math.max(0, x - FLOW_GAP);
    return block;
  }

  /** A step's own open activity, laid out as an ordinary tree, relative to
   *  its top-left corner (the step card itself left out). */
  function subtree(root: CanvasNode): { nodes: { id: string; x: number; y: number }[]; parents: Map<string, string>; width: number; height: number } | null {
    const below: CanvasNode[] = [];
    const walk = (id: string) => {
      for (const child of childrenOf.get(id) ?? []) {
        below.push(child);
        walk(child.id);
      }
    };
    walk(root.id);
    if (below.length === 0) return null;
    const inner = layoutTree([{ ...root, parentId: null }, ...below], expanded);
    const own = inner.positions.find((p) => p.id === root.id)!;
    const rest = inner.positions.filter((p) => p.id !== root.id);
    if (rest.length === 0) return null;
    // The tree's first column of children starts right of the root card:
    // pull it back under the card, indented.
    const dx = own.x + own.width + COLUMN_GAP;
    const top = Math.min(...rest.map((p) => p.y));
    const parents = new Map(below.map((node) => [node.id, node.parentId!]));
    return {
      nodes: rest.map((p) => ({ id: p.id, x: p.x - dx, y: p.y - top })),
      parents,
      width: Math.max(...rest.map((p) => p.x - dx + p.width)),
      height: Math.max(...rest.map((p) => p.y - top + p.height)),
    };
  }

  visit(null, 0);

  // Every visible leaf takes the next free vertical slot, stacked by its own
  // tier height rather than a uniform row height — a "row"-tier leaf and a
  // "card"-tier leaf in the same column must not overlap. A parent centres
  // on the vertical span its open subtree's first and last child occupy, so
  // with 20 members under one crew the crew card sits beside the middle of
  // its members instead of above the first one and the fan of edges stays
  // short and symmetric.
  const visibleChildren = new Map<string, string[]>();
  for (const id of order) {
    const parentId = parentIdOf.get(id)!;
    if (parentId === null) continue;
    const list = visibleChildren.get(parentId) ?? [];
    list.push(id);
    visibleChildren.set(parentId, list);
  }
  const centerYOf = new Map<string, number>();
  let nextY = MARGIN;
  let lastFrame: string | undefined;
  const placeCenters = (id: string): number => {
    const kids = visibleChildren.get(id) ?? [];
    if (kids.length === 0) {
      const block = flows.get(id);
      if (block) {
        // A flow is a leaf of the tree as tall as its block (BBP-303).
        const half = sizeOfNode(byId.get(id)!).height / 2;
        const above = Math.max(half, -block.minY);
        const below = Math.max(half, block.maxY);
        const top = nextY;
        nextY = top + above + below + ROW_GAP;
        centerYOf.set(id, top + above);
        lastFrame = undefined;
        return top + above;
      }
      const height = sizeOfNode(byId.get(id)!).height;
      // Entering a frame: room for its padding and label above the card;
      // leaving one: room for its padding below the last card.
      const frame = byId.get(id)!.frameId;
      if (frame !== lastFrame) {
        if (lastFrame !== undefined) nextY += FRAME_PADDING;
        if (frame !== undefined) nextY += FRAME_PADDING + FRAME_HEAD;
        lastFrame = frame;
      }
      const top = nextY;
      nextY = top + height + ROW_GAP;
      const center = top + height / 2;
      centerYOf.set(id, center);
      return center;
    }
    const centers = kids.map(placeCenters);
    const center = (centers[0]! + centers[centers.length - 1]!) / 2;
    centerYOf.set(id, center);
    return center;
  };
  for (const id of order) if (parentIdOf.get(id) === null) placeCenters(id);

  // Column x grows by the widest node actually placed in the previous
  // column, not a single global width — a "group" and a "row" tier share
  // the same 220px today, but columns are free to differ.
  const columnWidth = new Map<number, number>();
  for (const id of order) {
    const column = columnOf.get(id)!;
    const width = sizeOfNode(byId.get(id)!).width;
    columnWidth.set(column, Math.max(columnWidth.get(column) ?? 0, width));
  }
  const columnX = new Map<number, number>();
  let nextX = MARGIN;
  for (let column = 0; column <= Math.max(...[...columnOf.values()], -1); column++) {
    columnX.set(column, nextX);
    nextX += (columnWidth.get(column) ?? 0) + COLUMN_GAP;
  }

  const placed = new Map<string, PlacedNode>();
  for (const id of order) {
    const column = columnOf.get(id)!;
    const { width, height } = sizeOfNode(byId.get(id)!);
    placed.set(id, {
      id,
      x: columnX.get(column)!,
      y: centerYOf.get(id)! - height / 2,
      width,
      height,
      column,
    });
  }

  // Flow blocks: right of their flow node, centred on its centre line.
  for (const [flowId, block] of flows) {
    const flowPlaced = placed.get(flowId);
    if (!flowPlaced) continue;
    const originX = flowPlaced.x + flowPlaced.width + COLUMN_GAP;
    const centre = flowPlaced.y + flowPlaced.height / 2;
    for (const entry of block.nodes) {
      const { width, height } = sizeOfNode(byId.get(entry.id)!);
      placed.set(entry.id, { id: entry.id, x: originX + entry.x, y: centre + entry.y, width, height, column: flowPlaced.column + 1 });
      parentIdOf.set(entry.id, block.parents.get(entry.id) ?? flowId);
      columnOf.set(entry.id, flowPlaced.column + 1);
      order.push(entry.id);
    }
  }

  const onSelectedPath = selectedPathEdges(selectedId ?? null, parentIdOf);
  // As agent-graph: the whole path from the root down to running work is
  // marked, not only the last edge into the running node (BBP-298).
  const runningBranch = new Set<string>();
  // The same for whatever waits for the human (BBP-303): its path turns amber.
  const needsBranch = new Set<string>();
  for (const node of nodes) {
    if (!node.meta?.needsYou) continue;
    for (let id = parentOf(node); id !== null && !needsBranch.has(id); id = parentOf(byId.get(id)!)) needsBranch.add(id);
  }
  for (const node of nodes) {
    if (node.status !== "running") continue;
    for (let id = parentOf(node); id !== null && !runningBranch.has(id); id = parentOf(byId.get(id)!)) runningBranch.add(id);
  }
  // Inside a flow a step's tree parent is the flow node, so the walk above
  // skips the steps before it and the line broke between the run and the
  // running step (BBP-314). Follow the step edges back as well.
  extendUpstream(nodes.filter((node) => node.status === "running").map((node) => node.id), edges, runningBranch);
  extendUpstream(nodes.filter((node) => node.meta?.needsYou || node.meta?.waitsForYou).map((node) => node.id), edges, needsBranch);
  const flowEdges: PlacedEdge[] = order.flatMap((id) => {
    const parentId = parentIdOf.get(id)!;
    if (parentId === null) return [];
    // Inside a flow only the first layer hangs off the flow node; later
    // steps are reached by their "step" edges.
    const node = byId.get(id)!;
    if (flows.has(parentId) && typeof node.meta?.layer === "number" && node.meta.layer > 0) return [];
    return [flowEdge(placed.get(parentId)!, placed.get(id)!, byId.get(id)!, onSelectedPath.has(id), runningBranch.has(id), needsBranch.has(id))];
  });

  const stepOuts = new Map<string, number>();
  const stepIns = new Map<string, number>();
  for (const edge of edges) {
    if (edge.variant !== "step" || !placed.has(edge.from) || !placed.has(edge.to)) continue;
    stepOuts.set(edge.from, (stepOuts.get(edge.from) ?? 0) + 1);
    stepIns.set(edge.to, (stepIns.get(edge.to) ?? 0) + 1);
  }
  const joints = { outs: stepOuts, ins: stepIns };
  const declaredEdges: PlacedEdge[] = edges.flatMap((edge) => {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) return [];
    return [edge.variant === "back" ? backEdge(from, to, edge) : edge.variant === "step" ? stepEdge(from, to, edge, runningBranch, needsBranch, byId, joints) : messageEdge(from, to, edge)];
  });

  // Derived from the actual placed extents rather than a per-column/per-row
  // constant — columns and rows now mix tier sizes, so only the nodes
  // themselves know how far the layout reaches.
  const allPlaced = [...placed.values()];
  const width =
    allPlaced.length === 0
      ? MARGIN * 2
      : MARGIN + Math.max(...allPlaced.map((p) => p.x + p.width)) + BACK_EDGE_LANE;
  const height =
    allPlaced.length === 0 ? MARGIN * 2 : MARGIN + Math.max(...allPlaced.map((p) => p.y + p.height));

  const layout: TreeLayout = {
    positions: [...placed.values()],
    edges: [...flowEdges, ...declaredEdges],
    width,
    height,
  };
  if (frames === undefined) return layout;
  return { ...layout, frames: placeFrames(frames, nodes, placed) };
}

/** A frame with no visible member node is dropped rather than drawn with an
 *  empty or default-sized box — a collapsed crew must not leave a stray
 *  rectangle behind. */
function placeFrames(
  frames: readonly CanvasFrame[],
  nodes: readonly CanvasNode[],
  placed: Map<string, PlacedNode>,
): PlacedFrame[] {
  const membersOf = new Map<string, PlacedNode[]>();
  for (const node of nodes) {
    if (!node.frameId) continue;
    const placedNode = placed.get(node.id);
    if (!placedNode) continue;
    const list = membersOf.get(node.frameId) ?? [];
    list.push(placedNode);
    membersOf.set(node.frameId, list);
  }

  return frames.flatMap((frame) => {
    const members = membersOf.get(frame.id);
    if (!members || members.length === 0) return [];
    const minX = Math.min(...members.map((m) => m.x));
    const minY = Math.min(...members.map((m) => m.y));
    const maxX = Math.max(...members.map((m) => m.x + m.width));
    const maxY = Math.max(...members.map((m) => m.y + m.height));
    return [
      {
        id: frame.id,
        x: minX - FRAME_PADDING,
        y: minY - FRAME_PADDING - FRAME_HEAD,
        width: maxX - minX + FRAME_PADDING * 2,
        height: maxY - minY + FRAME_PADDING * 2 + FRAME_HEAD,
      },
    ];
  });
}

/** A tree line's state follows the child it leads to, not a declared edge —
 *  there is no `CanvasEdge` for it to read one from. Only a child that is
 *  actually `running` lights the line up ("now"); a finished or failed child
 *  draws the plain neutral line like anything else — "taken" is gone
 *  (BBP-214 stage 1): a line to a `done` step must not look like ongoing
 *  activity. */
function flowEdgeState(child: CanvasNode, onSelectedPath: boolean, leadsToRunning = false, leadsToNeeds = false): CanvasEdgeState | undefined {
  // Waiting for the human outranks running: it is the one thing to act on.
  if (child.meta?.needsYou || leadsToNeeds) return "needs";
  if (child.status === "running" || leadsToRunning) return "now";
  return onSelectedPath ? "selected-path" : undefined;
}

function flowEdge(from: PlacedNode, to: PlacedNode, toNode: CanvasNode, onSelectedPath: boolean, leadsToRunning = false, leadsToNeeds = false): PlacedEdge {
  const fromX = from.x + from.width;
  const fromY = from.y + from.height / 2;
  const toX = to.x;
  const toY = to.y + to.height / 2;
  const midX = (fromX + toX) / 2;
  // A child placed below its parent (a step's activity, BBP-303): down from
  // the parent's left part, then right into the child.
  const below = to.x < from.x + from.width - 1 && to.y >= from.y + from.height;
  const downX = from.x + 12;
  const path = below
    ? `M ${downX} ${from.y + from.height} L ${downX} ${toY - 6} Q ${downX} ${toY}, ${downX + 6} ${toY} L ${toX} ${toY}`
    : [`M ${fromX} ${fromY}`, `C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`].join(" ");
  const state = flowEdgeState(toNode, onSelectedPath, leadsToRunning, leadsToNeeds);
  return { from: from.id, to: to.id, variant: "flow", path, label: "", isBack: false, ...(state ? { state } : {}) };
}

/** Adds every step that leads, over step edges not marked skipped, to one
 *  of `seeds` — the edge into such a step is part of the path to it. */
function extendUpstream(seeds: readonly string[], edges: readonly CanvasEdge[], into: Set<string>): void {
  const before = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.variant !== "step" || edge.state === "skipped") continue;
    before.set(edge.to, [...(before.get(edge.to) ?? []), edge.from]);
  }
  const queue = [...seeds];
  const seen = new Set(seeds);
  while (queue.length > 0) {
    for (const from of before.get(queue.pop()!) ?? []) {
      if (seen.has(from)) continue;
      seen.add(from);
      into.add(from);
      queue.push(from);
    }
  }
}

/** One step of a flow to the next (BBP-303): right edge to left edge. Dashed
 *  blue while the target runs. */
function stepEdge(
  from: PlacedNode,
  to: PlacedNode,
  edge: CanvasEdge,
  running: ReadonlySet<string>,
  needs: ReadonlySet<string>,
  byId: ReadonlyMap<string, CanvasNode>,
  joints: { outs: ReadonlyMap<string, number>; ins: ReadonlyMap<string, number> },
): PlacedEdge {
  const fromY = from.y + from.height / 2;
  const toY = to.y + to.height / 2;
  // Every exit of a split leaves through one point, every way into a join
  // arrives through one: the point is the structure, drawn once per edge.
  const splits = (joints.outs.get(from.id) ?? 0) > 1;
  const joins = (joints.ins.get(to.id) ?? 0) > 1;
  const startX = from.x + from.width + (splits ? JUNCTION_OFFSET : 0);
  const endX = to.x - (joins ? JUNCTION_OFFSET : 0);
  const midX = (startX + endX) / 2;
  const junctions: Junction[] = [];
  if (splits) junctions.push({ x: startX, y: fromY, kind: byId.get(from.id)?.meta?.decision === true ? "decision" : "split" });
  if (joins) junctions.push({ x: endX, y: toY, kind: "join" });
  const path = [
    splits ? `M ${from.x + from.width} ${fromY} L ${startX} ${fromY}` : `M ${startX} ${fromY}`,
    `C ${midX} ${fromY}, ${midX} ${toY}, ${endX} ${toY}`,
    joins ? `L ${to.x} ${toY}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const target = byId.get(to.id);
  const state: CanvasEdgeState | undefined =
    edge.state === "skipped" ? "skipped" : target?.meta?.needsYou || target?.meta?.waitsForYou || needs.has(to.id) ? "needs" : target?.status === "running" || running.has(to.id) ? "now" : edge.state;
  return {
    from: from.id,
    to: to.id,
    variant: "step",
    path,
    // No label: the gap between two steps holds none without covering a card.
    label: "",
    isBack: false,
    ...(state ? { state } : {}),
    ...(junctions.length ? { junctions } : {}),
  };
}

/** Bows out past the right edge of the column the edge starts in, so a loop
 *  reads as a loop instead of hiding behind the nodes between its ends. In a
 *  flow, where the loop runs back to the left, it arcs above both cards. */
function backEdge(from: PlacedNode, to: PlacedNode, edge: CanvasEdge): PlacedEdge {
  if (to.x + to.width <= from.x) {
    const top = Math.min(from.y, to.y) - 36;
    const fx = from.x + from.width / 2;
    const tx = to.x + to.width / 2;
    return {
      from: from.id,
      to: to.id,
      variant: "back",
      path: `M ${fx} ${from.y} C ${fx} ${top}, ${tx} ${top}, ${tx} ${to.y}`,
      label: edge.label && edge.label.length > 22 ? `${edge.label.slice(0, 21)}…` : (edge.label ?? ""),
      isBack: true,
      ...(edge.state ? { state: edge.state } : {}),
      ...relationOf(edge),
    };
  }
  const laneX = Math.max(from.x + from.width, to.x + to.width) + BACK_EDGE_LANE;
  const fromX = from.x + from.width;
  const fromY = from.y + from.height / 2;
  const toX = to.x + to.width;
  const toY = to.y + to.height / 2;
  const path = [`M ${fromX} ${fromY}`, `C ${laneX} ${fromY}, ${laneX} ${toY}, ${toX} ${toY}`].join(" ");
  return {
    from: from.id,
    to: to.id,
    variant: "back",
    path,
    label: edge.label ?? "",
    isBack: true,
    ...(edge.state ? { state: edge.state } : {}),
    ...relationOf(edge),
  };
}

/** The straight-line shape for every declared edge that isn't a back
 *  reference — a literal chat `message`, but also a relation (BBP-202,
 *  `relation: true`) declared with variant `"flow"` when it runs forward
 *  through the columns rather than looping back (`canvas-layer.ts`,
 *  `pathBetween`). The placed edge keeps the *declared* variant rather than
 *  always stamping `"message"`: `StatusEdge`'s dash pattern is keyed by
 *  variant, and a `"flow"`-shaped relation stamped `"message"` picked up a
 *  dash it never asked for (BBP-214 feedback 2) — only an edge actually
 *  declared `"message"` should look like one. */
function messageEdge(from: PlacedNode, to: PlacedNode, edge: CanvasEdge): PlacedEdge {
  const fromX = from.x + from.width / 2;
  const fromY = from.y + from.height / 2;
  const toX = to.x + to.width / 2;
  const toY = to.y + to.height / 2;
  // Two cards in one column (a crew's members): centre to centre runs under
  // the cards. Bow out past their right edge instead, further the further
  // apart they are, so the arcs of one crew nest instead of overlapping
  // (BBP-191).
  const sameColumn = Math.abs(from.x - to.x) < 1;
  const right = Math.max(from.x + from.width, to.x + to.width);
  const lane = right + 14 + Math.min(70, Math.abs(toY - fromY) / 5);
  const path = sameColumn
    ? `M ${right - 6} ${fromY} C ${lane} ${fromY}, ${lane} ${toY}, ${right - 6} ${toY}`
    : `M ${fromX} ${fromY} L ${toX} ${toY}`;
  return {
    from: from.id,
    to: to.id,
    variant: edge.variant,
    path,
    label: edge.label ?? "",
    isBack: false,
    ...(edge.state ? { state: edge.state } : {}),
    ...relationOf(edge),
  };
}

function relationOf(edge: CanvasEdge): Pick<PlacedEdge, "relation" | "emphasis"> {
  if (!edge.relation) return {};
  return { relation: true, ...(edge.emphasis ? { emphasis: edge.emphasis } : {}) };
}

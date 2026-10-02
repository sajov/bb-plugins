// Layered top-down layout for the crew canvases, after Graph Studio's
// lib/layout.ts: compact cards in rows, the flow running downwards, edges as
// computed SVG paths. Arrows that go back up bow out into a lane on the right
// so they never hide behind a card; arrows inside a row arc underneath it.
//
// Top-down and narrow on purpose: a crew drawn sideways in group boxes was
// unreadable on a phone, where the panel is tall and thin.
//
// Pure and dependency-free, so both canvases share it and it is tested
// without a DOM.

// Room above the first row and below the last for the gap corridors (pathBetween).
export const MARGIN = 44;
export const SIBLING_GAP = 24;
export const LAYER_GAP = 64;

export type Box = { id: string; x: number; y: number; width: number; height: number; layer: number };
export type Placed = { boxes: Box[]; width: number; height: number };

/**
 * Rows of boxes, one row per layer, each centred. A layer wider than
 * `maxPerRow` wraps onto further rows, so a narrow panel grows downwards
 * instead of shrinking the cards to nothing.
 */
export function placeLayers(layers: readonly (readonly string[])[], size: { width: number; height: number }, maxPerRow = Infinity): Placed {
  const rows: { ids: string[]; layer: number }[] = [];
  layers.forEach((ids, layer) => {
    const per = Math.max(1, Math.min(maxPerRow, ids.length));
    for (let start = 0; start < ids.length; start += per) rows.push({ ids: ids.slice(start, start + per), layer });
  });
  const widest = Math.max(1, ...rows.map((row) => row.ids.length));
  const contentWidth = widest * size.width + (widest - 1) * SIBLING_GAP;
  const width = contentWidth + 2 * MARGIN;
  const boxes: Box[] = [];
  rows.forEach((row, index) => {
    const rowWidth = row.ids.length * size.width + (row.ids.length - 1) * SIBLING_GAP;
    const startX = MARGIN + (contentWidth - rowWidth) / 2;
    const y = MARGIN + index * (size.height + LAYER_GAP);
    row.ids.forEach((id, column) => boxes.push({ id, x: startX + column * (size.width + SIBLING_GAP), y, width: size.width, height: size.height, layer: row.layer }));
  });
  const height = rows.length === 0 ? 2 * MARGIN : MARGIN * 2 + rows.length * size.height + (rows.length - 1) * LAYER_GAP;
  return { boxes, width, height };
}

/** How many boxes fit side by side in a panel of this width (at least one). */
export function perRow(panelWidth: number, boxWidth: number): number {
  return Math.max(1, Math.floor((panelWidth - 2 * MARGIN + SIBLING_GAP) / (boxWidth + SIBLING_GAP)));
}

export type EdgeShape = "down" | "back" | "skip" | "side" | "under";
export type Path = { path: string; labelX: number; labelY: number; shape: EdgeShape };

/**
 * The path from one box to another. `slot` spreads several edges between the
 * same pair (a link, a message, the way back) so they stay apart.
 *
 * - down: bottom centre to top centre, a vertical S — Graph Studio's forward edge
 * - back: target above — out of the right side into a lane and back in
 * - skip: target more than one row below — the same lane, so no card is cut
 * - side: same row, the neighbour to the right — right side to left side
 * - under: same row otherwise — an arc beneath the row
 */
export function pathBetween(from: Box, to: Box, slot = 0, laneX?: number): Path {
  const shift = slot * 10;
  // More than one row down, a straight S would cut through the row between —
  // which is exactly what a wrapped group on a phone puts there. Take the lane.
  const skipsRow = to.y - from.y > from.height + LAYER_GAP + 1;
  if (to.y > from.y && !skipsRow) {
    const fromX = from.x + from.width / 2 + shift;
    const toX = to.x + to.width / 2 + shift;
    const startY = from.y + from.height;
    const endY = to.y;
    const midY = (startY + endY) / 2;
    return { path: `M ${fromX} ${startY} C ${fromX} ${midY}, ${toX} ${midY}, ${toX} ${endY}`, labelX: (fromX + toX) / 2, labelY: midY, shape: "down" };
  }
  if (to.y !== from.y) {
    // Only through the gaps, like a wire: down out of the source into the gap
    // under its row, right to the lane, up or down the lane, left along the gap
    // above the target's row, and in from above. A curve that cut across was
    // always crossing some card on a wrapped or busy row.
    const lane = (laneX ?? Math.max(from.x + from.width, to.x + to.width) + MARGIN / 2) + slot * 12;
    const fromX = from.x + from.width / 2 + shift;
    const toX = to.x + to.width / 2 + shift;
    const below = from.y + from.height + LAYER_GAP / 2 + slot * 4;
    const above = to.y - LAYER_GAP / 2 + slot * 4;
    const points: [number, number][] = [
      [fromX, from.y + from.height],
      [fromX, below],
      [lane, below],
      [lane, above],
      [toX, above],
      [toX, to.y],
    ];
    return { path: roundedPath(points), labelX: lane - 6, labelY: (below + above) / 2, shape: to.y < from.y ? "back" : "skip" };
  }
  // Side by side only between neighbours; past a card in between, go under the row.
  if (to.x > from.x && to.x - from.x <= from.width + SIBLING_GAP + 1) {
    const y = from.y + from.height / 2 + shift;
    const startX = from.x + from.width;
    const endX = to.x;
    const mid = (startX + endX) / 2;
    // A slight bow upwards: two neighbour edges in a row otherwise read as one line through the middle card.
    const bow = y - 14;
    return { path: `M ${startX} ${y} C ${mid} ${bow}, ${mid} ${bow}, ${endX} ${y}`, labelX: mid, labelY: bow, shape: "side" };
  }
  const fromX = from.x + from.width / 2 + shift;
  const toX = to.x + to.width / 2 + shift;
  const y = from.y + from.height;
  const depth = LAYER_GAP * 0.45 + Math.abs(slot) * 6;
  return { path: `M ${fromX} ${y} C ${fromX} ${y + depth}, ${toX} ${y + depth}, ${toX} ${y}`, labelX: (fromX + toX) / 2, labelY: y + depth * 0.75, shape: "under" };
}

/** An orthogonal polyline with its corners rounded, as an SVG path. */
export function roundedPath(points: readonly [number, number][], radius = 10): string {
  if (points.length === 0) return "";
  let path = `M ${points[0]![0]} ${points[0]![1]}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const [px, py] = points[i - 1]!;
    const [x, y] = points[i]!;
    const [nx, ny] = points[i + 1]!;
    const into = Math.min(radius, Math.hypot(x - px, y - py) / 2);
    const out = Math.min(radius, Math.hypot(nx - x, ny - y) / 2);
    const ax = x - Math.sign(x - px) * into;
    const ay = y - Math.sign(y - py) * into;
    const bx = x + Math.sign(nx - x) * out;
    const by = y + Math.sign(ny - y) * out;
    path += ` L ${ax} ${ay} Q ${x} ${y} ${bx} ${by}`;
  }
  const last = points[points.length - 1]!;
  return `${path} L ${last[0]} ${last[1]}`;
}

/**
 * Slots for edges that share a pair of boxes, in either direction: 0 for a
 * lone edge, then -1/+1, -2/+2 … around it.
 */
export function slots(pairs: readonly { from: string; to: string }[]): number[] {
  const seen = new Map<string, number>();
  return pairs.map(({ from, to }) => {
    const key = [from, to].sort().join("|");
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    if (index === 0) return 0;
    const step = Math.ceil(index / 2);
    return index % 2 === 1 ? step : -step;
  });
}

// ---------------------------------------------------------------------------
// The crew: who sits on which layer

export type CrewMemberRef = { key: string; groupId: string; lead: boolean };

/**
 * Layer 0 is the lead; then one layer per group, the lead's own group first,
 * in file order. Reads as the crew is built: the lead on top, the groups it
 * leads below.
 */
export function crewLayers(members: readonly CrewMemberRef[]): string[][] {
  const lead = members.find((member) => member.lead);
  const order: string[] = [];
  if (lead) order.push(lead.groupId);
  for (const member of members) if (!order.includes(member.groupId)) order.push(member.groupId);
  const layers: string[][] = lead ? [[lead.key]] : [];
  for (const groupId of order) {
    const row = members.filter((member) => member.groupId === groupId && member !== lead).map((member) => member.key);
    if (row.length > 0) layers.push(row);
  }
  return layers;
}

// ---------------------------------------------------------------------------
// The project: crews layered by what they wait for

/**
 * A crew that waits for another sits below it (longest path over waitsFor);
 * crews that wait for nobody share the top layer. A cycle cannot push a crew
 * further than the number of crews.
 */
export function boardLayers(crews: readonly string[], waits: readonly { crew: string; source: string }[]): string[][] {
  const layer = new Map(crews.map((name) => [name, 0]));
  for (let round = 0; round < crews.length; round += 1) {
    let changed = false;
    for (const wait of waits) {
      const above = layer.get(wait.source);
      const below = layer.get(wait.crew);
      if (above === undefined || below === undefined || wait.source === wait.crew) continue;
      if (below <= above) {
        layer.set(wait.crew, above + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const depth = Math.max(0, ...layer.values());
  return Array.from({ length: depth + 1 }, (_, index) => crews.filter((name) => layer.get(name) === index)).filter((row) => row.length > 0);
}

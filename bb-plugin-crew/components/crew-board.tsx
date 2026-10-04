// The project overview as a canvas (§3.9 "Oberfläche"), drawn the way Graph
// Studio draws a graph: crews are cards in layers from top to bottom — a crew
// that waits for another sits below it — and the leads' talk and waitsFor are
// computed paths (lib/canvas-layout.ts). On a narrow panel the rows wrap, so
// a phone shows the crews one under another instead of a shrunken grid.
import { useEffect, useMemo, type ReactNode } from "react";
import { Controls, Handle, Position, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { boardLayers, MARGIN, pathBetween, perRow, placeLayers, slots, type Box } from "../lib/canvas-layout";
import { FLOW_THEME, useHostColorMode, useWidth } from "./crew-topology";

export const CARD_W = 240;
export const CARD_H = 112;
const LANE_ROOM = 48;

export type BoardLine = { kind: "lead" | "wait"; from: string; to: string; label: string; live: boolean };

const LINE_STROKE = { lead: "var(--primary)", wait: "var(--muted-foreground)" } as const;

type CardData = { content: ReactNode };
type LineData = { line: BoardLine; path: string; labelX: number; labelY: number };

function CardNode({ data }: NodeProps<Node<CardData>>) {
  return (
    <div className="relative h-full w-full cursor-pointer">
      <Handle type="target" position={Position.Top} isConnectable={false} className="!pointer-events-none !opacity-0" />
      {data.content}
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="!pointer-events-none !opacity-0" />
    </div>
  );
}

/** A lead-to-lead or waitsFor line along its computed path; a dot runs along a lead line while the leads talk. */
function LineEdge({ id, data }: EdgeProps<Edge<LineData>>) {
  if (!data) return null;
  const { line, path, labelX, labelY } = data;
  const stroke = LINE_STROKE[line.kind];
  return (
    <g data-board-edge={line.kind} data-edge-id={id}>
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.5} strokeDasharray={line.kind === "wait" ? "5 4" : undefined} markerEnd={`url(#crew-board-arrow-${line.kind})`} />
      {line.live ? (
        <circle r={3.5} fill={stroke}>
          <animateMotion dur="2s" repeatCount="indefinite" path={path} />
        </circle>
      ) : null}
      <text x={labelX} y={labelY} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 10 }}>
        <tspan dy="-4" style={{ paintOrder: "stroke", stroke: "var(--background)", strokeWidth: 4 }}>
          {line.label}
        </tspan>
      </text>
    </g>
  );
}

const NODE_TYPES = { card: CardNode };
const EDGE_TYPES = { line: LineEdge };
// Room around the cards so the bottom-left zoom controls never sit on one.
const FIT = { padding: 0.15, maxZoom: 1 } as const;

function Fit({ layoutKey }: { layoutKey: string }) {
  const flow = useReactFlow();
  const ready = useNodesInitialized();
  useEffect(() => {
    if (ready) void flow.fitView({ ...FIT, duration: 200 });
  }, [ready, flow, layoutKey]);
  return null;
}

/** Boxes and line paths for the board, pure: crews layered by waitsFor, rows wrapped at `maxPerRow`. */
export function buildBoard(names: readonly string[], lines: readonly BoardLine[], maxPerRow = Infinity) {
  const waits = lines.filter((line) => line.kind === "wait").map((line) => ({ crew: line.from, source: line.to }));
  const placed = placeLayers(boardLayers(names, waits), { width: CARD_W, height: CARD_H }, maxPerRow);
  const byId = new Map<string, Box>(placed.boxes.map((box) => [box.id, box]));
  const known = lines.filter((line) => byId.has(line.from) && byId.has(line.to) && line.from !== line.to);
  const slotOf = slots(known);
  const edges: Edge<LineData>[] = known.map((line, index) => ({
    id: `${line.kind}:${line.from}->${line.to}:${index}`,
    source: line.from,
    target: line.to,
    type: "line",
    data: { line, ...pathBetween(byId.get(line.from)!, byId.get(line.to)!, slotOf[index]!, placed.width - MARGIN / 2) },
  }));
  return { boxes: placed.boxes, edges, width: placed.width + LANE_ROOM, height: placed.height };
}

export function CrewBoardCanvas({
  names,
  lines,
  renderCard,
  onOpen,
}: {
  /** Crew names in card order. */
  names: readonly string[];
  lines: readonly BoardLine[];
  renderCard: (name: string) => ReactNode;
  onOpen?: (name: string) => void;
}) {
  const [hostRef, colorMode] = useHostColorMode();
  const panelWidth = useWidth(hostRef);
  const maxPerRow = panelWidth > 0 ? perRow(panelWidth - LANE_ROOM, CARD_W) : Infinity;
  const board = useMemo(() => buildBoard(names, lines, maxPerRow), [names, lines, maxPerRow]);
  const nodes: Node<CardData>[] = board.boxes.map((box) => ({
    id: box.id,
    type: "card",
    position: { x: box.x, y: box.y },
    width: box.width,
    height: box.height,
    style: { width: box.width, height: box.height },
    draggable: false,
    selectable: false,
    data: { content: renderCard(box.id) },
  }));
  // BBP-81: fills the height its parent gives it, as Graph Studio's canvas
  // does, and fits the cards into it — a fixed height left them hanging at the top.
  return (
    <div ref={hostRef} aria-label="Crew board" className="relative min-h-[320px] flex-1 overflow-hidden rounded-lg border border-border bg-background">
      <svg width="0" height="0" className="absolute" aria-hidden>
        <defs>
          {(["lead", "wait"] as const).map((kind) => (
            <marker key={kind} id={`crew-board-arrow-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={LINE_STROKE[kind]} />
            </marker>
          ))}
        </defs>
      </svg>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={board.edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          colorMode={colorMode}
          style={FLOW_THEME}
          fitView
          fitViewOptions={FIT}
          minZoom={0.3}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnScroll={false}
          preventScrolling={false}
          zoomOnDoubleClick={false}
          // On a touch screen a drag over the board must scroll the panel, not pan the board.
          panOnDrag={panelWidth === 0 || panelWidth >= 640}
          proOptions={{ hideAttribution: true }}
          // The whole card opens the crew, as a node opens its card in Graph Studio;
          // its own buttons (Merge, Reject) stop the click before it gets here.
          onNodeClick={(_event, node) => onOpen?.(node.id)}
        >
          {panelWidth === 0 || panelWidth >= 640 ? <Controls showInteractive={false} position="bottom-left" /> : null}
          <Fit layoutKey={`${board.width}x${board.height}`} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

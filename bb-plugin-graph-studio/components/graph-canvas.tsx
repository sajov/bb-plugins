// The graph canvas.
//
// React Flow over the shared layout in lib/layout.ts. The layout stays
// computed — positions are not part of a graph, so a node that could be dragged
// would snap back on the next change and suggest a state that is never saved.
// React Flow brings what the plain SVG lacked: pan and zoom on big graphs,
// clickable nodes and edges, and handles to draw a new edge by dragging.
//
// Edges are drawn along the layout's own paths rather than React Flow's, so a
// back edge still bows out to the right and a cycle reads as a cycle. Colours
// come from the BB theme's CSS variables, as before.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ControlButton,
  Controls,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type ColorMode,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  getBezierPath,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  END_NODE,
  KIND_LABEL,
  START_NODE,
  nodeExecution,
  spawnsThread,
  type NodeExecution,
  type Graph,
  type GraphNode,
} from "../lib/graph";
import { MARGIN, layoutGraph, type PlacedEdge } from "../lib/layout";
import { elapsedLabel } from "../lib/activity";
import { cn } from "@/lib/utils";

/**
 * Model ids are long and front-loaded with the vendor ("claude-opus-5"); the
 * part that distinguishes two nodes sits at the end, so the tail is what a
 * 172px node shows.
 */
function shortModel(model: string): string {
  // The vendor prefix and a trailing release date say the same on every node
  // of a graph; dropping them leaves "opus-5-5" instead of "…aude-opus-5-5".
  const tail = (model.split("/").pop() ?? model)
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "");
  return tail.length > 16 ? `${tail.slice(0, 15)}…` : tail;
}

export type NodeVisualStatus =
  | "idle"
  | "running"
  | "done"
  | "failed"
  | "waiting";

export type GraphCanvasProps = {
  graph: Graph;
  /** Per-node run status; missing ids render as `idle`. */
  statuses?: Record<string, NodeVisualStatus>;
  /**
   * Branch progress for nodes that run fanned out. A node running n times has
   * no single status, so it says "3 of 7 done" instead of pretending one.
   */
  branches?: Record<string, { done: number; total: number }>;
  /** Which node the inspector is showing. */
  selectedId?: string | null;
  onSelect?: (nodeId: string | null) => void;
  /**
   * Whether Start and End can be selected. Only the editor has something to
   * show for them — their edges; the run inspector has no run data for a
   * terminal and would open on nothing.
   */
  terminalsSelectable?: boolean;
  /**
   * Drawing an edge by dragging from one node's lower handle to another's
   * upper one. Given only by the editor; without it the canvas offers no
   * handles, so a live run cannot look editable.
   */
  onConnect?: (from: string, to: string) => void;
  /**
   * A click on an edge. The editor opens the source's card on its Edges tab;
   * without it, the click selects the source node like a node click would.
   */
  onEdgeSelect?: (from: string) => void;
  /** Offers a "+" on each drawn edge that splices a new node into it. */
  onInsertOnEdge?: (from: string, to: string) => void;
  /**
   * The node to keep in view while a run moves — usually the one working.
   * Following stops the moment the reader pans, and a control resumes it:
   * a viewport that jumps away while someone is reading is worse than none.
   */
  followIds?: string[];
  /**
   * Moving a node by dragging it. Given only by the editor; the position is
   * stored with the graph, so the canvas is laid out the way its author left
   * it. Without it nodes stay where the computed layout puts them.
   */
  onMoveNode?: (id: string, x: number, y: number) => void;
  /**
   * Resolves an imported graph. A subgraph node then shows what it imports
   * and can be opened in place, inside the main graph.
   */
  resolveGraph?: (id: string) => Graph | null;
  /** How often each node has run so far, shown against its visit limit. */
  visits?: Record<string, number>;
  /**
   * Dims the nodes the run never reached, so the path it took stands out.
   * Only once a run has started — before that every node is unreached.
   */
  dimUnreached?: boolean;
  /** Draw the edge into this node highlighted — the path the run just took. */
  activeEdgeKeys?: Set<string>;
  /**
   * Live signs of life for running nodes: since when, and what the worker is
   * doing. A node can sit in `running` for ten minutes, and without these two
   * the canvas says exactly as much in minute ten as in minute one.
   */
  activity?: Record<string, { startedAt: number | null; text: string | null }>;
  /**
   * "Now", for the elapsed times. Passed in rather than read here so the whole
   * canvas ticks on one clock the owner controls — and so a test can state
   * what time it is.
   */
  now?: number;
  /** How long each finished node ran, shown where the running clock was. */
  durations?: Record<string, string>;
  /**
   * Extra classes on the container — in practice a height cap. The canvas is
   * as tall as the layout needs, and a layered graph grows downwards: eight
   * layers are already over a thousand pixels. Without a cap the preview
   * pushes everything below it off the screen, which is the opposite of what a
   * preview is for. Beyond the cap, pan and zoom take over from scrolling.
   */
  className?: string;
};

const STATUS_FILL: Record<NodeVisualStatus, string> = {
  idle: "var(--card)",
  running: "color-mix(in oklab, var(--primary) 14%, var(--card))",
  done: "color-mix(in oklab, var(--primary) 7%, var(--card))",
  failed: "color-mix(in oklab, var(--destructive) 12%, var(--card))",
  waiting: "color-mix(in oklab, var(--primary) 20%, var(--card))",
};

const STATUS_STROKE: Record<NodeVisualStatus, string> = {
  idle: "var(--border)",
  running: "var(--primary)",
  done: "color-mix(in oklab, var(--primary) 55%, var(--border))",
  failed: "var(--destructive)",
  waiting: "var(--primary)",
};

const STATUS_DOT: Record<NodeVisualStatus, string> = {
  idle: "color-mix(in oklab, var(--muted-foreground) 50%, transparent)",
  running: "var(--primary)",
  done: "color-mix(in oklab, var(--primary) 70%, var(--foreground))",
  failed: "var(--destructive)",
  waiting: "var(--primary)",
};

type Chip = { key: string; text: string; title?: string; strong?: boolean; quiet?: boolean };

/**
 * The kind colour of a member node. The only kind with one, because it is the
 * only kind whose card stands for something outside the graph — a persistent
 * thread that outlives the run — and that must be visible before anyone reads
 * the kind line. Kept off `node.color`, which stays the user's own choice.
 */
export const MEMBER_ACCENT = "#0AC5B3";

/**
 * The facts a card has room for, most telling first: which model, how hard it
 * thinks, which skills it follows, what it hands on. Anything left at its
 * default stays off the card — a chip that is always there says nothing.
 */
export function nodeChips(node: GraphNode, execution: NodeExecution | null): Chip[] {
  const chips: Chip[] = [];
  // A member node's "model" is who does the step: the address is the fact
  // that tells two member nodes apart.
  if (node.kind === "member") {
    const address = node.member.trim();
    chips.push(
      address
        ? { key: "member", text: address, title: `Crew member ${address}`, strong: true }
        : { key: "member", text: "no member", title: "Choose a member@crew", quiet: true },
    );
  }
  if (spawnsThread(node)) {
    if (execution) {
      chips.push({
        key: "model",
        text: shortModel(execution.model),
        title: `${execution.providerId} / ${execution.model}`,
        strong: true,
      });
      if (execution.reasoningLevel) {
        chips.push({ key: "reasoning", text: execution.reasoningLevel, title: "Reasoning level" });
      }
      if (execution.serviceTier === "fast") {
        chips.push({ key: "tier", text: "⚡ fast", title: "Fast service tier" });
      }
    } else {
      chips.push({
        key: "model",
        text: "inherits model",
        title: "Runs on the parent thread's provider and model",
        quiet: true,
      });
    }
  }
  if (node.skills.length > 0) {
    chips.push({
      key: "skills",
      text: node.skills.length === 1 ? "1 skill" : `${node.skills.length} skills`,
      title: node.skills.join(", "),
    });
  }
  if (node.fields.length > 0) {
    chips.push({
      key: "fields",
      text: node.fields.length === 1 ? "1 field" : `${node.fields.length} fields`,
      title: node.fields.map((field) => field.name).join(", "),
    });
  }
  return chips;
}

const STATUS_LABEL: Record<NodeVisualStatus, string> = {
  idle: "open",
  running: "running",
  done: "done",
  failed: "failed",
  waiting: "waiting",
};

type StepData = {
  node: GraphNode;
  status: NodeVisualStatus;
  statusText: string;
  selected: boolean;
  elapsed: string | null;
  doing: string | null;
  visits: number;
  dim: boolean;
  connectable: boolean;
  onActivate: () => void;
  /** The graph a subgraph node imports, when it can be resolved. */
  child: Graph | null;
  childStatuses: Record<string, NodeVisualStatus>;
  expanded: boolean;
  onToggleExpand: (() => void) | null;
};

type TerminalData = {
  label: string;
  selected: boolean;
  /** Start only has a way out, End only a way in. */
  handle: "source" | "target";
  connectable: boolean;
  onActivate: (() => void) | null;
};

type LayoutEdgeData = {
  placed: PlacedEdge;
  active: boolean;
  onInsert: (() => void) | null;
};

type StepNode = Node<StepData, "step">;
type TerminalNode = Node<TerminalData, "terminal">;
type LayoutEdge = Edge<LayoutEdgeData, "layout">;

/**
 * Handles only where an edge can be drawn. Hidden rather than absent in a
 * read-only canvas: React Flow anchors nothing to them there, but an edge
 * without a handle to start from logs a warning for every render.
 */
function handleClass(connectable: boolean): string {
  return cn(
    "!size-2.5 !border-border !bg-muted-foreground",
    !connectable && "!pointer-events-none !opacity-0",
  );
}

/** Enter and Space activate, like the button the node claims to be. */
function activateOnKey(onActivate: (() => void) | null) {
  return (event: React.KeyboardEvent) => {
    if (!onActivate) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivate();
    }
  };
}

function TerminalView({ data }: NodeProps<TerminalNode>) {
  return (
    <div
      className={cn(
        "flex h-full w-full items-center justify-center",
        data.onActivate && "cursor-pointer",
      )}
      role={data.onActivate ? "button" : undefined}
      tabIndex={data.onActivate ? 0 : undefined}
      aria-label={data.onActivate ? data.label : undefined}
      aria-pressed={data.onActivate ? data.selected : undefined}
      onKeyDown={activateOnKey(data.onActivate)}
    >
      <Handle
        type={data.handle}
        position={data.handle === "source" ? Position.Bottom : Position.Top}
        isConnectable={data.connectable}
        className={handleClass(data.connectable)}
      />
      <span
        className="rounded-full bg-muted px-4 py-1 text-[11px] text-muted-foreground"
        style={{
          border: `${data.selected ? 2.5 : 1}px solid ${data.selected ? "var(--primary)" : "var(--border)"}`,
        }}
      >
        {data.label}
      </span>
    </div>
  );
}

function StepView({ data }: NodeProps<StepNode>) {
  const { node, status, statusText, selected, elapsed, doing, visits, dim, child } = data;
  // A node on its own model is drawn exactly like one that inherits, and that
  // difference is what explains two agents behaving differently. The short
  // name is enough on the canvas; the full one is in the tooltip and the
  // editor.
  const execution = nodeExecution(node);
  const chips = nodeChips(node, execution);
  const kindLine =
    node.kind === "subgraph"
      ? `imports ${child?.name ?? (node.graphId || "nothing yet")}`
      : KIND_LABEL[node.kind];

  return (
    <div
      className={cn("relative h-full w-full cursor-pointer", dim && "opacity-45")}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={[node.label, statusText, elapsed, doing]
        .filter((part) => part !== null && part !== undefined && part !== "")
        .join(" — ")}
      onKeyDown={activateOnKey(data.onActivate)}
    >
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={data.connectable}
        className={handleClass(data.connectable)}
      />
      <div
        className="flex h-full w-full flex-col justify-between overflow-hidden rounded-[10px] py-1.5 pl-3 pr-2.5 shadow-sm"
        style={{
          background: STATUS_FILL[status],
          border: `${selected ? 2.5 : 1.5}px solid ${selected ? "var(--primary)" : STATUS_STROKE[status]}`,
        }}
        data-kind={node.kind}
      >
        {node.kind === "member" ? (
          <span
            aria-hidden
            data-testid="member-accent"
            className="pointer-events-none absolute inset-x-0 top-0 h-[3px] rounded-t-[10px]"
            style={{ background: MEMBER_ACCENT }}
          />
        ) : null}
        {/* The user's colour as a spine plus a faint wash — enough to group
            cards at a glance, too little to fight the status colours. */}
        {node.color ? (
          <>
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-[10px]"
              style={{
                background: `linear-gradient(90deg, color-mix(in oklab, ${node.color} 16%, transparent), transparent 70%)`,
              }}
            />
            <span
              aria-hidden
              data-testid="node-color"
              className="pointer-events-none absolute inset-y-[5px] left-[3px] w-[3px] rounded-full"
              style={{ background: node.color }}
            />
          </>
        ) : null}
        {status === "running" ? (
          // The marching border, as before: a dashed outline whose offset
          // runs, so a running node moves even while its text stands still.
          <svg
            className="pointer-events-none absolute inset-0 overflow-visible"
            width="100%"
            height="100%"
            aria-hidden
          >
            <rect
              x="0"
              y="0"
              width="100%"
              height="100%"
              rx={10}
              fill="none"
              stroke="var(--primary)"
              strokeWidth={2}
              strokeDasharray="6 6"
            >
              <animate
                attributeName="stroke-dashoffset"
                from="24"
                to="0"
                dur="1s"
                repeatCount="indefinite"
              />
            </rect>
          </svg>
        ) : null}
        <div className="relative flex items-center justify-between gap-2 text-[9px] uppercase tracking-[0.06em] text-muted-foreground">
          <span className="truncate">
            {kindLine}
            {/* Two nodes with the same edges branch completely differently
                under `every`, and the drawing alone cannot show it: the
                arrows look identical. Said here, or the graph lies. */}
            {node.routing === "every" ? " · any match" : ""}
          </span>
          <span className="flex shrink-0 items-center gap-1 normal-case tracking-normal">
            <span
              aria-hidden
              className={cn("size-1.5 rounded-full", status === "running" && "animate-pulse")}
              style={{ background: STATUS_DOT[status] }}
            />
            {statusText}
          </span>
        </div>
        <div className="relative flex items-baseline justify-between gap-2">
          <span className="truncate text-xs font-medium text-foreground" title={node.label}>
            {node.label}
          </span>
          {node.maxVisits > 1 ? (
            // In a run the count so far is the news: a loop on its third of
            // three rounds is about to give up.
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {visits > 0 ? `${visits}/${node.maxVisits}×` : `max ${node.maxVisits}×`}
            </span>
          ) : null}
        </div>
        {/* A node on its own model is drawn exactly like one that inherits,
            and that difference is what explains two agents behaving
            differently — so the model gets a chip, and inheriting says so. */}
        <div className="relative flex min-h-[15px] items-center gap-1 overflow-hidden">
          {chips.map((chip) => (
            <span
              key={chip.key}
              className={cn(
                "shrink-0 truncate rounded-[4px] px-1 text-[9px] leading-[14px]",
                chip.strong
                  ? "max-w-[92px] font-medium text-foreground"
                  : "bg-muted text-muted-foreground",
                chip.quiet && "bg-transparent px-0 italic",
              )}
              style={chip.strong ? { background: "color-mix(in oklab, var(--primary) 14%, transparent)" } : undefined}
              title={chip.title}
            >
              {chip.text}
            </span>
          ))}
          {/* Bottom right: the running clock, and once the node has stopped
              how long it ran. */}
          {elapsed ? (
            <span
              className={cn(
                "ml-auto shrink-0 pl-1 text-[10px] tabular-nums",
                status === "running" ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {elapsed}
            </span>
          ) : null}
        </div>
      </div>
      {/* A subgraph node is an import: the imported graph opens in place,
          inside the main graph, instead of on a page of its own. */}
      {node.kind === "subgraph" && child && data.onToggleExpand ? (
        <button
          type="button"
          className="nodrag absolute -right-2 -top-2 flex size-5 items-center justify-center rounded-full border border-border bg-card text-[11px] text-muted-foreground hover:border-primary hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation();
            data.onToggleExpand?.();
          }}
          aria-expanded={data.expanded}
          aria-label={`${data.expanded ? "Close" : "Open"} the imported graph ${child.name}`}
        >
          {data.expanded ? "−" : "+"}
        </button>
      ) : null}
      {node.kind === "subgraph" && child && data.expanded ? (
        <div
          className="nodrag absolute left-0 top-full z-10 mt-2 rounded-lg border border-dashed border-primary/60 bg-background/95 p-2 shadow-lg"
          onClick={(event) => event.stopPropagation()}
        >
          <p className="mb-1 text-[10px] text-muted-foreground">
            {child.name} · {child.nodes.length} nodes, share this run's state
          </p>
          <MiniGraph graph={child} statuses={data.childStatuses} />
        </div>
      ) : null}
      {/* Below the node, in the gap that holds the outgoing arrow: the node
          itself is 72px of three full text lines, and making every node taller
          for a line only running nodes ever show would charge every graph in
          the library for it. Opaque, so it wins against the arrow it
          crosses. */}
      {doing ? (
        <div
          className="absolute inset-x-1 top-full mt-[3px] truncate rounded-full bg-card px-2 text-center text-[9px] leading-4 text-muted-foreground"
          style={{
            border: "1px solid color-mix(in oklab, var(--primary) 40%, transparent)",
          }}
          title={doing}
        >
          {doing.length > 30 ? `${doing.slice(0, 29)}…` : doing}
        </div>
      ) : null}
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={data.connectable}
        className={handleClass(data.connectable)}
      />
    </div>
  );
}

/** Drawn along the layout's path, so back edges keep their arc on the right. */
function LayoutEdgeView({
  data,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: EdgeProps<LayoutEdge>) {
  if (!data) return null;
  const { placed, active, onInsert } = data;
  // Drawn from where the nodes actually are, not from the computed layout —
  // once an author moves a node, its arrows have to go with it. A back edge
  // still bows out to the right so a cycle reads as a cycle.
  let path: string;
  let labelX: number;
  let labelY: number;
  if (placed.isBack) {
    const lane = Math.max(sourceX, targetX) + 120;
    path = `M ${sourceX} ${sourceY} C ${lane} ${sourceY + 40}, ${lane} ${targetY - 40}, ${targetX} ${targetY}`;
    labelX = lane - 34;
    labelY = (sourceY + targetY) / 2;
  } else {
    [path, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
    });
  }
  const edge = { ...placed, path, labelX, labelY };
  return (
    <g>
      <path
        d={edge.path}
        fill="none"
        stroke={edge.isBack || active ? "var(--primary)" : "var(--border)"}
        strokeWidth={active || edge.isBack ? 2 : 1.5}
        // Three claims, three strokes: solid goes here, dashed goes here if a
        // condition holds, dotted may go here because a worker decides at run
        // time.
        strokeDasharray={
          edge.candidate ? "2 5" : edge.conditional ? "5 4" : undefined
        }
        opacity={edge.candidate ? 0.7 : undefined}
        markerEnd={`url(#${edge.isBack ? "gs-arrow-back" : "gs-arrow"})`}
      />
      {/* A wide invisible twin, so a 1.5px line can be hit with a pointer. */}
      <path d={edge.path} fill="none" stroke="transparent" strokeWidth={14} />
      {edge.label ? (
        <text
          x={edge.labelX}
          y={edge.labelY}
          textAnchor={edge.isBack ? "end" : "middle"}
          className="fill-muted-foreground"
          style={{ fontSize: 10 }}
        >
          <tspan
            dy="-3"
            style={{
              paintOrder: "stroke",
              stroke: "var(--background)",
              strokeWidth: 4,
            }}
          >
            {edge.label}
          </tspan>
        </text>
      ) : null}
      {onInsert ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="nodrag nopan pointer-events-auto absolute flex size-4 items-center justify-center rounded-full border border-border bg-card text-[11px] leading-none text-muted-foreground opacity-60 hover:border-primary hover:text-foreground hover:opacity-100"
            style={{
              // Below the caption, so the two never cover each other.
              transform: `translate(-50%, -50%) translate(${edge.labelX}px, ${edge.labelY + (edge.label ? 10 : 0)}px)`,
            }}
            onClick={onInsert}
            aria-label={`Insert a node between ${edge.from} and ${edge.to}`}
          >
            +
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </g>
  );
}

/**
 * An imported graph, drawn small and static inside the node that imports it.
 * Plain SVG over the same layout: it is read, not edited — the imported graph
 * is edited as a graph of its own.
 */
export function MiniGraph({
  graph,
  statuses = {},
  scale = 0.62,
}: {
  graph: Graph;
  statuses?: Record<string, NodeVisualStatus>;
  scale?: number;
}) {
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return (
    <svg
      width={layout.width * scale}
      height={layout.height * scale}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label={`Imported graph ${graph.name}`}
    >
      {layout.edges.map((edge) => (
        <path
          key={edge.key}
          d={edge.path}
          fill="none"
          stroke={edge.isBack ? "var(--primary)" : "var(--border)"}
          strokeWidth={1.5}
          strokeDasharray={edge.conditional ? "5 4" : undefined}
          markerEnd="url(#gs-arrow)"
        />
      ))}
      {layout.nodes.map((placed) => {
        const terminal = placed.id === START_NODE || placed.id === END_NODE;
        const status = statuses[placed.id] ?? "idle";
        return (
          <g key={placed.id}>
            <rect
              x={terminal ? placed.x + placed.width / 2 - 34 : placed.x}
              y={terminal ? placed.y + placed.height / 2 - 13 : placed.y}
              width={terminal ? 68 : placed.width}
              height={terminal ? 26 : placed.height}
              rx={terminal ? 13 : 10}
              fill={terminal ? "var(--muted)" : STATUS_FILL[status]}
              stroke={terminal ? "var(--border)" : STATUS_STROKE[status]}
              strokeWidth={1.5}
            />
            <text
              x={placed.x + placed.width / 2}
              y={placed.y + placed.height / 2 + 4}
              textAnchor="middle"
              className={terminal ? "fill-muted-foreground" : "fill-foreground"}
              style={{ fontSize: 12 }}
            >
              {placed.id === START_NODE
                ? "Start"
                : placed.id === END_NODE
                  ? "End"
                  : (byId.get(placed.id)?.label ?? placed.id).slice(0, 22)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * Keeps the working nodes centred. One node is centred at the current zoom;
 * several are fitted together, never zooming in past where the reader is.
 * Lives inside the provider because the viewport API does.
 */
function FollowNodes({
  ids,
  positions,
  paused,
}: {
  ids: string[];
  positions: Map<string, { x: number; y: number; width: number; height: number }>;
  paused: boolean;
}) {
  const flow = useReactFlow();
  const key = ids.join("|");
  useEffect(() => {
    if (paused || ids.length === 0) return;
    const boxes = ids.map((id) => positions.get(id)).filter((box) => box !== undefined);
    if (boxes.length === 0) return;
    if (boxes.length === 1) {
      const box = boxes[0]!;
      void flow.setCenter(box.x + box.width / 2, box.y + box.height / 2, {
        zoom: flow.getZoom(),
        duration: 400,
      });
      return;
    }
    void flow.fitView({
      nodes: ids.map((id) => ({ id })),
      duration: 400,
      padding: 0.3,
      maxZoom: Math.max(flow.getZoom(), 0.5),
    });
    // `positions` changes on every render; the ids are what decides a move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, key, paused]);
  return null;
}

const NODE_TYPES = { step: StepView, terminal: TerminalView };
const EDGE_TYPES = { layout: LayoutEdgeView };

/**
 * React Flow's chrome in the host theme. Its defaults are a light theme of
 * their own, which reads as a foreign widget inside BB's dark one.
 */
const THEME = {
  "--xy-background-color": "var(--background)",
  "--xy-node-background-color": "var(--card)",
  "--xy-node-color": "var(--foreground)",
  "--xy-node-border": "none",
  "--xy-edge-label-background-color": "var(--background)",
  "--xy-edge-label-color": "var(--muted-foreground)",
  "--xy-handle-background-color": "var(--muted-foreground)",
  "--xy-handle-border-color": "var(--border)",
  "--xy-controls-button-background-color": "var(--card)",
  "--xy-controls-button-background-color-hover": "var(--muted)",
  "--xy-controls-button-color": "var(--foreground)",
  "--xy-controls-button-color-hover": "var(--foreground)",
  "--xy-controls-button-border-color": "var(--border)",
  "--xy-controls-box-shadow": "none",
  "--xy-connectionline-stroke-default": "var(--primary)",
  "--xy-attribution-background-color": "transparent",
} as CSSProperties;

/**
 * Lightness of a computed CSS colour, 0 to 1. The host resolves its theme
 * tokens to rgb(), oklch() or oklab() depending on how the theme is written,
 * so all three are read.
 */
export function colorLightness(color: string): number | null {
  const ok = color.match(/^okl(?:ch|ab)\(\s*([\d.]+)(%?)/);
  if (ok) return Number(ok[1]) / (ok[2] === "%" ? 100 : 1);
  const rgb = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (rgb) {
    const [r, g, b] = rgb.slice(1, 4).map(Number) as [number, number, number];
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }
  return null;
}

/**
 * React Flow's colour mode, taken from the BB theme actually on screen. Left at
 * its default, React Flow paints its own chrome light — white controls and
 * surfaces inside a dark BB, which is what made the canvas look foreign.
 */
export function useHostColorMode(): [React.RefObject<HTMLDivElement | null>, ColorMode] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<ColorMode>("system");
  const measure = useCallback(() => {
    if (!ref.current || typeof getComputedStyle !== "function") return;
    const lightness = colorLightness(getComputedStyle(ref.current).backgroundColor);
    if (lightness !== null) setMode(lightness < 0.5 ? "dark" : "light");
  }, []);
  useLayoutEffect(measure);
  // BBP-82: BB switches the theme by class on <html> without re-rendering the
  // plugin; measured only on render, the canvas kept the theme it opened in.
  useEffect(() => {
    if (typeof MutationObserver !== "function") return;
    const observer = new MutationObserver(measure);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    return () => observer.disconnect();
  }, [measure]);
  return [ref, mode];
}

export function GraphCanvas(props: GraphCanvasProps) {
  // Own provider per canvas: the panel can show a run and a preview at once,
  // and two canvases sharing one store would share one viewport.
  return (
    <ReactFlowProvider>
      <GraphCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function GraphCanvasInner({
  graph,
  statuses = {},
  branches = {},
  selectedId = null,
  onSelect,
  terminalsSelectable = false,
  onConnect,
  onEdgeSelect,
  onInsertOnEdge,
  followIds = [],
  onMoveNode,
  resolveGraph,
  visits = {},
  dimUnreached = false,
  activeEdgeKeys,
  activity = {},
  now,
  durations = {},
  className,
}: GraphCanvasProps) {
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const [hostRef, colorMode] = useHostColorMode();
  const byId = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph],
  );
  const connectable = onConnect !== undefined;
  // Set by a pan or zoom the reader made; a programmatic move has no event.
  const [followPaused, setFollowPaused] = useState(false);
  const toggle = (id: string) => onSelect?.(selectedId === id ? null : id);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  /** Where a node is while it is being dragged, before the move is stored. */
  const [dragging, setDragging] = useState<Record<string, { x: number; y: number }>>({});
  const movable = onMoveNode !== undefined;

  /** The layout, with every node the author placed moved to where they put it. */
  const placedNodes = layout.nodes.map((placed) => {
    const at = dragging[placed.id] ?? graph.positions?.[placed.id];
    return at ? { ...placed, x: at.x, y: at.y } : placed;
  });
  const boxes = new Map(placedNodes.map((placed) => [placed.id, placed]));
  const canvasHeight =
    Math.max(layout.height, ...placedNodes.map((placed) => placed.y + placed.height + MARGIN)) + 2;

  /**
   * A worker inside an imported graph has an id the main graph does not
   * draw; the node to centre on is the subgraph node that imports it.
   */
  const followTargets = followIds.map((id) => {
    if (boxes.has(id)) return id;
    const importer = graph.nodes.find(
      (node) =>
        node.kind === "subgraph" &&
        resolveGraph?.(node.graphId)?.nodes.some((inner) => inner.id === id),
    );
    return importer?.id ?? id;
  });
  const following = followTargets.length > 0;

  const onNodesChange = (changes: NodeChange[]) => {
    if (!movable) return;
    for (const change of changes) {
      if (change.type !== "position") continue;
      if (change.position) {
        const position = change.position;
        setDragging((current) => ({ ...current, [change.id]: position }));
      }
      if (change.dragging === false) {
        const final = change.position ?? dragging[change.id];
        if (final) onMoveNode(change.id, Math.round(final.x), Math.round(final.y));
        setDragging((current) => {
          const next = { ...current };
          delete next[change.id];
          return next;
        });
      }
    }
  };

  const nodes = placedNodes.flatMap((placed): Array<StepNode | TerminalNode> => {
    const base = {
      id: placed.id,
      position: { x: placed.x, y: placed.y },
      // Given up front so React Flow draws the node on the first render
      // instead of hiding it until a ResizeObserver has measured it.
      width: placed.width,
      height: placed.height,
      // Where the handles sit, given up front for the same reason: React Flow
      // draws no edge until it knows both ends, and a measurement that never
      // comes (a hidden tab, a test) would leave the graph without arrows.
      handles: [
        { type: "target" as const, position: Position.Top, x: placed.width / 2 - 5, y: -5, width: 10, height: 10 },
        { type: "source" as const, position: Position.Bottom, x: placed.width / 2 - 5, y: placed.height - 5, width: 10, height: 10 },
      ],
      draggable: movable,
    };
    if (placed.id === START_NODE || placed.id === END_NODE) {
      const isStart = placed.id === START_NODE;
      return [
        {
          ...base,
          type: "terminal",
          selectable: terminalsSelectable,
          data: {
            label: isStart ? "Start" : "End",
            selected: terminalsSelectable && selectedId === placed.id,
            handle: isStart ? "source" : "target",
            connectable,
            onActivate: terminalsSelectable ? () => toggle(placed.id) : null,
          },
        },
      ];
    }
    const node = byId.get(placed.id);
    if (!node) return [];
    const status = statuses[placed.id] ?? "idle";
    // A fanned-out node reports its branches instead of one status: "3 of 7
    // done" is the honest answer where "done" would be a lie about the four
    // still running.
    const branch = branches[placed.id];
    // Signs of life, shown only while the node runs: the last tool call is no
    // longer news once it stops. The clock stays, as the time it ran.
    const live = status === "running" ? activity[placed.id] : undefined;
    return [
      {
        ...base,
        type: "step",
        data: {
          node,
          status,
          statusText: branch
            ? `${branch.done} of ${branch.total} done`
            : STATUS_LABEL[status],
          selected: selectedId === placed.id,
          elapsed:
            live && live.startedAt !== null && now !== undefined
              ? elapsedLabel(live.startedAt, now)
              : status === "done" || status === "failed"
                ? (durations[placed.id] ?? null)
                : null,
          doing: live?.text ?? null,
          visits: visits[placed.id] ?? 0,
          dim: dimUnreached && status === "idle" && !branch,
          connectable,
          onActivate: () => toggle(placed.id),
          child: node.kind === "subgraph" ? (resolveGraph?.(node.graphId) ?? null) : null,
          childStatuses: statuses,
          expanded: expanded.has(placed.id),
          onToggleExpand: resolveGraph
            ? () =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(placed.id)) next.delete(placed.id);
                  else next.add(placed.id);
                  return next;
                })
            : null,
        },
      },
    ];
  });

  const edges: LayoutEdge[] = layout.edges.map((placed, index) => ({
    // Two edges between the same pair are allowed (different conditions), so
    // the key alone would collide as an id.
    id: `${placed.key}#${index}`,
    source: placed.from,
    target: placed.to,
    type: "layout",
    data: {
      placed,
      active: activeEdgeKeys?.has(placed.key) ?? false,
      // Not on a drawn handoff candidate: that arrow is not an edge of the
      // graph, so there is nothing to splice into.
      onInsert:
        onInsertOnEdge && !placed.candidate
          ? () => onInsertOnEdge(placed.from, placed.to)
          : null,
    },
  }));

  return (
    <div
      ref={hostRef}
      className={cn(
        // `overflow-hidden` alone does not clip React Flow's transformed
        // viewport in WebKit once an ancestor is itself transformed (the
        // mobile sidebar drawer): the nodes escaped over the thread list.
        // `clip-path` clips composited layers too; `relative` and `isolate`
        // keep the absolutely positioned layers anchored to this box.
        "relative isolate h-[var(--gs-canvas-h)] overflow-hidden rounded-lg border border-border bg-background [clip-path:inset(0_round_0.5rem)]",
        className,
      )}
      style={{ "--gs-canvas-h": `${canvasHeight}px` } as CSSProperties}
      role="img"
      aria-label={`Graph ${graph.name}: ${graph.nodes.length} nodes, ${graph.edges.length} edges`}
    >
      <svg width="0" height="0" className="absolute" aria-hidden>
        <defs>
          <marker
            id="gs-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted-foreground)" />
          </marker>
          <marker
            id="gs-arrow-back"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--primary)" />
          </marker>
        </defs>
      </svg>
      <ReactFlow<StepNode | TerminalNode, LayoutEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        style={THEME}
        colorMode={colorMode}
        fitView
        // Never larger than the old drawing: a three-node graph blown up to
        // fill the panel reads as a different, clumsier picture.
        fitViewOptions={{ maxZoom: 1, padding: 0.04 }}
        minZoom={0.2}
        maxZoom={2}
        nodesDraggable={movable}
        onNodesChange={onNodesChange}
        // The library is MIT-licensed; the corner link is a request, not a
        // licence term, and in a side panel it competes with the graph.
        proOptions={{ hideAttribution: true }}
        nodesConnectable={connectable}
        // Only by dragging. React Flow also connects on two clicks — one on a
        // handle, one on another — and with movable nodes those handles sit
        // right where a node is grabbed: edges appeared nobody meant to draw.
        connectOnClick={false}
        elementsSelectable={false}
        // The canvas sits inside a scrolling panel. Taking the wheel for zoom
        // would trap the reader inside the graph; pinch and the controls zoom,
        // dragging pans, and the wheel keeps scrolling the panel.
        zoomOnScroll={false}
        preventScrolling={false}
        zoomOnDoubleClick={false}
        deleteKeyCode={null}
        onNodeClick={(_, clicked) => {
          if (clicked.type === "terminal" && !terminalsSelectable) return;
          toggle(clicked.id);
        }}
        // An edge is edited in the card of the node it leaves, so clicking it
        // opens that card.
        onEdgeClick={(_, clicked) => {
          if (onEdgeSelect) return onEdgeSelect(clicked.source);
          if (clicked.source === START_NODE && !terminalsSelectable) return;
          onSelect?.(clicked.source);
        }}
        onMoveStart={(event) => {
          if (event && following) setFollowPaused(true);
        }}
        onConnect={(connection: Connection) => {
          if (connection.source && connection.target) {
            onConnect?.(connection.source, connection.target);
          }
        }}
      >
        <Controls showInteractive={false} position="bottom-left">
          {following && followPaused ? (
            <ControlButton
              onClick={() => setFollowPaused(false)}
              aria-label="Follow the active node"
              title="Follow the active node"
            >
              <span className="text-[9px] font-medium">⌖</span>
            </ControlButton>
          ) : null}
        </Controls>
        <FollowNodes ids={followTargets} positions={boxes} paused={followPaused} />
      </ReactFlow>
    </div>
  );
}

export function CanvasLegend({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground",
        className,
      )}
    >
      <span className="inline-flex items-center gap-1.5">
        <svg width="22" height="8" aria-hidden>
          <line x1="0" y1="4" x2="22" y2="4" stroke="var(--border)" strokeWidth="2" />
        </svg>
        always
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="22" height="8" aria-hidden>
          <line
            x1="0"
            y1="4"
            x2="22"
            y2="4"
            stroke="var(--border)"
            strokeWidth="2"
            strokeDasharray="5 4"
          />
        </svg>
        conditional
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="22" height="8" aria-hidden>
          <line
            x1="0"
            y1="4"
            x2="22"
            y2="4"
            stroke="var(--border)"
            strokeWidth="2"
            strokeDasharray="2 5"
          />
        </svg>
        possible handoff
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="22" height="8" aria-hidden>
          <line x1="0" y1="4" x2="22" y2="4" stroke="var(--primary)" strokeWidth="2" />
        </svg>
        Back edge (cycle)
      </span>
    </div>
  );
}

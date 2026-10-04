// Topology tab (§4.6), drawn the way Graph Studio draws a graph: compact
// cards in layers from top to bottom — the lead on top, its groups below —
// and edges as computed paths (lib/canvas-layout.ts). Cards take the BB
// theme's own tokens, so the canvas reads as part of BB and not as a widget.
//
// Two layers of edges: the crew's links (assigns, works with, …) in muted
// strokes, and the messages members actually sent in the primary colour, a
// dot travelling along a flow while its talk is recent. Clicking a card picks
// the member; double-clicking opens its thread.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Controls, Handle, Position, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, type ColorMode, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ActivityDto, MemberDto, MessageDto } from "../server";
import { shownFlows, type Flow } from "../lib/comms";
import { crewLayers, MARGIN, pathBetween, placeLayers, slots, type Box } from "../lib/canvas-layout";
import { formatContextShare } from "../lib/format";
import { activityLabel, activityTone, hasErrorReason, LINK_STYLE, RUNNING, SEVERITY_TEXT, SEVERITY_TEXT_COLOR, severityTint, topReasonLabel } from "../lib/topology";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { InspectorFooter, InspectorHeader, InspectorRows } from "./inspector";

/** Graph Studio's card size. */
export const CARD_W = 172;
export const CARD_H = 72;
/** Room on the right for the lanes of edges that go back up. */
const LANE_ROOM = 56;

function shortModel(model: string | null): string {
  if (!model) return "?";
  return (model.split("/").pop() ?? model).replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

// ---------------------------------------------------------------------------
// Card

/** Activity in Graph Studio's status vocabulary: working runs, a decision or error waits on you, error failed. */
type Visual = "idle" | "running" | "decision" | "waiting" | "failed" | "off";
export function visualOf(view: ActivityDto | null, thread: MemberDto["thread"]): Visual {
  if (view && view.needsYou.length > 0) return hasErrorReason(view.needsYou) ? "waiting" : "decision";
  if (thread !== "present") return "off";
  switch (view?.activity) {
    case "working":
      return "running";
    case "error":
      return "failed";
    default:
      return "idle";
  }
}

const FILL: Record<Visual, string> = {
  idle: "var(--card)",
  off: "var(--card)",
  running: `color-mix(in oklab, ${RUNNING} 14%, var(--card))`,
  decision: "color-mix(in oklab, var(--warning) 12%, var(--card))",
  waiting: "color-mix(in oklab, var(--destructive) 12%, var(--card))",
  failed: "color-mix(in oklab, var(--destructive) 12%, var(--card))",
};
const STROKE: Record<Visual, string> = {
  idle: "var(--border)",
  off: "var(--border)",
  running: RUNNING,
  decision: "var(--warning)",
  waiting: "var(--destructive)",
  failed: "var(--destructive)",
};
const DOT: Record<Visual, string> = {
  idle: "color-mix(in oklab, var(--muted-foreground) 50%, transparent)",
  off: "color-mix(in oklab, var(--muted-foreground) 30%, transparent)",
  running: RUNNING,
  decision: "var(--warning)",
  waiting: "var(--destructive)",
  failed: "var(--destructive)",
};

export type MemberNodeData = { member: MemberDto; view: ActivityDto | null; selected: boolean };

export function MemberNode({ data }: NodeProps<Node<MemberNodeData>>) {
  const { member, view, selected } = data;
  const visual = visualOf(view, member.thread);
  const needs = visual === "waiting" || visual === "decision";
  const reason = needs ? topReasonLabel(view?.needsYou ?? []) : null;
  return (
    <div
      className={cn("relative h-full w-full cursor-pointer", visual === "off" && "opacity-55")}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${member.key}, ${activityLabel(view, member.thread)}`}
      data-member-node={member.key}
      data-activity={needs ? "needs-you" : (view?.activity ?? "unknown")}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} className="!pointer-events-none !opacity-0" />
      <div
        className="flex h-full w-full flex-col justify-between overflow-hidden rounded-[10px] py-1.5 pl-3 pr-2.5 shadow-sm"
        style={{ background: FILL[visual], border: `${selected ? 2.5 : 1.5}px solid ${selected ? "var(--primary)" : STROKE[visual]}` }}
      >
        {visual === "running" ? (
          // Graph Studio's marching border: a working member moves even while its text stands still.
          <svg className="pointer-events-none absolute inset-0 overflow-visible" width="100%" height="100%" aria-hidden>
            <rect x="0" y="0" width="100%" height="100%" rx={10} fill="none" stroke="var(--primary)" strokeWidth={2} strokeDasharray="6 6">
              <animate attributeName="stroke-dashoffset" from="24" to="0" dur="1s" repeatCount="indefinite" />
            </rect>
          </svg>
        ) : null}
        <div className="relative flex items-center justify-between gap-2 text-[9px] uppercase tracking-[0.06em] text-muted-foreground">
          <span className="truncate">{member.lead ? "lead" : member.groupId || "member"}</span>
          <span className="flex shrink-0 items-center gap-1 normal-case tracking-normal" style={needs ? { color: SEVERITY_TEXT_COLOR[visual === "decision" ? "decision" : "error"] } : undefined}>
            <span aria-hidden className={cn("size-1.5 rounded-full", visual === "running" && "animate-pulse")} style={{ background: DOT[visual] }} />
            {reason ?? (visual === "running" ? "working" : visual === "failed" ? "error" : null)}
          </span>
        </div>
        <span className="relative truncate text-xs font-medium text-foreground" title={member.address}>
          {member.key}
        </span>
        {/* Status first, then shift, then model, as before — the line the tests and the eye read.
            BBP-79: the model reads as a chip (mockup 1), not bare text in the sentence. */}
        <div data-member-meta className="relative line-clamp-2 break-words text-[10px] leading-[14px] text-muted-foreground">
          {activityLabel(view, member.thread)}
          {member.shift !== null ? ` · Shift ${member.shift}` : ""} ·{" "}
          <span className="inline-block rounded bg-muted px-1 py-px align-middle text-[9px] font-medium leading-[14px] text-foreground/80">
            {shortModel(member.model)}
          </span>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="!pointer-events-none !opacity-0" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edges

/** Message colour: the host's primary, so the talk reads apart from the links. */
const MESSAGE_STROKE = "var(--primary)";

export type PathEdgeData = {
  path: string;
  labelX: number;
  labelY: number;
  kind: string;
  /** Messages only. */
  count?: number;
  recent?: boolean;
  active?: boolean;
};

/** Every edge is a path computed by the layout, like Graph Studio's LayoutEdgeView. */
export function PathEdge({ id, data }: EdgeProps<Edge<PathEdgeData>>) {
  if (!data) return null;
  if (data.kind !== "message") {
    const style = LINK_STYLE[data.kind] ?? LINK_STYLE.works_with!;
    return (
      <g data-link-edge={data.kind}>
        <path d={data.path} fill="none" stroke={style.stroke} strokeWidth={1.25} strokeDasharray={style.dash} opacity={0.7} markerEnd={style.arrow ? "url(#crew-link-arrow)" : undefined} />
      </g>
    );
  }
  const live = Boolean(data.recent || data.active);
  const width = data.active ? 2.5 : Math.min(2.5, 1.25 + Math.log2(1 + (data.count ?? 1)) * 0.3);
  return (
    <g data-message-edge={id} data-recent={data.recent ? "true" : undefined} data-active={data.active ? "true" : undefined}>
      <title>{`${data.count ?? 0} messages`}</title>
      <path d={data.path} fill="none" stroke={MESSAGE_STROKE} strokeWidth={width} opacity={live ? 1 : 0.45} markerEnd="url(#crew-message-arrow)" />
      {/* A wide invisible twin, so a thin line can be hit with a pointer. */}
      <path d={data.path} fill="none" stroke="transparent" strokeWidth={14} />
      {live ? (
        <circle r={data.active ? 4 : 3} fill={MESSAGE_STROKE}>
          <animateMotion dur={data.active ? "1.2s" : "2.4s"} repeatCount="indefinite" path={data.path} />
        </circle>
      ) : null}
      {data.active ? (
        <text x={data.labelX} y={data.labelY} textAnchor="middle" className="fill-foreground" style={{ fontSize: 10 }}>
          <tspan dy="-4" style={{ paintOrder: "stroke", stroke: "var(--background)", strokeWidth: 4 }}>
            {data.count}×
          </tspan>
        </text>
      ) : null}
    </g>
  );
}

/** Arrow heads for link and message edges; any canvas drawing PathEdge needs them once. */
export function TopologyMarkers() {
  return (
    <defs>
      <marker id="crew-link-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted-foreground)" />
      </marker>
      <marker id="crew-message-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--primary)" />
      </marker>
    </defs>
  );
}

/** Holds the lane room inside the fitted view: React Flow fits nodes, not edges. */
function Spacer() {
  return null;
}

const NODE_TYPES = { member: MemberNode, spacer: Spacer };
const EDGE_TYPES = { path: PathEdge };

// ---------------------------------------------------------------------------
// The whole picture, pure

export type CrewCanvas = { boxes: Box[]; edges: Edge<PathEdgeData>[]; width: number; height: number };

/**
 * Boxes and edge paths for a crew. Links and message flows between the same
 * pair get their own slots, so a link, a message and the way back are three
 * curves and not one.
 */
export function buildCrewCanvas(
  members: readonly MemberDto[],
  links: readonly { from: string; to: string; kind: string }[],
  flows: readonly Flow[],
  recent: ReadonlySet<string>,
  active: string | null,
  maxPerRow = Infinity,
): CrewCanvas {
  const layers = crewLayers(members.map((member) => ({ key: member.key, groupId: member.groupId || member.key.split("-")[0]!, lead: member.lead })));
  const placed = placeLayers(layers, { width: CARD_W, height: CARD_H }, maxPerRow);
  const width = placed.width + LANE_ROOM;
  const byId = new Map(placed.boxes.map((box) => [box.id, box]));
  const known = links.filter((link) => byId.has(link.from) && byId.has(link.to) && link.from !== link.to);
  const pairs = [...known.map((link) => ({ from: link.from, to: link.to })), ...flows.map((flow) => ({ from: flow.from, to: flow.to }))];
  const slotOf = slots(pairs);
  const lane = placed.width - MARGIN / 2;
  const edges: Edge<PathEdgeData>[] = [];
  known.forEach((link, index) => {
    const route = pathBetween(byId.get(link.from)!, byId.get(link.to)!, slotOf[index]!, lane);
    edges.push({
      id: `${link.from}->${link.to}:${link.kind}`,
      source: link.from,
      target: link.to,
      type: "path",
      ariaLabel: `${link.from} ${(LINK_STYLE[link.kind] ?? LINK_STYLE.works_with!).label} ${link.to}`,
      data: { ...route, kind: link.kind },
    });
  });
  flows.forEach((flow, index) => {
    const from = byId.get(flow.from);
    const to = byId.get(flow.to);
    if (!from || !to) return;
    const route = pathBetween(from, to, slotOf[known.length + index]!, lane + 16);
    edges.push({
      id: flow.id,
      source: flow.from,
      target: flow.to,
      type: "path",
      zIndex: 1,
      ariaLabel: `${flow.from} messaged ${flow.to} ${flow.count} times`,
      data: { ...route, kind: "message", count: flow.count, recent: recent.has(flow.id), active: flow.id === active },
    });
  });
  return { boxes: placed.boxes, edges, width, height: placed.height };
}

// ---------------------------------------------------------------------------
// React Flow host

/** React Flow's chrome in the host theme — Graph Studio's mapping. */
export const FLOW_THEME = {
  "--xy-background-color": "var(--background)",
  "--xy-node-background-color": "var(--card)",
  "--xy-node-color": "var(--foreground)",
  "--xy-node-border": "none",
  "--xy-controls-button-background-color": "var(--card)",
  "--xy-controls-button-background-color-hover": "var(--muted)",
  "--xy-controls-button-color": "var(--foreground)",
  "--xy-controls-button-color-hover": "var(--foreground)",
  "--xy-controls-button-border-color": "var(--border)",
  "--xy-controls-box-shadow": "none",
  "--xy-attribution-background-color": "transparent",
} as CSSProperties;

/** Lightness 0–1 of a computed colour (rgb, oklch, oklab), as Graph Studio reads the theme. */
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

/** React Flow's colour mode from the BB theme on screen, so its chrome is never light inside a dark BB. */
export function useHostColorMode(): [React.RefObject<HTMLDivElement | null>, ColorMode] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<ColorMode>("system");
  const measure = useCallback(() => {
    if (!ref.current || typeof getComputedStyle !== "function") return;
    const lightness = colorLightness(getComputedStyle(ref.current).backgroundColor);
    if (lightness !== null) setMode(lightness < 0.5 ? "dark" : "light");
  }, []);
  useLayoutEffect(measure);
  // BBP-81: BB switches the theme by class on <html> without re-rendering the
  // plugin; measured only on render, the canvas kept the theme it opened in.
  useEffect(() => {
    if (typeof MutationObserver !== "function") return;
    const observer = new MutationObserver(measure);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    return () => observer.disconnect();
  }, [measure]);
  return [ref, mode];
}

/** The panel's width, for wrapping wide layers on a phone. */
export function useWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

const FIT = { padding: 0.04, maxZoom: 1 } as const;

/** Fits once measured and on resize; a selected message's pair is followed, as Graph Studio follows its active node. */
function Fit({ focus, layoutKey }: { focus: readonly string[]; layoutKey: string }) {
  const flow = useReactFlow();
  const ready = useNodesInitialized();
  const focusKey = focus.join("|");
  useEffect(() => {
    if (!ready) return;
    if (focus.length > 0) void flow.fitView({ nodes: focus.map((id) => ({ id })), duration: 400, padding: 0.5, maxZoom: 1 });
    else void flow.fitView({ ...FIT, duration: 300 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, flow, focusKey, layoutKey]);
  return null;
}

export function TopologyCanvas({
  members,
  links,
  activity,
  selected,
  onSelect,
  onOpen,
  flows = [],
  recent = new Set<string>(),
  activeFlow = null,
}: {
  members: MemberDto[];
  links: { from: string; to: string; kind: string }[];
  activity: ActivityDto[];
  selected: string | null;
  onSelect: (key: string) => void;
  onOpen?: (key: string) => void;
  flows?: readonly Flow[];
  recent?: ReadonlySet<string>;
  /** The flow of the selected message: drawn strongest and kept in view. */
  activeFlow?: string | null;
}) {
  const [hostRef, colorMode] = useHostColorMode();
  const panelWidth = useWidth(hostRef);
  // Wrap a wide group onto further rows when the panel is narrow: taller, never tiny.
  const maxPerRow = panelWidth > 0 ? Math.max(2, Math.floor((panelWidth - LANE_ROOM - 2 * MARGIN + 24) / (CARD_W + 24))) : Infinity;
  const views = useMemo(() => new Map(activity.map((view) => [view.key, view])), [activity]);
  const focus = useMemo(() => {
    const flow = flows.find((entry) => entry.id === activeFlow);
    return flow ? [flow.from, flow.to] : [];
  }, [flows, activeFlow]);
  // BBP-48: every possible link (crew.yaml's assigns_to, works_with, escalates_to,
  // can_read) stays drawn quietly on any panel width; only the active message
  // flows are narrowed down on a phone, where the structure is too dense.
  const drawnFlows = useMemo(() => shownFlows(flows, recent, activeFlow), [flows, recent, activeFlow]);
  const canvas = useMemo(
    () => buildCrewCanvas(members, links, drawnFlows, recent, activeFlow, maxPerRow),
    [members, links, drawnFlows, recent, activeFlow, maxPerRow],
  );
  const byKey = useMemo(() => new Map(members.map((member) => [member.key, member])), [members]);
  const nodes: Node[] = canvas.boxes.map((box) => ({
    id: box.id,
    type: "member",
    position: { x: box.x, y: box.y },
    width: box.width,
    height: box.height,
    style: { width: box.width, height: box.height },
    draggable: false,
    data: { member: byKey.get(box.id)!, view: views.get(box.id) ?? null, selected: box.id === selected },
  }));
  // Two corners of the drawing as invisible nodes: React Flow fits nodes, not edges,
  // and the corridors and the lane lie outside the cards.
  nodes.push(
    { id: "__corner-a", type: "spacer", position: { x: 0, y: 0 }, width: 1, height: 1, draggable: false, selectable: false, data: {} },
    { id: "__corner-b", type: "spacer", position: { x: canvas.width - 1, y: canvas.height - 1 }, width: 1, height: 1, draggable: false, selectable: false, data: {} },
  );
  // As tall as the drawing, like Graph Studio — not a fixed share of the window.
  // The drawing is scaled down to the panel's width; the box follows, or a phone shows a screen of empty canvas.
  const scale = panelWidth > 0 ? Math.min(1, panelWidth / canvas.width) : 1;
  const height = Math.min(640, Math.max(160, canvas.height * scale + 2));
  return (
    <div
      ref={hostRef}
      className="relative w-full min-w-0 overflow-hidden rounded-lg border border-border bg-background @3xl:flex-1"
      style={{ height }}
      aria-label="Topology"
    >
      <svg width="0" height="0" className="absolute" aria-hidden>
        <TopologyMarkers />
      </svg>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={canvas.edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          colorMode={colorMode}
          style={FLOW_THEME}
          fitView
          fitViewOptions={FIT}
          minZoom={0.2}
          maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          // As in Graph Studio: the wheel keeps scrolling the panel; pinch and the controls zoom.
          zoomOnScroll={false}
          preventScrolling={false}
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_event, node) => node.type === "member" && onSelect(node.id)}
          onNodeDoubleClick={(_event, node) => node.type === "member" && onOpen?.(node.id)}
        >
          {/* On a phone the buttons would sit on the cards; pinch zooms there. */}
          {panelWidth === 0 || panelWidth >= 640 ? <Controls showInteractive={false} position="bottom-left" /> : null}
          <Fit focus={focus} layoutKey={`${canvas.width}x${canvas.height}`} />
        </ReactFlow>
      </ReactFlowProvider>
      {/* The same links as text: React Flow draws edges only after measuring, and screen readers need them anyway. */}
      <ul className="sr-only" aria-label="Links">
        {links.map((link) => (
          <li key={`${link.from}-${link.to}-${link.kind}`} data-link-kind={link.kind}>
            {link.from} {link.kind} {link.to}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The legend under the canvas, Graph Studio's CanvasLegend: one line per stroke that is on screen. */
export function TopologyLegend({ kinds, messages }: { kinds: readonly string[]; messages: boolean }) {
  const shown = Object.entries(LINK_STYLE).filter(([kind]) => kinds.includes(kind));
  if (shown.length === 0 && !messages) return null;
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground" aria-label="Legend">
      {shown.map(([kind, style]) => (
        <li key={kind} className="flex items-center gap-1.5">
          <svg width="18" height="6" aria-hidden>
            <line x1="0" y1="3" x2="18" y2="3" stroke={style.stroke} strokeDasharray={style.dash} strokeWidth="1.5" />
          </svg>
          {style.label}
        </li>
      ))}
      {messages ? (
        <li className="flex items-center gap-1.5" data-legend="messages">
          <svg width="18" height="6" aria-hidden>
            <line x1="0" y1="3" x2="18" y2="3" stroke="var(--primary)" strokeWidth="1.75" />
            <circle cx="9" cy="3" r="2.5" fill="var(--primary)" />
          </svg>
          messages
        </li>
      ) : null}
    </ul>
  );
}


/** What each Needs-you reason means, and what the human can do about it. */
const REASON_TITLE: Record<string, string> = {
  approval: "Approval pending",
  question: "Question in the thread",
  "human-question": "Asks you",
  loop: "Stopped as a loop",
  error: "Thread failed",
  "merge-request": "Merge request waits",
  "merge-conflict": "Merge conflict",
  "follow-up": "Work item overdue",
  context: "Context nearly full",
  "graph-approval": "Graph run waits for you",
};
const REASON_TEXT: Record<string, string> = {
  approval: "The thread waits for you to allow a tool call.",
  question: "The provider asked something in the thread.",
  "human-question": "Sent you a question through the crew.",
  loop: "A message chain went back and forth too often and was held. Release it to deliver anyway, or discard it.",
  error: "The last turn ended with an error. Open the thread to see it.",
  "merge-request": "The crew's branch is ready to merge — decide on the project overview.",
  "merge-conflict": "The branch no longer merges cleanly.",
  "follow-up": "An open work item reached its last follow-up.",
  context: "Hand over to a fresh thread before it runs out.",
  "graph-approval": "A human node is waiting on an answer. Open Graph Studio to answer it.",
};

export type MemberAction = "open" | "handover" | "reset-clear" | "reset-new" | "detach";

/** Reset as a split button: the main part clears the context, the chevron offers a fresh thread. */
function ResetSplit({ disabled, onAction }: { disabled: boolean; onAction: (action: MemberAction) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-flex">
      <Button size="sm" variant="outline" className="h-7 rounded-r-none" disabled={disabled} onClick={() => onAction("reset-clear")}>
        Reset
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-7 rounded-l-none border-l-0 px-1.5"
        disabled={disabled}
        aria-label="More reset options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        ▾
      </Button>
      {open && !disabled ? (
        <div role="menu" className="absolute right-0 top-8 z-10 flex min-w-[180px] flex-col rounded-lg border border-border bg-popover text-popover-foreground p-1 text-xs shadow-lg">
          <button type="button" role="menuitem" className="rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => (setOpen(false), onAction("reset-clear"))}>
            Reset (clear context)
          </button>
          <button type="button" role="menuitem" className="rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => (setOpen(false), onAction("reset-new"))}>
            Reset (new thread)
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function MemberCard({
  member,
  view,
  crewName,
  onAction,
  onAnswer,
  held = [],
  onMessageAction,
  onShowMessage,
}: {
  member: MemberDto;
  view: ActivityDto | null;
  crewName: string;
  onAction: (action: MemberAction) => void;
  onAnswer: (body: string) => Promise<void>;
  /** Messages of this member that wait on the human: stopped loops, held, throttled. */
  held?: readonly MessageDto[];
  onMessageAction?: (id: string, action: "release" | "discard") => void;
  onShowMessage?: (id: string) => void;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const needs = (view?.needsYou.length ?? 0) > 0;
  const isError = hasErrorReason(view?.needsYou ?? []);
  // A BB interaction (approval, provider question) is answered in the thread; a crew_send question here.
  const inThread = view?.needsYou.some((reason) => reason === "approval" || reason === "question") ?? false;
  return (
    <aside aria-label="Member card" className="w-full flex-none rounded-lg border border-border bg-card p-4 text-xs @3xl:w-[300px]">
      <InspectorHeader
        icon={<Icon name="Bot" className="size-4" />}
        title={member.key}
        subtitle={`${member.address}${member.shift !== null ? ` · Shift ${member.shift}` : ""}`}
      />
      {needs ? (
        <div
          className="mb-3 flex flex-col gap-2 rounded-lg border p-2.5"
          style={severityTint(isError ? "error" : "decision", 5, 30)}
          data-needs-you="true"
        >
          <b className={cn("block", SEVERITY_TEXT[isError ? "error" : "decision"])}>{isError ? "Error" : "Needs a decision"}</b>
          {/* One line of context per reason: a bare "loop" with an empty box asked for input nobody could give. */}
          <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Reasons">
            {view!.needsYou.map((reason) => (
              <li key={reason} data-reason={reason}>
                <span className="font-medium text-foreground">{REASON_TITLE[reason] ?? reason}</span>
                <span className="block text-muted-foreground">{REASON_TEXT[reason] ?? ""}</span>
              </li>
            ))}
          </ul>
          {held.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="Held messages">
              {held.map((message) => (
                <li key={message.id} data-held={message.id} className="rounded-md border border-destructive/20 bg-background p-2">
                  <button type="button" className="w-full text-left" onClick={() => onShowMessage?.(message.id)}>
                    <span className="block truncate font-medium">{message.subject || "(no subject)"}</span>
                    <span className="block truncate text-muted-foreground">
                      to {message.toAddress.replace(`@${crewName}`, "")} · {message.status}
                      {message.reason ? ` · ${message.reason}` : ""}
                    </span>
                  </button>
                  {onMessageAction ? (
                    <div className="mt-1.5 flex gap-1.5">
                      <Button size="sm" variant="outline" className="h-6 px-2" onClick={() => onMessageAction(message.id, "release")}>
                        Release
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => onMessageAction(message.id, "discard")}>
                        Discard
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {view!.question ? (
            <>
              <p className="m-0 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md bg-background p-2 [overflow-wrap:anywhere]">{view!.question}</p>
              {inThread ? null : (
                <>
                  <textarea
                    aria-label="Answer"
                    placeholder={`Answer ${member.key}…`}
                    className="h-16 w-full resize-y rounded-md border border-input bg-transparent p-1.5"
                    value={answer}
                    onChange={(event) => setAnswer(event.target.value)}
                  />
                  <Button
                    size="sm"
                    className="h-7 self-start"
                    disabled={busy || answer.trim() === ""}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await onAnswer(answer);
                        setAnswer("");
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Send answer
                  </Button>
                </>
              )}
            </>
          ) : null}
          <Button size="sm" variant="ghost" className="h-7 self-start" onClick={() => onAction("open")}>
            {inThread ? "Answer in thread" : "Open thread"}
          </Button>
        </div>
      ) : null}
      <div className="border-t border-border/60 py-3">
        <InspectorRows
          rows={[
            { label: "Model", value: `${member.provider ?? "?"} · ${shortModel(member.model)}` },
            { label: "Permissions", value: member.permissions ?? "?", className: member.permissions === "full" ? "text-destructive" : undefined },
            { label: "Thread", value: member.thread === "present" ? (member.status ?? "?") : member.thread },
            { label: "Context", value: view?.context !== null && view?.context !== undefined ? formatContextShare(view.context) : "–" },
            { label: "Queue", value: `${view?.openWork ?? 0} open${view && view.held > 0 ? ` · ${view.held} held` : ""}` },
            view !== null && view.diagnoses.length > 0 && { label: "Diagnosis", value: view.diagnoses.join(" · "), className: "text-amber-600 dark:text-amber-400" },
          ]}
        />
      </div>
      {view && view.graphRuns && view.graphRuns.length > 0 ? (
        <ul className="mb-3 flex flex-col gap-1 border-l border-border pl-2.5 text-xs">
          {view.graphRuns.map((run) => (
            <li key={run.runId} className="flex items-center justify-between gap-2 text-muted-foreground">
              <span>{run.graphId}</span>
              <span className={run.status === "failed" ? "text-destructive" : run.status === "done" ? "text-emerald-600 dark:text-emerald-400" : ""}>{run.status}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <InspectorFooter note={`Click a node to switch the card · double-click opens the thread · ${crewName}`}>
        <Button size="sm" variant="outline" className="h-7" disabled={!member.threadId} onClick={() => onAction("open")}>
          Open
        </Button>
        <Button size="sm" variant="outline" className="h-7" disabled={!member.threadId} onClick={() => onAction("handover")}>
          Handover
        </Button>
        <ResetSplit disabled={!member.threadId} onAction={onAction} />
      </InspectorFooter>
    </aside>
  );
}

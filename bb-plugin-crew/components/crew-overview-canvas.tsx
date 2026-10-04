// The Crews canvas (BBP-71, made the main view in BBP-83): levels 0 and 1 of
// the semantic zoom — every project as a labelled cluster, then one project
// zoomed in. The canvas, nodes and edges — a card
// per crew/task, a labelled frame per project, animated edges for active
// work — as our own copy of the reference look. No import or runtime
// dependency on the sibling plugin; the only shared thing is @xyflow/react
// itself (an independent dependency of this plugin, see package.json) and
// the BB theme's own CSS variables, the same tokens components/crew-topology.tsx
// already draws with.
import { useLayoutEffect, useMemo, type CSSProperties } from "react";
import { Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, useReactFlow, type ColorMode, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { cn } from "@/lib/utils";
import {
  DEFAULT_OVERVIEW_FILTERS,
  buildOverviewGraph,
  crewNodeId,
  filterOverviewGraph,
  visibleOverviewEdges,
  type CrewNode,
  type OverviewEdge,
  type OverviewFilters,
  type OverviewGraph,
  type OverviewNode,
  type OverviewProject,
  type OverviewSource,
  type ProjectSummary,
  type TaskNode,
} from "../lib/overview-graph";
import { layoutOverview, type NodeSize } from "../lib/overview-layout";
import { RUNNING, topReasonLabel } from "../lib/topology";
import type { ActivityDto, MemberDto, WorkDto } from "../server";
import { AGENT_H, AGENT_W, AgentNodeView, currentWork } from "./crew-agent-node";
import { buildCrewCanvas, MemberNode, PathEdge, TopologyMarkers, type MemberAction, type PathEdgeData } from "./crew-topology";
import { colorLightness, FLOW_THEME as BASE_FLOW_THEME, useHostColorMode } from "./crew-topology";

export { buildOverviewGraph, filterOverviewGraph, type OverviewFilters, type OverviewGraph, type OverviewProject, type OverviewSource };

/** Same chrome mapping as the Topology tab — React Flow in the host's own theme. */
export const OVERVIEW_FLOW_THEME = BASE_FLOW_THEME;
export { colorLightness, useHostColorMode };

const STATUS_FILL: Record<string, string> = {
  running: `color-mix(in oklab, ${RUNNING} 14%, var(--card))`,
  degraded: "color-mix(in oklab, var(--destructive) 12%, var(--card))",
  starting: `color-mix(in oklab, ${RUNNING} 8%, var(--card))`,
  stopped: "var(--card)",
};
const STATUS_STROKE: Record<string, string> = {
  running: RUNNING,
  degraded: "var(--destructive)",
  starting: RUNNING,
  stopped: "var(--border)",
};

function CrewNodeView({ data }: NodeProps<Node<{ crew: CrewNode; selected: boolean; matched: boolean; dim: boolean }>>) {
  const { crew, selected, matched, dim } = data;
  const needs = crew.needsYouSeverity !== null;
  const fill = STATUS_FILL[crew.status] ?? STATUS_FILL.stopped!;
  const stroke = crew.needsYouSeverity === "error" ? "var(--destructive)" : crew.needsYouSeverity === "decision" ? "var(--warning)" : (STATUS_STROKE[crew.status] ?? STATUS_STROKE.stopped!);
  const pulsing = crew.status === "running" || needs;
  return (
    <div
      className={cn("relative h-full w-full cursor-pointer", dim && "opacity-40")}
      role="button"
      tabIndex={0}
      data-dim={dim ? "" : undefined}
      data-crew-node={crew.name}
      data-status={crew.status}
      aria-pressed={selected}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} className="!pointer-events-none !opacity-0" />
      <div
        className="flex h-full w-full flex-col gap-1 overflow-hidden rounded-[10px] p-2.5 shadow-sm"
        style={{ background: fill, border: `${selected || matched ? 2.5 : 1.5}px solid ${matched ? "var(--primary)" : selected ? "var(--primary)" : stroke}` }}
      >
        <div className="flex items-center justify-between gap-2 text-[9px] uppercase tracking-[0.06em] text-muted-foreground">
          <span>CREW</span>
          <span className="flex items-center gap-1" style={needs ? { color: crew.needsYouSeverity === "error" ? "var(--destructive-text)" : "var(--warning-text)" } : undefined}>
            <span aria-hidden className={cn("size-1.5 rounded-full", pulsing && "animate-pulse")} style={{ background: stroke }} />
            {needs ? (topReasonLabel(crew.members.flatMap((member) => member.needsYou ?? [])) ?? "waits on you") : crew.status}
          </span>
        </div>
        <span className="truncate text-sm font-medium text-foreground">{crew.name}</span>
        {crew.branch ? <span className="truncate text-[10px] text-muted-foreground">{crew.branch}</span> : null}
        <div className="mt-auto flex flex-wrap gap-1">
          {crew.members.slice(0, 4).map((member) => (
            <span key={member.key} className="truncate rounded-full border border-border/60 bg-background/60 px-1.5 py-0.5 text-[9px] text-muted-foreground">
              {member.key}
            </span>
          ))}
          {crew.members.length > 4 ? <span className="text-[9px] text-muted-foreground">+{crew.members.length - 4}</span> : null}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="!pointer-events-none !opacity-0" />
    </div>
  );
}

function TaskNodeView({ data }: NodeProps<Node<{ task: TaskNode; matched: boolean; dim: boolean }>>) {
  const { task, matched, dim } = data;
  return (
    <div
      className={cn("h-full w-full cursor-pointer", dim && "opacity-40")}
      role="button"
      tabIndex={0}
      data-task-node={task.key}
      data-done={task.done ? "true" : undefined}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} className="!pointer-events-none !opacity-0" />
      <div
        className="flex h-full w-full flex-col justify-center gap-0.5 overflow-hidden rounded-[8px] border px-2.5 py-1.5 text-xs shadow-sm"
        style={{
          background: task.done ? "color-mix(in oklab, var(--muted) 60%, var(--card))" : "var(--card)",
          borderWidth: matched ? 2.5 : 1.5,
          borderColor: matched ? "var(--primary)" : "var(--border)",
          borderStyle: "solid",
        }}
      >
        <div className="flex items-center justify-between gap-2 text-[9px] uppercase tracking-[0.06em] text-muted-foreground">
          <span className="font-mono">{task.key}</span>
          <span>{task.done ? "done" : "open"}</span>
        </div>
        <span className="truncate text-foreground">{task.title}</span>
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="!pointer-events-none !opacity-0" />
    </div>
  );
}

/** A project's cluster: its frame, drawn behind its crews and tasks (zIndex -1), with what runs and what waits on you. */
function FrameNodeView({ data }: NodeProps<Node<{ project: ProjectSummary; dim: boolean }>>) {
  const { project, dim } = data;
  return (
    <div
      data-project-frame={project.id}
      role="button"
      tabIndex={0}
      aria-label={`Project ${project.name}`}
      className={cn("h-full w-full cursor-zoom-in rounded-xl border border-border/60 bg-card/40 hover:border-dashed hover:border-primary/60 focus-visible:border-dashed focus-visible:border-primary/60 focus-visible:outline-none", dim && "opacity-40")}
    >
      <div className="flex items-center gap-3 px-3 py-2 text-xs">
        <span className="truncate text-sm font-medium text-foreground">{project.name}</span>
        <span className="text-muted-foreground">
          {project.crewCount} {project.crewCount === 1 ? "crew" : "crews"}
        </span>
        {project.runningCount > 0 ? (
          <span data-cluster="running" className="flex items-center gap-1 text-muted-foreground">
            <span aria-hidden className="size-1.5 rounded-full" style={{ background: RUNNING }} />
            {project.runningCount} running
          </span>
        ) : null}
        {project.errorCount > 0 ? (
          <span data-cluster="error" className="flex items-center gap-1 text-destructive-text">
            <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-destructive motion-reduce:animate-none" />
            {project.errorCount} {project.errorCount === 1 ? "error" : "errors"}
          </span>
        ) : null}
        {project.needsYouCount - project.errorCount > 0 ? (
          <span data-cluster="needs-you" className="flex items-center gap-1 text-warning-text">
            <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-warning motion-reduce:animate-none" />
            {project.needsYouCount - project.errorCount} waiting on you
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Level 2: the crew grown into a frame around its members, with its name on top. */
function CrewOpenNodeView({ data }: NodeProps<Node<{ crew: CrewNode }>>) {
  const { crew } = data;
  return (
    <div data-crew-open={crew.name} className="h-full w-full rounded-xl border-2 border-primary/60 bg-card/60">
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
        <span className="text-[9px] uppercase tracking-[0.06em] text-muted-foreground">Crew</span>
        <span className="text-sm font-medium text-foreground">{crew.name}</span>
        <span className="text-muted-foreground">{crew.status}</span>
        {crew.branch ? <span className="truncate font-mono text-[10px] text-muted-foreground">⎇ {crew.branch}</span> : null}
      </div>
    </div>
  );
}

const NODE_TYPES = { crew: CrewNodeView, task: TaskNodeView, frame: FrameNodeView, crewOpen: CrewOpenNodeView, member: MemberNode, agent: AgentNodeView };

type TaskCrewEdgeData = { active: boolean };
function TaskCrewEdgeView({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<Edge<TaskCrewEdgeData>>) {
  const path = `M ${sourceX},${sourceY} C ${sourceX},${(sourceY + targetY) / 2} ${targetX},${(sourceY + targetY) / 2} ${targetX},${targetY}`;
  const active = data?.active ?? false;
  return (
    <g data-task-crew-edge={id} data-active={active ? "true" : undefined}>
      <path d={path} fill="none" stroke="var(--primary)" strokeWidth={active ? 2 : 1.25} opacity={active ? 0.9 : 0.4} strokeDasharray={active ? undefined : "4 4"} />
      {active ? (
        <circle r={3} fill="var(--primary)">
          <animateMotion dur="1.4s" repeatCount="indefinite" path={path} />
        </circle>
      ) : null}
    </g>
  );
}

function LeadLeadEdgeView({ sourceX, sourceY, targetX, targetY }: EdgeProps<Edge>) {
  const path = `M ${sourceX},${sourceY} L ${targetX},${targetY}`;
  return <path d={path} fill="none" stroke="var(--muted-foreground)" strokeWidth={1.25} strokeDasharray="5 4" opacity={0.6} />;
}

/** A member link: the topology's own path, moved to where the crew sits on this canvas. */
function MemberLinkEdgeView(props: EdgeProps<Edge<PathEdgeData & { dx: number; dy: number }>>) {
  if (!props.data) return null;
  return (
    <g transform={`translate(${props.data.dx} ${props.data.dy})`}>
      <PathEdge {...(props as unknown as EdgeProps<Edge<PathEdgeData>>)} />
    </g>
  );
}

const EDGE_TYPES = { "task-crew": TaskCrewEdgeView, "lead-lead": LeadLeadEdgeView, "member-link": MemberLinkEdgeView };

/** Room around the members inside an opened crew: the name row on top, a margin around. */
const OPEN_PAD = 24;
const OPEN_HEADER = 40;

/** Levels 2 and 3: the crew drawn open on the canvas, with what its members need. */
export type ExpandedCrew = {
  projectId: string;
  name: string;
  members: readonly MemberDto[];
  links: readonly { from: string; to: string; kind: string }[];
  activity: readonly ActivityDto[];
  work: readonly WorkDto[];
  /** Level 3: the member opened into its agent card. */
  member: string | null;
  onEnterMember: (key: string) => void;
  onAction: (member: string, action: MemberAction) => void;
};

/** Zooms smoothly to what the level is about; with nothing in focus, fits everything. */
function Fit({ focus, layoutKey }: { focus: readonly string[]; layoutKey: string }) {
  const flow = useReactFlow();
  const focusKey = focus.join("|");
  useLayoutEffect(() => {
    if (focus.length > 0) void flow.fitView({ nodes: focus.map((id) => ({ id })), duration: 500, padding: 0.08, maxZoom: 1.5 });
    else void flow.fitView({ padding: 0.08, maxZoom: 1, duration: 400 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, focusKey, layoutKey]);
  return null;
}

export function OverviewCanvas({
  projects,
  overviews,
  focusProject,
  onEnterProject,
  onEnterCrew,
  onOpenTask,
  filters = DEFAULT_OVERVIEW_FILTERS,
  expanded = null,
}: {
  projects: readonly OverviewProject[];
  overviews: ReadonlyMap<string, OverviewSource>;
  /** Level 1: the project zoomed into; null on level 0. */
  focusProject: string | null;
  onEnterProject: (projectId: string) => void;
  onEnterCrew: (projectId: string, crewName: string) => void;
  onOpenTask: (projectId: string, taskKey: string) => void;
  filters?: OverviewFilters;
  expanded?: ExpandedCrew | null;
}) {
  const [colorRef, colorMode] = useHostColorMode();
  const openId = expanded ? crewNodeId(expanded.projectId, expanded.name) : null;
  // The opened crew's member topology, laid out the way the Topology tab lays it out.
  const topology = useMemo(
    () => (expanded ? buildCrewCanvas(expanded.members as MemberDto[], expanded.links, [], new Set(), null) : null),
    [expanded?.members, expanded?.links],
  );
  const sizes = useMemo(
    () => new Map<string, NodeSize>(openId && topology ? [[openId, { width: topology.width + OPEN_PAD * 2, height: topology.height + OPEN_HEADER + OPEN_PAD }]] : []),
    [openId, topology],
  );

  const graph = useMemo(() => buildOverviewGraph(projects, overviews), [projects, overviews]);
  const filtered = useMemo(() => filterOverviewGraph(graph, filters), [graph, filters]);
  const layout = useMemo(() => layoutOverview(graph, filtered.visible, sizes), [graph, filtered.visible, sizes]);
  const edges = useMemo(() => visibleOverviewEdges(graph, filtered.visible), [graph, filtered.visible]);

  const nodeById = useMemo(() => new Map<string, OverviewNode>(graph.nodes.map((node) => [node.id, node])), [graph]);

  // Deeper levels fade the rest instead of hiding it: you see where you zoomed in from.
  const dimmed = (node: OverviewNode) =>
    (focusProject !== null && node.projectId !== focusProject) ||
    (openId !== null && node.id !== openId) ||
    (filters.search.trim() !== "" && !filtered.matched.has(node.id));

  const nodes: Node[] = [
    ...layout.frames.map((frame) => {
      const project = graph.projects.find((entry) => entry.id === frame.projectId)!;
      return {
        id: `frame:${frame.projectId}`,
        type: "frame",
        position: { x: frame.x, y: frame.y },
        width: frame.width,
        height: frame.height,
        style: { width: frame.width, height: frame.height, zIndex: -1 },
        draggable: false,
        selectable: false,
        data: { project, dim: focusProject !== null && frame.projectId !== focusProject },
      };
    }),
    ...layout.placed.map((placed) => ({
      id: placed.id,
      type: placed.id === openId ? "crewOpen" : placed.node.kind,
      ...(placed.id === openId ? { zIndex: -1, selectable: false } : {}),
      position: { x: placed.x, y: placed.y },
      width: placed.width,
      height: placed.height,
      style: { width: placed.width, height: placed.height },
      draggable: false,
      data:
        placed.node.kind === "crew"
          ? { crew: placed.node, selected: false, matched: filtered.matched.has(placed.id), dim: dimmed(placed.node) }
          : { task: placed.node, matched: filtered.matched.has(placed.id), dim: dimmed(placed.node) },
    })),
  ];

  const flowEdges: Edge[] = edges.map((edge: OverviewEdge) => ({
    id: edge.id,
    source: edge.from,
    target: edge.to,
    type: edge.kind,
    data: edge.kind === "task-crew" ? { active: edge.active } : undefined,
  }));

  // Levels 2 and 3: the members inside the opened crew, and the agent card over its member.
  const open = openId ? layout.placed.find((placed) => placed.id === openId) : undefined;
  let focus: readonly string[] = filters.search.trim() !== "" ? filtered.focus : [];
  if (focusProject) focus = [`frame:${focusProject}`];
  if (expanded && open && topology) {
    const dx = open.x + OPEN_PAD;
    const dy = open.y + OPEN_HEADER;
    const views = new Map(expanded.activity.map((view) => [view.key, view]));
    const byKey = new Map(expanded.members.map((member) => [member.key, member]));
    for (const box of topology.boxes) {
      const member = byKey.get(box.id);
      if (!member) continue;
      nodes.push({
        id: `member:${box.id}`,
        type: "member",
        position: { x: dx + box.x, y: dy + box.y },
        width: box.width,
        height: box.height,
        style: { width: box.width, height: box.height },
        draggable: false,
        data: { member, view: views.get(box.id) ?? null, selected: box.id === expanded.member },
      });
    }
    for (const edge of topology.edges) {
      flowEdges.push({ ...edge, id: `member-link:${edge.id}`, source: `member:${edge.source}`, target: `member:${edge.target}`, type: "member-link", data: { ...edge.data!, dx, dy } });
    }
    focus = [openId!];
    const agentBox = expanded.member ? topology.boxes.find((box) => box.id === expanded.member) : undefined;
    const agent = agentBox ? byKey.get(agentBox.id) : undefined;
    if (agentBox && agent) {
      // Grows out of the member it opens, centred on it.
      nodes.push({
        id: `agent:${agent.key}`,
        type: "agent",
        position: { x: dx + agentBox.x + (agentBox.width - AGENT_W) / 2, y: dy + agentBox.y + (agentBox.height - AGENT_H) / 2 },
        width: AGENT_W,
        height: AGENT_H,
        style: { width: AGENT_W, height: AGENT_H },
        zIndex: 1000,
        draggable: false,
        selectable: false,
        data: {
          member: agent,
          view: views.get(agent.key) ?? null,
          work: currentWork(expanded.work, agent.address),
          onAction: (action: MemberAction) => expanded.onAction(agent.key, action),
        },
      });
      focus = [`agent:${agent.key}`];
    }
  }

  return (
    <div
      ref={colorRef}
      // BBP-81: the canvas takes the full height it is given, as in Graph Studio;
      // a height derived from the drawing left a thin strip of tiny cards.
      className="relative h-full w-full min-w-0 overflow-hidden rounded-lg border border-border bg-background"
      aria-label="Crews canvas"
    >
      <svg width="0" height="0" className="absolute" aria-hidden>
        <TopologyMarkers />
      </svg>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={flowEdges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          colorMode={colorMode}
          style={OVERVIEW_FLOW_THEME}
          fitView
          minZoom={0.15}
          maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          // As in Graph Studio: the wheel keeps scrolling; pinch and the controls zoom.
          zoomOnDoubleClick={false}
          onNodeClick={(_event, node) => {
            if (node.id.startsWith("frame:")) return onEnterProject(node.id.slice("frame:".length));
            if (node.id.startsWith("member:")) return expanded?.onEnterMember(node.id.slice("member:".length));
            if (node.id.startsWith("agent:") || node.id === openId) return;
            const overviewNode = nodeById.get(node.id);
            if (!overviewNode) return;
            if (overviewNode.kind === "crew") onEnterCrew(overviewNode.projectId, overviewNode.name);
            else onOpenTask(overviewNode.projectId, overviewNode.key);
          }}
        >
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap pannable zoomable position="bottom-right" style={{ background: "var(--card)" }} maskColor="color-mix(in oklab, var(--background) 70%, transparent)" />
          <Fit focus={focus} layoutKey={`${layout.width}x${layout.height}`} />
        </ReactFlow>
      </ReactFlowProvider>
      {/* The opened crew's links as text: React Flow draws edges only after measuring, and screen readers need them anyway. */}
      {expanded ? (
        <ul className="sr-only" aria-label="Links">
          {expanded.links.map((link) => (
            <li key={`${link.from}-${link.to}-${link.kind}`} data-link-kind={link.kind}>
              {link.from} {link.kind} {link.to}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export type { CSSProperties };

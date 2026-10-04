// Fullscreen overview diagram (BBP-71): the canvas, nodes and edges — a card
// per crew/task, a labelled frame per project, animated edges for active
// work — as our own copy of the reference look. No import or runtime
// dependency on the sibling plugin; the only shared thing is @xyflow/react
// itself (an independent dependency of this plugin, see package.json) and
// the BB theme's own CSS variables, the same tokens components/crew-topology.tsx
// already draws with.
import { useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import { Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow, type ColorMode, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { cn } from "@/lib/utils";
import {
  buildOverviewGraph,
  filterOverviewGraph,
  visibleOverviewEdges,
  type CrewNode,
  type OverviewEdge,
  type OverviewFilters,
  type OverviewGraph,
  type OverviewNode,
  type OverviewProject,
  type OverviewSource,
  type TaskNode,
} from "../lib/overview-graph";
import { layoutOverview } from "../lib/overview-layout";
import { colorLightness, FLOW_THEME as BASE_FLOW_THEME, useHostColorMode, useWidth } from "./crew-topology";

export { buildOverviewGraph, filterOverviewGraph, type OverviewFilters, type OverviewGraph, type OverviewProject, type OverviewSource };

/** Same chrome mapping as the Topology tab — React Flow in the host's own theme. */
export const OVERVIEW_FLOW_THEME = BASE_FLOW_THEME;
export { colorLightness, useHostColorMode };

const STATUS_FILL: Record<string, string> = {
  running: "color-mix(in oklab, var(--primary) 14%, var(--card))",
  degraded: "color-mix(in oklab, var(--destructive) 12%, var(--card))",
  starting: "color-mix(in oklab, var(--primary) 8%, var(--card))",
  stopped: "var(--card)",
};
const STATUS_STROKE: Record<string, string> = {
  running: "var(--primary)",
  degraded: "var(--destructive)",
  starting: "var(--primary)",
  stopped: "var(--border)",
};

function CrewNodeView({ data }: NodeProps<Node<{ crew: CrewNode; selected: boolean; matched: boolean; dim: boolean }>>) {
  const { crew, selected, matched, dim } = data;
  const needs = crew.needsYou > 0;
  const fill = STATUS_FILL[crew.status] ?? STATUS_FILL.stopped!;
  const stroke = needs ? "var(--destructive)" : (STATUS_STROKE[crew.status] ?? STATUS_STROKE.stopped!);
  const pulsing = crew.status === "running" || needs;
  return (
    <div
      className={cn("relative h-full w-full cursor-pointer", dim && "opacity-40")}
      role="button"
      tabIndex={0}
      data-crew-node={crew.name}
      data-status={crew.status}
      aria-pressed={selected}
    >
      <div
        className="flex h-full w-full flex-col gap-1 overflow-hidden rounded-[10px] p-2.5 shadow-sm"
        style={{ background: fill, border: `${selected || matched ? 2.5 : 1.5}px solid ${matched ? "var(--primary)" : selected ? "var(--primary)" : stroke}` }}
      >
        <div className="flex items-center justify-between gap-2 text-[9px] uppercase tracking-[0.06em] text-muted-foreground">
          <span>CREW</span>
          <span className="flex items-center gap-1" style={needs ? { color: "var(--destructive)" } : undefined}>
            <span aria-hidden className={cn("size-1.5 rounded-full", pulsing && "animate-pulse")} style={{ background: stroke }} />
            {needs ? "waits on you" : crew.status}
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
    </div>
  );
}

/** A project's labelled frame, drawn behind its crews and tasks (zIndex -1). */
function FrameNodeView({ data }: NodeProps<Node<{ name: string; crewCount: number; taskCount: number }>>) {
  return (
    <div className="pointer-events-none h-full w-full rounded-xl border border-dashed border-border/70 bg-muted/10">
      <div className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
        {data.name} · {data.crewCount} {data.crewCount === 1 ? "crew" : "crews"} · {data.taskCount} {data.taskCount === 1 ? "task" : "tasks"}
      </div>
    </div>
  );
}

const NODE_TYPES = { crew: CrewNodeView, task: TaskNodeView, frame: FrameNodeView };

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

const EDGE_TYPES = { "task-crew": TaskCrewEdgeView, "lead-lead": LeadLeadEdgeView };

function Fit({ focus, layoutKey }: { focus: readonly string[]; layoutKey: string }) {
  const flow = useReactFlow();
  const focusKey = focus.join("|");
  useLayoutEffect(() => {
    if (focus.length > 0) void flow.fitView({ nodes: focus.map((id) => ({ id })), duration: 400, padding: 0.5, maxZoom: 1.2 });
    else void flow.fitView({ padding: 0.08, duration: 300 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, focusKey, layoutKey]);
  return null;
}

export function OverviewCanvas({
  projects,
  overviews,
  filters,
  selected,
  onSelectCrew,
  onOpenCrew,
  onOpenTask,
}: {
  projects: readonly OverviewProject[];
  overviews: ReadonlyMap<string, OverviewSource>;
  filters: OverviewFilters;
  selected: string | null;
  onSelectCrew: (id: string | null) => void;
  onOpenCrew: (projectId: string, crewName: string) => void;
  onOpenTask: (projectId: string, taskKey: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [colorRef, colorMode] = useHostColorMode();
  const panelWidth = useWidth(hostRef);

  const graph = useMemo(() => buildOverviewGraph(projects, overviews), [projects, overviews]);
  const filtered = useMemo(() => filterOverviewGraph(graph, filters), [graph, filters]);
  const layout = useMemo(() => layoutOverview(graph, filtered.visible), [graph, filtered.visible]);
  const edges = useMemo(() => visibleOverviewEdges(graph, filtered.visible), [graph, filtered.visible]);

  const nodeById = useMemo(() => new Map<string, OverviewNode>(graph.nodes.map((node) => [node.id, node])), [graph]);

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
        data: { name: project.name, crewCount: project.crewCount, taskCount: project.taskCount },
      };
    }),
    ...layout.placed.map((placed) => ({
      id: placed.id,
      type: placed.node.kind,
      position: { x: placed.x, y: placed.y },
      width: placed.width,
      height: placed.height,
      style: { width: placed.width, height: placed.height },
      draggable: false,
      data:
        placed.node.kind === "crew"
          ? { crew: placed.node, selected: placed.id === selected, matched: filtered.matched.has(placed.id), dim: filters.search.trim() !== "" && !filtered.matched.has(placed.id) }
          : { task: placed.node, matched: filtered.matched.has(placed.id), dim: filters.search.trim() !== "" && !filtered.matched.has(placed.id) },
    })),
  ];

  const flowEdges: Edge[] = edges.map((edge: OverviewEdge) => ({
    id: edge.id,
    source: edge.from,
    target: edge.to,
    type: edge.kind,
    data: edge.kind === "task-crew" ? { active: edge.active } : undefined,
  }));

  return (
    <div
      ref={(element) => {
        hostRef.current = element;
        colorRef.current = element;
      }}
      // BBP-81: the layer gives the canvas its full height, as in Graph Studio;
      // a height derived from the drawing left a thin strip of tiny cards.
      className="relative h-full w-full min-w-0 overflow-hidden rounded-lg border border-border bg-background"
      aria-label="Crew overview diagram"
    >
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
          onPaneClick={() => onSelectCrew(null)}
          onNodeClick={(_event, node) => {
            const overviewNode = nodeById.get(node.id);
            if (!overviewNode) return;
            if (overviewNode.kind === "crew") onSelectCrew(node.id);
            else onOpenTask(overviewNode.projectId, overviewNode.key);
          }}
          onNodeDoubleClick={(_event, node) => {
            const overviewNode = nodeById.get(node.id);
            if (overviewNode?.kind === "crew") onOpenCrew(overviewNode.projectId, overviewNode.name);
          }}
        >
          {panelWidth === 0 || panelWidth >= 480 ? <Controls showInteractive={false} position="bottom-left" /> : null}
          <MiniMap pannable zoomable position="bottom-right" style={{ background: "var(--card)" }} maskColor="color-mix(in oklab, var(--background) 70%, transparent)" />
          <Fit focus={filtered.focus} layoutKey={`${layout.width}x${layout.height}`} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

export type { CSSProperties };

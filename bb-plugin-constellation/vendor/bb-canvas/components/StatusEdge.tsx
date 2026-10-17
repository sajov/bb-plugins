// One edge component for the three shapes `layoutTree` draws: `flow` along
// the tree, `back` bowing out to the right of its column, `message` as a
// plain dashed line (its pulse and counter land later, once there is
// traffic to show one for) — and, since BBP-146, the one state any `flow`
// or `back` edge can carry: `now` (solid primary with a dash that travels
// along it). BBP-214 stage 1 removed the other state, `taken`: a finished or
// failed child drew the same solid line as a running one, so completed work
// looked indistinguishable from activity.
//
// A relation edge (BBP-202) shows its label only on hover or when its
// selection highlights it, and dims when another node's relations are in
// focus.
import { useState } from "react";
import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import type { Junction } from "../lib/layout";
import type { CanvasEdgeEmphasis, CanvasEdgeState, CanvasEdgeVariant } from "../lib/types";

export type StatusEdgeData = {
  variant: CanvasEdgeVariant;
  path: string;
  label: string;
  state?: CanvasEdgeState;
  relation?: boolean;
  emphasis?: CanvasEdgeEmphasis;
  junctions?: readonly Junction[];
};

export function relationLabelVisible(data: StatusEdgeData, hovered: boolean): boolean {
  return !data.relation || hovered || data.emphasis === "highlight";
}

export type StatusEdgeProps = EdgeProps & { data: StatusEdgeData };

const STROKE_DASHARRAY: Partial<Record<CanvasEdgeVariant, string>> = {
  message: "4 4",
};

const RELATION_HOVER = { pointerEvents: "stroke" } as const;

const NOW_CLASS = "bb-canvas-edge-now";
const STYLE_ID = "bb-canvas-status-edge-styles";

/** Injected once, module-wide — React has no `@keyframes`. Reduced motion
 *  keeps the dash but drops the travel animation. */
function ensureNowStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes ${NOW_CLASS} { to { stroke-dashoffset: -16; } }
    .${NOW_CLASS} { stroke-dasharray: 6 4; animation: ${NOW_CLASS} 0.6s linear infinite; }
    @media (prefers-reduced-motion: reduce) {
      .${NOW_CLASS} { animation: none; }
    }
  `;
  document.head.appendChild(style);
}

function strokeFor(state: CanvasEdgeState | undefined, selected: boolean | undefined): { stroke: string; strokeWidth: number } {
  if (state === "now") return { stroke: "var(--primary)", strokeWidth: 2 };
  if (state === "needs") return { stroke: "#f59e0b", strokeWidth: 2 };
  if (state === "skipped") return { stroke: "var(--muted-foreground)", strokeWidth: 1.25 };
  if (state === "selected-path") return { stroke: "var(--ring)", strokeWidth: 1.75 };
  return { stroke: selected ? "var(--primary)" : "var(--border)", strokeWidth: selected ? 2 : 1.5 };
}

export function StatusEdge({ data, selected }: StatusEdgeProps) {
  ensureNowStyles();
  const [hovered, setHovered] = useState(false);
  const [labelX, labelY] = midpoint(data.path);
  const { stroke, strokeWidth } = strokeFor(data.state, selected || data.emphasis === "highlight");
  return (
    <g
      onMouseEnter={data.relation ? () => setHovered(true) : undefined}
      onMouseLeave={data.relation ? () => setHovered(false) : undefined}
      opacity={data.emphasis === "dim" ? 0.25 : undefined}
      // React Flow marks unselectable edges "inactive" (pointer-events: none),
      // so without this the hover label of a relation could never show.
      style={data.relation ? RELATION_HOVER : undefined}
    >
      <BaseEdge
        path={data.path}
        className={data.state === "now" || data.state === "needs" ? NOW_CLASS : undefined}
        style={{
          stroke,
          strokeWidth,
          strokeDasharray: data.state === "skipped" ? "3 4" : data.state ? undefined : STROKE_DASHARRAY[data.variant],
          opacity: data.state === "skipped" ? 0.55 : undefined,
          fill: "none",
        }}
      />
      {data.state === "skipped" ? <Strike x={labelX} y={labelY} /> : null}
      {(data.junctions ?? []).map((junction) => (
        <JunctionMark key={`${junction.kind}:${junction.x}:${junction.y}`} junction={junction} />
      ))}
      {data.label && relationLabelVisible(data, hovered) ? (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              fontSize: 10,
              color: "var(--muted-foreground)",
              background: "var(--card)",
              padding: "0 4px",
              borderRadius: 4,
              pointerEvents: "none",
            }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </g>
  );
}

/** A split or join: a small ring; a decision: a diamond (BBP-303). */
function JunctionMark({ junction }: { junction: Junction }) {
  const { x, y, kind } = junction;
  const style = { fill: "var(--card)", stroke: "var(--muted-foreground)", strokeWidth: 1.5 };
  if (kind === "decision") return <path d={`M ${x} ${y - 5} L ${x + 5} ${y} L ${x} ${y + 5} L ${x - 5} ${y} Z`} style={style} />;
  return <circle cx={x} cy={y} r={3.5} style={style} />;
}

/** The mark across an exit the run did not take. */
function Strike({ x, y }: { x: number; y: number }) {
  return <path d={`M ${x - 4} ${y + 5} L ${x + 4} ${y - 5}`} style={{ stroke: "var(--muted-foreground)", strokeWidth: 1.5, fill: "none" }} />;
}

/** The path's own midpoint, read from its end points — exact enough for a
 *  label, without re-deriving the curve's geometry here. */
function midpoint(path: string): [number, number] {
  const points = [...path.matchAll(/(-?[\d.]+)[ ,](-?[\d.]+)/g)].map(
    (match) => [Number(match[1]), Number(match[2])] as const,
  );
  const first = points[0] ?? [0, 0];
  const last = points[points.length - 1] ?? first;
  return [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2];
}

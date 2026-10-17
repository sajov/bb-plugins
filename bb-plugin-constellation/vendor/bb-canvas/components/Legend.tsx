// agent-graph's legend (BBP-298): what each card colour means, how many nodes
// on the canvas are running, failed, done or idle, and the gestures. Folds
// down to its title so it never covers the tree for long.
import { useState } from "react";
import { STATUS_COLORS, statusKey, TYPE_COLORS, TYPE_LABELS, type ColorMode, type TypeColorKey } from "../lib/kind-colors";
import type { CanvasNode } from "../lib/types";

const STATUS_LABELS = { running: "Running", failed: "Error", done: "Done", idle: "Idle" } as const;

function Dot({ color }: { color: string }) {
  return <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />;
}

export function Legend({ nodes, colorBy }: { nodes: readonly CanvasNode[]; colorBy: ColorMode }) {
  const needs = nodes.filter((node) => node.meta?.needsYou).length;
  const [open, setOpen] = useState(true);
  const counts = { running: 0, failed: 0, done: 0, idle: 0 };
  for (const node of nodes) if (node.kind !== "agents" && node.kind !== "project") counts[statusKey(node.status)] += 1;
  const row = { display: "flex", flexWrap: "wrap" as const, alignItems: "center", gap: 12, fontSize: 11 };
  return (
    <section
      aria-label="Legend"
      style={{ border: "1px solid var(--border)", borderRadius: 8, background: "var(--card)", color: "var(--foreground)", padding: "6px 10px", boxShadow: "0 1px 3px rgb(0 0 0 / 0.08)" }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        style={{ display: "flex", alignItems: "center", gap: 4, border: "none", background: "transparent", color: "inherit", fontSize: 12, fontWeight: 600, padding: 0, cursor: "pointer" }}
      >
        Legend
        <svg aria-hidden width={10} height={10} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" style={{ transform: open ? undefined : "rotate(-90deg)" }}>
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
          {colorBy === "type" ? (
            <div style={row}>
              {(Object.keys(TYPE_COLORS) as TypeColorKey[]).map((key) => (
                <span key={key} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <Dot color={TYPE_COLORS[key]} />
                  {TYPE_LABELS[key]}
                </span>
              ))}
            </div>
          ) : null}
          <div style={row}>
            {(Object.keys(STATUS_LABELS) as (keyof typeof STATUS_LABELS)[]).map((key) => (
              <span key={key} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <Dot color={STATUS_COLORS[key]} />
                {STATUS_LABELS[key]}
                <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{counts[key]}</span>
              </span>
            ))}
            {/* BBP-303: what waits for the human, counted apart from the states. */}
            <span style={{ display: "flex", alignItems: "center", gap: 5, color: needs > 0 ? "#b45309" : undefined, fontWeight: needs > 0 ? 600 : undefined }}>
              <Dot color="#f59e0b" />
              Needs you
              <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{needs}</span>
            </span>
          </div>
          <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>
            Click a node for details · double-click a thread to open its chat · drag or scroll to pan · ⌘/Ctrl+scroll to zoom · J jumps to running work
          </div>
        </div>
      ) : null}
    </section>
  );
}

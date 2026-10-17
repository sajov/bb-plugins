// Details of the selected node: a header (icon, label, status), one section
// per kind with its curated fields (BBP-185), and a collapsed "Details"
// block for everything else a provider put in `meta`. A chat or replay feed
// for `thread`/`turn` nodes is a later ticket, once there is a timeline to
// lazily load into this same slot.
import { useState, type ReactNode } from "react";
import { curateMeta, type CanvasNode, type CuratedField, type CanvasStatus } from "../lib/types";
import type { RelationGroup } from "../lib/relations";
import { KindIcon, KIND_LABEL } from "./KindIcon";
import { Accordion } from "./Accordion";
import { SidePanel } from "./SidePanel";

/** One fixed pill colour per status — the same precedence NodeCard's border
 *  uses, just as a background instead of an outline. */
const STATUS_COLOR: Record<CanvasStatus, string> = {
  idle: "var(--muted-foreground)",
  running: "var(--primary)",
  waiting: "var(--warning)",
  done: "var(--muted-foreground)",
  failed: "var(--destructive)",
  escalated: "var(--warning)",
};

function StatusPill({ status }: { status: CanvasStatus }) {
  const color = STATUS_COLOR[status];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        flexShrink: 0,
        height: 18,
        padding: "0 7px",
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.02em",
        color,
        // A tint of the status colour, not a bare outline: it keeps the pill
        // legible on both themes without a hex value per theme.
        background: `color-mix(in oklab, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in oklab, ${color} 45%, transparent)`,
      }}
    >
      {status[0].toUpperCase() + status.slice(1)}
    </span>
  );
}

/** Inline because bb-canvas cannot import BB's Button: the same tokens, the
 *  same 28 px height, and a focus ring from `:focus-visible` in SIDEBAR_CSS. */
const ACTION_STYLE = {
  display: "inline-flex",
  alignItems: "center",
  height: 28,
  padding: "0 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--card)",
  color: "var(--foreground)",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
} as const;

function SectionHeading({ children }: { children: string }) {
  return (
    <h3
      style={{
        margin: 0,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: "var(--muted-foreground)",
      }}
    >
      {children}
    </h3>
  );
}

// Long values (a full shell command, raw tool output) would otherwise blow
// out the sidebar's main body; truncated here, with the full value one
// click away rather than silently absent (BBP-206 review round 1).
const LONG_VALUE_THRESHOLD = 140;

function FieldValue({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);
  if (value.length <= LONG_VALUE_THRESHOLD) return <>{value}</>;
  return (
    <>
      {expanded ? value : `${value.slice(0, LONG_VALUE_THRESHOLD)}…`}{" "}
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="bb-canvas-action"
        style={{ ...ACTION_STYLE, height: 20, padding: "0 6px", fontSize: 11 }}
      >
        {expanded ? "less" : "more"}
      </button>
    </>
  );
}

// Machine text (a shell command, tool input, raw output) reads as code, not
// prose: monospace on a quiet well, whitespace kept (BBP-206 design).
const CODE_FIELDS = new Set(["Command", "Input", "Output", "Detail", "Stdout", "Stderr", "Query"]);

const CODE_STYLE = {
  display: "block",
  margin: 0,
  padding: "6px 8px",
  borderRadius: 6,
  background: "var(--muted)",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
  lineHeight: 1.45,
  whiteSpace: "pre-wrap",
} as const;

/** The values on a tool call that say "this failed" — a non-zero exit code,
 *  an error, stderr — carry the destructive colour, not the body colour. */
function isFailedExit(field: { label: string; value: string }): boolean {
  return (field.label === "Exit code" && field.value !== "0") || field.label === "Error" || field.label === "Stderr";
}

function FieldList({ fields }: { fields: { label: string; value: string }[] }) {
  return (
    <dl style={{ margin: 0, fontSize: 12, display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", gap: "6px 12px", lineHeight: 1.4 }}>
      {fields.map((field) => {
        const code = CODE_FIELDS.has(field.label);
        return (
          <div key={field.label} style={{ display: "contents" }}>
            <dt style={{ color: "var(--muted-foreground)", paddingTop: code ? 6 : 0 }}>{field.label}</dt>
            <dd
              style={{
                margin: 0,
                overflowWrap: "anywhere",
                whiteSpace: "pre-line",
                ...(isFailedExit(field) ? { color: "var(--destructive)", fontWeight: 600 } : {}),
              }}
            >
              {code ? (
                <code style={CODE_STYLE}>
                  <FieldValue value={field.value} />
                </code>
              ) : (
                <FieldValue value={field.value} />
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** A bundle's entries (each thought's text, each event's title) as their own
 *  readable items, separated, each long one behind its own "more" — not one
 *  run-together blob in the collapsed Details (BBP-206 R3 design). */
function EntryList({ entries }: { entries: readonly string[] }) {
  return (
    <div>
      <ol style={{ margin: 0, padding: 0, listStyle: "none", fontSize: 12, lineHeight: 1.5 }}>
        {entries.map((entry, index) => (
          <li
            key={index}
            style={{
              padding: "8px 0",
              borderTop: index === 0 ? "none" : "1px solid var(--border)",
              overflowWrap: "anywhere",
              whiteSpace: "pre-line",
            }}
          >
            <FieldValue value={entry} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry !== "") : [];
}

export type SidebarProps = {
  node: CanvasNode;
  onClose: () => void;
  /** Shown as "Open thread" only when `meta.threadId` is a string. */
  onOpenThread?: (threadId: string) => void;
  /** Shown as "Open run" only when `meta.runId` is a string. */
  onOpenRun?: (runId: string) => void;
  /** Shown as "Open crew" only when `meta.crew` is a string. */
  onOpenCrew?: (crew: string) => void;
  /** Shown as "Open in thread" only when `meta.threadId` is a string and
   *  `meta.sourceSeq` is a number; it then replaces "Open thread", which
   *  would open the same thread a second way. */
  onOpenAtRow?: (threadId: string, seq: number) => void;
  /** The node's own relations by kind (BBP-203); a target's name selects it
   *  through `onSelect`. Empty or absent: no section. */
  relations?: readonly RelationGroup[];
  onSelect?: (nodeId: string) => void;
  /** Shown as "Focus this" only for a crew/graph-run/thread node (BBP-242);
   *  replaces the whole focus selection with just this node's id. */
  onFocusThis?: (id: string) => void;
  /** A page-owned section after the relations (BBP-291). */
  extra?: ReactNode;
  /** Above everything else — the canvas's breadcrumb (BBP-298). */
  header?: ReactNode;
  /** Pinned below the sections, outside the scroll — a chat composer. */
  footer?: ReactNode;
  /** In the always-open panel (BBP-313): a "← Overview" button replaces the
   *  close button, and `onClose` is not shown. */
  onBack?: () => void;
  /** Extra buttons on the right of the panel header (collapse, say). */
  headerActions?: ReactNode;
};

const FOCUSABLE_KINDS = new Set<CanvasNode["kind"]>(["crew", "graph-run", "thread"]);

function stringMeta(node: CanvasNode, key: string): string | undefined {
  const value = node.meta?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function numberMeta(node: CanvasNode, key: string): number | undefined {
  const value = node.meta?.[key];
  return typeof value === "number" ? value : undefined;
}

export function Sidebar({
  node,
  onClose,
  onOpenThread,
  onOpenRun,
  onOpenCrew,
  onOpenAtRow,
  relations = [],
  onSelect,
  onFocusThis,
  extra,
  header,
  footer,
  onBack,
  headerActions,
}: SidebarProps) {
  const { curated, details: allDetails, debug } = curateMeta(node.kind, node.meta);
  // A bundle's `titles` render as their own list below, not again in Details.
  const entries = stringList(node.meta?.titles);
  const details = entries.length > 0 ? allDetails.filter((field) => field.label !== "Events") : allDetails;
  const entriesTitle = /\bthoughts?\b/.test(node.label) ? "Thoughts" : "Events";
  const runId = onOpenRun ? stringMeta(node, "runId") : undefined;
  const crew = onOpenCrew ? stringMeta(node, "crew") : undefined;
  const atRowThreadId = onOpenAtRow ? stringMeta(node, "threadId") : undefined;
  const atRowSeq = onOpenAtRow ? numberMeta(node, "sourceSeq") : undefined;
  const atRow = atRowThreadId !== undefined && atRowSeq !== undefined ? { threadId: atRowThreadId, seq: atRowSeq } : undefined;
  const threadId = onOpenThread && atRow === undefined ? stringMeta(node, "threadId") : undefined;
  const canFocusThis = onFocusThis !== undefined && FOCUSABLE_KINDS.has(node.kind);
  const hasActions = threadId !== undefined || runId !== undefined || crew !== undefined || atRow !== undefined || canFocusThis;
  // Open/closed is remembered per kind: a tool call's Details stay open for
  // the next tool call, not for the next thread (BBP-313).
  const key = (section: string) => `node:${node.kind}:${section}`;

  const panelHeader = onBack ? (
    <>
      <button type="button" onClick={onBack} className="bb-canvas-action" style={{ ...ACTION_STYLE, border: "none", background: "transparent", padding: "0 6px", color: "var(--muted-foreground)" }}>
        ← Overview
      </button>
      <span style={{ flex: 1 }} />
      {headerActions}
    </>
  ) : (
    <>
      <span style={{ flex: 1 }} />
      {headerActions}
      <IconButton label="Close details" onClick={onClose}>
        <path d="M4 4l8 8M12 4l-8 8" />
      </IconButton>
    </>
  );

  return (
    <SidePanel label={`Details for ${node.label}`} header={panelHeader}>
      <div style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
        {header ? <div style={{ padding: "8px 12px 0" }}>{header}</div> : null}
        {/* Who and what this is: always needed, so never behind a fold. */}
        <header style={{ display: "flex", alignItems: "start", gap: 10, padding: "12px", borderBottom: "1px solid var(--border)" }}>
          <span
            aria-hidden
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              width: 28,
              height: 28,
              borderRadius: 6,
              border: "1px solid var(--border)",
              color: "var(--muted-foreground)",
            }}
          >
            <KindIcon kind={node.kind} />
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>{KIND_LABEL[node.kind]}</span>
              {node.status ? <StatusPill status={node.status} /> : null}
            </div>
            <h2
              title={node.label}
              style={{
                margin: 0,
                fontSize: 14,
                fontWeight: 600,
                lineHeight: 1.3,
                overflowWrap: "anywhere",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {node.label}
            </h2>
            {hasActions ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {threadId !== undefined ? (
                  <button type="button" onClick={() => onOpenThread?.(threadId)} className="bb-canvas-action" style={ACTION_STYLE}>
                    Open thread
                  </button>
                ) : null}
                {runId !== undefined ? (
                  <button type="button" onClick={() => onOpenRun?.(runId)} className="bb-canvas-action" style={ACTION_STYLE}>
                    Open run
                  </button>
                ) : null}
                {crew !== undefined ? (
                  <button type="button" onClick={() => onOpenCrew?.(crew)} className="bb-canvas-action" style={ACTION_STYLE}>
                    Open crew
                  </button>
                ) : null}
                {atRow !== undefined ? (
                  <button type="button" onClick={() => onOpenAtRow?.(atRow.threadId, atRow.seq)} className="bb-canvas-action" style={ACTION_STYLE}>
                    Open in thread
                  </button>
                ) : null}
                {canFocusThis ? (
                  <button type="button" onClick={() => onFocusThis?.(node.id)} className="bb-canvas-action" style={ACTION_STYLE}>
                    Focus this
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </header>
        {curated.length > 0 ? (
          <Accordion title={KIND_LABEL[node.kind]} storageKey={key("curated")}>
            <FieldList fields={curated} />
          </Accordion>
        ) : null}
        {entries.length > 0 ? (
          <Accordion title={entriesTitle} summary={entries.length} storageKey={key("entries")}>
            <EntryList entries={entries} />
          </Accordion>
        ) : null}
        {relations.length > 0 ? (
          <Accordion title="Relations" summary={relations.reduce((sum, group) => sum + group.targets.length, 0)} storageKey={key("relations")}>
            {relations.map((group) => (
              <div key={group.kind} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <SectionHeading>{group.kind}</SectionHeading>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {group.targets.map((target) => (
                    <button key={target.id} type="button" onClick={() => onSelect?.(target.id)} className="bb-canvas-action" style={ACTION_STYLE}>
                      {target.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </Accordion>
        ) : null}
        {extra}
        {details.length > 0 ? (
          <Accordion title="Details" summary={details.length} defaultOpen={false} storageKey={key("details")}>
            <FieldList fields={details} />
          </Accordion>
        ) : null}
        {debug.length > 0 ? (
          <Accordion title="Debug" summary={debug.length} defaultOpen={false} storageKey={key("debug")}>
            <FieldList fields={debug} />
          </Accordion>
        ) : null}
        {footer ? <div style={{ marginTop: "auto", position: "sticky", bottom: 0, padding: 12, borderTop: "1px solid var(--border)", background: "var(--background)" }}>{footer}</div> : null}
      </div>
    </SidePanel>
  );
}

/** A 28 px square, borderless icon button for a panel header. */
export function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="bb-canvas-action"
      style={{ ...ACTION_STYLE, justifyContent: "center", width: 28, padding: 0, border: "none", background: "transparent", color: "var(--muted-foreground)" }}
    >
      <svg aria-hidden width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}

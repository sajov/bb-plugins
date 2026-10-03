// Graph editor: the graph itself is the entry point.
//
// A node is clicked on the canvas, and a card opens with everything about it —
// its settings and the edges coming in and going out. Edges can also be drawn
// by dragging between nodes. Positions are still not dragged: the layout is
// computed, so the only thing worth editing is the structure. Every change
// re-lays out and re-checks immediately, which is what makes a cyclic graph
// safe to author by hand.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  // Aliased because JSX reads a lowercase tag as an intrinsic element.
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_useProviders,
} from "@get-bb/plugin-sdk/app";
import {
  CONDITION_OPS,
  END_NODE,
  FIELD_TYPES,
  KIND_LABEL,
  NODE_COLORS,
  NODE_KINDS,
  ROUTING_MODES,
  START_NODE,
  conditionSchema,
  edgeSchema,
  fieldSchema,
  graphSchema,
  nodeExecution,
  nodeSchema,
  spawnsThread,
  validateGraph,
  type Condition,
  type Graph,
  type GraphEdge,
  type GraphNode,
} from "../lib/graph";
import { runCommand } from "../lib/describe";
import { edgeLabel } from "../lib/layout";
import { groupedLibrary } from "../lib/templates";
import { GraphCanvas, CanvasLegend } from "./graph-canvas";
import { CopyCommand } from "./copy-command";
import { FullscreenLayer } from "./fullscreen";
import { ExportedFileView, type ExportedFile } from "./exported-file";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import {
  FIELD_CONTROL,
  FIELD_HINT,
  FIELD_LABEL,
  InspectorFooter,
  InspectorHeader,
  InspectorSection,
} from "./inspector";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const KIND_ICONS: Record<(typeof NODE_KINDS)[number], IconName> = {
  agent: "Bot",
  dialog: "MessageQuestion",
  human: "CircleCheck",
  note: "Edit",
  subgraph: "Workflow",
  member: "Users",
};

const KIND_LABELS: Record<(typeof NODE_KINDS)[number], string> = {
  agent: "Agent (own thread)",
  dialog: "Dialogue (asks you, waits for an answer)",
  human: "Approval (waits for you)",
  note: "Note (does nothing)",
  subgraph: "Subgraph (embeds another graph)",
  member: "Crew member (a persistent member's thread does the step)",
};

/**
 * Spelled out rather than "first"/"every", because the short form reads as a
 * count and this is a choice between two behaviours. The node's own outgoing
 * edges look identical either way — that is exactly why the setting cannot
 * hide in the collapsed "Execution" section.
 */
const ROUTING_LABELS: Record<(typeof ROUTING_MODES)[number], string> = {
  first: "the first matching edge",
  every: "every matching edge",
};

const FIELD_TYPE_LABELS: Record<(typeof FIELD_TYPES)[number], string> = {
  string: "Text",
  number: "Number",
  boolean: "Yes/No",
  enum: "Choice",
  list: "List (can fan out)",
};

/**
 * The schema's own defaults, so the "what deviates from normal" summary below
 * cannot drift from what a fresh node actually is.
 */
const NODE_DEFAULTS = nodeSchema.parse({ id: "n", label: "n" });

/**
 * What the collapsed execution section has to admit to. A setting that is
 * folded away is a setting nobody sees — and an unseen model choice is exactly
 * the kind of silently-active state this project keeps getting bitten by. So
 * the summary names every deviation from the defaults, and says "Standard"
 * only when there is genuinely nothing to know.
 */
function executionSummary(node: GraphNode): string {
  const parts: string[] = [];
  const execution = nodeExecution(node);
  if (execution) {
    parts.push(execution.model);
    if (execution.reasoningLevel) parts.push(`Reasoning ${execution.reasoningLevel}`);
  } else if (node.providerId || node.model) {
    // Half a selection: validation reports it as an error, and the summary
    // must not pretend the node is configured.
    parts.push("incomplete model choice");
  }
  if (node.maxVisits !== NODE_DEFAULTS.maxVisits) {
    parts.push(`max. ${node.maxVisits} visits`);
  }
  if (node.maxAttempts !== NODE_DEFAULTS.maxAttempts) {
    parts.push(`${node.maxAttempts} attempts`);
  }
  if (node.kind === "dialog" && node.maxTurns !== NODE_DEFAULTS.maxTurns) {
    parts.push(`${node.maxTurns} questions`);
  }
  if (node.onError !== NODE_DEFAULTS.onError) {
    parts.push("routes its failure");
  }
  return parts.length === 0 ? "Default" : parts.join(" · ");
}

const OP_LABEL: Record<(typeof CONDITION_OPS)[number], string> = {
  always: "always (fallback)",
  contains: "result contains",
  notContains: "result does not contain",
  equals: "result is exactly",
  matches: "result matches regex",
  visitsBelow: "node ran fewer than N times",
  failed: "node failed",
  succeeded: "node succeeded",
};

/** The two conditions that ask about an outcome instead of reading text. */
function isOutcomeOp(op: Condition["op"]): boolean {
  return op === "failed" || op === "succeeded";
}

/**
 * A new node, with every field the schema declares. Built through the schema
 * rather than written out by hand: the three literals this replaced each had
 * to be remembered whenever a field was added, and the one that was forgotten
 * would only show up as a type error — or, worse, not at all.
 */
function newNode(id: string, label: string, prompt = ""): GraphNode {
  return nodeSchema.parse({ id, label, prompt });
}

/** An edge, for the same reason `newNode` exists: the schema owns the fields. */
function newEdge(from: string, to: string): GraphEdge {
  return edgeSchema.parse({ from, to });
}

/**
 * A blank draft is deliberately NOT parsed: an empty id and name are exactly
 * what the user is about to fill in, but they fail the schema, so parsing here
 * threw a ZodError during the editor's first render. The draft is held as a
 * plain value and validated continuously instead; `onSave` is the one place
 * that parses, and it is gated on that validation passing.
 */
function emptyGraph(): Graph {
  return {
    id: "",
    name: "",
    description: "",
    example: "",
    nodes: [newNode("step1", "First step", "Work on:\n\n{{input}}")],
    edges: [newEdge(START_NODE, "step1"), newEdge("step1", END_NODE)],
    maxSteps: 60,
    maxFanOut: 12,
    positions: {},
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * How a node runs, as opposed to what it does: guards, retries, and the
 * optional provider/model.
 *
 * Folded away on purpose. Everything in here has a working default, while the
 * things above it — kind, prompt, skills, declared fields — are what authoring
 * a graph actually consists of. The same split is what the next two roadmap
 * items need: a code node adds to the content half, a free state schema is a
 * graph-level concern, and neither has to squeeze past the tuning knobs.
 *
 * The summary is not decoration. A collapsed section hides state, and hidden
 * state that silently takes effect is this project's recurring bug — so the
 * fold has to say what deviates before anyone opens it.
 */
function NodeExecutionSection({
  node,
  index,
  onPatch,
  defaultOpen = false,
  only,
}: {
  node: GraphNode;
  index: number;
  onPatch: (patch: Partial<GraphNode>) => void;
  /** Unfolded from the start. */
  defaultOpen?: boolean;
  /**
   * One half only, for the inspector: the model is what a review looks at
   * first, the guards are tuning. Without it, both in one folded section.
   */
  only?: "model" | "limits";
}) {
  const providers = experimental_useProviders();
  const execution = nodeExecution(node);
  const explicit = node.providerId !== null || node.model !== null;

  return (
    only === "model" ? (
      <div className="space-y-2">
        {spawnsThread(node) ? (
          <div className="space-y-1">
            <span className={FIELD_LABEL}>Model</span>
            <select
              value={explicit ? "explicit" : "inherit"}
              onChange={(event) => {
                if (event.target.value === "inherit") {
                  onPatch({
                    providerId: null,
                    model: null,
                    reasoningLevel: null,
                    serviceTier: null,
                  });
                  return;
                }
                // Seeding only the provider leaves the node incomplete, and
                // validation says so in as many words. That is better than
                // inventing a model id the catalog may not have: a wrong one
                // would be found only when a worker fails to start.
                onPatch({
                  providerId: providers.providers[0]?.id ?? "",
                  model: "",
                });
              }}
              aria-label={`Model choice of node ${index + 1}`}
              className={FIELD_CONTROL}
            >
              <option value="inherit">Inherit from the parent thread</option>
              <option value="explicit">Set for this node</option>
            </select>
            {explicit ? null : (
              <p className={FIELD_HINT}>
                With no choice of its own, the worker runs on the model of the
                thread the run belongs to.
              </p>
            )}
            {explicit ? (
              <ProviderModelPicker
                value={{
                  providerId: node.providerId ?? "",
                  model: node.model ?? "",
                  reasoningLevel: node.reasoningLevel ?? "medium",
                  ...(node.serviceTier ? { serviceTier: node.serviceTier } : {}),
                }}
                onChange={(value) =>
                  onPatch({
                    providerId: value.providerId,
                    model: value.model,
                    reasoningLevel: value.reasoningLevel,
                    serviceTier: value.serviceTier ?? null,
                  })
                }
              />
            ) : null}
            {explicit && !execution ? (
              <p className="text-[11px] text-destructive">
                Provider and model belong together — set halfway, the choice
                is discarded and the node would run on the inherited model.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    ) : only === "limits" ? (
      <div className="space-y-2">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-[11px] text-muted-foreground">
              At most N visits
            </span>
            <Input
              type="number"
              min={1}
              max={50}
              value={node.maxVisits}
              onChange={(event) =>
                onPatch({
                  maxVisits: Number.parseInt(event.target.value, 10) || 1,
                })
              }
              aria-label={`Visit limit of node ${index + 1}`}
              className="h-8 px-2 text-xs"
            />
          </label>
          <label className="space-y-1">
            <span className="text-[11px] text-muted-foreground">
              Attempts per visit
            </span>
            <Input
              type="number"
              min={1}
              max={5}
              value={node.maxAttempts}
              onChange={(event) =>
                onPatch({
                  maxAttempts: Number.parseInt(event.target.value, 10) || 1,
                })
              }
              aria-label={`Attempts of node ${index + 1}`}
              className="h-8 px-2 text-xs"
            />
          </label>
          {node.kind === "dialog" ? (
            <label className="space-y-1">
              <span className="text-[11px] text-muted-foreground">
                Questions before wrapping up
              </span>
              <Input
                type="number"
                min={1}
                max={50}
                value={node.maxTurns}
                onChange={(event) =>
                  onPatch({
                    maxTurns: Number.parseInt(event.target.value, 10) || 1,
                  })
                }
                aria-label={`Questions of node ${index + 1}`}
                className="h-8 px-2 text-xs"
              />
            </label>
          ) : null}
        </div>

        {node.kind === "agent" || node.kind === "dialog" || node.kind === "member" ? (
          <label className="space-y-1">
            <span className="block text-[11px] text-muted-foreground">
              When the attempts are used up
            </span>
            <select
              value={node.onError}
              onChange={(event) =>
                onPatch({ onError: event.target.value as GraphNode["onError"] })
              }
              aria-label={`Failure handling of node ${index + 1}`}
              className={FIELD_CONTROL}
            >
              <option value="stop">End the run</option>
              <option value="route">
                Carry on — an edge decides, using "failed"
              </option>
            </select>
          </label>
        ) : null}

      </div>
    ) : (
    <details className="rounded-md border border-border" open={defaultOpen || undefined}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground">
        <Icon name="Settings" className="size-3.5" />
        Execution
        <span className="text-foreground">{executionSummary(node)}</span>
      </summary>
      <div className="space-y-2 border-t border-border px-2 py-2">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-[11px] text-muted-foreground">
              At most N visits
            </span>
            <Input
              type="number"
              min={1}
              max={50}
              value={node.maxVisits}
              onChange={(event) =>
                onPatch({
                  maxVisits: Number.parseInt(event.target.value, 10) || 1,
                })
              }
              aria-label={`Visit limit of node ${index + 1}`}
              className="h-8 px-2 text-xs"
            />
          </label>
          <label className="space-y-1">
            <span className="text-[11px] text-muted-foreground">
              Attempts per visit
            </span>
            <Input
              type="number"
              min={1}
              max={5}
              value={node.maxAttempts}
              onChange={(event) =>
                onPatch({
                  maxAttempts: Number.parseInt(event.target.value, 10) || 1,
                })
              }
              aria-label={`Attempts of node ${index + 1}`}
              className="h-8 px-2 text-xs"
            />
          </label>
          {node.kind === "dialog" ? (
            <label className="space-y-1">
              <span className="text-[11px] text-muted-foreground">
                Questions before wrapping up
              </span>
              <Input
                type="number"
                min={1}
                max={50}
                value={node.maxTurns}
                onChange={(event) =>
                  onPatch({
                    maxTurns: Number.parseInt(event.target.value, 10) || 1,
                  })
                }
                aria-label={`Questions of node ${index + 1}`}
                className="h-8 px-2 text-xs"
              />
            </label>
          ) : null}
        </div>

        {node.kind === "agent" || node.kind === "dialog" || node.kind === "member" ? (
          <label className="space-y-1">
            <span className="block text-[11px] text-muted-foreground">
              When the attempts are used up
            </span>
            <select
              value={node.onError}
              onChange={(event) =>
                onPatch({ onError: event.target.value as GraphNode["onError"] })
              }
              aria-label={`Failure handling of node ${index + 1}`}
              className={FIELD_CONTROL}
            >
              <option value="stop">End the run</option>
              <option value="route">
                Carry on — an edge decides, using "failed"
              </option>
            </select>
          </label>
        ) : null}

        {spawnsThread(node) ? (
          <div className="space-y-1">
            <span className="block text-[11px] text-muted-foreground">
              Model — with no choice of its own, the worker runs on the model
              of the thread the run belongs to.
            </span>
            <select
              value={explicit ? "explicit" : "inherit"}
              onChange={(event) => {
                if (event.target.value === "inherit") {
                  onPatch({
                    providerId: null,
                    model: null,
                    reasoningLevel: null,
                    serviceTier: null,
                  });
                  return;
                }
                // Seeding only the provider leaves the node incomplete, and
                // validation says so in as many words. That is better than
                // inventing a model id the catalog may not have: a wrong one
                // would be found only when a worker fails to start.
                onPatch({
                  providerId: providers.providers[0]?.id ?? "",
                  model: "",
                });
              }}
              aria-label={`Model choice of node ${index + 1}`}
              className={FIELD_CONTROL}
            >
              <option value="inherit">Inherit from the parent thread</option>
              <option value="explicit">Set for this node</option>
            </select>
            {explicit ? (
              <ProviderModelPicker
                value={{
                  providerId: node.providerId ?? "",
                  model: node.model ?? "",
                  reasoningLevel: node.reasoningLevel ?? "medium",
                  ...(node.serviceTier ? { serviceTier: node.serviceTier } : {}),
                }}
                onChange={(value) =>
                  onPatch({
                    providerId: value.providerId,
                    model: value.model,
                    reasoningLevel: value.reasoningLevel,
                    serviceTier: value.serviceTier ?? null,
                  })
                }
              />
            ) : null}
            {explicit && !execution ? (
              <p className="text-[11px] text-destructive">
                Provider and model belong together — set halfway, the choice
                is discarded and the node would run on the inherited model.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
    )
  );
}

/** "nodes.2.id" → "Node 3 · Id", so an issue points at a visible field. */
function fieldLabel(path: ReadonlyArray<PropertyKey>): string {
  const [head, index, field] = path;
  if (head === "nodes") return `Node ${Number(index) + 1} · ${String(field ?? "")}`;
  if (head === "edges") return `Edge ${Number(index) + 1} · ${String(field ?? "")}`;
  if (head === "id") return "Id";
  if (head === "name") return "Name";
  return path.map(String).join(".") || "Graph";
}

function issueText(path: ReadonlyArray<PropertyKey>, message: string): string {
  const field = path[path.length - 1];
  if (field === "id") {
    return "Lowercase letter first, then lowercase letters, digits or hyphens.";
  }
  if (field === "name") return "must not be empty.";
  return message;
}

/** A Crew member the member picker offers (plugin `crew`, `listMembers`). */
export type CrewMemberOption = { address: string; role: string; activity: string };

export type AvailableSkill = {
  id: string;
  name: string;
  description: string | null;
  scope: string;
};

export function GraphEditor({
  graphs,
  templates,
  graphId,
  pending,
  availableSkills = [],
  skillsError = null,
  crewMembers = [],
  onSave,
  onCancel,
  onClone,
  onDelete,
  onExport,
  onImport,
  exported = null,
  exporting = false,
  onDismissExport,
  startFullscreen = false,
  onOpenGraph,
}: {
  graphs: Graph[];
  templates: Graph[];
  graphId: string | null;
  pending: boolean;
  availableSkills?: AvailableSkill[];
  skillsError?: string | null;
  crewMembers?: CrewMemberOption[];
  onSave: (graph: Graph) => void;
  onCancel: () => void;
  onClone: (templateId: string, id: string, name: string) => void;
  onDelete: (id: string) => void;
  onExport?: (id: string) => void;
  onImport?: (json: string) => void;
  exported?: ExportedFile | null;
  exporting?: boolean;
  onDismissExport?: () => void;
  /**
   * Open straight into full screen. The panel asks for it when an existing
   * graph is edited: editing is work on the graph, and the graph needs the
   * room. A new graph starts in the panel, where the template picker is.
   */
  startFullscreen?: boolean;
  /** Opens another graph of the library in the editor — an imported one. */
  onOpenGraph?: (id: string) => void;
}) {
  const existing = graphId ? graphs.find((entry) => entry.id === graphId) : null;
  /**
   * The draft with its history, in one state so undo and the change it undoes
   * can never be half applied. Keystrokes within a moment of each other count
   * as one step — undoing a label letter by letter is not undo, it is typing
   * backwards.
   */
  const [history, setHistory] = useState<{
    draft: Graph;
    past: Graph[];
    future: Graph[];
  }>(() => ({ draft: existing ?? emptyGraph(), past: [], future: [] }));
  const draft = history.draft;
  const lastChange = useRef(0);
  const setDraft = useCallback((next: Graph | ((current: Graph) => Graph)) => {
    const now = Date.now();
    const push = now - lastChange.current > 600;
    lastChange.current = now;
    setHistory((state) => {
      const value = typeof next === "function" ? next(state.draft) : next;
      if (value === state.draft) return state;
      return {
        draft: value,
        past: push ? [...state.past.slice(-99), state.draft] : state.past,
        future: [],
      };
    });
  }, []);
  const undo = useCallback(() => {
    lastChange.current = 0;
    setHistory((state) =>
      state.past.length === 0
        ? state
        : {
            draft: state.past[state.past.length - 1]!,
            past: state.past.slice(0, -1),
            future: [state.draft, ...state.future],
          },
    );
  }, []);
  const redo = useCallback(() => {
    lastChange.current = 0;
    setHistory((state) =>
      state.future.length === 0
        ? state
        : {
            draft: state.future[0]!,
            past: [...state.past, state.draft],
            future: state.future.slice(1),
          },
    );
  }, []);
  /** What was loaded, to tell a changed draft from an untouched one. */
  const [baseline] = useState(() => JSON.stringify(existing ?? emptyGraph()));
  const dirty = JSON.stringify(draft) !== baseline;
  const [confirmLeave, setConfirmLeave] = useState(false);
  const leave = () => (dirty ? setConfirmLeave(true) : onCancel());

  // Undo outside text fields only: inside one, the browser's own undo for
  // that field is what the keystroke means.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);
  const [cloneFrom, setCloneFrom] = useState(templates[0]?.id ?? "");
  const [cloneId, setCloneId] = useState("");
  const [importText, setImportText] = useState("");
  /**
   * Whose card is open: a node by position, or one of the two terminals. The
   * first node starts open, so the editor never opens on a blank card beside
   * a graph that is already there.
   */
  const [fullscreen, setFullscreen] = useState(startFullscreen);
  /** Which edge rows are unfolded, by edge index. */
  const [openEdges, setOpenEdges] = useState<Set<number>>(() => new Set());
  // Stable, so the layer's Escape listener is not re-bound on every keystroke.
  const closeFullscreen = useCallback(() => setFullscreen(false), []);
  const [selection, setSelection] = useState<number | "start" | "end" | null>(
    (existing ?? draft).nodes.length > 0 ? 0 : null,
  );

  /**
   * Subgraph nodes are validated against the library the editor already holds,
   * so an id that names nothing is an error while typing rather than at the
   * first run. Templates count too — they are graphs like any other.
   */
  const resolveGraph = useMemo(() => {
    const library = new Map(
      [...templates, ...graphs].map((entry) => [entry.id, entry]),
    );
    return (id: string) => library.get(id) ?? null;
  }, [graphs, templates]);

  const problems = useMemo(() => {
    const parsed = graphSchema.safeParse(draft);
    if (parsed.success) return validateGraph(parsed.data, resolveGraph);
    // Zod's own wording ("Too small…") is unhelpful next to a form field, so
    // each issue is reported with the field it belongs to.
    return parsed.error.issues.map((issue) => ({
      level: "error" as const,
      message: `${fieldLabel(issue.path)}: ${issueText(issue.path, issue.message)}`,
    }));
  }, [draft, resolveGraph]);

  const blocking = problems.filter((problem) => problem.level === "error");
  const nodeIds = draft.nodes.map((node) => node.id);
  /** Every declared field as `nodeId.fieldName`, for the condition picker. */
  const declaredFields = draft.nodes.flatMap((node) =>
    node.fields.map((field) => ({
      key: `${node.id}.${field.name}`,
      type: field.type,
    })),
  );
  /** Only a list field can be fanned out over. */
  const listFields = declaredFields.filter((entry) => entry.type === "list");
  /**
   * A handoff target comes from a choice or a text. The choice is listed first
   * and labelled as the recommended one, because it is the form that keeps the
   * canvas able to draw and the validator able to check.
   */
  const handoffFields = declaredFields.filter(
    (entry) => entry.type === "enum" || entry.type === "string",
  );
  const targets = [...nodeIds, END_NODE];
  const sources = [START_NODE, ...nodeIds];

  const patchNode = (index: number, patch: Partial<GraphNode>) =>
    setDraft((current) => {
      const previous = current.nodes[index];
      // A renamed node takes its edges along. Without this, typing a new id
      // left every edge pointing at the old one — and with the edges now
      // shown inside the node's card, they would silently drop out of it.
      // Not when the new id belongs to another node: that is a typo on the
      // way somewhere else, and merging two nodes' edges could not be undone.
      // Nor while the old id is shared: the edges then belong to the other
      // node just as much, and the next keystroke would carry them off.
      const taken = (id: string) =>
        current.nodes.some((node, i) => i !== index && node.id === id);
      const renamed =
        previous !== undefined &&
        patch.id !== undefined &&
        patch.id !== previous.id &&
        !taken(patch.id) &&
        !taken(previous.id);
      const rename = (id: string) =>
        renamed && id === previous!.id ? patch.id! : id;
      return {
        ...current,
        nodes: current.nodes.map((node, i) =>
          i === index ? { ...node, ...patch } : node,
        ),
        edges: renamed
          ? current.edges.map((edge) => ({
              ...edge,
              from: rename(edge.from),
              to: rename(edge.to),
            }))
          : current.edges,
        positions:
          renamed && current.positions?.[previous!.id]
            ? Object.fromEntries(
                Object.entries(current.positions).map(([id, at]) => [rename(id), at]),
              )
            : current.positions,
      };
    });

  const patchEdge = (index: number, patch: Partial<GraphEdge>) =>
    setDraft((current) => ({
      ...current,
      edges: current.edges.map((edge, i) =>
        i === index ? { ...edge, ...patch } : edge,
      ),
    }));

  const addEdge = (from: string, to: string) => {
    setDraft((current) => ({
      ...current,
      edges: [...current.edges, newEdge(from, to)],
    }));
    // A new edge opens straight away: its target and condition are what the
    // author is about to set.
    setOpenEdges((current) => new Set(current).add(draft.edges.length));
  };

  /**
   * A node spliced into an edge: the edge keeps its condition and now ends at
   * the new node, which carries on to the old target unconditionally.
   */
  const insertOnEdge = (from: string, to: string) => {
    const at = draft.edges.findIndex((edge) => edge.from === from && edge.to === to);
    if (at < 0) return;
    let n = draft.nodes.length + 1;
    while (draft.nodes.some((node) => node.id === `step${n}`)) n += 1;
    const id = `step${n}`;
    setDraft((current) => ({
      ...current,
      nodes: [...current.nodes, newNode(id, `Step ${n}`)],
      edges: [
        ...current.edges.slice(0, at),
        { ...current.edges[at]!, to: id },
        newEdge(id, to),
        ...current.edges.slice(at + 1),
      ],
    }));
    setOpenEdges(new Set());
    setSelection(draft.nodes.length);
  };

  const addNode = () => {
    setDraft((current) => ({
      ...current,
      nodes: [
        ...current.nodes,
        newNode(
          `step${current.nodes.length + 1}`,
          `Step ${current.nodes.length + 1}`,
        ),
      ],
    }));
    // Straight into the new node's card: adding one is the first half of
    // editing it.
    setSelection(draft.nodes.length);
  };

  /**
   * The card follows the node by position rather than by id, because the id
   * is one of the things being edited in it — selecting by id would close the
   * card on the first keystroke of a rename.
   */
  const selectedIndex =
    typeof selection === "number" && selection < draft.nodes.length
      ? selection
      : null;
  const canvasSelection =
    selection === "start"
      ? START_NODE
      : selection === "end"
        ? END_NODE
        : selectedIndex !== null
          ? draft.nodes[selectedIndex]!.id
          : null;

  const selectById = (id: string | null) => {
    if (id === null) return setSelection(null);
    if (id === START_NODE) return setSelection("start");
    if (id === END_NODE) return setSelection("end");
    const index = draft.nodes.findIndex((node) => node.id === id);
    setSelection(index >= 0 ? index : null);
  };

  /** Edges with their position in the graph, which is what their labels count. */
  const indexedEdges = draft.edges.map((edge, index) => ({ edge, index }));
  const outgoing = (id: string) =>
    indexedEdges.filter(({ edge }) => edge.from === id);
  // A self-loop is listed once, under outgoing: twice would put two identical
  // sets of controls on the card for one edge.
  const incoming = (id: string) =>
    indexedEdges.filter(({ edge }) => edge.to === id && edge.from !== id);
  /**
   * Edges that belong in no card: an end names no node there is. Validation
   * already reports them, but an edge nobody can reach to fix is worse than
   * the error, so they keep a list of their own.
   */
  const strayEdges = indexedEdges.filter(
    ({ edge }) => !sources.includes(edge.from) || !targets.includes(edge.to),
  );

  /** What a node is called in a sentence: its label, or Start/End. */
  const nameOf = (id: string) =>
    id === START_NODE
      ? "Start"
      : id === END_NODE
        ? "End"
        : (draft.nodes.find((node) => node.id === id)?.label || id);

  /**
   * One edge as a single line — where it goes and under which condition —
   * that opens into all its controls. A card listing every edge fully open
   * was the crowding: three selects and two inputs per edge, times every edge
   * the node has, before the reader even knew which edge they wanted.
   */
  const renderEdge = (
    edge: GraphEdge,
    index: number,
    side: "in" | "out" | "stray" = "stray",
  ) => {
    const other = side === "in" ? edge.from : edge.to;
    const caption = edgeLabel(edge);
    return (
      <details
        key={index}
        open={openEdges.has(index)}
        onToggle={(event) => {
          const isOpen = event.currentTarget.open;
          setOpenEdges((current) => {
            if (current.has(index) === isOpen) return current;
            const next = new Set(current);
            if (isOpen) next.add(index);
            else next.delete(index);
            return next;
          });
        }}
        className="group rounded-md border border-border/60"
      >
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-xs">
          <Icon
            name="ChevronRight"
            className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
          />
          {side === "stray" ? (
            <span className="truncate font-medium">
              {edge.from} → {edge.to}
            </span>
          ) : (
            <>
              <span className="shrink-0 text-muted-foreground">
                {side === "in" ? "from" : "to"}
              </span>
              <span className="truncate font-medium">{nameOf(other)}</span>
            </>
          )}
          {caption ? (
            <span className="min-w-0 truncate text-muted-foreground">· {caption}</span>
          ) : (
            <span className="shrink-0 text-muted-foreground">· always</span>
          )}
          {side !== "stray" && targets.concat(sources).includes(other) ? (
            <button
              type="button"
              className="ml-auto shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={(event) => {
                // Inside <summary>: without this the click also folds the row.
                event.preventDefault();
                selectById(other);
              }}
              aria-label={`Go to ${nameOf(other)}`}
              title={`Go to ${nameOf(other)}`}
            >
              <Icon name="Target" className="size-3.5" />
            </button>
          ) : null}
        </summary>
          <div className="space-y-2 border-t border-border px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={edge.from}
                onChange={(event) => patchEdge(index, { from: event.target.value })}
                aria-label={`Source of edge ${index + 1}`}
                className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
              >
                {sources.map((id) => (
                  <option key={id} value={id}>
                    {id === START_NODE ? "Start" : id}
                  </option>
                ))}
              </select>
              <Icon name="ChevronRight" className="size-4 text-muted-foreground" />
              <select
                value={edge.to}
                onChange={(event) => patchEdge(index, { to: event.target.value })}
                aria-label={`Target of edge ${index + 1}`}
                className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
              >
                {targets.map((id) => (
                  <option key={id} value={id}>
                    {id === END_NODE ? "End" : id}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-6 px-2 text-destructive"
                onClick={() =>
                  {
                    setDraft({
                      ...draft,
                      edges: draft.edges.filter((_, i) => i !== index),
                    });
                    // Indices behind the removed edge shift by one.
                    setOpenEdges(new Set());
                  }
                }
                aria-label={`Remove edge ${index + 1}`}
              >
                <Icon name="Trash2" className="size-3.5" />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={edge.when ? edge.when.op : "__none__"}
                onChange={(event) => {
                  const value = event.target.value;
                  patchEdge(index, {
                    when:
                      value === "__none__"
                        ? null
                        : conditionSchema.parse({
                            ...(edge.when ?? {}),
                            op: value as Condition["op"],
                          }),
                  });
                }}
                aria-label={`Condition of edge ${index + 1}`}
                className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
              >
                <option value="__none__">no condition</option>
                {CONDITION_OPS.map((op) => (
                  <option key={op} value={op}>
                    {OP_LABEL[op]}
                  </option>
                ))}
              </select>
              {edge.when && isOutcomeOp(edge.when.op) ? (
                // An outcome condition names a node, not a field and not a
                // search text — so it gets its own picker rather than the
                // text-and-field one below, which would offer both.
                <select
                  value={edge.when.key}
                  onChange={(event) =>
                    patchEdge(index, {
                      when: {
                        ...edge.when!,
                        source: "output",
                        key: event.target.value,
                        value: "",
                      },
                    })
                  }
                  aria-label={`Subject of edge ${index + 1}`}
                  className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                >
                  <option value="">This edge's source node</option>
                  {nodeIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              ) : null}
              {edge.when && edge.when.op !== "always" && !isOutcomeOp(edge.when.op) ? (
                <>
                  <select
                    value={
                      edge.when.source === "field"
                        ? `field:${edge.when.key}`
                        : `output:${edge.when.key}`
                    }
                    onChange={(event) => {
                      const [source, ...rest] = event.target.value.split(":");
                      patchEdge(index, {
                        when: {
                          ...edge.when!,
                          source: source === "field" ? "field" : "output",
                          key: rest.join(":"),
                        },
                      });
                    }}
                    aria-label={`Subject of edge ${index + 1}`}
                    className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                  >
                    <option value="output:">Text of this edge's source node</option>
                    {/* Declared fields first: comparing a value beats
                        searching prose, which is what broke a live run once. */}
                    {declaredFields.length > 0 ? (
                      <optgroup label="Fields (recommended)">
                        {declaredFields.map((entry) => (
                          <option key={entry.key} value={`field:${entry.key}`}>
                            {entry.key} ({FIELD_TYPE_LABELS[entry.type]})
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                    <optgroup label="Raw text">
                      {nodeIds.map((id) => (
                        <option key={id} value={`output:${id}`}>
                          Text of {id}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  <Input
                    value={edge.when.value}
                    onChange={(event) =>
                      patchEdge(index, {
                        when: { ...edge.when!, value: event.target.value },
                      })
                    }
                    placeholder={
                      edge.when.op === "visitsBelow" ? "Count" : "Search text"
                    }
                    aria-label={`Comparison value of edge ${index + 1}`}
                    className="h-8 flex-1"
                  />
                </>
              ) : null}
            </div>
            {/* Only offered once a list field exists: a fan-out needs
                something to fan out over, and an empty dropdown on every edge
                is noise on the graphs that will never use one. */}
            {listFields.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-[11px] text-muted-foreground">
                  Fan out over
                </label>
                <select
                  value={edge.fanOutOver || "__none__"}
                  onChange={(event) => {
                    const value = event.target.value;
                    patchEdge(index, {
                      fanOutOver: value === "__none__" ? "" : value,
                      // A fan-out edge carries no condition — the runtime
                      // branches over every element, so there is nothing left
                      // for a condition to decide.
                      ...(value === "__none__" ? {} : { when: null }),
                    });
                  }}
                  aria-label={`Fan-out of edge ${index + 1}`}
                  className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                >
                  <option value="__none__">no fan-out</option>
                  {listFields.map((entry) => (
                    <option key={entry.key} value={entry.key}>
                      {entry.key}
                    </option>
                  ))}
                </select>
                {edge.fanOutOver ? (
                  <span className="text-[11px] text-muted-foreground">
                    The target runs once per entry and reads it as{" "}
                    <code>{"{{item}}"}</code>; at most {draft.maxFanOut}.
                  </span>
                ) : null}
              </div>
            ) : null}
            {/* Same rule as the fan-out above: offered only once there is a
                field it could read, so it stays out of the way on the graphs
                that route the ordinary way. */}
            {handoffFields.length > 0 && !edge.fanOutOver ? (
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-[11px] text-muted-foreground">
                  Target from a field
                </label>
                <select
                  value={edge.handoffFrom || "__none__"}
                  onChange={(event) => {
                    const value = event.target.value;
                    patchEdge(index, {
                      handoffFrom: value === "__none__" ? "" : value,
                    });
                  }}
                  aria-label={`Handoff of edge ${index + 1}`}
                  className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                >
                  <option value="__none__">no, the target above</option>
                  <optgroup label="Choice (recommended)">
                    {handoffFields
                      .filter((entry) => entry.type === "enum")
                      .map((entry) => (
                        <option key={entry.key} value={entry.key}>
                          {entry.key}
                        </option>
                      ))}
                  </optgroup>
                  <optgroup label="Free text (open swarm)">
                    {handoffFields
                      .filter((entry) => entry.type === "string")
                      .map((entry) => (
                        <option key={entry.key} value={entry.key}>
                          {entry.key}
                        </option>
                      ))}
                  </optgroup>
                </select>
                {edge.handoffFrom ? (
                  <span className="text-[11px] text-muted-foreground">
                    The worker picks the next node. The target above becomes the
                    fallback for when it names nothing known.
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
      </details>
    );
  };

  const edgeGroup = ({
    title,
    entries,
    onAdd,
    addLabel,
    hint,
    side = "stray",
  }: {
    title: string;
    entries: Array<{ edge: GraphEdge; index: number }>;
    onAdd?: () => void;
    addLabel?: string;
    hint?: string;
    side?: "in" | "out" | "stray";
  }) => (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </p>
        {onAdd ? (
          <Button size="sm" variant="outline" className="h-6 px-2" onClick={onAdd}>
            <Icon name="Plus" className="size-3.5" />
            {addLabel}
          </Button>
        ) : null}
      </div>
      {hint ? (
        <details className="text-[11px] text-muted-foreground">
          <summary className="cursor-pointer list-none underline decoration-dotted underline-offset-2">
            How edges decide
          </summary>
          <p className="mt-1">{hint}</p>
        </details>
      ) : null}
      {entries.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">None.</p>
      ) : (
        entries.map(({ edge, index }) => renderEdge(edge, index, side))
      )}
    </div>
  );

  const outgoingHint =
    "Several unconditional edges from one node run in parallel. With " +
    "conditions, the first matching one wins — an unconditional edge at the " +
    "bottom serves as the fallback. An edge back upwards makes a cycle. " +
    "Compare a result field rather than raw text where you can: prose " +
    "contains the words you are looking for all too casually.";

  /** The problems that name this node, by label, id or placeholder. */
  const problemsFor = (node: GraphNode) =>
    problems.filter(
      (problem) =>
        problem.message.includes(`"${node.label}"`) ||
        problem.message.includes(`"${node.id}"`) ||
        problem.message.includes(`{{${node.id}}}`),
    );

  /**
   * One section of the node inspector: a heading, a one-line summary of what
   * is set, and the controls. Folded by default — the summaries are the
   * overview, so the card reads as one list until a section is opened.
   */
  const section = (
    title: string,
    summary: string,
    body: React.ReactNode,
    open = false,
  ) => (
    <InspectorSection title={title} summary={summary} open={open}>
      {body}
    </InspectorSection>
  );

  const renderNodeCard = (node: GraphNode, index: number) => {
    const execution = nodeExecution(node);
    const outCount = outgoing(node.id).length;
    const inCount = incoming(node.id).length;
    const worker = node.kind === "agent" || node.kind === "dialog";
    return (
    <div className="space-y-1" aria-label={`Node ${node.label}`}>
      {/* Head: what the node is, in one glance. */}
      <InspectorHeader
        icon={<Icon name={KIND_ICONS[node.kind]} className="size-4" />}
        title={node.label || node.id}
        subtitle={
          <>
            <code>{node.id}</code> · {KIND_LABEL[node.kind]}
            {node.kind === "subgraph" && resolveGraph(node.graphId)
              ? ` · imports ${resolveGraph(node.graphId)!.name}`
              : ""}
          </>
        }
        actions={
          <Button
            size="sm"
            variant="ghost"
            className="size-7 p-0"
            onClick={() => setSelection(null)}
            aria-label="Close the card"
          >
            <Icon name="X" className="size-3.5" />
          </Button>
        }
      />


      {problemsFor(node).length > 0 ? (
          // The graph-wide list says what is wrong; here it says so where it
          // can be fixed.
          <ul className="space-y-1 rounded-md bg-muted/40 px-2 py-1.5">
            {problemsFor(node).map((problem) => (
              <li
                key={problem.message}
                className={cn(
                  "flex items-start gap-1.5 text-[11px]",
                  problem.level === "error" ? "text-destructive" : "text-muted-foreground",
                )}
              >
                <Icon
                  name={problem.level === "error" ? "AlertTriangle" : "Info"}
                  className="mt-px size-3.5 shrink-0"
                />
                {problem.message}
              </li>
            ))}
          </ul>
        ) : null}

      {section(
        "Identity",
        KIND_LABEL[node.kind],
        <>
          <div className="grid gap-2 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-[11px] text-muted-foreground">Id</span>
                  <Input
                    value={node.id}
                    onChange={(event) =>
                      patchNode(index, { id: event.target.value.toLowerCase() })
                    }
                    aria-label={`Id of node ${index + 1}`}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-muted-foreground">Label</span>
                  <Input
                    value={node.label}
                    onChange={(event) => patchNode(index, { label: event.target.value })}
                    aria-label={`Label of node ${index + 1}`}
                  />
                </label>
                <div className="space-y-1 sm:col-span-2">
                  <span className="text-[11px] text-muted-foreground">Colour</span>
                  <div
                    role="radiogroup"
                    aria-label={`Colour of node ${index + 1}`}
                    className="flex flex-wrap items-center gap-1"
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={node.color === null}
                      aria-label="No colour"
                      title="No colour"
                      onClick={() => patchNode(index, { color: null })}
                      className={cn(
                        "size-5 rounded border border-dashed border-border text-[10px] leading-none text-muted-foreground",
                        node.color === null && "ring-1 ring-ring ring-offset-1 ring-offset-background",
                      )}
                    >
                      ∅
                    </button>
                    {NODE_COLORS.map((swatch) => (
                      <button
                        key={swatch}
                        type="button"
                        role="radio"
                        aria-checked={node.color === swatch}
                        aria-label={`Colour ${swatch}`}
                        title={swatch}
                        onClick={() => patchNode(index, { color: swatch })}
                        className={cn(
                          "size-5 rounded border border-border",
                          node.color === swatch && "ring-1 ring-ring ring-offset-1 ring-offset-background",
                        )}
                        style={{ backgroundColor: swatch }}
                      />
                    ))}
                  </div>
                </div>
          </div>
                {/* Five kinds as five buttons: an option that is a whole
                    sentence was the only way to say what each does, and a
                    select shows one of them at a time. */}
                <div className="space-y-1 sm:col-span-2">
                  <span className="text-[11px] text-muted-foreground">Kind</span>
                  <div
                    role="radiogroup"
                    aria-label={`Kind of node ${index + 1}`}
                    className="grid grid-cols-3 gap-1"
                  >
                    {NODE_KINDS.map((kind) => (
                      <button
                        key={kind}
                        type="button"
                        role="radio"
                        aria-checked={node.kind === kind}
                        title={KIND_LABELS[kind]}
                        onClick={() => patchNode(index, { kind })}
                        className={cn(
                          "flex min-w-0 flex-col items-center gap-1 rounded-md border px-1 py-2 text-[11px]",
                          node.kind === kind
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border text-muted-foreground hover:text-foreground",
                        )}
                      >
                        <Icon name={KIND_ICONS[kind]} className="size-4" />
                        <span className="truncate">{KIND_LABEL[kind]}</span>
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {KIND_LABELS[node.kind]}
                  </p>
                </div>
        </>,
        false,
      )}

      {node.kind === "subgraph"
        ? section(
            "Import",
            resolveGraph(node.graphId)?.name ?? "no graph chosen",
            <>
              {true ? (
                <div className="space-y-2">
                <label className="block space-y-1">
                  <span className="block rounded-md bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
                    <strong className="font-medium text-foreground">
                      What a subgraph does:
                    </strong>{" "}
                    when the run reaches this node, it runs another graph in
                    its place. That graph's nodes join this run and share its
                    state; when it reaches its End, the run carries on along
                    this node's outgoing edges. This node does no work and
                    writes no result of its own — a later node reads the
                    results of the embedded nodes by their ids.
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    Embedded graph
                  </span>
                  <select
                    value={node.graphId}
                    onChange={(event) =>
                      patchNode(index, { graphId: event.target.value })
                    }
                    aria-label={`Embedded graph of node ${index + 1}`}
                    className={FIELD_CONTROL}
                  >
                    <option value="">Choose a graph …</option>
                    {groupedLibrary(
                      // The graph cannot embed itself, so it is not offered.
                      [...templates, ...graphs].filter(
                        (entry) => entry.id !== draft.id,
                      ),
                    ).map((section) => (
                      <optgroup key={section.key} label={section.label}>
                        {section.graphs.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.name} ({entry.nodes.length} nodes)
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  {(() => {
                    const child = resolveGraph(node.graphId);
                    if (!child) return null;
                    return (
                      <span className="block text-[11px] text-muted-foreground">
                        Runs {child.nodes.length} nodes. Later nodes read them
                        as{" "}
                        {child.nodes.map((entry, i) => (
                          <span key={entry.id}>
                            {i > 0 ? ", " : ""}
                            <code>{`{{${entry.id}}}`}</code>
                          </span>
                        ))}
                        .
                      </span>
                    );
                  })()}
                  {/* Left over from the kind the node had before. Hidden
                      fields that still count are exactly what makes a
                      warning impossible to fix, so they get a way out. */}
                  {node.prompt.trim() !== "" || node.fields.length > 0 ? (
                    <span className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      Left over from the previous kind:
                      {node.prompt.trim() !== "" ? " a prompt" : ""}
                      {node.prompt.trim() !== "" && node.fields.length > 0 ? " and" : ""}
                      {node.fields.length > 0 ? ` ${node.fields.length} result fields` : ""}
                      — unused here.
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2"
                        onClick={() => patchNode(index, { prompt: "", fields: [] })}
                      >
                        Clear them
                      </Button>
                    </span>
                  ) : null}
                </label>
                {resolveGraph(node.graphId) && onOpenGraph &&
                graphs.some((entry) => entry.id === node.graphId) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    onClick={() => onOpenGraph(node.graphId)}
                  >
                    Edit “{resolveGraph(node.graphId)!.name}”
                  </Button>
                ) : null}
                <p className="text-[11px] text-muted-foreground">
                  On the canvas, the “+” on this node opens the imported graph
                  in place.
                </p>
                </div>
              ) : null}
            </>,
          )
        : section(
            node.kind === "note" ? "Note" : "Task",
            node.prompt.trim() === "" ? "empty" : `${node.prompt.trim().split("\n")[0]!.slice(0, 48)}`,
            <>
              <label
                className={cn(
                  "block space-y-1",
                )}
              >
                <span className="text-[11px] text-muted-foreground">
                  Prompt — {"{{input}}"} and {"{{node_id}}"} are filled in
                </span>
                <textarea
                  value={node.prompt}
                  onChange={(event) => patchNode(index, { prompt: event.target.value })}
                  rows={4}
                  className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-xs"
                  aria-label={`Prompt of node ${index + 1}`}
                />
              </label>
            </>,
          )}

      {node.kind === "member"
        ? section(
            "Member",
            node.member.trim() || "none chosen",
            <div className="space-y-1">
              <span className="block rounded-md bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
                <strong className="font-medium text-foreground">
                  What a member node does:
                </strong>{" "}
                the step goes to a persistent member of a crew (plugin Crew)
                instead of a fresh thread. The member keeps its memory across
                visits and runs; provider and model come from the crew file.
              </span>
              <label className="block space-y-1">
                <span className="block text-[11px] text-muted-foreground">
                  Member — member@crew
                </span>
                <Input
                  value={node.member}
                  list={`crew-members-${index}`}
                  placeholder="dev-owner@my-crew"
                  onChange={(event) => patchNode(index, { member: event.target.value })}
                  aria-label={`Member of node ${index + 1}`}
                />
                <datalist id={`crew-members-${index}`}>
                  {crewMembers.map((member) => (
                    <option key={member.address} value={member.address}>
                      {member.role || member.activity}
                    </option>
                  ))}
                </datalist>
              </label>
              {crewMembers.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  No crew members found in this project — type the address.
                </p>
              ) : null}
            </div>,
          )
        : null}

      {spawnsThread(node)
        ? section(
            "Model",
            execution ? `${execution.model}${execution.reasoningLevel ? ` · ${execution.reasoningLevel}` : ""}` : "inherited",
            <NodeExecutionSection
              node={node}
              index={index}
              only="model"
              onPatch={(patch) => patchNode(index, patch)}
            />,
          )
        : null}

      {worker
        ? section(
            "Skills",
            node.skills.length > 0 ? `${node.skills.length}` : "none",
            <>
              {true ? (
                <div className="space-y-1">
                  <span className="text-[11px] text-muted-foreground">
                    Skills — reviewed ways of working, instead of writing the
                    rules out yourself. The worker loads them itself.
                  </span>
                  {node.skills.length > 0 ? (
                    <ul className="flex flex-wrap gap-1">
                      {node.skills.map((skill) => (
                        <li key={skill}>
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-[11px]"
                            onClick={() =>
                              patchNode(index, {
                                skills: node.skills.filter((s) => s !== skill),
                              })
                            }
                            aria-label={`Remove skill ${skill}`}
                          >
                            {skill}
                            <Icon name="X" className="size-3" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {availableSkills.length > 0 ? (
                    <select
                      value=""
                      onChange={(event) => {
                        const id = event.target.value;
                        if (!id || node.skills.includes(id)) return;
                        patchNode(index, { skills: [...node.skills, id] });
                      }}
                      aria-label={`Add a skill to node ${index + 1}`}
                      className={FIELD_CONTROL}
                    >
                      <option value="">Add a skill …</option>
                      {availableSkills
                        .filter((skill) => !node.skills.includes(skill.id))
                        .map((skill) => (
                          <option key={skill.id} value={skill.id}>
                            {skill.name} ({skill.scope})
                          </option>
                        ))}
                    </select>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      {skillsError
                        ? `Skills unavailable: ${skillsError}`
                        : "No skills found."}
                    </p>
                  )}
                </div>
              ) : null}
            </>,
          )
        : null}

      {node.kind === "agent" || node.kind === "member"
        ? section(
            "Result fields",
            node.fields.length > 0 ? `${node.fields.length}` : "none",
            <>
              {true ? (
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-muted-foreground">
                      Result fields — the worker additionally answers as JSON.
                      Edges then compare values instead of searching text.
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 shrink-0 px-2"
                      onClick={() =>
                        patchNode(index, {
                          fields: [
                            ...node.fields,
                            fieldSchema.parse({
                              name: `field${node.fields.length + 1}`,
                            }),
                          ],
                        })
                      }
                    >
                      <Icon name="Plus" className="size-3.5" />
                      Field
                    </Button>
                  </div>
                  {node.fields.map((declared, fieldIndex) => {
                    const patchField = (patch: Partial<typeof declared>) =>
                      patchNode(index, {
                        fields: node.fields.map((entry, i) =>
                          i === fieldIndex ? { ...entry, ...patch } : entry,
                        ),
                      });
                    return (
                      <div
                        key={fieldIndex}
                        className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5"
                      >
                        <Input
                          value={declared.name}
                          onChange={(event) =>
                            patchField({ name: event.target.value.toLowerCase() })
                          }
                          aria-label={`Name of field ${fieldIndex + 1} in node ${index + 1}`}
                          className="h-7 w-32"
                        />
                        <select
                          value={declared.type}
                          onChange={(event) =>
                            patchField({
                              type: event.target
                                .value as (typeof FIELD_TYPES)[number],
                            })
                          }
                          aria-label={`Type of field ${fieldIndex + 1} in node ${index + 1}`}
                          className="h-7 rounded-md border border-input bg-transparent px-2 text-xs"
                        >
                          {FIELD_TYPES.map((type) => (
                            <option key={type} value={type}>
                              {FIELD_TYPE_LABELS[type]}
                            </option>
                          ))}
                        </select>
                        {declared.type === "enum" ? (
                          <Input
                            value={declared.options.join(", ")}
                            onChange={(event) =>
                              patchField({
                                options: event.target.value
                                  .split(",")
                                  .map((option) => option.trim())
                                  .filter(Boolean),
                              })
                            }
                            placeholder="APPROVE, REWORK, BLOCK"
                            aria-label={`Choices of field ${fieldIndex + 1} in node ${index + 1}`}
                            className="h-7 flex-1"
                          />
                        ) : (
                          <Input
                            value={declared.description}
                            onChange={(event) =>
                              patchField({ description: event.target.value })
                            }
                            placeholder="Description (optional)"
                            aria-label={`Description of field ${fieldIndex + 1} in node ${index + 1}`}
                            className="h-7 flex-1"
                          />
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-destructive"
                          onClick={() =>
                            patchNode(index, {
                              fields: node.fields.filter(
                                (_, i) => i !== fieldIndex,
                              ),
                            })
                          }
                          aria-label={`Remove field ${fieldIndex + 1} in node ${index + 1}`}
                        >
                          <Icon name="Trash2" className="size-3.5" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </>,
          )
        : null}

      {section(
        "Edges",
        `${inCount} in · ${outCount} out`,
        <div className="space-y-3">
                {/* Only where there is something to choose between. On a node
                    with one way out the setting changes nothing, and an inert
                    dropdown on every node teaches that it does not matter. */}
                {outCount > 1 ? (
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground">Takes</span>
                    <select
                      value={node.routing}
                      onChange={(event) =>
                        patchNode(index, {
                          routing: event.target.value as GraphNode["routing"],
                        })
                      }
                      aria-label={`Routing of node ${index + 1}`}
                      className={FIELD_CONTROL}
                    >
                      {ROUTING_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                          {ROUTING_LABELS[mode]}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              {draft.edges.filter((edge) => edge.from === node.id).length > 1 &&
              node.routing === "every" ? (
                <p className="text-[11px] text-muted-foreground">
                  Every edge whose condition holds is taken, and those branches
                  run at once. They cannot be merged again afterwards: a branch
                  that was not taken never arrives, so a node waiting for it
                  would wait forever.
                </p>
              ) : null}
        {edgeGroup({
          title: "Incoming edges",
          entries: incoming(node.id),
          side: "in",
          onAdd: () => addEdge(START_NODE, node.id),
          addLabel: "Incoming",
        })}
        {edgeGroup({
          title: "Outgoing edges",
          entries: outgoing(node.id),
          side: "out",
          onAdd: () => addEdge(node.id, END_NODE),
          addLabel: "Outgoing",
          hint: outgoingHint,
        })}
        </div>,
      )}

      {section(
        "Limits and failure",
        executionSummary(node),
        <NodeExecutionSection
          node={node}
          index={index}
          only="limits"
          onPatch={(patch) => patchNode(index, patch)}
        />,
        false,
      )}

      <InspectorFooter
        note={
          <>
            <code>{`{{${node.id}}}`}</code> — how later prompts read this node
          </>
        }
      >
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2.5 text-destructive hover:text-destructive"
          onClick={() => {
            setDraft({
              ...draft,
              nodes: draft.nodes.filter((_, i) => i !== index),
              edges: draft.edges.filter(
                (edge) => edge.from !== node.id && edge.to !== node.id,
              ),
              positions: Object.fromEntries(
                Object.entries(draft.positions ?? {}).filter(([id]) => id !== node.id),
              ),
            });
            setSelection(null);
          }}
        >
          Remove node
        </Button>
      </InspectorFooter>
    </div>
    );
  };

  /** Start and End have no settings — only the edges that leave or reach them. */
  const renderTerminalCard = (which: "start" | "end") => (
    <div>
      <div className="flex items-center justify-between gap-2 pb-2">
        <p className="text-sm">
          {which === "start" ? "Start" : "End"}{" "}
          <span className="text-muted-foreground">
            {which === "start"
              ? "— where every run begins"
              : "— where a run is finished"}
          </span>
        </p>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 shrink-0 px-2"
          onClick={() => setSelection(null)}
          aria-label="Close the card"
        >
          <Icon name="X" className="size-3.5" />
        </Button>
      </div>
      <div className="space-y-3 border-t border-border/60 pt-2.5">
        {which === "start"
          ? edgeGroup({
              title: "Outgoing edges",
              entries: outgoing(START_NODE),
              side: "out",
              onAdd: () => addEdge(START_NODE, nodeIds[0] ?? END_NODE),
              addLabel: "Outgoing",
              hint: outgoingHint,
            })
          : edgeGroup({
              title: "Incoming edges",
              entries: incoming(END_NODE),
              side: "in",
              onAdd: () => addEdge(nodeIds[0] ?? START_NODE, END_NODE),
              addLabel: "Incoming",
            })}
      </div>
    </div>
  );

  const canvasFor = (className: string) => (
    <GraphCanvas
      graph={draft}
      selectedId={canvasSelection}
      onSelect={selectById}
      terminalsSelectable
      onConnect={(from, to) => {
        // The same unconditional arrow twice is never meant: it would run the
        // target twice in parallel, or trip the fallback rule.
        const duplicate = draft.edges.some(
          (edge) => edge.from === from && edge.to === to && edge.when === null,
        );
        if (!duplicate) addEdge(from, to);
        selectById(from);
      }}
      onEdgeSelect={(from) => selectById(from)}
      onInsertOnEdge={insertOnEdge}
      onMoveNode={(id, x, y) =>
        setDraft((current) => ({
          ...current,
          positions: { ...current.positions, [id]: { x, y } },
        }))
      }
      resolveGraph={resolveGraph}
      className={className}
    />
  );

  const canvasHint = (
    <p className="text-[11px] text-muted-foreground">
      Click a node to edit it. Drag from the dot under a node to another node
      to draw an edge.
    </p>
  );

  /*
    The same selection as a row of buttons: reachable by keyboard and screen
    reader without aiming at a canvas, and the one place a node is added.
  */
  /*
    Which card is open, as one dropdown. It used to be a row of buttons, one per
    node — tabs in all but name, and on a graph of twelve nodes a wall of them
    above the card. The canvas is the primary way to pick a node; this is the
    keyboard's way, and the one place a node is added.
  */
  const nodePicker = (
    <div className="flex items-center gap-2">
      <select
        aria-label="Edit node"
        value={
          selection === "start" || selection === "end"
            ? selection
            : selectedIndex !== null
              ? String(selectedIndex)
              : ""
        }
        onChange={(event) => {
          const value = event.target.value;
          setSelection(
            value === ""
              ? null
              : value === "start" || value === "end"
                ? value
                : Number(value),
          );
        }}
        className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs"
      >
        <option value="">{fullscreen ? "Graph settings" : "Choose a node …"}</option>
        <option value="start">Start</option>
        {draft.nodes.map((node, index) => (
          <option key={index} value={index}>
            {node.label || node.id || `Node ${index + 1}`} ({node.id})
          </option>
        ))}
        <option value="end">End</option>
      </select>
      <Button size="sm" variant="outline" className="h-8 shrink-0 px-2" onClick={addNode}>
        <Icon name="Plus" className="size-3.5" />
        Node
      </Button>
    </div>
  );

  /*
    The graph's own settings, for the full-screen sidebar when no node is
    selected — clicking empty canvas is how one "leaves" a node, and the graph
    is what is left.
  */
  const graphSettings = (
    <div className="space-y-2">
      <p className="text-sm font-medium">Graph</p>
      <label className="block space-y-1">
        <span className="text-[11px] text-muted-foreground">Name</span>
        <Input
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          aria-label="Graph name"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-[11px] text-muted-foreground">
          Example task — what is this graph for?
        </span>
        <Input
          value={draft.example}
          onChange={(event) => setDraft({ ...draft, example: event.target.value })}
          aria-label="Example task"
        />
      </label>
      {/*
        The studio is for reviewing; the chat is where a graph is written.
        Both routes are one copy away, so the next change does not start with
        looking up a command.
      */}
      <div className="space-y-1 border-t border-border/60 pt-2.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          In the chat
        </p>
        <CopyCommand command={`/graph-studio Change the graph ${draft.id || "<graph-id>"}: …`} />
        <CopyCommand command={`/graph-studio Run ${draft.id || "<graph-id>"} on: …`} />
      </div>
      <div className="space-y-1 border-t border-border/60 pt-2.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          On the command line
        </p>
        <CopyCommand command={runCommand(draft)} />
        <CopyCommand command={`bb graph-studio show ${draft.id || "<graph-id>"}`} />
        <CopyCommand command={`bb graph-studio export ${draft.id || "<graph-id>"} > file.json`} />
      </div>
    </div>
  );

  const problemList =
    problems.length > 0 ? (
      <ul className="space-y-1">
        {problems.map((problem) => (
          <li
            key={problem.message}
            className={cn(
              "flex items-start gap-1.5 text-xs",
              problem.level === "error"
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            <Icon
              name={problem.level === "error" ? "AlertTriangle" : "Info"}
              className="mt-px size-3.5 shrink-0"
            />
            {problem.message}
          </li>
        ))}
      </ul>
    ) : (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon name="Check" className="size-3.5" />
        The graph is runnable.
      </p>
    );

  const cardColumn = (
    <div className="space-y-3">
      {selectedIndex !== null
        ? renderNodeCard(draft.nodes[selectedIndex]!, selectedIndex)
        : selection === "start" || selection === "end"
          ? renderTerminalCard(selection)
          : fullscreen
            ? graphSettings
            : (
              <p className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
                Click a node in the graph to edit it and its edges.
              </p>
            )}
      {strayEdges.length > 0
        ? edgeGroup({
            title: "Edges pointing at no node",
            entries: strayEdges,
          })
        : null}
    </div>
  );


  /** Back to the computed layout: forgets where nodes were dragged. */
  const autoLayoutButton =
    Object.keys(draft.positions ?? {}).length > 0 ? (
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-[11px]"
        onClick={() => setDraft({ ...draft, positions: {} })}
      >
        Auto layout
      </Button>
    ) : null;

  const historyButtons = (
    <>
      {dirty ? (
        <span className="text-[11px] text-muted-foreground" aria-live="polite">
          Unsaved changes
        </span>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2"
        disabled={history.past.length === 0}
        onClick={undo}
        aria-label="Undo"
      >
        <Icon name="RotateCcw" className="size-3.5" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2"
        disabled={history.future.length === 0}
        onClick={redo}
        aria-label="Redo"
      >
        <Icon name="RotateCcw" className="size-3.5 -scale-x-100" />
      </Button>
    </>
  );

  /*
    Leaving with unsaved changes asks first. The draft lives only in this
    component; one click on "Overview" used to drop an hour of editing
    without a word.
  */
  const leaveBanner = confirmLeave ? (
    <div
      role="alertdialog"
      aria-label="Unsaved changes"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs"
    >
      <span className="mr-auto">This graph has unsaved changes.</span>
      <Button size="sm" variant="outline" className="h-7" onClick={() => setConfirmLeave(false)}>
        Keep editing
      </Button>
      <Button
        size="sm"
        variant="destructive"
        className="h-7"
        onClick={() => {
          setConfirmLeave(false);
          onCancel();
        }}
      >
        Discard and leave
      </Button>
    </div>
  ) : null;

  /*
    In full screen the panel view is not rendered underneath: two copies of
    every field in the document would be two sources of truth for one draft
    as far as a screen reader — and a test — can tell.
  */
  if (fullscreen) {
    return (
      <div className="space-y-2">
        <FullscreenLayer
          title={draft.name || draft.id || "New graph"}
          status={
            blocking.length > 0
              ? `${blocking.length} ${blocking.length === 1 ? "problem" : "problems"} to fix`
              : "Runnable"
          }
          actions={
            <>
            {historyButtons}
            {autoLayoutButton}
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              onClick={leave}
            >
              Overview
            </Button>
            <Button
              size="sm"
              className="h-7"
              disabled={pending || blocking.length > 0 || draft.id === ""}
              onClick={() => onSave(graphSchema.parse(draft))}
            >
              Save
            </Button>
            </>
          }
          onClose={closeFullscreen}
          sidebar={
            <div className="space-y-3">
              {leaveBanner}
              {nodePicker}
              {problemList}
              {cardColumn}
            </div>
          }
        >
          <div className="flex h-full flex-col gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              {canvasHint}
              <CanvasLegend />
            </div>
            {canvasFor("min-h-0 flex-1 h-auto max-h-none rounded-md border-border/60")}
          </div>
        </FullscreenLayer>
        <p className="text-xs text-muted-foreground">
          Editing “{draft.name || draft.id || "new graph"}” in full screen.
        </p>
        <Button size="sm" variant="outline" onClick={closeFullscreen}>
          Back to the panel
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" variant="ghost" className="-ml-2 h-6 px-2" onClick={leave}>
          <Icon name="ChevronLeft" className="size-4" />
          Overview
        </Button>
        <div className="flex items-center gap-2">
          {historyButtons}
          {existing ? (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive"
              onClick={() => onDelete(existing.id)}
            >
              Delete
            </Button>
          ) : null}
          <Button
            size="sm"
            disabled={pending || blocking.length > 0 || draft.id === ""}
            onClick={() => onSave(graphSchema.parse(draft))}
          >
            Save
          </Button>
        </div>
      </div>
      {leaveBanner}


      {!existing ? (
        <div className="rounded-lg border border-border bg-card px-3 py-3">
          <p className="text-sm font-medium">Start from a template</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Quicker than starting from nothing. The <em>Patterns</em> headings
            run from the simplest control flow to the most composed — one step,
            one branch, several at once, cycles; under <em>Work</em> the arcs
            for this repo.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <select
              value={cloneFrom}
              onChange={(event) => setCloneFrom(event.target.value)}
              className="h-8 flex-1 rounded-md border border-input bg-transparent px-2 text-xs"
            >
              {groupedLibrary(templates, "section").map((section) => (
                <optgroup key={section.key} label={section.label}>
                  {section.graphs.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <Input
              value={cloneId}
              onChange={(event) => setCloneId(event.target.value)}
              placeholder="new-id"
              aria-label="Id of the new graph"
              className="h-8 flex-1"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={pending || cloneId.trim() === ""}
              onClick={() => {
                const template = templates.find((entry) => entry.id === cloneFrom);
                onClone(cloneFrom, cloneId.trim(), template?.name ?? cloneId);
              }}
            >
              Copy
            </Button>
          </div>
        </div>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Id (fixed)</span>
          <Input
            value={draft.id}
            disabled={Boolean(existing)}
            onChange={(event) =>
              setDraft({ ...draft, id: event.target.value.toLowerCase() })
            }
            placeholder="my-graph"
            aria-label="Graph id"
          />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Name</span>
          <Input
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            aria-label="Graph name"
          />
        </label>
      </div>

      {/*
        The name says what the graph is, the example says what you put into it
        — and only the second one tells a reader six weeks later whether this
        is the graph for the task in front of them. It is also what the
        ready-made command line below offers.
      */}
      <label className="block space-y-1">
        <span className="text-[11px] text-muted-foreground">
          Example task — what is this graph for?
        </span>
        <Input
          value={draft.example}
          onChange={(event) => setDraft({ ...draft, example: event.target.value })}
          placeholder="Move the product filter's sorting to the server side"
          aria-label="Example task"
        />
        <CopyCommand command={runCommand(draft)} />
      </label>

      {/*
        The graph is the editor. Nodes and edges used to be two long lists
        under a picture that could only be looked at, so changing one arrow
        meant finding it by its index among all the others. Now a node is
        clicked and its card holds everything about it — settings, and the
        edges coming in and going out. On a wide panel the card sits next to
        the graph; on a narrow one, below it. Full screen gives the graph the
        window and moves the card into a sidebar.
      */}
      <div className="@container">
        <div className="grid gap-3 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] @3xl:items-start">
          <div className="space-y-1.5 @3xl:sticky @3xl:top-0">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Graph
              </p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <CanvasLegend />
                {autoLayoutButton}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setFullscreen(true)}
                >
                  Full screen
                </Button>
              </div>
            </div>
            {canvasFor("max-h-[55vh]")}
            {canvasHint}
            {nodePicker}
            {problemList}
          </div>
          {cardColumn}
        </div>
      </div>

      {/*
        Moved to the bottom: exporting a graph is a utility somebody reaches
        for now and then, and it used to sit between the header and the form —
        a collapsed row of chrome pushing the preview further down every time
        the editor opened.
      */}
      <details className="rounded-lg border border-border bg-card">
        <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium">
          File: export / import
        </summary>
        <div className="space-y-2 border-t border-border px-3 py-3">
          <p className="text-[11px] text-muted-foreground">
            Graphs live centrally in the plugin database. As a JSON file they
            can be put into the repo, versioned and shared. On the command
            line:
          </p>
          <CopyCommand
            command={`bb graph-studio export ${draft.id || "<graph-id>"} > file.json`}
          />
          <CopyCommand command="bb graph-studio import file.json" />
          {existing && onExport ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={exporting}
                onClick={() => onExport(existing.id)}
              >
                {exporting ? "Exporting …" : "Show as JSON"}
              </Button>
              <ExportedFileView
                exported={exported}
                onDismiss={onDismissExport ?? (() => {})}
              />
            </>
          ) : null}
          {onImport ? (
            <div className="space-y-1">
              <label
                className="block text-[11px] text-muted-foreground"
                htmlFor="gs-import"
              >
                Paste JSON and import
              </label>
              <textarea
                id="gs-import"
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                rows={4}
                className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 font-mono text-[11px]"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={pending || importText.trim() === ""}
                onClick={() => onImport(importText)}
              >
                Import
              </Button>
            </div>
          ) : null}
        </div>
      </details>
    </div>
  );
}

// Fullscreen crew editor (BBP-80), laid out like Graph Studio's editor: the
// topology canvas on the left (click a member to edit it, drag from the dot
// under a member to another member to draw a link), the selected member's
// accordions on the right, and Save writing the crew file.
//
// The editor holds YAML text only; every edit is a pure text-in/text-out step
// from lib/crew-edit.ts, and validity is the same validateCrew the server
// runs on save, so the panel cannot call something valid that the server
// rejects.
import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Controls, Handle, Position, ReactFlow, ReactFlowProvider, type Connection, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { experimental_ProviderModelPicker } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { usePortalScopeProps } from "../lib/portal-scope";
import { LINK_KINDS, PERMISSIONS, validateCrew, type LinkKind } from "../lib/spec";
import { removeMemberFromFile } from "../lib/crewfile";
import {
  addGroupToFile,
  addLinkToFile,
  editorModel,
  nextMemberId,
  removeLinkFromFile,
  renameMemberInFile,
  setCrewValue,
  setMemberExecution,
  setMemberSkills,
  setMemberValue,
  type EditorMember,
  type EditorModel,
} from "../lib/crew-edit";
import { FLOW_THEME, useHostColorMode } from "./crew-topology";

type ExecutionValue = { providerId: string; model: string; reasoningLevel?: string; serviceTier?: string };
export type ExecutionPickerProps = { value: ExecutionValue; onChange: (value: ExecutionValue) => void };

const DefaultPicker = experimental_ProviderModelPicker as unknown as ComponentType<ExecutionPickerProps>;

const NODE_W = 168;
const NODE_H = 64;
const GAP_X = 24;
const GAP_Y = 44;

/** Edge strokes per link kind; the legend reads from the same table. */
const LINK_STYLE: Record<string, { dash?: string; label: string }> = {
  assigns_to: { label: "assigns_to" },
  works_with: { dash: "6 4", label: "works_with" },
  escalates_to: { dash: "2 4", label: "escalates_to" },
  can_read: { dash: "1 6", label: "can_read" },
};

/** Lead row on top, then one row per group, centred — the shape of the mockup. */
export function editorLayout(model: EditorModel): Map<string, { x: number; y: number }> {
  const rows: EditorMember[][] = [model.members.filter((member) => member.lead)];
  for (const group of model.groups) rows.push(model.members.filter((member) => member.group === group && !member.lead));
  const filled = rows.filter((row) => row.length > 0);
  const widest = Math.max(1, ...filled.map((row) => row.length));
  const positions = new Map<string, { x: number; y: number }>();
  filled.forEach((row, rowIndex) => {
    const offset = ((widest - row.length) * (NODE_W + GAP_X)) / 2;
    row.forEach((member, index) => positions.set(member.key, { x: offset + index * (NODE_W + GAP_X), y: rowIndex * (NODE_H + GAP_Y) }));
  });
  return positions;
}

type MemberNodeData = { member: EditorMember; selected: boolean; status?: string };

function MemberNode({ data }: NodeProps<Node<MemberNodeData>>) {
  const { member, selected, status } = data;
  return (
    <div
      data-member-node={member.key}
      className={cn("flex h-full w-full cursor-pointer flex-col gap-0.5 rounded-[10px] border bg-card px-2.5 py-2 shadow-sm", selected ? "border-2 border-primary" : "border-border")}
    >
      <Handle type="target" position={Position.Top} className="!size-2 !border-border !bg-muted-foreground" />
      <div className="flex items-center justify-between gap-2 text-[9px] uppercase tracking-[0.06em] text-muted-foreground">
        <span className="truncate">{member.lead ? `lead · ${member.group}` : member.group}</span>
        {status ? (
          <span className="flex items-center gap-1 normal-case tracking-normal">
            <span aria-hidden className={cn("size-1.5 rounded-full", status === "working" ? "bg-primary" : status === "waits" ? "bg-destructive" : "bg-muted-foreground")} />
            {status}
          </span>
        ) : null}
      </div>
      <span className="truncate text-xs font-medium text-foreground">{member.key}</span>
      <div className="mt-auto flex gap-1 overflow-hidden">
        {member.model ? <span className="truncate rounded bg-muted px-1 py-px text-[9px] text-muted-foreground">{member.model.replace(/^claude-/, "")}</span> : null}
        {member.skills.length > 0 ? <span className="shrink-0 rounded bg-muted px-1 py-px text-[9px] text-muted-foreground">{member.skills.length} skills</span> : null}
      </div>
      <Handle type="source" position={Position.Bottom} className="!size-2 !border-border !bg-muted-foreground" />
    </div>
  );
}

const NODE_TYPES = { member: MemberNode };

function EditorCanvas({
  model,
  selected,
  statuses,
  onSelect,
  onConnect,
}: {
  model: EditorModel;
  selected: string | null;
  statuses: Readonly<Record<string, string>>;
  onSelect: (key: string) => void;
  onConnect: (from: string, to: string) => void;
}) {
  const [ref, colorMode] = useHostColorMode();
  const positions = useMemo(() => editorLayout(model), [model]);
  const nodes: Node<MemberNodeData>[] = model.members.map((member) => ({
    id: member.key,
    type: "member",
    position: positions.get(member.key) ?? { x: 0, y: 0 },
    width: NODE_W,
    height: NODE_H,
    draggable: false,
    data: { member, selected: member.key === selected, status: statuses[member.key] },
  }));
  const keys = new Set(model.members.map((member) => member.key));
  const edges: Edge[] = model.links
    .filter((link) => keys.has(link.from) && keys.has(link.to))
    .map((link, index) => ({
      id: `${link.from}>${link.to}:${link.kind}:${index}`,
      source: link.from,
      target: link.to,
      style: { stroke: "var(--muted-foreground)", strokeWidth: 1.25, strokeDasharray: LINK_STYLE[link.kind]?.dash },
    }));
  return (
    <div ref={ref} className="h-full w-full bg-background" style={FLOW_THEME}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        colorMode={colorMode}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        nodesDraggable={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_event, node) => onSelect(node.id)}
        onConnect={(connection: Connection) => {
          if (connection.source && connection.target) onConnect(connection.source, connection.target);
        }}
      >
        <Controls position="bottom-left" showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function Section({ title, summary, open, onToggle, children }: { title: string; summary: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className="border-b border-border">
      <button type="button" aria-expanded={open} className="flex w-full items-center gap-2 py-2.5 text-left text-sm" onClick={onToggle}>
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">{title}</span>
        <span className="ml-auto truncate pl-3 text-xs text-muted-foreground">{summary}</span>
      </button>
      {open ? <div className="flex flex-col gap-2 pb-3 pl-5">{children}</div> : null}
    </section>
  );
}

const fieldClass = "w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-xs text-foreground";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

export function CrewEditFullscreen({
  title,
  initialYaml,
  statuses = {},
  onSave,
  onReload,
  onOverview,
  onClose,
  ExecutionPicker = DefaultPicker,
}: {
  title: string;
  initialYaml: string;
  /** Live status per member key (working, waits, idle); optional decoration. */
  statuses?: Readonly<Record<string, string>>;
  /** Writes the crew file; resolves to an error message, or null when saved. */
  onSave: (yaml: string) => Promise<string | null>;
  /** Re-reads the stored crew file. */
  onReload: () => Promise<string>;
  onOverview: () => void;
  onClose: () => void;
  ExecutionPicker?: ComponentType<ExecutionPickerProps>;
}) {
  const scope = usePortalScopeProps();
  const [saved, setSaved] = useState(initialYaml);
  const [text, setText] = useState(initialYaml);
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [linkKind, setLinkKind] = useState<LinkKind>("works_with");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [skillDraft, setSkillDraft] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const model = useMemo(() => editorModel(text), [text]);
  const validation = useMemo(() => validateCrew(text), [text]);
  const errors = validation.problems.filter((problem) => problem.level === "error");
  const dirty = text !== saved;
  const member = model?.members.find((entry) => entry.key === selected) ?? model?.members[0] ?? null;

  /** Runs one edit; a refused edit (duplicate id, self link) shows as an error, the text stays. */
  const edit = (run: (current: string) => string, select?: string | null) => {
    try {
      setText(run(text));
      setError(null);
      if (select !== undefined) setSelected(select);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const save = async () => {
    setSaving(true);
    const failure = await onSave(text).catch((cause: unknown) => (cause instanceof Error ? cause.message : String(cause)));
    setSaving(false);
    if (failure) setError(failure);
    else {
      setSaved(text);
      setError(null);
    }
  };

  const reload = async () => {
    const fresh = await onReload();
    setSaved(fresh);
    setText(fresh);
    setError(null);
  };

  const toggle = (id: string) => setOpen((current) => (current === id ? null : id));
  const outgoing = member && model ? model.links.map((link, index) => ({ link, index })).filter(({ link }) => link.from === member.key) : [];
  const incoming = member && model ? model.links.map((link, index) => ({ link, index })).filter(({ link }) => link.to === member.key) : [];

  return createPortal(
    <div {...scope} role="dialog" aria-modal="true" aria-label={`Edit crew ${title} — full screen`} className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <span className="truncate text-sm font-medium">{title}</span>
        <span className={cn("text-xs", errors.length > 0 ? "text-destructive" : "text-muted-foreground")}>{errors.length > 0 ? `${errors.length} error${errors.length === 1 ? "" : "s"}` : "Valid"}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {dirty ? <span className="mr-1 text-xs text-muted-foreground">Unsaved changes</span> : null}
          <Button size="sm" variant="ghost" className="h-7 px-2" aria-label="Reload" onClick={() => void reload()}>
            <Icon name="RotateCw" className="size-4" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7" onClick={onOverview}>
            Overview
          </Button>
          <Button size="sm" className="h-7" disabled={!dirty || errors.length > 0 || saving} onClick={() => void save()}>
            Save
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onClose}>
            <Icon name="X" className="size-4" />
            Leave full screen
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-4 pt-3 text-xs text-muted-foreground">
            <span>Click a member to edit it. Drag from the dot under a member to another member to draw a link.</span>
            <label className="flex items-center gap-1.5">
              New links
              <select aria-label="New link kind" className="rounded-md border border-input bg-transparent px-1.5 py-0.5 text-xs text-foreground" value={linkKind} onChange={(event) => setLinkKind(event.target.value as LinkKind)}>
                {LINK_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex shrink-0 flex-wrap gap-4 px-4 pb-2 pt-1.5 text-[11px] text-muted-foreground" aria-label="Link legend">
            {LINK_KINDS.map((kind) => (
              <span key={kind} className="flex items-center gap-1.5">
                <svg width="22" height="4" aria-hidden>
                  <line x1="0" y1="2" x2="22" y2="2" stroke="currentColor" strokeWidth="1.25" strokeDasharray={LINK_STYLE[kind]?.dash} />
                </svg>
                {kind}
              </span>
            ))}
          </div>
          <div className="min-h-0 flex-1 border-t border-border">
            {model ? (
              <ReactFlowProvider>
                <EditorCanvas model={model} selected={member?.key ?? null} statuses={statuses} onSelect={setSelected} onConnect={(from, to) => edit((current) => addLinkToFile(current, from, to, linkKind))} />
              </ReactFlowProvider>
            ) : (
              <p className="p-4 text-sm text-destructive">The crew file does not parse.</p>
            )}
          </div>
        </div>
        <aside className="flex w-[26rem] max-w-[45vw] shrink-0 flex-col gap-3 overflow-y-auto border-l border-border px-4 py-3" aria-label="Member editor">
          <div className="flex items-center gap-2">
            <select aria-label="Member" className={cn(fieldClass, "min-w-0 flex-1 text-sm")} value={member?.key ?? ""} onChange={(event) => setSelected(event.target.value)}>
              {model?.members.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.key} ({entry.group})
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={!model || !member}
              onClick={() => {
                if (!model || !member) return;
                const id = nextMemberId(model, member.group);
                edit((current) => addGroupToFile(current, member.group, id), `${member.group}-${id}`);
              }}
            >
              <Icon name="Plus" className="size-3.5" />
              Member
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={!model}
              onClick={() => {
                if (!model) return;
                let n = 2;
                while (model.groups.includes(`group${n}`)) n++;
                edit((current) => addGroupToFile(current, `group${n}`, "member"), `group${n}-member`);
              }}
            >
              <Icon name="Plus" className="size-3.5" />
              Group
            </Button>
          </div>
          {errors.length === 0 ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Icon name="Check" className="size-3.5" />
              The crew file is valid.
            </p>
          ) : (
            <ul className="flex flex-col gap-1 text-xs text-destructive" aria-label="Problems">
              {errors.map((problem, index) => (
                <li key={index}>{problem.message}</li>
              ))}
            </ul>
          )}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {member && model ? (
            <>
              <div>
                <div className="text-sm font-semibold">
                  {member.key}@{model.crew.name}
                </div>
                <div className="text-xs text-muted-foreground">
                  group {member.group} · {member.lead ? "Lead" : "Member"}
                </div>
              </div>
              <div>
                <Section title="Identity" summary="id, group, lead" open={open === "identity"} onToggle={() => toggle("identity")}>
                  <Field label="Member id">
                    <input
                      key={member.key}
                      aria-label="Member id"
                      className={fieldClass}
                      defaultValue={member.id}
                      onBlur={(event) => {
                        const id = event.target.value.trim();
                        if (id && id !== member.id) edit((current) => renameMemberInFile(current, member.key, id), `${member.group}-${id}`);
                      }}
                    />
                  </Field>
                  <p className="text-[11px] text-muted-foreground">
                    Group {member.group}
                    {member.lead ? " · lead of the crew" : ""}
                  </p>
                </Section>
                <Section title="Role" summary={member.role || "none"} open={open === "role"} onToggle={() => toggle("role")}>
                  <textarea aria-label="Role text" rows={5} className={cn(fieldClass, "resize-y")} value={member.role} onChange={(event) => edit((current) => setMemberValue(current, member.key, "role", event.target.value))} />
                </Section>
                <Section title="Provider & model" summary={[member.provider, member.model].filter(Boolean).join(" · ") || "inherited"} open={open === "model"} onToggle={() => toggle("model")}>
                  <ExecutionPicker
                    value={{
                      providerId: member.provider,
                      model: member.model,
                      // The picker needs a level to show; it is only written once the user picks.
                      reasoningLevel: member.reasoningLevel || "medium",
                      ...(member.serviceTier ? { serviceTier: member.serviceTier } : {}),
                    }}
                    onChange={(value) => edit((current) => setMemberExecution(current, member.key, value))}
                  />
                </Section>
                <Section title="Skills" summary={String(member.skills.length)} open={open === "skills"} onToggle={() => toggle("skills")}>
                  <div className="flex flex-wrap gap-1.5">
                    {member.skills.map((skill) => (
                      <span key={skill} className="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs">
                        {skill}
                        <button type="button" aria-label={`Remove skill ${skill}`} className="text-muted-foreground hover:text-foreground" onClick={() => edit((current) => setMemberSkills(current, member.key, member.skills.filter((entry) => entry !== skill)))}>
                          <Icon name="X" className="size-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                  <form
                    className="flex gap-1.5"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!skillDraft.trim()) return;
                      edit((current) => setMemberSkills(current, member.key, [...member.skills, skillDraft]));
                      setSkillDraft("");
                    }}
                  >
                    <input aria-label="Add skill" placeholder="skill name" className={fieldClass} value={skillDraft} onChange={(event) => setSkillDraft(event.target.value)} />
                    <Button size="sm" variant="outline" type="submit" className="h-7">
                      Add
                    </Button>
                  </form>
                </Section>
                <Section title="Permissions" summary={[member.permissions || "inherited", member.environment].filter(Boolean).join(" · ")} open={open === "permissions"} onToggle={() => toggle("permissions")}>
                  <Field label="Permissions">
                    <select aria-label="Permissions" className={fieldClass} value={member.permissions} onChange={(event) => edit((current) => setMemberValue(current, member.key, "permissions", event.target.value))}>
                      <option value="">(inherited)</option>
                      {PERMISSIONS.map((permission) => (
                        <option key={permission} value={permission}>
                          {permission}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Environment">
                    <select aria-label="Environment" className={fieldClass} value={member.environment} onChange={(event) => edit((current) => setMemberValue(current, member.key, "environment", event.target.value))}>
                      <option value="">(inherited)</option>
                      {["auto", "reuse", "worktree"].map((environment) => (
                        <option key={environment} value={environment}>
                          {environment}
                        </option>
                      ))}
                    </select>
                  </Field>
                </Section>
                <Section title="Links" summary={`${incoming.length} in · ${outgoing.length} out`} open={open === "links"} onToggle={() => toggle("links")}>
                  {incoming.length + outgoing.length === 0 ? <p className="text-xs text-muted-foreground">No links. Drag from a member's dot to draw one.</p> : null}
                  <ul className="flex flex-col gap-1 text-xs">
                    {[...outgoing, ...incoming].map(({ link, index }) => (
                      <li key={index} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate">{link.from === member.key ? `${link.kind} → ${link.to}` : `${link.from} → ${link.kind}`}</span>
                        <button
                          type="button"
                          aria-label={`Remove link ${link.from} ${link.kind} ${link.to}`}
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() => edit((current) => removeLinkFromFile(current, index))}
                        >
                          <Icon name="X" className="size-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </Section>
                <Section title="Crew settings" summary={`baseBranch ${model.crew.baseBranch}${model.crew.instructions ? " · instructions" : ""}`} open={open === "crew"} onToggle={() => toggle("crew")}>
                  <Field label="Base branch">
                    <input aria-label="Base branch" className={fieldClass} value={model.crew.baseBranch} onChange={(event) => edit((current) => setCrewValue(current, "baseBranch", event.target.value))} />
                  </Field>
                  <Field label="Instructions">
                    <textarea aria-label="Crew instructions" rows={6} className={cn(fieldClass, "resize-y")} value={model.crew.instructions} onChange={(event) => edit((current) => setCrewValue(current, "instructions", event.target.value))} />
                  </Field>
                </Section>
              </div>
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-destructive"
                  disabled={member.lead}
                  onClick={() => edit((current) => removeMemberFromFile(current, member.key), null)}
                >
                  Remove member
                </Button>
                {member.lead ? <p className="mt-1 text-[11px] text-muted-foreground">The lead cannot be removed; make another member lead first.</p> : null}
              </div>
            </>
          ) : null}
        </aside>
      </div>
    </div>,
    document.body,
  );
}

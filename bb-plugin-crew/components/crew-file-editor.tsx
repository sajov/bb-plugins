// "Edit crew file" tab (§4.6): YAML and a form as two views of the same text,
// validation while typing, the preview "What Apply does" and one Apply button.
//
// - Validation runs in the browser on every keystroke with the same
//   `validateCrew` the server uses (lib/spec.ts is pure).
// - The preview is the server's `plan` for the text being edited, rendered
//   with the same `formatPlan` as `bb crew plan` (lib/format.ts), so the two
//   cannot drift apart (§8.1 E4).
// - Form edits go through the YAML document (`setIn`), so comments survive.
import { useEffect, useMemo, useState } from "react";
import YAML, { isMap, isSeq, type YAMLMap } from "yaml";
import {
  // Aliased because JSX reads a lowercase tag as an intrinsic element.
  experimental_ProviderModelPicker as ProviderModelPicker,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { formatPlan, type PlanLine, type ProblemLine } from "../lib/format";
import { PERMISSIONS, validateCrew } from "../lib/spec";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ACTION_TONE: Record<string, string> = {
  reuse: "bg-muted text-muted-foreground",
  spawn: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  unarchive: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  update: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  remove: "bg-destructive/10 text-destructive",
};

type FormMember = {
  path: (string | number)[];
  group: string;
  id: string;
  lead: boolean;
  role: string;
  provider: string;
  model: string;
  reasoningLevel: string;
  serviceTier: string;
  permissions: string;
};

function formModel(text: string): { crew: Record<string, string>; members: FormMember[] } | null {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
  const root = doc.contents as YAMLMap;
  const crew: Record<string, string> = {};
  for (const key of ["name", "summary", "messaging", "permissions"]) crew[key] = String(root.get(key) ?? "");
  const members: FormMember[] = [];
  const groups = root.get("groups", true);
  if (isSeq(groups)) {
    groups.items.forEach((group, gi) => {
      if (!isMap(group)) return;
      const list = (group as YAMLMap).get("members", true);
      if (!isSeq(list)) return;
      list.items.forEach((member, mi) => {
        if (!isMap(member)) return;
        const m = member as YAMLMap;
        members.push({
          path: ["groups", gi, "members", mi],
          group: String((group as YAMLMap).get("id") ?? ""),
          id: String(m.get("id") ?? ""),
          lead: m.get("lead") === true,
          role: String(m.get("role") ?? ""),
          provider: String(m.get("provider") ?? ""),
          model: String(m.get("model") ?? ""),
          reasoningLevel: String(m.get("reasoningLevel") ?? ""),
          serviceTier: String(m.get("serviceTier") ?? ""),
          permissions: String(m.get("permissions") ?? ""),
        });
      });
    });
  }
  return { crew, members };
}

/**
 * Write what BB's provider/model picker chose onto one member. Provider and
 * model are always written; reasoning level and service tier only when the
 * picker returns them (a tier is dropped when the new provider has none).
 */
export function setExecution(
  text: string,
  path: (string | number)[],
  value: { providerId: string; model: string; reasoningLevel?: string; serviceTier?: string },
): string {
  const doc = YAML.parseDocument(text);
  doc.setIn([...path, "provider"], value.providerId);
  doc.setIn([...path, "model"], value.model);
  if (value.reasoningLevel) doc.setIn([...path, "reasoningLevel"], value.reasoningLevel);
  else doc.deleteIn([...path, "reasoningLevel"]);
  if (value.serviceTier) doc.setIn([...path, "serviceTier"], value.serviceTier);
  else doc.deleteIn([...path, "serviceTier"]);
  return doc.toString({ lineWidth: 0 });
}

/** Set (or clear, for "") one value in the YAML text, keeping everything else as written. */
export function setYamlValue(text: string, path: (string | number)[], value: string | boolean): string {
  const doc = YAML.parseDocument(text);
  if (value === "" || value === false) doc.deleteIn(path);
  else doc.setIn(path, value);
  return doc.toString({ lineWidth: 0 });
}

export function CrewFileEditor({ projectId, initialYaml, onApplied }: { projectId: string; initialYaml: string; onApplied?: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [text, setText] = useState(initialYaml);
  const [view, setView] = useState<"yaml" | "form">("yaml");
  const [confirmFull, setConfirmFull] = useState(false);
  const [plan, setPlan] = useState<{ items: PlanLine[]; problems: ProblemLine[] } | null>(null);
  const [planning, setPlanning] = useState(false);
  const [applied, setApplied] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(initialYaml), [initialYaml]);

  const validation = useMemo(() => validateCrew(text, { confirmFull }), [text, confirmFull]);
  const errors = validation.problems.filter((problem) => problem.level === "error");
  const needsFull = validation.problems.some((problem) => problem.code === "full-unconfirmed") || confirmFull;

  // The preview follows the text, debounced; a stale answer never overwrites a newer one.
  useEffect(() => {
    if (errors.length > 0) {
      setPlan(null);
      return;
    }
    let live = true;
    setPlanning(true);
    const timer = setTimeout(() => {
      rpc.call("plan", { projectId, yaml: text, fresh: [], confirmFull }).then(
        (result) => {
          if (!live) return;
          setPlan({ items: result.items, problems: result.problems });
          setPlanning(false);
        },
        (cause: unknown) => {
          if (!live) return;
          setError(cause instanceof Error ? cause.message : String(cause));
          setPlanning(false);
        },
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [rpc, projectId, text, confirmFull, errors.length]);

  const model = useMemo(() => (view === "form" ? formModel(text) : null), [view, text]);
  const lines = plan ? formatPlan(plan.items) : [];
  const serverProblems = plan ? plan.problems.filter((problem) => !validation.problems.some((own) => own.message === problem.message)) : [];

  return (
    <div className="flex flex-col gap-3" aria-label="Crew file editor">
      <div className="flex items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-md border border-border" role="tablist" aria-label="Editor view">
          {(["yaml", "form"] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={view === entry}
              className={cn("px-2.5 py-1 text-xs", view === entry ? "bg-muted text-foreground" : "text-muted-foreground")}
              onClick={() => setView(entry)}
            >
              {entry === "yaml" ? "YAML" : "Form"}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">Two views of the same file.</span>
      </div>
      <div className="flex min-h-0 flex-col gap-3 lg:flex-row">
        <div className="min-w-0 flex-1">
          {view === "yaml" ? (
            <textarea
              aria-label="Crew file YAML"
              spellCheck={false}
              className="h-[380px] w-full resize-y rounded-xl border border-border bg-background p-3 font-mono text-xs leading-relaxed"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setApplied(null);
              }}
            />
          ) : model ? (
            <FormView text={text} model={model} onChange={(next) => (setText(next), setApplied(null))} />
          ) : (
            <p className="text-sm text-destructive">The YAML does not parse; fix it in the YAML view first.</p>
          )}
        </div>
        <div className="flex w-full flex-col gap-2 lg:w-[380px]">
          <section aria-label="Problems" className="rounded-xl border border-border bg-card text-card-foreground p-3 text-xs">
            <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Check</h4>
            {validation.problems.length === 0 && serverProblems.length === 0 ? (
              <div className="rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-emerald-700 dark:text-emerald-400">Valid crew file.</div>
            ) : (
              <ul className="flex flex-col gap-1">
                {[...validation.problems, ...serverProblems].map((problem, index) => (
                  <li
                    key={index}
                    data-level={problem.level}
                    className={cn("rounded-md px-2.5 py-1.5", problem.level === "error" ? "bg-destructive/10 text-destructive" : "bg-amber-500/10 text-amber-700 dark:text-amber-400")}
                  >
                    {problem.message}
                  </li>
                ))}
              </ul>
            )}
            {needsFull ? (
              <label className="mt-2 flex items-center gap-1.5 text-destructive">
                <input type="checkbox" aria-label="Confirm full permissions" checked={confirmFull} onChange={(event) => setConfirmFull(event.target.checked)} />
                I confirm permissions: full
              </label>
            ) : null}
          </section>
          <section aria-label="What Apply does" className="rounded-xl border border-border bg-card text-card-foreground p-3">
            <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">What Apply does</h4>
            {errors.length > 0 ? (
              <p className="text-xs text-muted-foreground">Fix the errors to see the plan.</p>
            ) : planning && !plan ? (
              <p className="text-xs text-muted-foreground">Planning…</p>
            ) : (
              <div className="flex flex-col gap-1" data-plan-lines={lines.length}>
                {lines.map((line, index) => (
                  <pre key={index} data-plan-line className={cn("m-0 overflow-x-auto rounded-md px-2 py-1 font-mono text-[11px]", ACTION_TONE[plan!.items[index]!.action])}>
                    {line}
                  </pre>
                ))}
              </div>
            )}
            <p className="mt-2 text-[11px] text-muted-foreground">Same lines as bb crew plan.</p>
          </section>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            disabled={errors.length > 0 || !plan || planning}
            onClick={async () => {
              setError(null);
              try {
                const result = await rpc.call("apply", { projectId, yaml: text, fresh: [], confirmFull });
                setApplied(result.results.map((entry) => `${entry.result} ${entry.address}${entry.detail ? ` (${entry.detail})` : ""}`));
                onApplied?.();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
              }
            }}
          >
            Apply
          </Button>
          {applied ? (
            <ul aria-label="Apply results" className="text-xs text-muted-foreground">
              {applied.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FormView({ text, model, onChange }: { text: string; model: NonNullable<ReturnType<typeof formModel>>; onChange: (text: string) => void }) {
  const field = (label: string, value: string, path: (string | number)[], options?: readonly string[]) => (
    <label className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
      {label}
      {options ? (
        <select
          aria-label={label}
          className="rounded-md border border-border bg-transparent px-1.5 py-1 text-xs text-foreground"
          value={value}
          onChange={(event) => onChange(setYamlValue(text, path, event.target.value))}
        >
          <option value="">(inherited)</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          aria-label={label}
          className="rounded-md border border-border bg-transparent px-1.5 py-1 text-xs text-foreground"
          value={value}
          onChange={(event) => onChange(setYamlValue(text, path, event.target.value))}
        />
      )}
    </label>
  );
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card text-card-foreground p-3" aria-label="Crew file form">
      <div className="grid grid-cols-2 gap-2">
        {field("Name", model.crew.name!, ["name"])}
        {field("Summary", model.crew.summary!, ["summary"])}
        {field("Messaging", model.crew.messaging!, ["messaging"], ["open", "links"])}
        {field("Crew permissions", model.crew.permissions!, ["permissions"], PERMISSIONS)}
      </div>
      {model.members.map((member) => (
        <fieldset key={member.path.join(".")} className="grid grid-cols-2 gap-2 rounded-lg border border-border p-2">
          <legend className="px-1 text-xs">
            {member.group}-{member.id}
            {member.lead ? " ★ lead" : ""}
          </legend>
          {field(`${member.group}-${member.id} role`, member.role, [...member.path, "role"])}
          {field(`${member.group}-${member.id} permissions`, member.permissions, [...member.path, "permissions"], PERMISSIONS)}
          <div className="col-span-2 flex flex-col gap-0.5 text-[11px] text-muted-foreground" aria-label={`${member.group}-${member.id} execution`}>
            Provider and model
            <ProviderModelPicker
              value={{
                providerId: member.provider,
                model: member.model,
                // The picker needs a level to show; it is only written once the user picks.
                reasoningLevel: (member.reasoningLevel || "medium") as never,
                ...(member.serviceTier ? { serviceTier: member.serviceTier as never } : {}),
              }}
              onChange={(value) => onChange(setExecution(text, member.path, value))}
            />
          </div>
        </fieldset>
      ))}
    </div>
  );
}

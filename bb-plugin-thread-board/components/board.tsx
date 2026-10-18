import { useMemo, useState } from "react";
import { COLUMNS, columnFor, groupByColumn, isRunning, relativeTime, type Column } from "@/lib/board";
import type { Purpose } from "@/lib/purpose";
import { cn } from "@/lib/utils";
import { ThreadDetail } from "./thread-detail";

export interface CardThread {
  id: string;
  projectId: string;
  displayTitle: string;
  status: string;
  hasPendingInteraction: boolean;
  updatedAt: number;
  href: string;
}

export interface BoardProps {
  threads: readonly CardThread[];
  projects: readonly { id: string; name: string }[];
  purposes: Record<string, Purpose>;
  markedDone: readonly string[];
  evaluating: readonly string[];
  staleDays: number;
  model: string;
  now: number;
  onOpen: (threadId: string) => void;
  onRefresh: (threadId: string) => void;
  onSetDone: (threadId: string, done: boolean) => void;
  onArchive: (threadId: string) => void;
  onEvaluateMany: (threadIds: string[]) => void;
  onSend: (threadId: string, text: string) => void;
}

export const TONE: Record<Column, string> = {
  working: "var(--brand)",
  waiting: "var(--warning)",
  stale: "var(--muted-foreground)",
  done: "var(--success)",
};

export function Board(props: BoardProps) {
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const markedDone = useMemo(() => new Set(props.markedDone), [props.markedDone]);
  const projectName = useMemo(() => new Map(props.projects.map((p) => [p.id, p.name])), [props.projects]);

  const visible = props.threads.filter((thread) => {
    if (projectId !== null && thread.projectId !== projectId) return false;
    const needle = query.trim().toLowerCase();
    if (needle === "") return true;
    const purpose = props.purposes[thread.id];
    return `${thread.displayTitle} ${purpose?.headline ?? ""} ${purpose?.purpose ?? ""}`.toLowerCase().includes(needle);
  });
  const columnOf = (thread: CardThread) =>
    columnFor(thread, props.purposes[thread.id], {
      now: props.now,
      staleDays: props.staleDays,
      markedDone: markedDone.has(thread.id),
    });
  const groups = groupByColumn(visible, columnOf);
  const unevaluated = visible.filter(
    (t) => {
      const purpose = props.purposes[t.id];
      const outdated = purpose?.headline === undefined || purpose.actions === undefined;
      return outdated && !props.evaluating.includes(t.id);
    },
  );
  const usedProjects = props.projects.filter((p) => props.threads.some((t) => t.projectId === p.id));
  const selected = props.threads.find((thread) => thread.id === selectedId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-3 text-base font-semibold">Thread Board</h1>
        <input
          aria-label="Search threads"
          placeholder="Search threads…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-8 min-w-40 flex-1 rounded-md border border-border bg-card px-3 text-sm outline-none focus:border-ring"
        />
        <select
          aria-label="Project"
          value={projectId ?? ""}
          onChange={(event) => setProjectId(event.target.value === "" ? null : event.target.value)}
          className="h-8 rounded-md border border-border bg-card px-2 text-sm outline-none focus:border-ring"
        >
          <option value="">All projects</option>
          {usedProjects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        {unevaluated.length > 0 && (
          <button
            type="button"
            onClick={() => props.onEvaluateMany(unevaluated.map((t) => t.id))}
            className="rounded-full border border-border px-2.5 py-0.5 text-xs hover:bg-accent"
            title={`One ${props.model} session per thread, one at a time`}
          >
            Evaluate {unevaluated.length} {unevaluated.length === 1 ? "thread" : "threads"}
          </button>
        )}
        {props.evaluating.length > 0 && (
          <span className="text-xs text-muted-foreground">Evaluating {props.evaluating.length}…</span>
        )}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto md:grid-cols-4">
        {COLUMNS.map((column) => (
          <section key={column.id} aria-label={column.title} className="flex min-h-0 flex-col">
            <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
              <span className="size-2 rounded-full" style={{ background: TONE[column.id] }} />
              {column.title}
              <span className="ml-auto font-normal">{groups[column.id].length}</span>
            </h2>
            <div className="flex flex-col gap-2 overflow-y-auto pb-2">
              {groups[column.id].map((thread) => (
                <Card
                  key={thread.id}
                  thread={thread}
                  column={column.id}
                  project={projectName.get(thread.projectId) ?? null}
                  purpose={props.purposes[thread.id]}
                  evaluating={props.evaluating.includes(thread.id)}
                  now={props.now}
                  onSelect={() => setSelectedId(thread.id)}
                />
              ))}
              {groups[column.id].length === 0 && (
                <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                  Nothing here
                </div>
              )}
            </div>
          </section>
        ))}
      </div>

      {selected && (
        <ThreadDetail
          thread={selected}
          column={columnOf(selected)}
          project={projectName.get(selected.projectId) ?? null}
          purpose={props.purposes[selected.id]}
          evaluating={props.evaluating.includes(selected.id)}
          markedDone={markedDone.has(selected.id)}
          now={props.now}
          onClose={() => setSelectedId(null)}
          onOpen={() => props.onOpen(selected.id)}
          onRefresh={() => props.onRefresh(selected.id)}
          onSetDone={(done) => props.onSetDone(selected.id, done)}
          onArchive={() => props.onArchive(selected.id)}
          onSend={(text) => props.onSend(selected.id, text)}
        />
      )}
    </div>
  );
}

/**
 * A card says what the thread is about and how far it is — nothing more.
 * Everything to read or do lives in the detail popup, one click away.
 */
function Card(props: {
  thread: CardThread;
  column: Column;
  project: string | null;
  purpose: Purpose | undefined;
  evaluating: boolean;
  now: number;
  onSelect: () => void;
}) {
  const { thread, column, purpose } = props;
  const headline = purpose?.headline ?? thread.displayTitle;
  const running = isRunning(thread);
  return (
    <button
      type="button"
      data-testid={`card-${thread.id}`}
      onClick={props.onSelect}
      className={cn(
        "w-full rounded-lg border border-border bg-card px-3 py-2.5 text-left hover:border-ring focus-visible:border-ring focus-visible:outline-none",
        column === "stale" && "opacity-70",
      )}
    >
      <div className="flex items-center gap-2">
        {running && (
          <span className="size-1.5 shrink-0 animate-pulse rounded-full" style={{ background: TONE.working }} aria-label="Agent running" />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{headline}</span>
        {(column === "waiting" || column === "stale") && purpose?.nextStep && (
          <span className="size-1.5 shrink-0 rounded-full" style={{ background: TONE.waiting }} aria-label="Open step" />
        )}
      </div>
      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
        {[props.project, purpose?.headline ? thread.displayTitle : null].filter(Boolean).join(" · ") || " "}
      </div>
      <div className="mt-2 h-[3px] overflow-hidden rounded bg-muted">
        {purpose && <div className="h-full" style={{ width: `${purpose.progress}%`, background: TONE[column] }} />}
      </div>
      <div className="mt-1.5 flex justify-between text-[10.5px] text-muted-foreground">
        <span>{purpose ? `${purpose.progress}%` : props.evaluating ? "Evaluating…" : "Not evaluated"}</span>
        <span>{relativeTime(thread.updatedAt, props.now)}</span>
      </div>
    </button>
  );
}

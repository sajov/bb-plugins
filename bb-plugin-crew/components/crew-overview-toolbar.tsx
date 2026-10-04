// Level 0 of the Crews canvas (BBP-71, kept in BBP-83): which projects are
// drawn, whether crews, tasks and done tasks show, and a search that fades
// everything it does not match.
import type { ReactNode } from "react";
import type { OverviewFilters } from "../lib/overview-graph";
import { cn } from "@/lib/utils";

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
        active ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-muted/50",
      )}
    >
      {children}
    </button>
  );
}

function Toggle({ active, onToggle, label }: { active: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      onClick={onToggle}
      className={cn("rounded-md border px-2 py-1 text-[11px]", active ? "border-primary text-foreground" : "border-border text-muted-foreground")}
    >
      {label}
    </button>
  );
}

export function OverviewToolbar({
  projects,
  filters,
  onChange,
}: {
  projects: readonly { id: string; name: string; count: number }[];
  filters: OverviewFilters;
  onChange: (next: OverviewFilters) => void;
}) {
  const shown = (id: string) => filters.projectIds === null || filters.projectIds.has(id);
  const toggleProject = (id: string) => {
    const next = new Set(filters.projectIds ?? projects.map((project) => project.id));
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange({ ...filters, projectIds: next.size === projects.length ? null : next });
  };
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xs">
      <div role="group" aria-label="Projects" className="flex flex-wrap items-center gap-1.5">
        <Chip active={filters.projectIds === null} onClick={() => onChange({ ...filters, projectIds: null })}>
          All
        </Chip>
        {projects.map((project) => (
          <Chip key={project.id} active={filters.projectIds !== null && shown(project.id)} onClick={() => toggleProject(project.id)}>
            {project.name}
            <span className="text-muted-foreground">{project.count}</span>
          </Chip>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <Toggle active={filters.showCrews} onToggle={() => onChange({ ...filters, showCrews: !filters.showCrews })} label="Crews" />
        <Toggle active={filters.showTasks} onToggle={() => onChange({ ...filters, showTasks: !filters.showTasks })} label="Tasks" />
        <Toggle active={filters.showDone} onToggle={() => onChange({ ...filters, showDone: !filters.showDone })} label="Done" />
      </div>
      <input
        type="search"
        aria-label="Search crews, members and tasks"
        placeholder="Search…"
        className="h-7 min-w-[10rem] flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground"
        value={filters.search}
        onChange={(event) => onChange({ ...filters, search: event.target.value })}
      />
    </div>
  );
}

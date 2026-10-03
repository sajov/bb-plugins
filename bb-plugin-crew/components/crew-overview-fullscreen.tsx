// Fullscreen overview diagram (BBP-71): a real full-screen layer over the
// whole BB window, the reference full-screen pattern copied and adapted as
// our own file — portaled to the body so the canvas gets the window instead
// of the panel's column, with the inspector as a sidebar beside it.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usePortalScopeProps } from "../lib/portal-scope";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { DEFAULT_OVERVIEW_FILTERS, type OverviewFilters, type OverviewProject, type OverviewSource } from "../lib/overview-graph";
import { OverviewCanvas } from "./crew-overview-canvas";
import { OverviewInspector } from "./crew-overview-inspector";
import { buildOverviewGraph } from "../lib/overview-graph";

function ProjectChip({ active, onToggle, children }: { active: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className={cn(
        "rounded-full border px-2.5 py-1 text-[11px] font-medium",
        active ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-muted/50",
      )}
      aria-pressed={active}
      onClick={onToggle}
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
      className={cn("rounded-md border px-2 py-1 text-[11px]", active ? "border-primary text-foreground" : "border-border text-muted-foreground")}
      onClick={onToggle}
    >
      {label}
    </button>
  );
}

export function CrewOverviewFullscreen({
  projects,
  overviews,
  onOpenCrew,
  onOpenTask,
  onClose,
}: {
  projects: readonly OverviewProject[];
  overviews: ReadonlyMap<string, OverviewSource>;
  onOpenCrew: (projectId: string, crewName: string) => void;
  onOpenTask: (projectId: string, taskKey: string) => void;
  onClose: () => void;
}) {
  const scope = usePortalScopeProps();
  const [filters, setFilters] = useState<OverviewFilters>(DEFAULT_OVERVIEW_FILTERS);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const graph = buildOverviewGraph(projects, overviews);
  const selectedCrew = selected ? graph.nodes.find((node) => node.id === selected) : null;

  const toggleProject = (id: string) => {
    setFilters((current) => {
      const all = new Set(projects.map((project) => project.id));
      const picked = current.projectIds ?? all;
      const next = new Set(picked);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...current, projectIds: next.size === all.size ? null : next };
    });
  };

  return createPortal(
    <div {...scope} role="dialog" aria-modal="true" aria-label="Crew overview — full screen" className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
        <span className="truncate text-sm font-medium">Crew overview</span>
        <div className="ml-2 flex flex-wrap items-center gap-1.5" aria-label="Projects">
          {projects.map((project) => (
            <ProjectChip key={project.id} active={filters.projectIds === null || filters.projectIds.has(project.id)} onToggle={() => toggleProject(project.id)}>
              {project.name}
            </ProjectChip>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <Toggle active={filters.showCrews} onToggle={() => setFilters((current) => ({ ...current, showCrews: !current.showCrews }))} label="Crews" />
          <Toggle active={filters.showTasks} onToggle={() => setFilters((current) => ({ ...current, showTasks: !current.showTasks }))} label="Tasks" />
          <Toggle active={filters.showDone} onToggle={() => setFilters((current) => ({ ...current, showDone: !current.showDone }))} label="Done" />
        </div>
        <input
          type="search"
          aria-label="Search crews, members and tasks"
          placeholder="Search…"
          className="h-7 min-w-[10rem] flex-1 rounded-md border border-input bg-transparent px-2 text-xs"
          value={filters.search}
          onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
        />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onClose}>
            <Icon name="X" className="size-4" />
            Leave full screen
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 p-2">
          <OverviewCanvas
            projects={projects}
            overviews={overviews}
            filters={filters}
            selected={selected}
            onSelectCrew={setSelected}
            onOpenCrew={onOpenCrew}
            onOpenTask={onOpenTask}
          />
        </div>
        {selectedCrew && selectedCrew.kind === "crew" ? (
          <aside className="w-[24rem] max-w-[42vw] shrink-0 overflow-y-auto border-l border-border/60 bg-background px-4 py-3">
            <OverviewInspector crew={selectedCrew} onOpen={() => onOpenCrew(selectedCrew.projectId, selectedCrew.name)} onClose={() => setSelected(null)} />
          </aside>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

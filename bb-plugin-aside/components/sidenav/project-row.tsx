// The project row.
//
// No chevron and no handle: the row itself expands and collapses, the row
// itself is dragged. The count sits on the right — outlined while the project
// is open. If something waits in there, the blue mark sits before it.
//
// Dragging happens on the avatar: it is the project's identity anyway, and a
// separate grip next to it would be one more symbol in a list that wants to do
// without symbols. The rest of the row stays a click target for expanding and
// collapsing. The drop target is the whole project block, so nobody has to hit
// the 32 pixels of the header.
//
// The personal project can be dragged too. The host does not sort it (its id is
// synthetic), so the sidenav keeps its position itself — see `placePersonal`.
// Renaming still does not work there, because in the host it has no name at
// all.
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  type PluginSidebarProject,
} from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { RowCount, RowTail } from "@/components/sidenav/row-slots";
import { badgeColor, badgeForeground, badgeLetter, BADGE_PALETTE } from "@/lib/colors";
import { stateLabel } from "@/components/sidenav/marks";
import { TagEditor } from "@/components/sidenav/tag-editor";
import type { ThreadState } from "@/lib/tree";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

export const PROJECT_DRAG_TYPE = "application/x-aside-project";

function NameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      defaultValue={initial}
      onClick={(event) => event.stopPropagation()}
      onBlur={onCancel}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") onCancel();
        if (event.key === "Enter") {
          const value = event.currentTarget.value.trim();
          // An empty name never writes — otherwise a project would lose its
          // name to an accidental Enter.
          if (value.length === 0) {
            onCancel();
            return;
          }
          onCommit(value);
        }
      }}
      className="relative z-10 w-full min-w-0 rounded border border-border bg-background px-1 py-px text-xs font-semibold outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}

export function ProjectRow({
  project,
  color,
  tags,
  knownTags,
  threadCount,
  waitingCount,
  state,
  age,
  now,
  collapsed,
  renaming,
  onToggle,
  onSolo,
  sectionsCollapsed,
  onToggleSections,
  onStartRename,
  onCancelRename,
  onRename,
  onSetColor,
  onSetTags,
  onReorder,
  children,
}: {
  project: PluginSidebarProject;
  color: string | null;
  /** What this project carries; the list itself never shows them. */
  tags: readonly string[];
  /** Every tag in use anywhere — what the editor offers to pick from. */
  knownTags: readonly string[];
  threadCount: number;
  waitingCount: number;
  state: ThreadState;
  /** Newest activity in the project; `null` while it holds no threads. */
  age: number | null;
  now: number;
  collapsed: boolean;
  renaming: boolean;
  onToggle: () => void;
  onSolo: () => void;
  /**
   * Whether every section in this project is folded; `null` when it has none,
   * which hides the menu entry rather than offering to fold nothing.
   */
  sectionsCollapsed: boolean | null;
  onToggleSections: () => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onRename: (name: string) => void;
  onSetColor: (color: string | null) => void;
  onSetTags: (tags: string[]) => void;
  onReorder: (sourceProjectId: string, position: "before" | "after") => void;
  children: ReactNode;
}) {
  const actions = useSidebarThreadActions();
  const background = badgeColor(project.id, color);
  const dragging = useRef(false);
  const headerRef = useRef<HTMLDivElement>(null);
  // The swatches are not menu items, so Radix does not close the menu after a
  // click. We therefore drive the open state ourselves.
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <section
      aria-label={project.name}
      data-aside-project={project.id}
      onDragOver={(event: DragEvent<HTMLElement>) => {
        if (!event.dataTransfer.types.includes(PROJECT_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event: DragEvent<HTMLElement>) => {
        const source = event.dataTransfer.getData(PROJECT_DRAG_TYPE);
        if (!source || source === project.id) return;
        event.preventDefault();
        event.stopPropagation();
        const bounds = headerRef.current?.getBoundingClientRect();
        onReorder(
          source,
          bounds !== undefined && event.clientY >= bounds.top + bounds.height / 2
            ? "after"
            : "before",
        );
      }}
    >
      <ContextMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <ContextMenuTrigger asChild>
          <div
            ref={headerRef}
            // Sticky: deep in a long project you still see whose threads you
            // are scrolling through.
            className="group/project sticky top-0 z-20 flex h-8 select-none bg-sidebar items-center gap-2 rounded-md px-1.5 hover:bg-sidebar-accent/60"
          >
            <button
              type="button"
              aria-label={`${collapsed ? "Expand" : "Collapse"} ${project.name}`}
              aria-expanded={!collapsed}
              title="Click expands and collapses · Alt-click opens only this one"
              onClick={(event) => {
                // A rapid double click must not expand and collapse in
                // between; renaming now lives in the context menu.
                if (renaming || event.detail > 1) return;
                if (event.altKey) onSolo();
                else onToggle();
              }}
              onMouseDown={(event) => {
                // A right click must not focus the button: the menu opens on
                // the same mousedown, and a focus change racing its own focus
                // trap closed it again right away.
                if (event.button === 2 || event.ctrlKey) event.preventDefault();
              }}
              className="absolute inset-0 cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <span
              draggable
              title={`${project.name} — drag to reorder projects`}
              onDragStart={(event) => {
                dragging.current = true;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(PROJECT_DRAG_TYPE, project.id);
                // Some environments only start a drag with a standard type
                // aboard.
                event.dataTransfer.setData("text/plain", project.name);
              }}
              onDragEnd={() => {
                window.setTimeout(() => {
                  dragging.current = false;
                }, 0);
              }}
              onClick={(event) => {
                // An aborted drag must not pass as a click.
                if (dragging.current || event.detail > 1) return;
                if (event.altKey) onSolo();
                else onToggle();
              }}
              className={cn(
                "relative z-10 flex size-5 shrink-0 items-center justify-center rounded-md border border-black/15 text-2xs font-semibold uppercase shadow-sm",
                "cursor-grab active:cursor-grabbing",
              )}
              style={{ backgroundColor: background, color: badgeForeground(background) }}
            >
              {badgeLetter(project.name)}
            </span>
            {renaming ? (
              <NameInput
                initial={project.name}
                onCommit={onRename}
                onCancel={onCancelRename}
              />
            ) : (
              <span
                // Deliberately independent of `collapsed`: a project does not
                // become less of a project by being folded. Fading its avatar
                // and name made half the list look disabled, and the fold state
                // is already carried by the count badge's fill and by the
                // button's own arrow.
                className="pointer-events-none relative min-w-0 truncate text-xs font-semibold text-foreground/90"
              >
                {project.name}
              </span>
            )}
            <RowCount
              count={threadCount}
              open={!collapsed}
              className="pointer-events-none relative"
            />
            <RowTail
              age={age}
              now={now}
              state={state}
              /* `ml-auto`: the name no longer stretches, so without this the
                 tail would follow the count instead of holding the right edge. */
              stateTitle={
                state === "quiet"
                  ? stateLabel(state)
                  : waitingCount > 0
                    ? `${waitingCount} ${waitingCount === 1 ? "thread is" : "threads are"} waiting for you`
                    : stateLabel(state)
              }
              className="pointer-events-none relative ml-auto mr-0.5"
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent
          className="w-56"
          // Only a click outside or Escape closes this menu. Focus wandering off
          // — to the host, or back to the row under the pointer — used to close
          // it the moment it had opened, so a right click often only flashed.
          onFocusOutside={(event) => event.preventDefault()}
        >
          {/* One grammar for every row menu: open or new, edit, organise,
              visibility, destructive. Tags and colour are submenus — inline
              they made this the longest menu in the list, with a text field
              in the middle of it. */}
          <ContextMenuItem
            onSelect={() =>
              actions.openNewThread({ projectId: project.id, focusPrompt: true })
            }
          >
            New thread
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={project.isPersonal} onSelect={onStartRename}>
            Rename
            {project.isPersonal ? (
              <ContextMenuShortcut>implicit</ContextMenuShortcut>
            ) : null}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <span className="min-w-0 flex-1">Tags</span>
              <span className="ml-2 max-w-24 truncate text-2xs text-muted-foreground">
                {tags.length > 0 ? tags.join(", ") : "none"}
              </span>
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-56">
              <TagEditor tags={tags} knownTags={knownTags} onChange={onSetTags} />
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <span className="min-w-0 flex-1">Colour</span>
              <span
                aria-hidden
                className="ml-2 inline-block size-2.5 rounded-sm border border-border"
                style={{ backgroundColor: background }}
              />
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-48">
              <div className="grid grid-cols-6 gap-1 px-2 pb-1.5 pt-1.5">
                {BADGE_PALETTE.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    aria-label={`Colour ${swatch}`}
                    aria-pressed={background === swatch}
                    onClick={() => {
                      onSetColor(swatch);
                      setMenuOpen(false);
                    }}
                    className={cn(
                      "aspect-square w-full rounded border border-border",
                      background === swatch && "ring-1 ring-ring",
                    )}
                    style={{ backgroundColor: swatch }}
                  />
                ))}
              </div>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => onSetColor(null)}>
                Automatic colour
                <ContextMenuShortcut>from the id</ContextMenuShortcut>
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onSolo}>
            Focus on this project
            <ContextMenuShortcut>⌥Click</ContextMenuShortcut>
          </ContextMenuItem>
          {sectionsCollapsed === null ? null : (
            <ContextMenuItem onSelect={onToggleSections}>
              {sectionsCollapsed ? "Expand all sections" : "Collapse all sections"}
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {collapsed ? null : <div className="mt-0.5 flex flex-col gap-0.5">{children}</div>}
    </section>
  );
}

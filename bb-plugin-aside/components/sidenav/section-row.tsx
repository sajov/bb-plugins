// The section row.
//
// In the host a section belongs to no project (its schema is only
// { id, name }); it therefore appears in every project where it has threads.
// The count on the right is — as everywhere — the toggle.
import { useEffect, useRef, type DragEvent } from "react";
import { cn } from "@/lib/utils";
import { RowCount, RowTail } from "@/components/sidenav/row-slots";
import type { ThreadState } from "@/lib/tree";
import { THREAD_DRAG_TYPE } from "@/components/sidenav/thread-card";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

/** A section has no project of its own, so its drag type stays separate from
 *  `PROJECT_DRAG_TYPE` — dropping a project on a section row must not reorder
 *  sections, and dropping a section on a project row must not move a project. */
export const SECTION_DRAG_TYPE = "application/x-aside-section";

export function SectionRow({
  id,
  name,
  count,
  state,
  age,
  now,
  collapsed,
  renaming,
  threadCount,
  projectCount,
  onToggle,
  onStartRename,
  onCancelRename,
  onRename,
  onDissolve,
  onDropThread,
  onNewThread,
  onReorder,
}: {
  id: string;
  name: string;
  count: number;
  state: ThreadState;
  /** Newest activity inside the section; `null` while it holds no threads. */
  age: number | null;
  now: number;
  collapsed: boolean;
  renaming: boolean;
  /** Threads in this section across every project. */
  threadCount: number;
  /**
   * Projects that use this section. A host section belongs to no project, so
   * renaming or dissolving it here changes all of them — the row and the menu
   * say so.
   */
  projectCount: number;
  onToggle: () => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onRename: (name: string) => void;
  onDissolve: () => void;
  onDropThread: (threadId: string) => void;
  onNewThread: () => void;
  onReorder: (sourceSectionId: string, position: "before" | "after") => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  useEffect(() => {
    if (!renaming) return;
    ref.current?.focus();
    ref.current?.select();
  }, [renaming]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={rowRef}
          draggable
          onDragStart={(event: DragEvent<HTMLDivElement>) => {
            dragging.current = true;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(SECTION_DRAG_TYPE, id);
            event.dataTransfer.setData("text/plain", name);
          }}
          onDragEnd={() => {
            window.setTimeout(() => {
              dragging.current = false;
            }, 0);
          }}
          onDragOver={(event) => {
            if (
              !event.dataTransfer.types.includes(THREAD_DRAG_TYPE) &&
              !event.dataTransfer.types.includes(SECTION_DRAG_TYPE)
            ) {
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => {
            const sourceSectionId = event.dataTransfer.getData(SECTION_DRAG_TYPE);
            if (sourceSectionId && sourceSectionId !== id) {
              event.preventDefault();
              event.stopPropagation();
              const bounds = rowRef.current?.getBoundingClientRect();
              onReorder(
                sourceSectionId,
                bounds !== undefined && event.clientY >= bounds.top + bounds.height / 2
                  ? "after"
                  : "before",
              );
              return;
            }
            const threadId = event.dataTransfer.getData(THREAD_DRAG_TYPE);
            if (!threadId) return;
            event.preventDefault();
            event.stopPropagation();
            onDropThread(threadId);
          }}
          onClick={(event) => {
            if (dragging.current || renaming || event.detail > 1) return;
            onToggle();
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            onStartRename();
          }}
          className="mt-1 flex cursor-grab select-none items-center gap-2 rounded-md px-2 py-0.5 hover:bg-sidebar-accent/60 active:cursor-grabbing"
        >
          {renaming ? (
            <input
              ref={ref}
              defaultValue={name}
              onClick={(event) => event.stopPropagation()}
              onBlur={onCancelRename}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") onCancelRename();
                if (event.key === "Enter") {
                  const value = event.currentTarget.value.trim();
                  if (value.length === 0) {
                    onCancelRename();
                    return;
                  }
                  onRename(value);
                }
              }}
              className="w-full min-w-0 rounded border border-border bg-background px-1 py-px text-2xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          ) : (
            <span className="min-w-0 truncate text-2xs uppercase tracking-wider text-muted-foreground/70">
              {name}
            </span>
          )}
          <RowCount count={count} open={!collapsed} />
          {projectCount > 1 ? (
            <span
              title={`Also in ${projectCount - 1} other ${projectCount === 2 ? "project" : "projects"}`}
              className="shrink-0 text-2xs text-muted-foreground/60"
            >
              +{projectCount - 1}
            </span>
          ) : null}
          <RowTail age={age} now={now} state={state} className="ml-auto" />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        <ContextMenuItem onSelect={onNewThread}>New thread</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onStartRename}>
          Rename section
          <ContextMenuShortcut>
            {projectCount > 1 ? `in ${projectCount} projects` : "Double click"}
          </ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onToggle}>
          {collapsed ? "Expand section" : "Collapse section"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={onDissolve}
        >
          Dissolve section
          <ContextMenuShortcut>
            {projectCount > 1
              ? `${projectCount} projects · ${threadCount} threads`
              : `${threadCount} threads`}
          </ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// A card: one root thread with its agents.
//
// Grid and metrics come from Dockside's `thread-card.tsx` — the harness mark on
// the left, aligned with the project badge, title and location in the middle,
// time and state on the right. Children hang off the indent, with no line and
// no frame. What is new: the count is the toggle, there is no chevron.
import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { badgeForeground, badgeLetter } from "@/lib/colors";
import { RowCount, RowTail } from "@/components/sidenav/row-slots";
import {
  familyState,
  threadState,
  threadTitle,
  type Family,
  type ThreadState,
} from "@/lib/tree";
import {
  BranchGlyph,
  EnvironmentGlyph,
  PinGlyph,
} from "@/components/sidenav/marks";
import {
  ProviderGlyph,
  type ProviderMap,
} from "@/components/sidenav/provider-glyph";
import { RowMenu } from "@/components/sidenav/row-menu";
import { Checkbox } from "@/components/ui/checkbox";

/**
 * In selection mode the checkbox takes the glyph's place rather than a column of
 * its own: a list that grows a column the moment you select would push every
 * title sideways and reflow what you are trying to read.
 */
function SelectMark({
  thread,
  selection,
  className,
}: {
  thread: PluginSidebarThread;
  selection: SelectionProps;
  className?: string;
}) {
  return (
    <Checkbox
      checked={selection.selected.has(thread.id)}
      aria-label={`Select ${threadTitle(thread)}`}
      onClick={(event) => event.stopPropagation()}
      onCheckedChange={(checked) => selection.onToggle(thread.id, checked === true)}
      className={cn("size-3.5", className)}
    />
  );
}

export const THREAD_DRAG_TYPE = "application/x-aside-thread";

/** Where a dragged card lands: before, after, or inside. */
export type DropWhere = "before" | "after" | "into";

/**
 * The selection mode, or `null` while it is off.
 *
 * Passed down instead of read from a context so a card is still renderable on
 * its own — the tests build one without a sidenav around it.
 */
export interface SelectionProps {
  selected: ReadonlySet<string>;
  onToggle: (threadId: string, on: boolean) => void;
}

export interface CardCallbacks {
  onOpen: (threadId: string, split: boolean) => void;
  onToggleChildren: (threadId: string) => void;
  onRename: (threadId: string, title: string) => void;
  onSetSection: (threadId: string, sectionId: string | null) => void;
  onCreateSection: (threadId: string) => void;
  onNest: (threadId: string, parentThreadId: string) => void;
  onReorder: (threadId: string, targetThreadId: string, where: "before" | "after") => void;
  onDropRejected: (reason: string) => void;
}

function Location({ thread }: { thread: PluginSidebarThread }) {
  const branch = thread.environment?.branchName;
  if (branch) {
    return (
      <span className="flex min-w-0 items-center gap-1" title={`Branch: ${branch}`}>
        <BranchGlyph />
        <span className="truncate font-mono">{branch}</span>
      </span>
    );
  }
  const environment = thread.environment?.name;
  if (environment) {
    return (
      <span className="flex min-w-0 items-center gap-1" title={`Environment: ${environment}`}>
        <EnvironmentGlyph />
        <span className="truncate">{environment}</span>
      </span>
    );
  }
  if (thread.host) {
    return <span className="min-w-0 truncate">{thread.host.name}</span>;
  }
  return <span className="min-w-0 truncate">personal</span>;
}

/** Inline rename: Enter commits, Escape discards, an empty value never writes. */
function TitleInput({
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
          if (value.length === 0) {
            onCancel();
            return;
          }
          onCommit(value);
        }
      }}
      className="w-full min-w-0 rounded border border-border bg-background px-1 py-px text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}

export function ThreadCard({
  family,
  providers,
  sections,
  activeThreadId,
  childrenOpen,
  compact,
  now,
  renaming,
  selection,
  onStartRename,
  onCancelRename,
  callbacks,
  pinnedIn,
}: {
  /**
   * Set when the card sits in the pinned group at the top: the project it
   * belongs to takes the location's place, and the card does not drag — the
   * group is a shortcut to threads that live in their projects, not a place
   * to rearrange them.
   */
  pinnedIn?: { name: string; color: string };
  family: Family;
  providers: ProviderMap;
  sections: readonly { id: string; name: string }[];
  activeThreadId: string | null;
  childrenOpen: boolean;
  compact: boolean;
  now: number;
  renaming: boolean;
  selection: SelectionProps | null;
  onStartRename: (threadId: string) => void;
  onCancelRename: () => void;
  callbacks: CardCallbacks;
}) {
  const { root, children } = family;
  const { splitProps } = useSidebarThreadSplit(root.id);
  const [dropWhere, setDropWhere] = useState<DropWhere | null>(null);
  // A drag ends with a click event. Without this latch, every nesting gesture
  // would also open the dragged thread.
  const dragging = useRef(false);
  // The root's mark stands for the whole family, not just for the root itself —
  // exactly as the project row's mark stands for all of its families. Otherwise
  // the root would stay silent while a child works, and the signal would jump
  // over it straight to the project.
  const rolled = familyState(family);
  const isActive = root.id === activeThreadId;
  const receded = rolled === "quiet" && !root.isPinned;

  return (
    <div>
      <RowMenu
        thread={root}
        sections={sections}
        onRename={() => onStartRename(root.id)}
        onSetSection={(sectionId) => callbacks.onSetSection(root.id, sectionId)}
        onCreateSection={() => callbacks.onCreateSection(root.id)}
      >
        <div
          data-aside-card={root.id}
          // Dragging and selecting are the same gesture with the same button.
          // While a selection is running the card stays put.
          draggable={selection === null && pinnedIn === undefined}
          onDragStart={(event: DragEvent<HTMLDivElement>) => {
            dragging.current = true;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(THREAD_DRAG_TYPE, root.id);
            // Some environments only start a drag with a standard type aboard.
            event.dataTransfer.setData("text/plain", threadTitle(root));
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(THREAD_DRAG_TYPE)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            // The top and bottom 30% reorder, the middle nests. Two targets on
            // the same card, but with clearly separated affordances: line
            // versus frame.
            const bounds = event.currentTarget.getBoundingClientRect();
            const share = (event.clientY - bounds.top) / bounds.height;
            setDropWhere(share < 0.3 ? "before" : share > 0.7 ? "after" : "into");
          }}
          onDragLeave={() => setDropWhere(null)}
          onDragEnd={() => {
            setDropWhere(null);
            window.setTimeout(() => {
              dragging.current = false;
            }, 0);
          }}
          onDrop={(event) => {
            const where = dropWhere ?? "into";
            setDropWhere(null);
            const draggedId = event.dataTransfer.getData(THREAD_DRAG_TYPE);
            if (!draggedId || draggedId === root.id) return;
            event.preventDefault();
            event.stopPropagation();
            if (where === "into") callbacks.onNest(draggedId, root.id);
            else callbacks.onReorder(draggedId, root.id, where);
          }}
          onClick={(event) => {
            // A rapid double click must not open the thread twice; renaming
            // now lives in the context menu, not on the second click.
            if (renaming || dragging.current || event.detail > 1) return;
            // In selection mode the whole row is the checkbox: hitting a 14px
            // box for every thread you want gone is the part people give up on.
            if (selection !== null) {
              selection.onToggle(root.id, !selection.selected.has(root.id));
              return;
            }
            callbacks.onOpen(root.id, event.metaKey || event.ctrlKey);
          }}
          {...(selection === null ? splitProps : {})}
          className={cn(
            "grid cursor-pointer grid-cols-[14px_minmax(0,1fr)_auto] content-center items-center gap-x-2 gap-y-0.5 rounded-lg px-2",
            compact ? "min-h-9 grid-rows-[16px] py-1" : "min-h-12 grid-rows-[16px_16px] py-1.5",
            isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
            // A checked box on a 14px glyph is easy to miss while scanning a
            // long list, so the row carries the state as well.
            selection?.selected.has(root.id) && "bg-sidebar-accent",
            dropWhere === "into" && "ring-1 ring-muted-foreground",
            dropWhere === "before" && "shadow-[inset_0_1px_0_0_var(--muted-foreground)]",
            dropWhere === "after" && "shadow-[inset_0_-1px_0_0_var(--muted-foreground)]",
          )}
        >
          {selection === null && pinnedIn !== undefined ? (
            // In the pinned group the project's avatar takes the harness
            // mark's place: there the question is "whose thread is this",
            // and the row is single-line, so the name below would never show.
            <span
              aria-hidden
              title={pinnedIn.name}
              className="col-start-1 row-start-1 flex size-3.5 items-center justify-center rounded-[3px] border border-black/15 text-[8px] font-semibold uppercase"
              style={{ backgroundColor: pinnedIn.color, color: badgeForeground(pinnedIn.color) }}
            >
              {badgeLetter(pinnedIn.name)}
            </span>
          ) : selection === null ? (
            <ProviderGlyph
              providerId={root.providerId}
              providers={providers}
              className="col-start-1 row-start-1"
            />
          ) : (
            <SelectMark
              thread={root}
              selection={selection}
              className="col-start-1 row-start-1"
            />
          )}

          <div className="col-start-2 row-start-1 flex min-w-0 items-center gap-1.5">
            {renaming ? (
              <TitleInput
                initial={threadTitle(root)}
                onCommit={(value) => callbacks.onRename(root.id, value)}
                onCancel={onCancelRename}
              />
            ) : (
              <span
                title={threadTitle(root)}
                className={cn(
                  // `text-xs`, the same step as the project name above it: a
                  // thread must not be set larger than the project it lives in.
                  // The hierarchy is carried by weight, colour and indent, not
                  // by a fourth type size.
                  "min-w-0 truncate text-xs",
                  root.isUnread ? "font-semibold" : "font-medium",
                  receded && "font-normal text-muted-foreground",
                )}
              >
                {threadTitle(root)}
              </span>
            )}
            {children.length > 0 ? (
              <RowCount
                count={children.length}
                open={childrenOpen}
                onToggle={{
                  onClick: () => callbacks.onToggleChildren(root.id),
                  label: `${childrenOpen ? "Hide" : "Show"} ${children.length} agents`,
                  title: `${children.length} agents — ${childrenOpen ? "hide" : "show"}`,
                }}
              />
            ) : null}
            {root.isPinned && pinnedIn === undefined ? <PinGlyph className="text-muted-foreground/70" /> : null}
          </div>

          <RowTail
            age={root.updatedAt}
            now={now}
            state={rolled}
            className="col-start-3 row-start-1 justify-self-end"
          />

          {compact ? null : (
            <div className="col-start-2 row-start-2 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground/80">
              {pinnedIn === undefined ? (
                <Location thread={root} />
              ) : (
                <span className="flex min-w-0 items-center gap-1" title={`Project: ${pinnedIn.name}`}>
                  <span
                    aria-hidden
                    className="inline-block size-2 shrink-0 rounded-sm"
                    style={{ backgroundColor: pinnedIn.color }}
                  />
                  <span className="truncate">{pinnedIn.name}</span>
                </span>
              )}
            </div>
          )}
        </div>
      </RowMenu>

      {childrenOpen && children.length > 0 ? (
        <div className="pl-[18px]">
          {children.map((child) => (
            <ChildRow
              key={child.id}
              thread={child}
              providers={providers}
              sections={sections}
              isActive={child.id === activeThreadId}
              compact={compact}
              now={now}
              selection={selection}
              callbacks={callbacks}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ChildRow({
  thread,
  providers,
  sections,
  isActive,
  compact,
  now,
  selection,
  callbacks,
}: {
  thread: PluginSidebarThread;
  providers: ProviderMap;
  sections: readonly { id: string; name: string }[];
  isActive: boolean;
  compact: boolean;
  now: number;
  selection: SelectionProps | null;
  callbacks: CardCallbacks;
}) {
  const { splitProps } = useSidebarThreadSplit(thread.id);
  const state: ThreadState = threadState(thread);
  return (
    <RowMenu
      thread={thread}
      sections={sections}
      onRename={() => callbacks.onRename(thread.id, threadTitle(thread))}
      onSetSection={(sectionId) => callbacks.onSetSection(thread.id, sectionId)}
      onCreateSection={() => callbacks.onCreateSection(thread.id)}
    >
      <div
        onClick={(event) => {
          if (selection !== null) {
            selection.onToggle(thread.id, !selection.selected.has(thread.id));
            return;
          }
          callbacks.onOpen(thread.id, event.metaKey || event.ctrlKey);
        }}
        {...(selection === null ? splitProps : {})}
        className={cn(
          "flex cursor-pointer gap-2 rounded-md px-2",
          compact ? "min-h-7 items-center py-0.5" : "min-h-9 items-start py-1",
          isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
          selection?.selected.has(thread.id) && "bg-sidebar-accent",
        )}
      >
        {selection === null ? (
          <ProviderGlyph
            providerId={thread.providerId}
            providers={providers}
            className={compact ? undefined : "mt-0.5"}
          />
        ) : (
          <SelectMark thread={thread} selection={selection} className={compact ? undefined : "mt-0.5"} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              title={threadTitle(thread)}
              className={cn(
                "min-w-0 flex-1 truncate text-xs",
                thread.isUnread ? "font-semibold text-foreground" : "text-muted-foreground",
              )}
            >
              {threadTitle(thread)}
            </span>
          </div>
          {compact ? null : (
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground/70">
              <Location thread={thread} />
            </div>
          )}
        </div>
        <RowTail age={thread.updatedAt} now={now} state={state} />
      </div>
    </RowMenu>
  );
}

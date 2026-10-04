// A card's context menu — the same entries bb's own list has, plus rename and
// section.
//
// Deleting a single thread goes through the host dialog (`requestDelete`): it
// counts the child threads first, and one thread is exactly the case the host
// handles well.
//
// Do not read that as "the children are handled". Measured against bb 0.43.1 on
// 15.09.2026: the host deletes the addressed thread ONLY. Its children survive
// with `parent_thread_id` set to NULL and surface as roots of their own, here
// through `visibleRootOf`. The same happens on a direct
// `DELETE /api/v1/threads/:id` with `childThreadsConfirmed: true`, so the flag
// is a confirmation receipt, not a cascade — and the SDK's own claim that
// deletion "is destructive and recursive" does not hold.
//
// That is what selection mode is for (see lib/deletion.ts and the
// `threads_delete` RPC): whoever wants a whole family gone selects it and gets
// a delete that addresses every member itself. aside owns destructive deletion
// there, which is why that path asks twice and names the count.
import { useState, type ReactNode } from "react";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
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

export function RowMenu({
  thread,
  sections,
  onRename,
  onSetSection,
  onCreateSection,
  onNewSubThread,
  children,
}: {
  thread: PluginSidebarThread;
  sections: readonly { id: string; name: string }[];
  onRename: () => void;
  onSetSection: (sectionId: string | null) => void;
  onCreateSection: () => void;
  /** New thread, one level under this one — created and opened right away. */
  onNewSubThread: () => void;
  children: ReactNode;
}) {
  const actions = useSidebarThreadActions();
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <ContextMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent
        className="w-56"
        // Only a click outside or Escape closes this menu. Focus wandering off
        // — to the host, or back to the row under the pointer — used to close
        // it the moment it had opened, so a right click often only flashed.
        onFocusOutside={(event) => event.preventDefault()}
      >
        <ContextMenuItem onSelect={() => actions.open(thread.id, { split: true })}>
          Open in split view
          <ContextMenuShortcut>⌘Click</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={onNewSubThread}>New sub-thread</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onRename}>Rename</ContextMenuItem>
        <ContextMenuItem
          onSelect={() => void actions.setPinned(thread.id, !thread.isPinned)}
        >
          {thread.isPinned ? "Unpin" : "Pin"}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => void actions.setRead(thread.id, thread.isUnread)}
        >
          {thread.isUnread ? "Mark as read" : "Mark as unread"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>Section</ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-52">
            <ContextMenuItem onSelect={() => onSetSection(null)}>
              — none —
              {thread.sectionId === null ? (
                <ContextMenuShortcut>✓</ContextMenuShortcut>
              ) : null}
            </ContextMenuItem>
            {sections.length > 0 ? <ContextMenuSeparator /> : null}
            {sections.map((section) => (
              <ContextMenuItem key={section.id} onSelect={() => onSetSection(section.id)}>
                {section.name}
                {thread.sectionId === section.id ? (
                  <ContextMenuShortcut>✓</ContextMenuShortcut>
                ) : null}
              </ContextMenuItem>
            ))}
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onCreateSection}>New section …</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.archive(thread.id)}>
          Archive
        </ContextMenuItem>
        <ContextMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => actions.requestDelete(thread.id)}
        >
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { COLUMNS, relativeTime, type Column } from "@/lib/board";
import { actionsOf, type Purpose } from "@/lib/purpose";
import { ActionList, actionIndexFor } from "./action-list";
import type { CardThread } from "./board";

export interface ThreadDetailProps {
  thread: CardThread;
  column: Column;
  project: string | null;
  purpose: Purpose | undefined;
  evaluating: boolean;
  markedDone: boolean;
  now: number;
  onClose: () => void;
  onOpen: () => void;
  onRefresh: () => void;
  onSetDone: (done: boolean) => void;
  onArchive: () => void;
  onSend: (text: string) => void;
}

/** Single-key shortcuts, shown on the buttons they trigger. */
export const SHORTCUTS = { open: "Enter", done: "d", refresh: "r", archive: "a" } as const;


function Kbd({ children }: { children: string }) {
  return (
    <kbd className="ml-1.5 rounded border border-border px-1 font-mono text-[10px] text-muted-foreground">
      {children === "Enter" ? "↵" : children.toUpperCase()}
    </kbd>
  );
}

/**
 * What the thread is about, the open step, and the moves that settle it — each
 * on one key, so a stack of waiting threads can be worked through without the
 * mouse.
 */
export function ThreadDetail(props: ThreadDetailProps) {
  const { thread, purpose, column } = props;
  const [confirmArchive, setConfirmArchive] = useState(false);
  const actions = actionsOf(purpose);
  const canArchive = column === "done";

  const pick = (index: number) => {
    const action = actions[index];
    if (action === undefined) return;
    props.onSend(action.reply);
    props.onClose();
  };
  const act = {
    open: () => {
      props.onOpen();
      props.onClose();
    },
    done: () => props.onSetDone(!props.markedDone),
    refresh: () => props.onRefresh(),
    archive: () => {
      if (!canArchive) return;
      if (!confirmArchive) return setConfirmArchive(true);
      props.onArchive();
      props.onClose();
    },
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, [contenteditable='true']")) return;
      const key = event.key === "Enter" ? "Enter" : event.key.toLowerCase();
      const actionIndex = actionIndexFor(event, actions.length);
      if (actionIndex !== -1) {
        event.preventDefault();
        pick(actionIndex);
        return;
      }
      const entry = (Object.entries(SHORTCUTS) as [keyof typeof SHORTCUTS, string][]).find(([, k]) => k === key);
      if (entry === undefined) return;
      event.preventDefault();
      act[entry[0]]();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const columnTitle = COLUMNS.find((c) => c.id === column)?.title ?? column;

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="max-w-lg">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {columnTitle}
          {props.project ? ` · ${props.project}` : ""}
        </div>
        <DialogTitle className="text-lg font-semibold leading-snug">{purpose?.headline ?? thread.displayTitle}</DialogTitle>
        {purpose?.headline && <div className="-mt-1 truncate text-xs text-muted-foreground">{thread.displayTitle}</div>}

        <DialogDescription asChild>
          <div className="text-sm leading-relaxed text-foreground">
            {purpose ? purpose.purpose : props.evaluating ? "The evaluation is running." : "Not evaluated yet — press R to evaluate."}
          </div>
        </DialogDescription>

        {purpose?.nextStep && (
          <div className="rounded-md border-l-2 bg-muted/40 px-3 py-2 text-sm" style={{ borderColor: "var(--warning)" }}>
            <div className="mb-0.5 text-[11px] uppercase tracking-wider text-muted-foreground">
              {column === "waiting" ? "Waiting for you" : column === "stale" ? "Next action" : "Open step"}
            </div>
            {purpose.nextStep}
          </div>
        )}

        <ActionList actions={actions} title={column === "stale" ? "Pick it up with" : "Next actions"} onPick={pick} />

        {purpose && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <div className="h-1 flex-1 overflow-hidden rounded bg-muted">
              <div className="h-full" style={{ width: `${purpose.progress}%`, background: "var(--brand)" }} />
            </div>
            {purpose.progress}% · evaluated {relativeTime(purpose.evaluatedAt, props.now)}
          </div>
        )}

        <div className="mt-1 flex flex-wrap gap-2">
          <Button size="sm" onClick={act.open}>
            Open thread<Kbd>{SHORTCUTS.open}</Kbd>
          </Button>
          <Button size="sm" variant="outline" onClick={act.done}>
            {props.markedDone ? "Reopen" : "Mark done"}<Kbd>{SHORTCUTS.done}</Kbd>
          </Button>
          <Button size="sm" variant="ghost" onClick={act.refresh} disabled={props.evaluating}>
            {props.evaluating ? "Evaluating…" : "Refresh"}<Kbd>{SHORTCUTS.refresh}</Kbd>
          </Button>
          {canArchive && (
            <Button size="sm" variant={confirmArchive ? "destructive" : "ghost"} onClick={act.archive}>
              {confirmArchive ? "Archive — sure?" : "Archive"}<Kbd>{SHORTCUTS.archive}</Kbd>
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

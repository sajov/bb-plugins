import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { relativeTime } from "@/lib/board";
import { actionsOf, type Purpose } from "@/lib/purpose";
import { ActionList, actionIndexFor } from "./action-list";
import { usePortalScopeProps } from "@/lib/portal-scope";

export interface PurposeBarProps {
  purpose: Purpose | undefined;
  evaluating: boolean;
  compact: boolean;
  now: number;
  onRefresh: () => void;
  onSend: (text: string) => void;
}

const STATE_LABEL: Record<Purpose["state"], string> = {
  working: "in progress",
  waiting: "waiting for you",
  done: "done",
};
const STATE_TONE: Record<Purpose["state"], string> = {
  working: "var(--brand)",
  waiting: "var(--warning)",
  done: "var(--success)",
};

function Ring({ progress, tone }: { progress: number; tone: string }) {
  const circumference = 2 * Math.PI * 15;
  return (
    <svg viewBox="0 0 36 36" className="size-4 shrink-0" aria-hidden>
      <circle cx="18" cy="18" r="15" fill="none" stroke="var(--muted)" strokeWidth="5" />
      <circle
        cx="18"
        cy="18"
        r="15"
        fill="none"
        stroke={tone}
        strokeWidth="5"
        strokeDasharray={`${(progress / 100) * circumference} ${circumference}`}
        transform="rotate(-90 18 18)"
      />
    </svg>
  );
}

/**
 * Variant B: one line in the thread header — ring, purpose, state — that
 * opens the details. The header row is 28px tall, so the details live in a
 * portalled popover rather than growing the row.
 */
export function PurposeBar({ purpose, evaluating, compact, now, onRefresh, onSend }: PurposeBarProps) {
  const [open, setOpen] = useState(false);
  // Without these attributes the portalled panel sits outside the plugin's
  // CSS scope and none of its classes apply.
  const scopeProps = usePortalScopeProps();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const actions = actionsOf(purpose);
  const pick = (index: number) => {
    const action = actions[index];
    if (action === undefined) return;
    onSend(action.reply);
    setOpen(false);
  };
  // Number keys pick an action only while the panel is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      const index = actionIndexFor(event, actions.length);
      if (index === -1) return;
      event.preventDefault();
      pick(index);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !panel.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const tone = purpose ? STATE_TONE[purpose.state] : "var(--muted-foreground)";
  const label = purpose ? (purpose.headline ?? purpose.purpose) : evaluating ? "Evaluating purpose…" : "No purpose yet";
  const rect = open ? button.current?.getBoundingClientRect() : undefined;

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-label={`Purpose: ${label}`}
        onClick={() => setOpen((value) => !value)}
        title={purpose ? `${STATE_LABEL[purpose.state]} · ${purpose.progress}%` : undefined}
        className="flex h-7 min-w-0 max-w-[240px] items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Ring progress={purpose?.progress ?? 0} tone={tone} />
        {!compact && <span className="min-w-0 truncate">{purpose?.headline ?? (purpose ? `${purpose.progress}%` : label)}</span>}
      </button>
      {open &&
        rect &&
        createPortal(
          <div
            {...scopeProps}
            ref={panel}
            role="dialog"
            aria-label="Thread purpose"
            className="fixed z-50 rounded-lg border border-border bg-popover p-4 text-sm text-popover-foreground shadow-lg"
            style={{
              top: rect.bottom + 6,
              width: Math.min(360, window.innerWidth - 16),
              left: Math.max(8, Math.min(rect.left, window.innerWidth - 368)),
            }}
          >
            <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wider text-muted-foreground">
              <span>
                Purpose
                {purpose && <span style={{ color: tone }}> · {STATE_LABEL[purpose.state]}</span>}
              </span>
              <button type="button" className="normal-case tracking-normal hover:text-foreground" disabled={evaluating} onClick={onRefresh}>
                {evaluating ? "Evaluating…" : "↻ Refresh"}
              </button>
            </div>
            {purpose ? (
              <>
                {purpose.headline && <p className="mb-1 font-semibold">{purpose.headline}</p>}
                <p className="mb-3 leading-snug">{purpose.purpose}</p>
                <div className="flex items-center gap-2">
                  <div className="h-1 flex-1 overflow-hidden rounded bg-muted">
                    <div className="h-full" style={{ width: `${purpose.progress}%`, background: tone }} />
                  </div>
                  <span className="text-xs text-muted-foreground">{purpose.progress}%</span>
                </div>
                {purpose.nextStep && (
                  <div className="mt-3 border-l-2 pl-2 text-xs" style={{ borderColor: "var(--warning)" }}>
                    <b>Next step:</b> {purpose.nextStep}
                  </div>
                )}
                <div className="mt-3">
                  <ActionList actions={actions} title="Next actions" onPick={pick} />
                </div>
                <div className="mt-3 text-[11px] text-muted-foreground">
                  updated {relativeTime(purpose.evaluatedAt, now)} · {purpose.model}
                </div>
              </>
            ) : (
              <p className="text-muted-foreground">
                {evaluating ? "The evaluation is running." : "This thread has not been evaluated yet. Refresh to evaluate it now."}
              </p>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

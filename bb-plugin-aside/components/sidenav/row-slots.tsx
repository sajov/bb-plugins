// The two slots every row shares: the count at the end of the title, age and
// mark at the right edge.
//
// One component per slot rather than four hand-built flex rows, because that is
// exactly how these drifted apart before: projects carried no age at all, on a
// card the age sat one line above the count instead of beside it, and in
// single-line mode the two even shared a grid cell and drew on top of each
// other.
//
// Why the count left the right edge: that edge was carrying three things at
// once. A count belongs to the row's identity — how much is in here — while age
// and state are its *current* condition, and those two stay together.
//
// Why it sits after the title rather than before it: in front, every title with
// a count started further right than the titles without one, so the column of
// titles jumped from row to row. Attached to the end of the text it counts for,
// it travels with that text and leaves the left edge alone.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { relativeAge } from "@/lib/time";
import { countBadgeClass, COUNT_BADGE_SHAPE } from "@/lib/badge";
import { StateMark } from "@/components/sidenav/marks";
import type { ThreadState } from "@/lib/tree";

/**
 * The count, at the end of the title it counts for.
 *
 * Deliberately no reserved width when there is nothing to count: the badge
 * hangs off the text, so a row without one simply ends earlier. Nothing lines
 * up against it, which is exactly why it may come and go.
 */
export function RowCount({
  count,
  open,
  onToggle,
  className,
}: {
  count: number;
  /** A filled badge means the counted rows are expanded. */
  open: boolean;
  /**
   * Set where the count itself is the toggle (a card's agents). Left unset
   * where the whole row already toggles — a button inside a button is neither
   * clickable nor announced correctly.
   */
  onToggle?: { onClick: () => void; label: string; title: string };
  className?: string;
}): ReactNode {
  if (onToggle === undefined) {
    return (
      <span className={cn("shrink-0", COUNT_BADGE_SHAPE, countBadgeClass(open), className)}>
        {count}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={onToggle.label}
      title={onToggle.title}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle.onClick();
      }}
      className={cn(
        "shrink-0",
        COUNT_BADGE_SHAPE,
        "hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        countBadgeClass(open),
        className,
      )}
    >
      {count}
    </button>
  );
}

/**
 * Age and state mark, at the row's right edge.
 *
 * Here the slot DOES keep its width when the age is missing: this side has no
 * anchor, so an empty age would pull the mark out of its column and the right
 * edge would stop being one.
 *
 * The mark itself is never missing. Every row has a state — a project and a
 * section roll theirs up from the threads inside — and drawing nothing for
 * `quiet` used to make that state look unknown rather than calm. It also left
 * the mark present on some rows and absent on others, which read as a
 * distinction where there was none.
 */
export function RowTail({
  age,
  now,
  state,
  stateTitle,
  className,
}: {
  /** Newest activity in this row's subtree; `null` when there is none to date. */
  age: number | null;
  now: number;
  state: ThreadState;
  stateTitle?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex shrink-0 items-center gap-1.5", className)}>
      <span className="min-w-7 text-right text-2xs tabular-nums text-muted-foreground/70">
        {age === null ? null : relativeAge(age, now)}
      </span>
      <span title={stateTitle} className="grid size-3 shrink-0 place-items-center">
        <StateMark state={state} className="size-3" />
      </span>
    </div>
  );
}

/**
 * The header's count: all families, and — while anything runs — how many of
 * them are processing, as "5/29" behind the same spinner the cards use.
 *
 * The same badge as every other count rather than a second one beside it, so
 * the header still reads as one number. With nothing running it falls back to
 * the plain total; "0/29" would only be noise.
 *
 * The spinner turns blue while any thread waits for you — the colour the
 * "needs you" mark already carries — so a glance at the header tells you
 * whether the busy work is also blocked on you.
 */
export function WorkingCount({
  working,
  waiting,
  total,
}: {
  working: number;
  waiting: number;
  total: number;
}): ReactNode {
  if (working === 0 && waiting === 0) return <RowCount count={total} open />;
  const label = [
    `${working} of ${total} threads processing`,
    waiting > 0 ? `${waiting} waiting for you` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={cn("shrink-0 grid-flow-col gap-1", COUNT_BADGE_SHAPE, countBadgeClass(true))}
    >
      <svg viewBox="0 0 14 14" fill="none" className="size-2.5" aria-hidden>
        <circle
          cx="7"
          cy="7"
          r="4.6"
          className={cn(
            "origin-center animate-spin motion-reduce:animate-none",
            waiting > 0 ? "text-[color:var(--primary,#006fee)]" : "text-muted-foreground",
          )}
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeDasharray="7.2 4.4"
          style={{ animationDuration: "1.6s" }}
        />
      </svg>
      {working > 0 ? (
        <span>
          <span className="text-foreground">{working}</span>/{total}
        </span>
      ) : (
        <span>{total}</span>
      )}
    </span>
  );
}

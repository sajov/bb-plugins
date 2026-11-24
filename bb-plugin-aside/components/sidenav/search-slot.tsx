// The search flyout — the magnifier in the header opens it.
//
// It drops in from the top and covers the whole column, header included: while
// you are asking "where is it", the list below is in the way, not a help. One
// field on top, one list under it — tags first, then projects, told apart by
// their icon rather than by two boxes that each scroll on their own. A click
// toggles a row; there is no checkbox, a picked row is lit and carries a ✓.
//
// Picking a row empties the field: what was typed was the way to that row, and
// standing there it would go on narrowing the list — hiding the pick itself.
// What is typed stays when the flyout closes through the text row: there it is
// a filter like the picked rows, and the scope bar names it with its own ✕.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  MAX_QUERY_LENGTH,
  flyoutEntries,
  normalizeQuery,
  queryTerms,
  tagPrefix,
  type FlyoutEntry,
} from "@/lib/search";

/** The parts of `name` that a query term matched, bold. Case-insensitive. */
function highlight(name: string, query: string): ReactNode {
  const prefix = tagPrefix(query);
  const terms = (prefix !== null ? [prefix] : queryTerms(query)).filter((term) => term.length > 0);
  if (terms.length === 0) return name;
  const lower = name.toLocaleLowerCase();
  const marks = new Array<boolean>(name.length).fill(false);
  for (const term of terms) {
    let at = lower.indexOf(term);
    while (at >= 0) {
      for (let index = at; index < at + term.length; index += 1) marks[index] = true;
      at = lower.indexOf(term, at + term.length);
    }
  }
  const parts: ReactNode[] = [];
  let start = 0;
  for (let index = 1; index <= name.length; index += 1) {
    if (index === name.length || marks[index] !== marks[start]) {
      const text = name.slice(start, index);
      parts.push(
        marks[start] ? (
          <mark key={start} className="bg-transparent font-semibold text-foreground">
            {text}
          </mark>
        ) : (
          text
        ),
      );
      start = index;
    }
  }
  return parts;
}

function Row({
  icon,
  label,
  count,
  picked,
  highlighted,
  onPick,
  onHover,
}: {
  icon: ReactNode;
  label: ReactNode;
  count?: number;
  picked: boolean;
  highlighted: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={picked}
      onClick={onPick}
      onMouseMove={onHover}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs",
        picked ? "bg-sidebar-accent text-foreground" : "text-muted-foreground",
        highlighted && !picked && "bg-sidebar-accent/60 text-foreground",
        highlighted && picked && "ring-1 ring-inset ring-border",
      )}
    >
      <span className="grid w-4 shrink-0 place-items-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count === undefined ? null : (
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground/70">{count}</span>
      )}
      <span className="grid w-3 shrink-0 place-items-center">
        {picked ? <Icon name="Check" className="size-3" aria-hidden /> : null}
      </span>
    </button>
  );
}

export function SearchSlot({
  query,
  matchCount,
  focusTick,
  onQuery,
  onClose,
  tagCounts,
  activeTags,
  onToggleTag,
  knownProjects,
  activeProjects,
  onToggleProject,
  onClearAll,
}: {
  query: string;
  tagCounts: Readonly<Record<string, number>>;
  /** The tags the list is narrowed to. */
  activeTags: readonly string[];
  onToggleTag: (tag: string) => void;
  /** Every project, with how many threads it holds. */
  knownProjects: readonly { id: string; name: string; count: number }[];
  /** The projects picked directly, by id. */
  activeProjects: readonly string[];
  onToggleProject: (projectId: string) => void;
  /** How many projects the list shows now. */
  matchCount: number;
  /** Counts up every time the shortcut is pressed; the caret goes back in. */
  focusTick: number;
  onQuery: (query: string) => void;
  /** Escape, the magnifier, or Enter on the text row. */
  onClose: () => void;
  onClearAll: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, [focusTick]);

  const typed = normalizeQuery(query);
  const textRow = typed.length > 0 && tagPrefix(query) === null;
  const entries = useMemo(
    () => flyoutEntries({ query, projects: knownProjects, tagCounts, activeProjects, activeTags }),
    [query, knownProjects, tagCounts, activeProjects, activeTags],
  );
  // The text row counts as row 0 while there is one.
  const rowCount = entries.length + (textRow ? 1 : 0);
  useEffect(() => setCursor(0), [query]);

  const toggle = (entry: FlyoutEntry) => {
    if (entry.kind === "project") onToggleProject(entry.id);
    else onToggleTag(entry.id);
    // The query was only there to find this row; once it is picked it has done
    // its job. Left standing it keeps narrowing the list — and hides the very
    // entry just picked, along with every pick that does not match it.
    if (query.length > 0) onQuery("");
    field.current?.focus();
  };
  const pickAt = (index: number) => {
    if (textRow && index === 0) {
      onClose();
      return;
    }
    const entry = entries[index - (textRow ? 1 : 0)];
    if (entry !== undefined) toggle(entry);
  };

  const picked = [
    ...activeProjects
      .map((id) => knownProjects.find((project) => project.id === id))
      .filter((project) => project !== undefined)
      .map((project) => ({ kind: "project" as const, id: project.id, name: project.name })),
    ...activeTags.map((tag) => ({ kind: "tag" as const, id: tag, name: tag })),
  ];
  const firstProject = entries.findIndex((entry) => entry.kind === "project");

  return (
    <div
      role="dialog"
      aria-label="Search projects and tags"
      className="absolute inset-0 z-30 flex flex-col bg-sidebar animate-in fade-in slide-in-from-top-2 duration-150"
    >
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border-hairline px-3">
        <Icon name="Search" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          ref={field}
          type="text"
          value={query}
          maxLength={MAX_QUERY_LENGTH}
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded
          aria-label="Search projects and tags, # for tags only"
          placeholder="Search projects and tags…"
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (rowCount === 0) return;
              const step = event.key === "ArrowDown" ? 1 : -1;
              setCursor((current) => (current + step + rowCount) % rowCount);
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              if (rowCount === 0) onClose();
              else pickAt(cursor);
              return;
            }
            if (event.key === "Backspace" && query.length === 0) {
              const last = picked[picked.length - 1];
              if (last === undefined) return;
              event.preventDefault();
              if (last.kind === "project") onToggleProject(last.id);
              else onToggleTag(last.id);
              return;
            }
            if (event.key !== "Escape") return;
            event.preventDefault();
            onClose();
          }}
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
        />
        <kbd className="shrink-0 rounded border border-border-hairline px-1 text-2xs text-muted-foreground">
          esc
        </kbd>
      </div>

      {picked.length > 0 ? (
        <div className="flex shrink-0 flex-wrap gap-1.5 px-3 pt-2.5">
          {picked.map((entry) => (
            <button
              key={`${entry.kind}:${entry.id}`}
              type="button"
              title={`Remove ${entry.kind === "tag" ? `#${entry.name}` : entry.name}`}
              onClick={() =>
                entry.kind === "project" ? onToggleProject(entry.id) : onToggleTag(entry.id)
              }
              className="flex max-w-full items-center gap-1 rounded-full bg-foreground px-2 py-px text-2xs font-medium text-background hover:opacity-90"
            >
              {entry.kind === "project" ? (
                <Icon name="Folder" className="size-2.5 shrink-0" aria-hidden />
              ) : (
                <span aria-hidden>#</span>
              )}
              <span className="truncate">{entry.name}</span>
              <Icon name="X" className="size-2.5 shrink-0 opacity-50" aria-hidden />
            </button>
          ))}
        </div>
      ) : null}

      <div role="listbox" aria-multiselectable className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {textRow ? (
          <>
            <Row
              icon={<Icon name="Search" className="size-3" aria-hidden />}
              label={
                <>
                  Filter by “<span className="font-semibold text-foreground">{typed}</span>”
                </>
              }
              count={matchCount}
              picked={false}
              highlighted={cursor === 0}
              onPick={() => pickAt(0)}
              onHover={() => setCursor(0)}
            />
            {entries.length > 0 ? <div className="mx-2.5 my-1 h-px bg-border-hairline" /> : null}
          </>
        ) : null}
        {entries.map((entry, index) => {
          const row = index + (textRow ? 1 : 0);
          return (
            <div key={`${entry.kind}:${entry.id}`}>
              {index === firstProject && index > 0 ? (
                <div className="mx-2.5 my-1 h-px bg-border-hairline" />
              ) : null}
              <Row
                icon={
                  entry.kind === "project" ? (
                    <Icon name="Folder" className="size-3" aria-hidden />
                  ) : (
                    <span aria-hidden className="text-xs">#</span>
                  )
                }
                label={highlight(entry.name, query)}
                count={entry.count}
                picked={entry.picked}
                highlighted={cursor === row}
                onPick={() => pickAt(row)}
                onHover={() => setCursor(row)}
              />
            </div>
          );
        })}
        {rowCount === 0 ? (
          <div className="px-2.5 py-3 text-xs text-muted-foreground">
            {tagPrefix(query) !== null && Object.keys(tagCounts).length === 0
              ? "No tags yet — right-click a project to add one."
              : "Nothing matches."}
          </div>
        ) : null}
      </div>

      <div className="flex h-8 shrink-0 items-center justify-between border-t border-border-hairline px-3 text-2xs text-muted-foreground">
        {picked.length > 0 || textRow ? (
          <button type="button" onClick={onClearAll} className="hover:text-foreground">
            Clear all
          </button>
        ) : (
          <span>↑↓ select · ↵ toggle · esc close</span>
        )}
        <button
          type="button"
          onClick={onClose}
          className="font-medium text-foreground hover:opacity-80"
        >
          Show {matchCount} {matchCount === 1 ? "project" : "projects"}
        </button>
      </div>
    </div>
  );
}

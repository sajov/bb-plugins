// The search slot — one line between the menu bar and the list.
//
// It only appears once you ask for it. A field that is always there costs a row
// of the list forever to serve the rare moment you cannot find a project; this
// way the cost is paid exactly while you are searching, and the magnifier in the
// header stays pressed the whole time so it is never a mystery why rows are
// missing.
//
// Narrow on purpose: one line, no border box, no button. It sits where the list
// begins, so it reads as the list's own heading rather than as a form.
//
// Tags are picked here too, since the funnel is gone: the picked ones sit as
// chips in front of the caret, `#` narrows the offer below the field to tags,
// Enter takes the first one offered and Backspace in an empty field drops the
// last chip. One place to ask "what am I looking at", not two.
import { useEffect, useRef } from "react";
import { Icon } from "@/components/ui/icon";
import { RowCount } from "@/components/sidenav/row-slots";
import { MAX_QUERY_LENGTH, tagPrefix, tagSuggestions } from "@/lib/search";

function TagChip({
  tag,
  picked,
  count,
  onClick,
}: {
  tag: string;
  picked: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={picked ? `Stop filtering on #${tag}` : `Filter on #${tag}`}
      aria-pressed={picked}
      onClick={onClick}
      className={
        picked
          ? "flex shrink-0 items-center gap-1 rounded-full border border-border bg-sidebar-accent px-1.5 text-2xs text-foreground"
          : "flex shrink-0 items-center gap-1 rounded-full border border-border-hairline px-1.5 text-2xs text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
      }
    >
      #{tag}
      {picked ? (
        <Icon name="X" className="size-2.5 opacity-60" aria-hidden />
      ) : count === undefined ? null : (
        <RowCount count={count} open={false} />
      )}
    </button>
  );
}

function ProjectChip({
  name,
  picked,
  onClick,
}: {
  name: string;
  picked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={picked ? `Stop filtering on ${name}` : `Filter on ${name}`}
      aria-pressed={picked}
      onClick={onClick}
      className={
        picked
          ? "flex shrink-0 items-center gap-1 rounded-full border border-border bg-sidebar-accent px-1.5 text-2xs text-foreground"
          : "flex shrink-0 items-center gap-1 rounded-full border border-border-hairline px-1.5 text-2xs text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
      }
    >
      <Icon name="Folder" className="size-2.5 shrink-0 opacity-60" aria-hidden />
      <span className="truncate">{name}</span>
      {picked ? <Icon name="X" className="size-2.5 shrink-0 opacity-60" aria-hidden /> : null}
    </button>
  );
}

export function SearchSlot({
  query,
  matchCount,
  focusTick,
  onQuery,
  onClose,
  knownTags,
  tagCounts,
  activeTags,
  onToggleTag,
  knownProjects,
  activeProjects,
  onToggleProject,
}: {
  query: string;
  /** Every tag in use, alphabetical. */
  knownTags: readonly string[];
  tagCounts: Readonly<Record<string, number>>;
  /** The tags the list is narrowed to. */
  activeTags: readonly string[];
  onToggleTag: (tag: string) => void;
  /** Every project, offered below the tags as its own filter entries. */
  knownProjects: readonly { id: string; name: string }[];
  /** The projects picked directly, by id. */
  activeProjects: readonly string[];
  onToggleProject: (projectId: string) => void;
  /**
   * How many projects the query leaves. Shown only while something is typed —
   * a zero is the one answer the list itself cannot give, because an empty list
   * looks the same as a broken one.
   */
  matchCount: number;
  /**
   * Counts up every time the shortcut is pressed. The caret goes back into the
   * field then — pressing ⌥F on an open slot has to do something, or the
   * shortcut is dead exactly when you reach for it twice.
   */
  focusTick: number;
  onQuery: (query: string) => void;
  /** Escape, or the ✕ — leaves the search and shows every project again. */
  onClose: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);

  // Opened to be typed in: anything else would make the magnifier a two-click
  // control for a one-word question.
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, [focusTick]);

  const typed = query.trim().length > 0;
  const prefix = tagPrefix(query);
  const offered = tagSuggestions(knownTags, activeTags, prefix);
  return (
    <div className="shrink-0 border-b border-border-hairline">
    <div className="flex min-h-7 flex-wrap items-center gap-1.5 px-3 py-1">
      <Icon name="Search" className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      {activeTags.map((tag) => (
        <TagChip key={tag} tag={tag} picked onClick={() => onToggleTag(tag)} />
      ))}
      {activeProjects.map((projectId) => {
        const project = knownProjects.find((entry) => entry.id === projectId);
        if (project === undefined) return null;
        return (
          <ProjectChip
            key={projectId}
            name={project.name}
            picked
            onClick={() => onToggleProject(projectId)}
          />
        );
      })}
      <input
        ref={field}
        type="text"
        value={query}
        maxLength={MAX_QUERY_LENGTH}
        autoComplete="off"
        spellCheck={false}
        aria-label="Filter projects by name, # for tags"
        placeholder={
          activeTags.length > 0 || activeProjects.length > 0 ? "" : "Filter projects… # for tags"
        }
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && prefix !== null) {
            event.preventDefault();
            const first = offered[0];
            if (first !== undefined) {
              onToggleTag(first);
              onQuery("");
            }
            return;
          }
          if (event.key === "Backspace" && query.length === 0 && activeTags.length > 0) {
            event.preventDefault();
            onToggleTag(activeTags[activeTags.length - 1]);
            return;
          }
          if (event.key !== "Escape") return;
          event.preventDefault();
          // Escape clears first and closes second: while a query is standing,
          // the thing you most likely want back is the full list, not the row.
          if (typed) onQuery("");
          else onClose();
        }}
        className="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
      />
      {typed && prefix === null ? (
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground/70">
          {matchCount}
        </span>
      ) : null}
      <button
        type="button"
        aria-label="Close search"
        title="Close search · Esc"
        onClick={onClose}
        className="grid size-4 shrink-0 place-items-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon name="X" className="size-3" aria-hidden />
      </button>
    </div>
    {offered.length > 0 ? (
      <div className="flex max-h-12 flex-wrap gap-1 overflow-y-auto px-3 pb-1.5">
        {offered.map((tag) => (
          <TagChip
            key={tag}
            tag={tag}
            picked={false}
            count={tagCounts[tag] ?? 0}
            onClick={() => {
              onToggleTag(tag);
              if (prefix !== null) onQuery("");
            }}
          />
        ))}
      </div>
    ) : knownTags.length === 0 && prefix !== null ? (
      // Not an empty offer: a `#` that shows nothing reads as broken.
      <div className="px-3 pb-1.5 text-2xs text-muted-foreground">
        No tags yet — right-click a project to add one.
      </div>
    ) : null}
    {/* Projects, as their own filter entries below the tags. Hidden while
        browsing tags with `#` so the two offers never mix in one list. */}
    {prefix === null && knownProjects.length > activeProjects.length ? (
      <div className="px-3 pb-1.5">
        <div className="pb-1 text-2xs font-medium text-muted-foreground/70">Projects</div>
        <div className="flex max-h-12 flex-wrap gap-1 overflow-y-auto">
          {knownProjects
            .filter((project) => !activeProjects.includes(project.id))
            .map((project) => (
              <ProjectChip
                key={project.id}
                name={project.name}
                picked={false}
                onClick={() => onToggleProject(project.id)}
              />
            ))}
        </div>
      </div>
    ) : null}
    </div>
  );
}

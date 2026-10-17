// Generic searchable popover multi-select (BBP-205), extracted out of
// ProjectFilter so BBP-204's "Focus" dropdown can reuse it. Owns popover
// placement, outside click, search and stopping key events from reaching
// the canvas's own shortcuts.
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { placePopover, visibleBounds } from "../lib/popover";

export type SearchableMultiSelectOption = {
  id: string;
  name: string;
  // BBP-239: optional clustering (e.g. "Crews"/"Threads") and extra search
  // terms (e.g. a thread id) for dropdowns beyond the plain Projects list.
  group?: string;
  keywords?: readonly string[];
};

// Clusters a list in first-occurrence order of `group` (no alphabetical
// resort of the groups themselves); options without a group form their own
// headerless bucket wherever they first appear.
function clusterByGroup(
  list: readonly SearchableMultiSelectOption[],
): { group?: string; items: SearchableMultiSelectOption[] }[] {
  const order: string[] = [];
  const buckets = new Map<string, SearchableMultiSelectOption[]>();
  for (const option of list) {
    const key = option.group ?? "";
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(option);
  }
  return order.map((key) => ({ group: key === "" ? undefined : key, items: buckets.get(key)! }));
}

export type SearchableMultiSelectProps = {
  label: string;
  options: readonly SearchableMultiSelectOption[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  emptyText: string;
  /** Overrides the default `${label}: ${summarizeSelection(...)}` button
   *  text (BBP-240) — the Focus dropdown's "All"/"Focus (n)" scheme doesn't
   *  fit that formula the way Projects' "All"/"<Name>"/"n selected" does. */
  summarize?: (options: readonly SearchableMultiSelectOption[], selected: readonly string[]) => string;
};

const POPOVER_WIDTH = 240;

export function summarizeSelection(
  options: readonly SearchableMultiSelectOption[],
  selected: readonly string[],
): string {
  const chosen = options.filter((option) => selected.includes(option.id));
  if (chosen.length === 0) return "All";
  if (chosen.length === 1) return chosen[0]!.name;
  return `${chosen.length} selected`;
}

function highlight(name: string, query: string) {
  if (!query) return name;
  const index = name.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return name;
  return (
    <>
      {name.slice(0, index)}
      <mark>{name.slice(index, index + query.length)}</mark>
      {name.slice(index + query.length)}
    </>
  );
}

export function SearchableMultiSelect({
  label,
  options,
  selected,
  onChange,
  emptyText,
  summarize,
}: SearchableMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [frozenOrder, setFrozenOrder] = useState<readonly SearchableMultiSelectOption[]>(options);
  const [frozenCheckedIds, setFrozenCheckedIds] = useState<ReadonlySet<string>>(new Set());
  const root = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [place, setPlace] = useState<{ offset: number; width: number } | null>(null);
  // The row under the pointer and the row holding keyboard focus get the same
  // full-width tint, so the active row reads clearly, not just the checkbox ring.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // Measured on open: the canvas may sit in a slim panel, and the button's
  // spot in a wrapped toolbar is only known once laid out.
  useLayoutEffect(() => {
    if (!open || !root.current) return;
    const anchor = root.current.getBoundingClientRect();
    setPlace(placePopover(anchor, visibleBounds(root.current), POPOVER_WIDTH));
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    // Order and the checked/unchecked split are frozen the moment the popover
    // opens, so entries don't jump across the divider as the user checks them.
    setFrozenOrder(options);
    setFrozenCheckedIds(new Set(selected));
    searchRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((other) => other !== id) : [...selected, id]);

  const normalizedQuery = query.trim().toLowerCase();
  const matches = (option: SearchableMultiSelectOption) =>
    option.name.toLowerCase().includes(normalizedQuery) ||
    (option.keywords ?? []).some((keyword) => keyword.toLowerCase().includes(normalizedQuery));

  const checkedBlock = frozenOrder
    .filter((option) => frozenCheckedIds.has(option.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Checked entries that still match the query stay pinned above the divider
  // as before; checked entries the query no longer matches move to their own
  // "Selected" block so they aren't mistaken for actual search matches.
  const checkedMatching = normalizedQuery === "" ? checkedBlock : checkedBlock.filter(matches);
  // Entries checked after the popover opened aren't in the frozen checked
  // block (that split stays frozen so match rows don't jump), but a
  // non-matching one must still surface in Selected right away (BBP-218)
  // instead of disappearing from the list until the next open.
  const checkedNotMatching = normalizedQuery === ""
    ? []
    : [
        ...checkedBlock.filter((option) => !matches(option)),
        ...frozenOrder.filter(
          (option) => !frozenCheckedIds.has(option.id) && selected.includes(option.id) && !matches(option),
        ),
      ].sort((a, b) => a.name.localeCompare(b.name));
  const remaining = frozenOrder.filter(
    (option) => !frozenCheckedIds.has(option.id) && (normalizedQuery === "" || matches(option)),
  );
  const matchingIds = frozenOrder.filter(matches).map((option) => option.id);
  const noMatches = normalizedQuery !== "" && checkedMatching.length === 0 && remaining.length === 0;
  const visibleOptions = [...checkedMatching, ...remaining, ...checkedNotMatching];
  itemRefs.current = [];

  const renderOption = (option: SearchableMultiSelectOption) => (
    <label
      key={option.id}
      // A mouse press must not move focus onto the row (BBP-227): focus goes
      // back to the search field so further typing lands there. Keyboard
      // toggles never fire mousedown, so arrow navigation keeps its row.
      onMouseDown={(event) => {
        event.preventDefault();
        searchRef.current?.focus();
      }}
      onMouseEnter={() => setHoveredId(option.id)}
      onMouseLeave={() => setHoveredId((id) => (id === option.id ? null : id))}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 8px",
        borderRadius: 4,
        background: hoveredId === option.id || focusedId === option.id ? "var(--accent, rgba(127, 127, 127, 0.15))" : "transparent",
        cursor: "pointer",
      }}
    >
      <input
        ref={(el) => {
          itemRefs.current[visibleOptions.indexOf(option)] = el;
        }}
        type="checkbox"
        aria-label={option.name}
        checked={selected.includes(option.id)}
        onChange={() => toggle(option.id)}
        onFocus={() => setFocusedId(option.id)}
        onBlur={() => setFocusedId((id) => (id === option.id ? null : id))}
      />
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{highlight(option.name, query)}</span>
    </label>
  );

  const renderGroupedOptions = (list: readonly SearchableMultiSelectOption[]) =>
    clusterByGroup(list).map((cluster, index) => (
      <Fragment key={cluster.group ?? `_ungrouped_${index}`}>
        {cluster.group ? (
          <div role="presentation" style={{ padding: "4px 8px", fontSize: 11, fontWeight: 600, color: "var(--muted-foreground)" }}>
            {cluster.group}
          </div>
        ) : null}
        {cluster.items.map(renderOption)}
      </Fragment>
    ));

  const moveActive = (delta: number) => {
    const current = itemRefs.current.findIndex((el) => el === document.activeElement);
    const next = current === -1 ? (delta > 0 ? 0 : itemRefs.current.length - 1) : current + delta;
    const clamped = Math.max(0, Math.min(itemRefs.current.length - 1, next));
    itemRefs.current[clamped]?.focus();
  };

  return (
    <div
      ref={root}
      style={{ position: "relative" }}
      // Keys typed in the list must not reach the canvas's own shortcuts.
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          if (query !== "") setQuery("");
          else setOpen(false);
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          moveActive(event.key === "ArrowDown" ? 1 : -1);
        } else if (
          event.key.length === 1 &&
          event.key !== " " &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          itemRefs.current.includes(document.activeElement as HTMLInputElement)
        ) {
          // Typing on a row continues the search (BBP-227).
          event.preventDefault();
          setQuery((value) => value + event.key);
          searchRef.current?.focus();
        } else if (event.key === " " || event.key === "Enter") {
          const active = document.activeElement;
          if (active instanceof HTMLInputElement && active.type === "checkbox") {
            event.preventDefault();
            active.click();
          } else if (event.key === "Enter" && active === searchRef.current) {
            // Enter in the search field checks the highlighted row if arrow
            // navigation already moved focus there; otherwise it checks the
            // first visible match.
            event.preventDefault();
            itemRefs.current[0]?.click();
          }
        }
        event.stopPropagation();
      }}
    >
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={`Choose which ${label.toLowerCase()} the canvas shows`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "2px 8px",
          border: "1px solid var(--border)",
          borderRadius: 6,
          background: "var(--card)",
          color: "var(--foreground)",
          fontSize: 11,
          cursor: "pointer",
        }}
      >
        <svg
          aria-hidden
          width={12}
          height={12}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 4h12l-4.5 5v4l-3-1.5V9z" />
        </svg>
        {summarize ? summarize(options, selected) : `${label}: ${summarizeSelection(options, selected)}`}
      </button>
      {open ? (
        <div
          role="group"
          aria-label={label}
          // Scrolling a long option list must not pan the canvas underneath
          // the popover (BBP-199) — React Flow skips its own wheel handling
          // for this class.
          className="nowheel"
          style={{
            position: "absolute",
            left: place?.offset ?? 0,
            top: "calc(100% + 4px)",
            zIndex: 10,
            width: place?.width ?? POPOVER_WIDTH,
            boxSizing: "border-box",
            maxHeight: 280,
            overflowY: "auto",
            padding: 4,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--popover, var(--card))",
            color: "var(--popover-foreground, var(--foreground))",
            fontSize: 12,
            boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
          }}
        >
          <input
            ref={searchRef}
            type="search"
            role="searchbox"
            aria-label={`Search ${label.toLowerCase()}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search..."
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "4px 8px",
              marginBottom: 4,
              border: "1px solid var(--border)",
              borderRadius: 4,
              background: "var(--background, var(--card))",
              color: "var(--foreground)",
              fontSize: 12,
            }}
          />
          <button
            type="button"
            onClick={() => onChange([])}
            disabled={selected.length === 0}
            style={{
              width: "100%",
              textAlign: "left",
              padding: "4px 8px",
              border: "none",
              background: "transparent",
              color: "var(--muted-foreground)",
              cursor: selected.length === 0 ? "default" : "pointer",
            }}
          >
            Clear selection
          </button>
          {normalizedQuery !== "" && !noMatches ? (
            <button
              type="button"
              onClick={() => onChange(Array.from(new Set([...selected, ...matchingIds])))}
              style={{
                width: "100%",
                textAlign: "left",
                padding: "4px 8px",
                border: "none",
                background: "transparent",
                color: "var(--muted-foreground)",
                cursor: "pointer",
              }}
            >
              Select all matches
            </button>
          ) : null}
          {options.length === 0 ? (
            <div style={{ padding: "4px 8px", color: "var(--muted-foreground)" }}>{emptyText}</div>
          ) : (
            <>
              {noMatches ? (
                <div style={{ padding: "4px 8px", color: "var(--muted-foreground)" }}>No matches</div>
              ) : (
                <>
                  {renderGroupedOptions(checkedMatching)}
                  {checkedMatching.length > 0 && remaining.length > 0 ? (
                    <div role="separator" style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />
                  ) : null}
                  {renderGroupedOptions(remaining)}
                </>
              )}
              {checkedNotMatching.length > 0 ? (
                <>
                  <div role="separator" style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />
                  <div style={{ padding: "4px 8px", color: "var(--muted-foreground)", fontWeight: 600 }}>Selected</div>
                  {renderGroupedOptions(checkedNotMatching)}
                </>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

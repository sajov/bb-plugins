// The toolbar's Focus dropdown (BBP-204/240): which crews, graph runs or
// threads the canvas narrows down to, plus their whole subtree (the actual
// filtering is lib/focus-filter.ts; this only builds the options and the
// "Focus: All"/"Focus (n)" label). Thin wrapper around SearchableMultiSelect, same
// shape as ProjectFilter.
import { SearchableMultiSelect, type SearchableMultiSelectOption } from "./SearchableMultiSelect";
import type { CanvasNode } from "../lib/types";

export type FocusFilterProps = {
  nodes: readonly CanvasNode[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
};

const GROUP_BY_KIND: Partial<Record<CanvasNode["kind"], string>> = {
  crew: "Crews",
  "graph-run": "Graph runs",
  thread: "Threads",
};

/** A crew's searchable keywords: the `member@crew` address of each of its
 *  direct member children, so searching for a member finds their crew. */
function crewMemberKeywords(crew: CanvasNode, nodes: readonly CanvasNode[]): string[] {
  return nodes
    .filter((node) => node.kind === "member" && node.parentId === crew.id)
    .map((member) => member.meta?.address)
    .filter((address): address is string => typeof address === "string");
}

function focusOptions(nodes: readonly CanvasNode[]): SearchableMultiSelectOption[] {
  const options: SearchableMultiSelectOption[] = [];
  for (const node of nodes) {
    const group = GROUP_BY_KIND[node.kind];
    if (group === undefined) continue;
    const keywords =
      node.kind === "crew"
        ? crewMemberKeywords(node, nodes)
        : typeof node.meta?.threadId === "string"
          ? [node.meta.threadId]
          : [];
    options.push({ id: node.id, name: node.label, group, keywords });
  }
  return options;
}

function summarizeFocus(options: readonly SearchableMultiSelectOption[], selected: readonly string[]): string {
  const count = options.filter((option) => selected.includes(option.id)).length;
  return count === 0 ? "Focus: All" : `Focus (${count})`;
}

export function FocusFilter({ nodes, selected, onChange }: FocusFilterProps) {
  return (
    <SearchableMultiSelect
      label="Focus"
      options={focusOptions(nodes)}
      selected={selected}
      onChange={onChange}
      emptyText="Nothing to focus on yet."
      summarize={summarizeFocus}
    />
  );
}

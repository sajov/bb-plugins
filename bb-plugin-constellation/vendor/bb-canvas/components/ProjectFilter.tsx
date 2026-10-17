// The toolbar's project multi-select (BBP-181). Nothing ticked means all
// projects, so the button never reads as an empty or broken filter. Thin
// wrapper around SearchableMultiSelect (BBP-205/BBP-211); callers unchanged.
import { SearchableMultiSelect } from "./SearchableMultiSelect";
import type { ProjectOption } from "../lib/project-filter";

export type ProjectFilterProps = {
  projects: readonly ProjectOption[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
};

export function ProjectFilter({ projects, selected, onChange }: ProjectFilterProps) {
  return (
    <SearchableMultiSelect
      label="Projects"
      options={projects}
      selected={selected}
      onChange={onChange}
      emptyText="No projects yet."
    />
  );
}

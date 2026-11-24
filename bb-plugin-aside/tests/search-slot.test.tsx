// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SearchSlot } from "@/components/sidenav/search-slot";

afterEach(cleanup);

const projects = [
  { id: "p1", name: "bb-plugins", count: 21 },
  { id: "p2", name: "Brain", count: 4 },
  { id: "p3", name: "Mastra Proxy", count: 2 },
];
const tagCounts = { management: 5, bb: 1 };

/**
 * The flyout with the state the sidenav holds for it: the query and both
 * filters live outside, so a click's effect on the field is only visible when
 * the caller feeds the new value back in — which is exactly what this is about.
 */
function Harness({ start = "" }: { start?: string }) {
  const [query, setQuery] = useState(start);
  const [activeProjects, setActiveProjects] = useState<string[]>([]);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
  return (
    <SearchSlot
      query={query}
      matchCount={projects.length}
      focusTick={0}
      onQuery={setQuery}
      onClose={vi.fn()}
      tagCounts={tagCounts}
      activeTags={activeTags}
      onToggleTag={(tag) => setActiveTags((current) => toggle(current, tag))}
      knownProjects={projects}
      activeProjects={activeProjects}
      onToggleProject={(id) => setActiveProjects((current) => toggle(current, id))}
      onClearAll={vi.fn()}
    />
  );
}

function field() {
  return screen.getByRole("combobox") as HTMLInputElement;
}

function row(name: string) {
  return screen.getByRole("option", { name: new RegExp(name) });
}

describe("search flyout — picking a row clears the field", () => {
  it("empties the query on a click and leaves every project in the list", () => {
    render(<Harness start="brain" />);
    fireEvent.click(row("Brain"));
    expect(field().value).toBe("");
    // The picked project is still there, and so are the ones the query hid.
    expect(row("Brain").getAttribute("aria-selected")).toBe("true");
    expect(row("bb-plugins")).toBeTruthy();
    expect(row("Mastra Proxy")).toBeTruthy();
  });

  it("empties the query on a tag click too", () => {
    render(<Harness start="manage" />);
    fireEvent.click(row("management"));
    expect(field().value).toBe("");
    expect(row("management").getAttribute("aria-selected")).toBe("true");
    // `^bb1$` is the tag row with its count — "bb-plugins" would match a looser one.
    expect(row("^bb1$")).toBeTruthy();
  });

  it("empties the query when Enter picks the highlighted row", () => {
    render(<Harness start="mastra" />);
    // Row 0 is the text row while something is typed; one step down is the project.
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(field().value).toBe("");
    expect(row("Mastra Proxy").getAttribute("aria-selected")).toBe("true");
  });

  it("empties the query when a click takes a pick away again", () => {
    render(<Harness />);
    fireEvent.click(row("Brain"));
    fireEvent.change(field(), { target: { value: "brain" } });
    fireEvent.click(row("Brain"));
    expect(field().value).toBe("");
    expect(row("Brain").getAttribute("aria-selected")).toBe("false");
  });

  // The negative case: typing is not picking. Were the field emptied on every
  // change, there would be no way to search at all.
  it("does NOT empty the query while only typing", () => {
    render(<Harness />);
    fireEvent.change(field(), { target: { value: "brain" } });
    expect(field().value).toBe("brain");
    expect(screen.queryByRole("option", { name: /bb-plugins/ })).toBeNull();
    expect(row("Brain")).toBeTruthy();
  });

  // The text row keeps the typed words as a filter on purpose — clearing it
  // there would throw away the one thing that row stands for.
  it("does NOT empty the query when the text row is picked", () => {
    render(<Harness start="brain" />);
    fireEvent.click(screen.getByRole("option", { name: /Filter by/ }));
    expect(field().value).toBe("brain");
  });
});

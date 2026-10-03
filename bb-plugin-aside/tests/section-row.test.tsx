// @vitest-environment jsdom
//
// "New thread" must lead the section menu, like it already does on the
// project row — otherwise starting a thread in a section needs a detour
// through the project row first.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SectionRow } from "@/components/sidenav/section-row";

afterEach(cleanup);

function row(onNewThread: () => void) {
  return (
    <SectionRow
      name="Backlog"
      count={2}
      state="quiet"
      age={null}
      now={0}
      collapsed={false}
      renaming={false}
      threadCount={2}
      projectCount={1}
      onToggle={vi.fn()}
      onStartRename={vi.fn()}
      onCancelRename={vi.fn()}
      onRename={vi.fn()}
      onDissolve={vi.fn()}
      onDropThread={vi.fn()}
      onNewThread={onNewThread}
    />
  );
}

describe("section row context menu", () => {
  it("offers New thread first, followed by a separator", () => {
    render(row(vi.fn()));
    fireEvent.contextMenu(screen.getByText("Backlog"));
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(items[0]).toBe("New thread");
    expect(screen.getAllByRole("separator").length).toBeGreaterThan(0);
  });

  it("calls onNewThread when picked", () => {
    const onNewThread = vi.fn();
    render(row(onNewThread));
    fireEvent.contextMenu(screen.getByText("Backlog"));
    fireEvent.click(screen.getByText("New thread"));
    expect(onNewThread).toHaveBeenCalled();
  });
});

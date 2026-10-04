// @vitest-environment jsdom
//
// "New thread" must lead the section menu, like it already does on the
// project row — otherwise starting a thread in a section needs a detour
// through the project row first.
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { SectionRow, SECTION_DRAG_TYPE } from "@/components/sidenav/section-row";
import { THREAD_DRAG_TYPE } from "@/components/sidenav/thread-card";
import { OPEN_SELECT_GUARD_MS } from "@/components/ui/context-menu";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function row(
  onNewThread: () => void,
  overrides: Partial<React.ComponentProps<typeof SectionRow>> = {},
) {
  return (
    <SectionRow
      id="s1"
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
      onReorder={vi.fn()}
      {...overrides}
    />
  );
}

/** A minimal stand-in for a drag event's DataTransfer in jsdom. */
function dataTransfer(entries: Record<string, string>) {
  const store = { ...entries };
  return {
    effectAllowed: "",
    dropEffect: "",
    types: Object.keys(store),
    setData: (type: string, value: string) => {
      store[type] = value;
    },
    getData: (type: string) => store[type] ?? "",
  };
}

/** jsdom's synthetic drop event ignores `clientY` passed through fireEvent's
 *  init object, so it is patched onto the event directly. */
function dropAt(element: Element, clientY: number, transfer: ReturnType<typeof dataTransfer>) {
  const event = createEvent.drop(element, { dataTransfer: transfer });
  Object.defineProperty(event, "clientY", { value: clientY });
  fireEvent(element, event);
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
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onNewThread = vi.fn();
    render(row(onNewThread));
    fireEvent.contextMenu(screen.getByText("Backlog"));
    // Past the open-select guard: a deliberate click, not the opening gesture.
    vi.setSystemTime(OPEN_SELECT_GUARD_MS + 1);
    fireEvent.click(screen.getByText("New thread"));
    expect(onNewThread).toHaveBeenCalled();
  });
});

describe("section row drag and drop", () => {
  it("is draggable and carries its id as SECTION_DRAG_TYPE", () => {
    render(row(vi.fn()));
    const handle = screen.getByText("Backlog").closest("[draggable]");
    expect(handle).not.toBeNull();
    const transfer = dataTransfer({});
    fireEvent.dragStart(handle!, { dataTransfer: transfer });
    expect(transfer.getData(SECTION_DRAG_TYPE)).toBe("s1");
  });

  it("drops another section before it when released on the top half", () => {
    const onReorder = vi.fn();
    render(row(vi.fn(), { onReorder }));
    const handle = screen.getByText("Backlog").closest("[draggable]")!;
    vi.spyOn(handle, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 20,
      height: 20,
      left: 0,
      right: 100,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    dropAt(handle, 5, dataTransfer({ [SECTION_DRAG_TYPE]: "s2" }));
    expect(onReorder).toHaveBeenCalledWith("s2", "before");
  });

  it("drops another section after it when released on the bottom half", () => {
    const onReorder = vi.fn();
    render(row(vi.fn(), { onReorder }));
    const handle = screen.getByText("Backlog").closest("[draggable]")!;
    vi.spyOn(handle, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 20,
      height: 20,
      left: 0,
      right: 100,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    dropAt(handle, 15, dataTransfer({ [SECTION_DRAG_TYPE]: "s2" }));
    expect(onReorder).toHaveBeenCalledWith("s2", "after");
  });

  it("ignores a drop of itself", () => {
    const onReorder = vi.fn();
    const onToggle = vi.fn();
    render(row(vi.fn(), { onReorder, onToggle }));
    const handle = screen.getByText("Backlog").closest("[draggable]")!;
    fireEvent.drop(handle, { dataTransfer: dataTransfer({ [SECTION_DRAG_TYPE]: "s1" }) });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("still drops a thread onto the section", () => {
    const onDropThread = vi.fn();
    render(row(vi.fn(), { onDropThread }));
    const handle = screen.getByText("Backlog").closest("[draggable]")!;
    fireEvent.drop(handle, { dataTransfer: dataTransfer({ [THREAD_DRAG_TYPE]: "t1" }) });
    expect(onDropThread).toHaveBeenCalledWith("t1");
  });
});

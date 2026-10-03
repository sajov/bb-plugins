// @vitest-environment jsdom
//
// The guard that stops the mouse-up releasing a right click from immediately
// "clicking" whatever item Radix places under the cursor. Covered here at the
// primitive level so every menu built on top of it (threads, projects,
// sections) inherits the fix rather than re-implementing it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  OPEN_SELECT_GUARD_MS,
} from "@/components/ui/context-menu";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function menu(onSelect: () => void) {
  return (
    <ContextMenu open>
      <ContextMenuTrigger>trigger</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onSelect}>Pin</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

describe("context menu open guard", () => {
  it("swallows a select that lands right after the menu opens", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onSelect = vi.fn();
    render(menu(onSelect));

    vi.setSystemTime(OPEN_SELECT_GUARD_MS - 1);
    fireEvent.click(screen.getByText("Pin"));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("lets a select through once the guard window has passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onSelect = vi.fn();
    render(menu(onSelect));

    vi.setSystemTime(OPEN_SELECT_GUARD_MS + 1);
    fireEvent.click(screen.getByText("Pin"));

    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

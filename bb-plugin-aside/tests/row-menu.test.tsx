// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_useSidebarThreadActions: () => ({
    open: vi.fn(),
    setPinned: vi.fn(),
    setRead: vi.fn(),
    archive: vi.fn(),
    requestDelete: vi.fn(),
  }),
}));

const { RowMenu } = await import("@/components/sidenav/row-menu");
const { OPEN_SELECT_GUARD_MS } = await import("@/components/ui/context-menu");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function thread(): PluginSidebarThread {
  return {
    id: "a",
    title: "Root",
    titleFallback: null,
    parentThreadId: null,
    projectId: "p",
    sectionId: null,
    providerId: "claude",
    isPinned: false,
    isUnread: false,
    isArchived: false,
  } as unknown as PluginSidebarThread;
}

describe("RowMenu", () => {
  it("offers Rename as a plain menu item, without a double-click hint", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onRename = vi.fn();
    render(
      <RowMenu
        thread={thread()}
        sections={[]}
        onRename={onRename}
        onSetSection={vi.fn()}
        onCreateSection={vi.fn()}
      >
        <div>Row</div>
      </RowMenu>,
    );

    fireEvent.contextMenu(screen.getByText("Row"));
    const rename = screen.getByText("Rename");
    expect(rename.textContent).toBe("Rename");

    // Past the open-select guard: a deliberate click, not the opening gesture.
    vi.setSystemTime(OPEN_SELECT_GUARD_MS + 1);
    fireEvent.click(rename);
    expect(onRename).toHaveBeenCalled();
  });
});

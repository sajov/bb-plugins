// @vitest-environment jsdom
//
// "New thread" on a section's context menu must create the thread inside
// that section, not at the project root (BBP-91).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PluginSidebarProject, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { OPEN_SELECT_GUARD_MS } from "@/components/ui/context-menu";

const openNewThread = vi.fn();

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    experimental_useProviders: () => ({ providers: [] }),
    experimental_ProviderIcon: () => null,
    experimental_useSidebarThreadActions: () => ({
      openNewThread,
      open: vi.fn(),
    }),
    experimental_useSidebarThreadSplit: () => ({ splitProps: {} }),
    experimental_useSidebarThreads: () => ({
      threads: [thread()],
      projects: [project()],
      status: "ready",
    }),
    useRealtime: () => {},
    useRpc: () => ({
      call: (name: string) => {
        if (name === "sections_list") {
          return Promise.resolve({ sections: [{ id: "sec1", name: "Backlog" }] });
        }
        if (name === "view_get") return Promise.resolve({ view: null });
        if (name === "projects_state") return Promise.resolve({ colors: [], tags: [] });
        return Promise.resolve({});
      },
    }),
  };
});

const { Sidenav } = await import("@/components/sidenav/sidenav");

function project(): PluginSidebarProject {
  return { id: "p1", name: "Project", isPersonal: false } as PluginSidebarProject;
}

function thread(): PluginSidebarThread {
  return {
    id: "t1",
    title: "Thread",
    titleFallback: null,
    parentThreadId: null,
    projectId: "p1",
    sectionId: "sec1",
    originKind: null,
    originPluginId: null,
    providerId: "claude",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 1000,
    updatedAt: 1000,
    lastReadAt: null,
    latestAttentionAt: 1000,
  } as unknown as PluginSidebarThread;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  openNewThread.mockClear();
});

describe("sidenav section new-thread", () => {
  it("passes the section's id to openNewThread", async () => {
    render(<Sidenav activeThreadId={null} activeProjectId={null} onNavigate={vi.fn()} />);

    // Sections load asynchronously via rpc.
    await screen.findByText("Backlog");

    fireEvent.contextMenu(screen.getByText("Backlog"));
    await new Promise((resolve) => setTimeout(resolve, OPEN_SELECT_GUARD_MS + 50));
    const item = screen.getAllByText("New thread")[0];
    fireEvent.click(item);

    expect(openNewThread).toHaveBeenCalledWith({
      projectId: "p1",
      sectionId: "sec1",
      focusPrompt: true,
    });
  });
});

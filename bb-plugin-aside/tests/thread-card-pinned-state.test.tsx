// @vitest-environment jsdom
//
// A pinned card used to drop its children to hide the agent count and
// toggle, which also threw away the state the row's mark rolls up from —
// a running sub-thread under a pinned root went silent. This pins the
// aggregation to the full family while keeping the count/toggle hidden.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_useSidebarThreadActions: () => ({
    open: vi.fn(),
    setPinned: vi.fn(),
    setRead: vi.fn(),
    archive: vi.fn(),
    requestDelete: vi.fn(),
    rename: vi.fn(),
  }),
  experimental_useSidebarThreadSplit: () => ({ splitProps: {} }),
  experimental_ProviderIcon: () => null,
}));

const { ThreadCard } = await import("@/components/sidenav/thread-card");
import type { CardCallbacks } from "@/components/sidenav/thread-card";
import type { Family } from "@/lib/tree";

afterEach(cleanup);

function thread(id: string, title: string, overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id,
    title,
    titleFallback: null,
    parentThreadId: null,
    projectId: "p",
    sectionId: null,
    providerId: "claude",
    isPinned: false,
    isUnread: false,
    isArchived: false,
    hasPendingInteraction: false,
    indicator: null,
    createdAt: 0,
    updatedAt: 0,
    latestAttentionAt: 0,
    environment: null,
    host: null,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    ...overrides,
  } as unknown as PluginSidebarThread;
}

const callbacks: CardCallbacks = {
  onOpen: vi.fn(),
  onToggleChildren: vi.fn(),
  onRename: vi.fn(),
  onSetSection: vi.fn(),
  onCreateSection: vi.fn(),
  onNest: vi.fn(),
  onReorder: vi.fn(),
  onDropRejected: vi.fn(),
  onNewSubThread: vi.fn(),
};

function pinnedCard(family: Family) {
  return (
    <ThreadCard
      family={family}
      providers={new Map()}
      sections={[]}
      activeThreadId={null}
      childrenOpen={false}
      compact
      now={0}
      renaming={false}
      selection={null}
      onStartRename={vi.fn()}
      onCancelRename={vi.fn()}
      callbacks={callbacks}
      pinnedIn={{ name: "Project", color: "#000" }}
    />
  );
}

describe("pinned thread card aggregates sub-thread state", () => {
  it("shows the working mark while a child runs, even though the root is idle", () => {
    const root = thread("a", "Root", { isPinned: true });
    const child = thread("a1", "Agent", { indicator: "runtime" } as Partial<PluginSidebarThread>);
    render(pinnedCard({ root, children: [child] }));
    expect(screen.getByRole("img", { name: "Working" })).toBeTruthy();
  });

  it("falls back to quiet once the child is done", () => {
    const root = thread("a", "Root", { isPinned: true });
    const child = thread("a1", "Agent");
    render(pinnedCard({ root, children: [child] }));
    expect(screen.queryByRole("img", { name: "Working" })).toBeNull();
  });

  it("never shows an agent-count toggle in the pinned row", () => {
    const root = thread("a", "Root", { isPinned: true });
    const child = thread("a1", "Agent", { indicator: "runtime" } as Partial<PluginSidebarThread>);
    render(pinnedCard({ root, children: [child] }));
    expect(screen.queryByRole("button", { name: /agents/i })).toBeNull();
  });
});

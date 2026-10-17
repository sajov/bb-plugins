// @vitest-environment jsdom
//
// The Canvas nav page (BBP-189 AK 1): Agents → projects → every thread BB
// lists, with no crew or Graph Studio RPC anywhere in the way.
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot, type CapturedPluginApp } from "@get-bb/plugin-sdk/testing/app";

let app: CapturedPluginApp;

beforeAll(async () => {
  app = await loadPluginApp(() => import("../app"));
});
beforeEach(() => localStorage.clear());
afterEach(cleanup);

const row = (id: string, projectId: string, title: string | null, extra: { status?: string; archivedAt?: number | null; updatedAt?: number } = {}) => ({
  id,
  projectId,
  title,
  titleFallback: null,
  status: "idle",
  providerId: "claude-code",
  archivedAt: null,
  updatedAt: Date.now(),
  ...extra,
});

function canvasPanel(sdk: Record<string, unknown>, settings?: Record<string, number>) {
  const panel = app.navPanels.find((entry) => entry.id === "constellation")!;
  // No live events unless a test brings its own `subscribe`.
  const withLive = { subscribe: () => () => {}, ...sdk };
  return renderSlot(panel, { subPath: "" }, { context: { projectId: null, threadId: null }, sdk: withLive as never, ...(settings ? { settings } : {}) });
}

describe("the Canvas nav page", () => {
  it("has a nav entry titled Canvas", () => {
    expect(app.navPanels.map((entry) => [entry.id, entry.title])).toContainEqual(["constellation", "Constellation"]);
  });

  it("shows every thread, a plain chat thread included, under Agents → its project", async () => {
    canvasPanel({
      projects: { list: async () => [{ id: "p1", name: "Shop" }] },
      threads: { list: async () => [row("t1", "p1", "Plain chat")] },
    });
    expect(await screen.findByRole("button", { name: /^Agents — / })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Shop — / })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Plain chat — / })).toBeTruthy();
  });

  it("shows an empty state, not an error, when there are no threads", async () => {
    canvasPanel({
      projects: { list: async () => [{ id: "p1", name: "Shop" }] },
      threads: { list: async () => [] },
    });
    expect(await screen.findByText("No threads yet.")).toBeTruthy();
  });

  it("still shows threads when the project list cannot be read", async () => {
    canvasPanel({
      projects: {
        list: async () => {
          throw new Error("offline");
        },
      },
      threads: { list: async () => [row("t1", "p1", "Plain chat")] },
    });
    expect(await screen.findByRole("button", { name: /^Plain chat — / })).toBeTruthy();
  });

  it("names the failure when the thread list cannot be read", async () => {
    canvasPanel({
      projects: { list: async () => [] },
      threads: {
        list: async () => {
          throw new Error("offline");
        },
      },
    });
    expect(await screen.findByText("Canvas not available: offline")).toBeTruthy();
  });
});

// BBP-189 AK 4: every filter narrows, an empty project filter hides nothing.
describe("the Canvas surface", () => {
  const sdk = (threads: unknown[]) => ({
    projects: { list: async () => [{ id: "p1", name: "Shop" }, { id: "p2", name: "Blog" }] },
    threads: { list: async () => threads },
  });
  const card = (name: string) => screen.queryByRole("button", { name: new RegExp(`^${name} — `) });

  it("hides archived threads", async () => {
    canvasPanel(sdk([row("t1", "p1", "Live"), row("t2", "p1", "Old", { archivedAt: 1 })]));
    expect(await screen.findByRole("button", { name: /^Live — / })).toBeTruthy();
    expect(card("Old")).toBeNull();
  });

  it("puts search, filters, view options, status and legend in the overview panel, and no toolbar row (BBP-310/311/313)", async () => {
    canvasPanel(sdk([row("t1", "p1", "Live")]));
    await screen.findByRole("button", { name: /^Live — / });
    const overview = screen.getByRole("complementary", { name: "Overview" });
    for (const section of ["Search & filter", "View", "Status", "Legend"]) expect(within(overview).getByRole("region", { name: section })).toBeTruthy();
    expect(within(overview).getByRole("textbox", { name: "Search nodes" })).toBeTruthy();
    expect(within(overview).getByRole("button", { name: "Active only" })).toBeTruthy();
    expect(within(overview).getByRole("radiogroup", { name: "Time window" })).toBeTruthy();
    expect(within(overview).getByRole("radiogroup", { name: "Cards" })).toBeTruthy();
    expect(within(overview).getByRole("button", { name: /^Projects/ })).toBeTruthy();
    expect(within(overview).getByRole("button", { name: /^Focus/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Collapse all" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Expand all" })).toBeNull();
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });

  it("Compact and All open replace Collapse all / Expand all", async () => {
    canvasPanel(sdk([row("t1", "p1", "Live")]));
    await screen.findByRole("button", { name: /^Live — / });
    fireEvent.click(screen.getByRole("radio", { name: "Compact" }));
    expect(screen.getByRole("radio", { name: "Compact" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("button", { name: /^Live — / })).toBeNull();
  });

  it("shows Reset only once a filter is set, and Reset clears it", async () => {
    canvasPanel(sdk([row("t1", "p1", "Live")]));
    await screen.findByRole("button", { name: /^Live — / });
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Search nodes" }), { target: { value: "Live" } });
    expect(within(screen.getByRole("region", { name: "Search & filter" })).getByText("1 active")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Active only" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByRole("button", { name: "Active only" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("colours by type by default; the toggle switches to status and is remembered", async () => {
    canvasPanel(sdk([row("t1", "p1", "Live")]));
    const type = await screen.findByRole("radio", { name: "Type" });
    expect(type.getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector("[data-bb-accent]")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Status" }));
    expect(screen.getByRole("radio", { name: "Status" }).getAttribute("aria-checked")).toBe("true");
    cleanup();
    canvasPanel(sdk([row("t1", "p1", "Live")]));
    expect((await screen.findByRole("radio", { name: "Status" })).getAttribute("aria-checked")).toBe("true");
  });

  it("counts running work on the status board; the tile jumps to it, the list selects it", async () => {
    canvasPanel(sdk([row("t1", "p1", "Busy", { status: "active" }), row("t2", "p1", "Quiet")]));
    await screen.findByRole("button", { name: /^Busy — / });
    const status = screen.getByRole("region", { name: "Status" });
    const tile = within(status).getByText("Running").closest("button")!;
    expect(tile.textContent).toContain("1");
    fireEvent.click(tile);
    expect(screen.getByRole("button", { name: /^Busy — / }).getAttribute("aria-pressed")).toBe("true");
    expect(within(screen.getByRole("complementary", { name: "Details for Busy" })).getByText("Busy")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "← Overview" }));
    fireEvent.click(within(screen.getByRole("region", { name: "Status" })).getByRole("button", { name: /Busy/ }));
    expect(screen.getByRole("complementary", { name: "Details for Busy" })).toBeTruthy();
  });

  it("the running badge in the panel header jumps to running work", async () => {
    canvasPanel(sdk([row("t1", "p1", "Busy", { status: "active" }), row("t2", "p1", "Quiet")]));
    await screen.findByRole("button", { name: /^Busy — / });
    fireEvent.click(screen.getByRole("button", { name: "1 running" }));
    expect(screen.getByRole("button", { name: /^Busy — / }).getAttribute("data-halo")).toBe("true");
  });

  it("negative: no badge while nothing runs or waits", async () => {
    canvasPanel(sdk([row("t2", "p1", "Quiet")]));
    await screen.findByRole("button", { name: /^Quiet — / });
    expect(screen.queryByRole("button", { name: /running$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /needs? you$/ })).toBeNull();
  });

  it("search finds without selecting: the overview stays, the match is marked, Enter steps on", async () => {
    canvasPanel(sdk([row("t1", "p1", "Live one"), row("t2", "p1", "Live two")]));
    await screen.findByRole("button", { name: /^Live one — / });
    const field = screen.getByRole("textbox", { name: "Search nodes" });
    fireEvent.change(field, { target: { value: "Live" } });
    expect(screen.getByText("1 / 2")).toBeTruthy();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.getByText("2 / 2")).toBeTruthy();
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(screen.getByText("1 / 2")).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Overview" })).toBeTruthy();
    expect(document.querySelectorAll('[data-canvas-view] button[aria-pressed="true"]')).toHaveLength(0);
  });

  it("negative: a tile with nothing to jump to is disabled, and nothing running says so", async () => {
    canvasPanel(sdk([row("t2", "p1", "Quiet")]));
    await screen.findByRole("button", { name: /^Quiet — / });
    const status = screen.getByRole("region", { name: "Status" });
    expect((within(status).getByText("Running").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect(within(status).getByText("No running work.")).toBeTruthy();
  });

  it("keeps the legend closed by default, with the type colours inside", async () => {
    canvasPanel(sdk([row("t1", "p1", "Live")]));
    await screen.findByRole("button", { name: /^Live — / });
    const legend = screen.getByRole("region", { name: "Legend" });
    expect(within(legend).getByRole("button", { name: /Legend/ }).getAttribute("aria-expanded")).toBe("false");
    expect(within(legend).getByText("Shell")).toBeTruthy();
  });

  it("says where to widen the window when it leaves no thread", async () => {
    canvasPanel(sdk([row("t2", "p1", "Old", { archivedAt: 1 })]));
    expect(await screen.findByText("No threads match the projects and window. Widen the window in the plugin settings.")).toBeTruthy();
  });

  it("opens the search with /", async () => {
    canvasPanel(sdk([row("t1", "p1", "Live")]));
    await screen.findByRole("button", { name: /^Live — / });
    fireEvent.keyDown(document.querySelector("[data-canvas-view]")!, { key: "/" });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Search nodes" })).toBe(document.activeElement));
  });
});

// BBP-189 AK 5: the chat beside the graph, and the thread panel's "Canvas".
describe("the Canvas chat tab and thread panel action", () => {
  const sdk = (threads: unknown[]) => ({
    projects: { list: async () => [{ id: "p1", name: "Shop" }] },
    threads: { list: async () => threads },
  });
  const chat = () => screen.queryByTestId("bb-thread-chat");

  it("has no chat column and no tabs: the graph is the page (BBP-298)", async () => {
    canvasPanel(sdk([row("t1", "p1", "First")]));
    fireEvent.click(await screen.findByRole("button", { name: /^First — / }));
    expect(chat()).toBeNull();
    expect(screen.queryByRole("tab", { name: "Chat" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Graph" })).toBeNull();
    expect(screen.queryByText("Select a thread to see its chat.")).toBeNull();
  });

  it("opens a thread in BB's own thread view on double-click", async () => {
    const rendered = canvasPanel(sdk([row("t1", "p1", "First")]));
    const card = await screen.findByRole("button", { name: /^First — / });
    fireEvent.click(card, { detail: 1 });
    fireEvent.click(card, { detail: 2 });
    expect(JSON.stringify(rendered.navigateCalls)).toContain("t1");
  });

  it("closes the detail panel with Escape", async () => {
    canvasPanel(sdk([row("t1", "p1", "First")]));
    fireEvent.click(await screen.findByRole("button", { name: /^First — / }));
    expect(screen.getByRole("button", { name: /^First — / }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(document.querySelector("[data-canvas-view]")!, { key: "Escape" });
    expect(screen.getByRole("button", { name: /^First — / }).getAttribute("aria-pressed")).toBe("false");
  });

  it("registers a thread panel action titled Canvas", () => {
    expect(app.threadPanelActions.map((entry) => [entry.id, entry.title])).toContainEqual(["constellation", "Constellation"]);
  });

  const threadPanel = (threadId: string, threads: unknown[]) => {
    const action = app.threadPanelActions.find((entry) => entry.id === "constellation")!;
    return renderSlot(action, { threadId, params: null }, { context: { projectId: "p1", threadId }, sdk: { subscribe: () => () => {}, ...sdk(threads) } as never });
  };

  it("opens the canvas focused on its thread", async () => {
    threadPanel("t2", [row("t1", "p1", "Other"), row("t2", "p1", "Mine")]);
    expect(await screen.findByRole("button", { name: /^Mine — / })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Other — / })).toBeNull();
  });

  it("keeps the focused thread even when the filters would hide it", async () => {
    threadPanel("t2", [row("t2", "p1", "Archived one", { archivedAt: 1 })]);
    expect(await screen.findByRole("button", { name: /^Archived one — / })).toBeTruthy();
  });

  it("shows FocusUnavailable, not a crash, for an unknown thread; Show all clears the focus", async () => {
    threadPanel("gone", [row("t1", "p1", "Other")]);
    expect(await screen.findByRole("status")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Show all/ }));
    expect(await screen.findByRole("button", { name: /^Other — / })).toBeTruthy();
  });

  it("shows FocusUnavailable for an unknown thread when there are no threads at all", async () => {
    threadPanel("gone", []);
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.queryByText("No threads yet.")).toBeNull();
  });

  it("shows FocusUnavailable for an unknown thread when the filters leave nothing", async () => {
    threadPanel("gone", [row("t1", "p1", "Old", { archivedAt: 1 })]);
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.queryByText(/No threads match the projects and window/)).toBeNull();
  });

  it("focuses a thread named in the nav page's sub-path", async () => {
    const panel = app.navPanels.find((entry) => entry.id === "constellation")!;
    renderSlot(panel, { subPath: "thread/t2" }, { context: { projectId: null, threadId: null }, sdk: { subscribe: () => () => {}, ...sdk([row("t1", "p1", "Other"), row("t2", "p1", "Mine")]) } as never });
    expect(await screen.findByRole("button", { name: /^Mine — / })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Other — / })).toBeNull();
  });
});

// BBP-189 AK 2 + 3: turns load only when a thread is opened; `thread:changed`
// refreshes a thread's status, and its turns only once they are loaded.
type ThreadChanged = { entity: "thread"; id?: string; changes: string[]; metadata?: Record<string, unknown> };

function liveSdk(timelineRows: () => unknown[]) {
  const listeners: ((event: ThreadChanged) => void)[] = [];
  const timeline = vi.fn(async () => ({ rows: timelineRows() }));
  const timelineTurnSummaryDetails = vi.fn(async () => ({
    rows: [{ id: "w1", kind: "work", workKind: "delegation", toolName: "Task", status: "completed", description: "Review the diff" }],
  }));
  const sdk = {
    projects: { list: async () => [{ id: "p1", name: "Shop" }] },
    threads: { list: async () => [row("t1", "p1", "Plain chat"), row("t2", "p1", "Other chat")], timeline, timelineTurnSummaryDetails },
    subscribe: (args: { event: string; callback: (event: ThreadChanged) => void }) => {
      if (args.event === "thread:changed") listeners.push(args.callback);
      return () => listeners.splice(listeners.indexOf(args.callback), 1);
    },
  };
  const emit = (event: ThreadChanged) => act(() => listeners.forEach((listener) => listener(event)));
  return { sdk, timeline, timelineTurnSummaryDetails, emit };
}

const turnRow = (id: string) => ({ id, kind: "turn", turnId: id, status: "completed", summaryCount: 1, sourceSeqStart: 1, sourceSeqEnd: 2, children: null });

async function open(name: RegExp) {
  fireEvent.click(await screen.findByRole("button", { name }));
  fireEvent.keyDown(document.querySelector("[data-canvas-view]")!, { key: "Enter" });
}

describe("the Canvas page's turns", () => {
  it("loads no timeline for a collapsed thread", async () => {
    const { sdk, timeline } = liveSdk(() => [turnRow("turn-1")]);
    canvasPanel(sdk);
    await screen.findByRole("button", { name: /^Plain chat — / });
    expect(timeline).not.toHaveBeenCalled();
  });

  it("loads a thread's turns on opening it, and opens its newest turn by itself (BBP-298)", async () => {
    const { sdk, timeline, timelineTurnSummaryDetails } = liveSdk(() => [turnRow("turn-1")]);
    canvasPanel(sdk);
    await open(/^Plain chat — /);
    await waitFor(() => expect(timeline).toHaveBeenCalledWith({ threadId: "t1" }));
    expect(await screen.findByRole("button", { name: /^Agent: Review the diff — / })).toBeTruthy();
    expect(timelineTurnSummaryDetails).toHaveBeenCalled();
  });

  it("shows only the newest turns-per-thread turns", async () => {
    const { sdk, timeline } = liveSdk(() => [1, 2, 3].map((n) => ({ ...turnRow(`turn-${n}`), summaryCount: 0 })));
    canvasPanel(sdk, { overviewTurns: 2 });
    await open(/^Plain chat — /);
    await waitFor(() => expect(timeline).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Turn.* — / })).toHaveLength(2));
  });
});

describe("the Canvas page live", () => {
  it("reloads the turns of an opened thread on thread:changed", async () => {
    let rows = [turnRow("turn-1")];
    const { sdk, timeline, emit } = liveSdk(() => rows);
    canvasPanel(sdk, { overviewTurns: 10 });
    await open(/^Plain chat — /);
    // Once for the canvas, once each for the Turns, Tool calls and Chat
    // sections (BBP-291, BBP-298, BBP-317).
    await waitFor(() => expect(timeline).toHaveBeenCalledTimes(4));
    rows = [turnRow("turn-1"), { ...turnRow("turn-2"), summaryCount: 0 }];
    emit({ entity: "thread", id: "t1", changes: ["events-appended"] });
    await waitFor(() => expect(timeline).toHaveBeenCalledTimes(8));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Turn.* — / })).toHaveLength(2));
  });

  it("loads nothing for a thread:changed on a thread whose turns are not loaded", async () => {
    const { sdk, timeline, emit } = liveSdk(() => [turnRow("turn-1")]);
    canvasPanel(sdk);
    await screen.findByRole("button", { name: /^Other chat — / });
    emit({ entity: "thread", id: "t2", changes: ["events-appended"] });
    emit({ entity: "thread", id: "unknown", changes: ["events-appended"] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(timeline).not.toHaveBeenCalled();
  });

  it("updates a thread's status from the event", async () => {
    const { sdk, emit } = liveSdk(() => []);
    canvasPanel(sdk);
    await screen.findByRole("button", { name: /^Other chat — / });
    emit({ entity: "thread", id: "t2", changes: ["status-changed"], metadata: { statusChange: { runtime: { displayStatus: "active" } } } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Other chat — / }).querySelector('[data-bb-status-glyph="running"]')).not.toBeNull(),
    );
  });
});

// BBP-287 (BBP-225): the overview window — last 12 h, 20 threads, 1 turn,
// live threads always in; the bar names it and offers "Show all".
describe("the Canvas overview window", () => {
  const sdk = (threads: unknown[]) => ({
    projects: { list: async () => [{ id: "p1", name: "Shop" }, { id: "p2", name: "Blog" }] },
    threads: { list: async () => threads },
  });
  const DAY = 24 * 3_600_000;
  const card = (name: string) => screen.queryByRole("button", { name: new RegExp(`^${name} — `) });

  it("shows the last 12 h by default", async () => {
    canvasPanel(sdk([row("t1", "p1", "Today"), row("t2", "p2", "Stale", { updatedAt: Date.now() - 2 * DAY })]));
    expect(await screen.findByRole("button", { name: /^Today — / })).toBeTruthy();
    expect(card("Stale")).toBeNull();
    // The project with nothing left in view is gone too.
    expect(screen.queryByRole("button", { name: /^Blog — / })).toBeNull();
  });

  it("keeps a running thread three days old in view", async () => {
    canvasPanel(sdk([row("t1", "p1", "Busy", { status: "active", updatedAt: Date.now() - 3 * DAY }), row("t2", "p1", "Done", { updatedAt: Date.now() - 3 * DAY })]));
    expect(await screen.findByRole("button", { name: /^Busy — / })).toBeTruthy();
    expect(card("Done")).toBeNull();
  });

  it("takes window, thread limit and turns from the plugin settings", async () => {
    canvasPanel(sdk([row("t1", "p1", "Yesterday", { updatedAt: Date.now() - 20 * 3_600_000 })]), { windowHours: 24, maxThreads: 5, overviewTurns: 3 });
    expect(await screen.findByRole("button", { name: /^Yesterday — / })).toBeTruthy();
  });
});

// S16b (BBP-286): a real turn's steps — command, MCP tool, file read and a
// subagent from `timelineTurnSummaryDetails` — are reachable under the turn.
describe("the Canvas page's tool calls under a turn", () => {
  it("shows a real turn's tool calls and its subagent, the newest turn open by itself", async () => {
    const real = (await import("../../bb-canvas/fixtures/real-timeline-rows.json")).default;
    const steps = [real.workToolMcpCall, real.workCommandBash, real.workFileRead, real.workDelegationSubagent];
    const { sdk } = liveSdk(() => [real.turnWithManySteps]);
    sdk.threads.timelineTurnSummaryDetails.mockImplementation(async () => ({ rows: steps }) as never);
    canvasPanel(sdk);
    await open(/^Plain chat — /);
    expect(await screen.findByRole("button", { name: /^Agent: / })).toBeTruthy();
    for (const label of [String(real.workToolMcpCall.toolName), String(real.workFileRead.path).split("/").pop()!]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — `) })).toBeTruthy();
    }
  });
});

describe("the Canvas page's turn stream (BBP-320, was +N earlier BBP-286)", () => {
  const steps = Array.from({ length: 12 }, (_, i) => ({ id: `w${i + 1}`, kind: "work", workKind: "tool", toolName: `tool${i + 1}`, status: "completed" }));

  it("shows every step of a turn in one stream, no +N earlier node", async () => {
    const { sdk } = liveSdk(() => [{ ...turnRow("turn-1"), summaryCount: 12 }]);
    sdk.threads.timelineTurnSummaryDetails.mockImplementation(async () => ({ rows: steps }) as never);
    canvasPanel(sdk);
    await open(/^Plain chat — /);
    const stream = await screen.findByRole("log", { name: "12 steps" });
    expect(within(stream).getByRole("button", { name: /^tool12 — / })).toBeTruthy();
    expect(within(stream).getByRole("button", { name: /^tool1 — / })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^\+2 earlier/ })).toBeNull();
  });

  it("gives a turn without steps no expander", async () => {
    const { sdk, timelineTurnSummaryDetails } = liveSdk(() => [{ ...turnRow("turn-1"), summaryCount: 0 }]);
    canvasPanel(sdk);
    await open(/^Plain chat — /);
    await screen.findByRole("button", { name: /^Turn.* — / });
    expect(screen.getByRole("button", { name: /^Collapse Plain chat/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Expand Turn/ })).toBeNull();
    expect(timelineTurnSummaryDetails).not.toHaveBeenCalled();
  });
});

describe("the Canvas Active only toggle (BBP-288)", () => {
  const sdk = (threads: unknown[]) => ({ projects: { list: async () => [{ id: "p1", name: "Shop" }] }, threads: { list: async () => threads } });

  it("is off by default; on, it shows only the running threads", async () => {
    canvasPanel(sdk([row("t1", "p1", "Busy chat", { status: "active" }), row("t2", "p1", "Quiet chat")]));
    const toggle = await screen.findByRole("button", { name: "Active only" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(await screen.findByRole("button", { name: /^Quiet chat — / })).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Quiet chat — / })).toBeNull());
    expect(screen.getByRole("button", { name: /^Busy chat — / })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Active only" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("remembers the toggle across reloads", async () => {
    canvasPanel(sdk([row("t1", "p1", "Busy chat", { status: "active" }), row("t2", "p1", "Quiet chat")]));
    fireEvent.click(await screen.findByRole("button", { name: "Active only" }));
    cleanup();
    canvasPanel(sdk([row("t1", "p1", "Busy chat", { status: "active" }), row("t2", "p1", "Quiet chat")]));
    expect((await screen.findByRole("button", { name: "Active only" })).getAttribute("aria-pressed")).toBe("true");
  });

  it("says nothing is running, and Show everything turns it off", async () => {
    canvasPanel(sdk([row("t2", "p1", "Quiet chat")]));
    fireEvent.click(await screen.findByRole("button", { name: "Active only" }));
    expect(await screen.findByText("Nothing is running right now.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show everything" }));
    expect(await screen.findByRole("button", { name: /^Quiet chat — / })).toBeTruthy();
  });
});

// BBP-290 (BBP-237): J cycles through the running threads and gives the one
// it lands on a halo; shortcuts typed into a field stay in the field.
describe("the Canvas keyboard jump", () => {
  const sdk = (threads: unknown[]) => ({ projects: { list: async () => [{ id: "p1", name: "Shop" }] }, threads: { list: async () => threads } });
  const root = () => document.querySelector("[data-canvas-view]") as HTMLElement;
  const pressed = (name: RegExp) => screen.getByRole("button", { name }).getAttribute("aria-pressed");
  const halo = (name: RegExp) => screen.getByRole("button", { name }).getAttribute("data-halo");

  it("J jumps to a running thread, then the next, and wraps; the target has a halo", async () => {
    canvasPanel(sdk([row("t1", "p1", "Run one", { status: "active" }), row("t2", "p1", "Quiet"), row("t3", "p1", "Run two", { status: "active", updatedAt: Date.now() - 1000 })]));
    await screen.findByRole("button", { name: /^Run one — / });
    fireEvent.keyDown(root(), { key: "j" });
    expect(pressed(/^Run one — /)).toBe("true");
    expect(halo(/^Run one — /)).toBe("true");
    fireEvent.keyDown(root(), { key: "j" });
    expect(pressed(/^Run two — /)).toBe("true");
    expect(halo(/^Run two — /)).toBe("true");
    expect(halo(/^Run one — /)).toBeNull();
    fireEvent.keyDown(root(), { key: "j" });
    expect(pressed(/^Run one — /)).toBe("true");
  });

  it("J does nothing when nothing runs", async () => {
    canvasPanel(sdk([row("t2", "p1", "Quiet")]));
    await screen.findByRole("button", { name: /^Quiet — / });
    fireEvent.keyDown(root(), { key: "j" });
    expect(pressed(/^Quiet — /)).toBe("false");
    expect(document.querySelector("[data-halo]")).toBeNull();
  });

  it("ignores shortcuts typed into a field", async () => {
    canvasPanel(sdk([row("t1", "p1", "Run one", { status: "active" })]));
    await screen.findByRole("button", { name: /^Run one — / });
    fireEvent.keyDown(root(), { key: "/" });
    const input = screen.getByRole("textbox", { name: "Search nodes" });
    const jKey = fireEvent.keyDown(input, { key: "j" });
    expect(pressed(/^Run one — /)).toBe("false");
    // Not swallowed either: "0" must still reach the field.
    expect(fireEvent.keyDown(input, { key: "0" })).toBe(true);
    expect(jKey).toBe(true);
  });

  it("a click selects without a halo", async () => {
    canvasPanel(sdk([row("t1", "p1", "Run one", { status: "active" })]));
    fireEvent.click(await screen.findByRole("button", { name: /^Run one — / }));
    expect(pressed(/^Run one — /)).toBe("true");
    expect(halo(/^Run one — /)).toBeNull();
  });
});

// BBP-291: the selected thread's full Activity list in the canvas sidebar.
describe("the Canvas Activity list", () => {
  const turns = (...ids: string[]) => ids.map((id) => ({ ...turnRow(id), summaryCount: 0 }));
  const activity = () => screen.getByRole("region", { name: "Turns" });

  it("lists every turn of the selected thread and how many the canvas shows", async () => {
    const { sdk } = liveSdk(() => turns("turn-1", "turn-2", "turn-3"));
    canvasPanel(sdk);
    fireEvent.click(await screen.findByRole("button", { name: /^Plain chat — / }));
    expect(await screen.findByText("1 of 3 in canvas")).toBeTruthy();
    expect(activity().querySelectorAll("li")).toHaveLength(3);
  });

  it("brings a turn the canvas hides into view and selects it on a click", async () => {
    const { sdk } = liveSdk(() => turns("turn-1", "turn-2", "turn-3"));
    canvasPanel(sdk);
    fireEvent.click(await screen.findByRole("button", { name: /^Plain chat — / }));
    await screen.findByText("1 of 3 in canvas");
    fireEvent.click(activity().querySelectorAll("li button")[0]!);
    await waitFor(() => expect(document.querySelectorAll('[data-canvas-view] button[aria-pressed="true"]').length).toBe(1));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Turn/ }).length).toBeGreaterThanOrEqual(2));
  });

  it("updates live on thread:changed, and a turn that is gone does not crash", async () => {
    let rows = turns("turn-1", "turn-2");
    const { sdk, emit } = liveSdk(() => rows);
    canvasPanel(sdk);
    fireEvent.click(await screen.findByRole("button", { name: /^Plain chat — / }));
    await screen.findByText("1 of 2 in canvas");
    fireEvent.click(activity().querySelectorAll("li button")[0]!);
    rows = turns("turn-2", "turn-3", "turn-4");
    emit({ entity: "thread", id: "t1", changes: ["events-appended"] });
    expect(await screen.findByText("1 of 3 in canvas")).toBeTruthy();
  });
});

// BBP-283 review fix 4: the Activity list's error path.
describe("the Canvas Activity list when the timeline fails", () => {
  it("leaves the section out, and the canvas keeps working, when the timeline cannot be read", async () => {
    const { sdk } = liveSdk(() => []);
    sdk.threads.timeline.mockImplementation(async () => {
      throw new Error("gone");
    });
    canvasPanel(sdk);
    fireEvent.click(await screen.findByRole("button", { name: /^Plain chat — / }));
    await waitFor(() => expect(sdk.threads.timeline).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Turns" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Other chat — / })).toBeTruthy();
  });

  it("keeps the last list when a live reload fails", async () => {
    const { sdk, emit } = liveSdk(() => [{ ...turnRow("turn-1"), summaryCount: 0 }]);
    canvasPanel(sdk);
    fireEvent.click(await screen.findByRole("button", { name: /^Plain chat — / }));
    await screen.findByText("1 of 1 in canvas");
    sdk.threads.timeline.mockImplementation(async () => {
      throw new Error("offline");
    });
    const calls = sdk.threads.timeline.mock.calls.length;
    emit({ entity: "thread", id: "t1", changes: ["events-appended"] });
    await waitFor(() => expect(sdk.threads.timeline.mock.calls.length).toBeGreaterThan(calls));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText("1 of 1 in canvas")).toBeTruthy();
  });
});

// BBP-298: filters back on the surface, Active only opens running work down
// to its tool calls, and the sidebar logs every step of the newest turns.
describe("the Canvas filters, auto-open and Log (BBP-298)", () => {
  it("narrows to the projects picked in the Projects filter", async () => {
    canvasPanel({
      projects: { list: async () => [{ id: "p1", name: "Shop" }, { id: "p2", name: "Blog" }] },
      threads: { list: async () => [row("t1", "p1", "In shop"), row("t2", "p2", "In blog")] },
    });
    expect(await screen.findByRole("button", { name: /^In shop — / })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Projects/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Blog" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^In shop — / })).toBeNull());
    expect(screen.getByRole("button", { name: /^In blog — / })).toBeTruthy();
  });

  it("opens a running thread and its running turn by itself under Active only", async () => {
    localStorage.setItem("bb-canvas:active-only", "true");
    const { sdk, timelineTurnSummaryDetails } = liveSdk(() => [{ ...turnRow("turn-1"), status: "running" }]);
    sdk.threads.list = async () => [row("t1", "p1", "Plain chat", { status: "active" })];
    canvasPanel(sdk);
    await waitFor(() => expect(timelineTurnSummaryDetails).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: /Review the diff/ })).toBeTruthy();
  });

  it("logs every step of the selected thread's newest turns in the sidebar", async () => {
    const { sdk } = liveSdk(() => [turnRow("turn-1")]);
    canvasPanel(sdk);
    fireEvent.click(await screen.findByRole("button", { name: /^Plain chat — / }));
    const log = await screen.findByRole("region", { name: "Tool calls" });
    fireEvent.click(within(log).getByRole("button", { name: /Tool calls/ }));
    expect(within(log).getByText(/Review the diff/)).toBeTruthy();
  });
});

describe("the Canvas tool-call terminal (BBP-312)", () => {
  it("shows the calls of every thread on the canvas while nothing is selected, closed threads too", async () => {
    localStorage.setItem("bb-canvas:terminal-open", "true");
    const { sdk, timeline } = liveSdk(() => [turnRow("turn-1")]);
    canvasPanel(sdk);
    const terminal = await screen.findByRole("region", { name: "Tool calls" });
    await waitFor(() => expect(within(terminal).getAllByRole("button", { name: /Review the diff/ }).length).toBeGreaterThan(0));
    expect(timeline).toHaveBeenCalledWith({ threadId: "t1" });
    expect(timeline).toHaveBeenCalledWith({ threadId: "t2" });
  });

  it("negative: reads nothing while the terminal is closed", async () => {
    const { sdk, timeline } = liveSdk(() => [turnRow("turn-1")]);
    canvasPanel(sdk);
    await screen.findByRole("button", { name: /^Plain chat — / });
    expect(timeline).not.toHaveBeenCalled();
  });
});

describe("the Canvas time window in the toolbar (BBP-298)", () => {
  it("starts at the settings' window and widens on request", async () => {
    canvasPanel({
      projects: { list: async () => [{ id: "p1", name: "Shop" }] },
      threads: { list: async () => [row("t1", "p1", "Today"), row("t2", "p1", "Yesterday", { updatedAt: Date.now() - 20 * 3_600_000 })] },
    });
    expect(await screen.findByRole("button", { name: /^Today — / })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Yesterday — / })).toBeNull();
    expect(screen.getByRole("radio", { name: "12 h" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "24 h" }));
    expect(await screen.findByRole("button", { name: /^Yesterday — / })).toBeTruthy();
  });
});

describe("the Canvas sidebar layout (BBP-298)", () => {
  it("negative: shows no breadcrumb, over the canvas or in the panel", async () => {
    const { sdk } = liveSdk(() => [turnRow("turn-1")]);
    canvasPanel(sdk);
    fireEvent.click(await screen.findByRole("button", { name: /^Plain chat — / }));
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
  });

  it("remembers an opened section for the next thread", async () => {
    const { sdk } = liveSdk(() => [turnRow("turn-1")]);
    canvasPanel(sdk);
    fireEvent.click(await screen.findByRole("button", { name: /^Plain chat — / }));
    const log = await screen.findByRole("region", { name: "Tool calls" });
    fireEvent.click(within(log).getByRole("button", { name: /Tool calls/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Other chat — / }));
    const next = await screen.findByRole("region", { name: "Tool calls" });
    expect(within(next).getByRole("button", { name: /Tool calls/ }).getAttribute("aria-expanded")).toBe("true");
  });
});

describe("the Canvas turn limit takes a dropped turn's steps along (BBP-298)", () => {
  it("shows no loose steps of a turn the limit drops", async () => {
    const turn = (id: string) => ({ ...turnRow(id), summaryCount: 0 });
    const step = { id: "w-old", kind: "work", workKind: "command", command: "echo old", turnId: "live-old", status: "completed" };
    const { sdk } = liveSdk(() => [turn("turn-1"), step, turn("turn-2")]);
    canvasPanel(sdk, { overviewTurns: 1 });
    await open(/^Plain chat — /);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Turn.* — / })).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /echo old/ })).toBeNull();
  });
});

describe("the Canvas picks up threads started after it opened (BBP-298)", () => {
  it("reloads the list when an event names a thread it does not know", async () => {
    const { sdk, emit } = liveSdk(() => []);
    let threads = [row("t1", "p1", "Plain chat")];
    sdk.threads.list = async () => threads;
    canvasPanel(sdk);
    await screen.findByRole("button", { name: /^Plain chat — / });
    threads = [...threads, row("t9", "p1", "Brand new", { status: "active" })];
    emit({ entity: "thread", id: "t9", changes: ["created"] });
    expect(await screen.findByRole("button", { name: /^Brand new — / }, { timeout: 3000 })).toBeTruthy();
  });
});

describe("the Canvas turn limit counts real turns only (BBP-298)", () => {
  it("keeps the newest turn and opens it, even when a reply row comes after it", async () => {
    const reply = { id: "a1", kind: "conversation", role: "assistant", text: "Done.", turnId: "turn-2" };
    const { sdk, timelineTurnSummaryDetails } = liveSdk(() => [turnRow("turn-1"), turnRow("turn-2"), reply]);
    canvasPanel(sdk, { overviewTurns: 1 });
    await open(/^Plain chat — /);
    await waitFor(() => expect(timelineTurnSummaryDetails).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: /Review the diff/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Done\./ })).toBeNull();
  });
});

describe("the Canvas shows crews from the crew plugin (BBP-190)", () => {
  it("hangs a crew under its project and draws its member as its thread", async () => {
    const panel = app.navPanels.find((entry) => entry.id === "constellation")!;
    const layer = {
      nodes: [
        { id: "crew:f1", kind: "crew", label: "factory-1", parentId: "project:p1", meta: { crew: "factory-1" } },
        { id: "member:lead@f1", kind: "member", label: "lead", parentId: "crew:f1", meta: { threadId: "t1", lead: true, activity: "idle" } },
      ],
      edges: [],
      expanded: ["crew:f1"],
      frames: [],
      sources: ["crew"],
    };
    renderSlot(panel, { subPath: "" }, {
      context: { projectId: null, threadId: null },
      sdk: { subscribe: () => () => {}, projects: { list: async () => [{ id: "p1", name: "Shop" }] }, threads: { list: async () => [row("t1", "p1", "lead@factory-1"), row("t2", "p1", "Plain chat")] } } as never,
      rpc: { extensionLayers: async () => layer } as never,
    });
    expect(await screen.findByRole("button", { name: /^factory-1 — / })).toBeTruthy();
    expect(await screen.findByRole("button", { name: /^lead — lead/ })).toBeTruthy();
    // One card for the lead: its own thread card gave way to the member.
    expect(screen.queryByRole("button", { name: /^lead@factory-1 — / })).toBeNull();
  });
});

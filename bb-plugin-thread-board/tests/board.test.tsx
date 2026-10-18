// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { columnFor } from "@/lib/board";
import { Board, type BoardProps, type CardThread } from "@/components/board";
import type { Purpose } from "@/lib/purpose";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";

// The vendored dialog draws its close icon through the SDK runtime.
installTestPluginRuntime();
afterEach(cleanup);

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const opts = { now: NOW, staleDays: 7, markedDone: false };
const thread = (over: Partial<CardThread> = {}): CardThread => ({
  id: "t1",
  projectId: "p1",
  displayTitle: "erstelle ein neues plugin lokal",
  status: "idle",
  hasPendingInteraction: false,
  updatedAt: NOW - 60_000,
  href: "/t/t1",
  ...over,
});
const purpose = (over: Partial<Purpose> = {}): Purpose => ({
  threadId: "t1",
  headline: "Thread Board plugin",
  purpose: "A long purpose paragraph that belongs in the popup.",
  progress: 60,
  state: "working",
  nextStep: null,
  actions: [],
  messageCount: 4,
  evaluatedAt: NOW - 60_000,
  model: "claude-opus-5-5",
  ...over,
});

describe("columnFor", () => {
  it("puts a running agent in progress, even when the model said done or the user marked it", () => {
    expect(columnFor(thread({ status: "active" }), { state: "done" }, { ...opts, markedDone: true })).toBe("working");
  });
  it("puts an idle thread with work left in progress", () => {
    expect(columnFor(thread(), { state: "working" }, opts)).toBe("working");
  });
  it("puts a pending approval in waiting, whatever the model said", () => {
    expect(columnFor(thread({ hasPendingInteraction: true }), { state: "working" }, opts)).toBe("waiting");
  });
  it("puts an unevaluated or waiting idle thread in waiting", () => {
    expect(columnFor(thread(), undefined, opts)).toBe("waiting");
    expect(columnFor(thread(), { state: "waiting" }, opts)).toBe("waiting");
  });
  it("follows the model's done and keeps a manual done", () => {
    expect(columnFor(thread(), { state: "done" }, opts)).toBe("done");
    expect(columnFor(thread(), { state: "working" }, { ...opts, markedDone: true })).toBe("done");
  });
  it("moves a quiet thread to stale, but not a done one", () => {
    const old = thread({ updatedAt: NOW - 8 * DAY });
    expect(columnFor(old, undefined, opts)).toBe("stale");
    expect(columnFor(old, { state: "working" }, opts)).toBe("stale");
    expect(columnFor(old, { state: "done" }, opts)).toBe("done");
  });
  it("does not call a thread stale inside the window", () => {
    expect(columnFor(thread({ updatedAt: NOW - 6 * DAY }), undefined, opts)).toBe("waiting");
  });
});

function renderBoard(over: Partial<BoardProps> = {}) {
  const props: BoardProps = {
    threads: [thread()],
    projects: [{ id: "p1", name: "eApp" }],
    purposes: {},
    markedDone: [],
    evaluating: [],
    staleDays: 7,
    model: "claude-opus-5-5",
    now: NOW,
    onOpen: vi.fn(),
    onRefresh: vi.fn(),
    onSetDone: vi.fn(),
    onArchive: vi.fn(),
    onEvaluateMany: vi.fn(),
    onSend: vi.fn(),
    ...over,
  };
  render(<Board {...props} />);
  return props;
}

describe("card", () => {
  it("shows the headline and the thread title, not the purpose text", () => {
    renderBoard({ purposes: { t1: purpose() } });
    const card = screen.getByTestId("card-t1");
    expect(within(card).getByText("Thread Board plugin")).toBeTruthy();
    expect(within(card).getByText(/erstelle ein neues plugin/)).toBeTruthy();
    expect(within(card).queryByText(/long purpose paragraph/)).toBeNull();
  });

  it("falls back to the thread title without an assessment", () => {
    renderBoard();
    expect(within(screen.getByTestId("card-t1")).getByText("erstelle ein neues plugin lokal")).toBeTruthy();
    expect(screen.getByText("Not evaluated")).toBeTruthy();
  });

  it("marks a running agent, and only then", () => {
    renderBoard({ threads: [thread({ status: "active" })] });
    expect(screen.getByLabelText("Agent running")).toBeTruthy();
    cleanup();
    renderBoard();
    expect(screen.queryByLabelText("Agent running")).toBeNull();
  });
});

describe("detail popup", () => {
  it("opens on click with purpose, open step and suggested reply", () => {
    renderBoard({ purposes: { t1: purpose({ state: "waiting", nextStep: "Pick a variant", actions: [{ label: "Take variant B", reply: "Variant B." }] }) } });
    fireEvent.click(screen.getByTestId("card-t1"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/long purpose paragraph/)).toBeTruthy();
    expect(within(dialog).getByText("Pick a variant")).toBeTruthy();
    expect(within(dialog).getByText(/Variant B\./)).toBeTruthy();
  });

  it("sends the first action with 1 and opens the thread with Enter", () => {
    const props = renderBoard({ purposes: { t1: purpose({ state: "waiting", actions: [{ label: "Take variant B", reply: "Variant B." }] }) } });
    fireEvent.click(screen.getByTestId("card-t1"));
    fireEvent.keyDown(document, { key: "1" });
    expect(props.onSend).toHaveBeenCalledWith("t1", "Variant B.");
    fireEvent.click(screen.getByTestId("card-t1"));
    fireEvent.keyDown(document, { key: "Enter" });
    expect(props.onOpen).toHaveBeenCalledWith("t1");
  });

  it("offers no actions without any, and 1 does nothing", () => {
    const props = renderBoard({ purposes: { t1: purpose() } });
    fireEvent.click(screen.getByTestId("card-t1"));
    expect(screen.queryByText("Next actions")).toBeNull();
    fireEvent.keyDown(document, { key: "1" });
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("offers the next action and a pick-up message on a stale thread", () => {
    const props = renderBoard({
      threads: [thread({ updatedAt: NOW - 30 * DAY })],
      purposes: { t1: purpose({ nextStep: "Write the e2e tests", actions: [{ label: "Resume e2e tests", reply: "Continue with the e2e tests." }] }) },
    });
    fireEvent.click(screen.getByTestId("card-t1"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Next action")).toBeTruthy();
    expect(within(dialog).getByText("Pick it up with")).toBeTruthy();
    fireEvent.keyDown(document, { key: "1" });
    expect(props.onSend).toHaveBeenCalledWith("t1", "Continue with the e2e tests.");
  });

  it("keeps the stale labels off a waiting thread", () => {
    renderBoard({ purposes: { t1: purpose({ state: "waiting", nextStep: "Pick", actions: [{ label: "B", reply: "B." }] }) } });
    fireEvent.click(screen.getByTestId("card-t1"));
    expect(screen.queryByText("Next action")).toBeNull();
    expect(screen.getByText("Next actions")).toBeTruthy();
  });

  it("puts each action on its own number key", () => {
    const props = renderBoard({
      purposes: {
        t1: purpose({
          state: "waiting",
          actions: [
            { label: "Take A", reply: "A." },
            { label: "Take B", reply: "B." },
            { label: "Drop it", reply: "Drop it." },
          ],
        }),
      },
    });
    fireEvent.click(screen.getByTestId("card-t1"));
    expect(screen.getByText("Drop it")).toBeTruthy();
    fireEvent.keyDown(document, { key: "3" });
    expect(props.onSend).toHaveBeenCalledWith("t1", "Drop it.");
  });

  it("ignores a number key beyond the offered actions", () => {
    const props = renderBoard({ purposes: { t1: purpose({ actions: [{ label: "A", reply: "A." }] }) } });
    fireEvent.click(screen.getByTestId("card-t1"));
    fireEvent.keyDown(document, { key: "2" });
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("offers a reply stored before actions existed as action 1", () => {
    const props = renderBoard({ purposes: { t1: purpose({ actions: undefined, suggestedReply: "Old reply." }) } });
    fireEvent.click(screen.getByTestId("card-t1"));
    fireEvent.keyDown(document, { key: "1" });
    expect(props.onSend).toHaveBeenCalledWith("t1", "Old reply.");
  });

  it("marks done with D", () => {
    const props = renderBoard({ purposes: { t1: purpose() } });
    fireEvent.click(screen.getByTestId("card-t1"));
    fireEvent.keyDown(document, { key: "d" });
    expect(props.onSetDone).toHaveBeenCalledWith("t1", true);
  });

  it("archives a done thread only on the second A", () => {
    const props = renderBoard({ purposes: { t1: purpose({ state: "done" }) } });
    fireEvent.click(screen.getByTestId("card-t1"));
    fireEvent.keyDown(document, { key: "a" });
    expect(props.onArchive).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "a" });
    expect(props.onArchive).toHaveBeenCalledWith("t1");
  });

  it("does not archive outside done", () => {
    const props = renderBoard({ purposes: { t1: purpose() } });
    fireEvent.click(screen.getByTestId("card-t1"));
    fireEvent.keyDown(document, { key: "a" });
    fireEvent.keyDown(document, { key: "a" });
    expect(props.onArchive).not.toHaveBeenCalled();
  });
});

describe("column picker on narrow screens", () => {
  it("shows waiting first and switches the visible column on a tab", () => {
    renderBoard({ threads: [thread(), thread({ id: "t2", displayTitle: "Running", status: "active" })] });
    const waiting = screen.getByRole("region", { name: "Waiting for you" });
    const progress = screen.getByRole("region", { name: "In progress" });
    expect(waiting.className).toMatch(/(^| )flex( |$)/);
    expect(progress.className).toMatch(/(^| )hidden( |$)/);
    fireEvent.click(screen.getByRole("tab", { name: /In progress/ }));
    expect(progress.className).toMatch(/(^| )flex( |$)/);
    expect(waiting.className).toMatch(/(^| )hidden( |$)/);
  });

  it("counts the cards on each tab", () => {
    renderBoard({ threads: [thread(), thread({ id: "t2" })] });
    expect(screen.getByRole("tab", { name: /Waiting for you/ }).textContent).toContain("2");
    expect(screen.getByRole("tab", { name: /Done/ }).textContent).toContain("0");
  });
});

describe("toolbar", () => {
  it("offers to evaluate the unevaluated threads only", () => {
    const props = renderBoard({ threads: [thread(), thread({ id: "t2", displayTitle: "Other" })], purposes: { t1: purpose() } });
    fireEvent.click(screen.getByText("Evaluate 1 thread"));
    expect(props.onEvaluateMany).toHaveBeenCalledWith(["t2"]);
  });

  it("hides the evaluate button when everything is evaluated", () => {
    renderBoard({ purposes: { t1: purpose() } });
    expect(screen.queryByText(/^Evaluate \d/)).toBeNull();
  });

  it("filters by project", () => {
    renderBoard({
      threads: [thread(), thread({ id: "t2", projectId: "p2", displayTitle: "Other" })],
      projects: [{ id: "p1", name: "eApp" }, { id: "p2", name: "Brain" }],
    });
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "p2" } });
    expect(screen.getByText("Other")).toBeTruthy();
    expect(screen.queryByText("erstelle ein neues plugin lokal")).toBeNull();
  });

  it("filters by search over title and headline", () => {
    renderBoard({ threads: [thread(), thread({ id: "t2", displayTitle: "Other" })], purposes: { t1: purpose({ headline: "Webhook retry" }) } });
    fireEvent.change(screen.getByLabelText("Search threads"), { target: { value: "webhook" } });
    expect(screen.getByText("Webhook retry")).toBeTruthy();
    expect(screen.queryByText("Other")).toBeNull();
  });
});

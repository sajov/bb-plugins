// @vitest-environment jsdom
//
// BBP-312: the tool-call terminal — which calls it lists, where it may sit,
// and what a row and the window's buttons do.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { clampBox, clock, MIN_SIZE, shownBox, terminalLines, ToolCallTerminal } from "../components/terminal";
import type { CanvasNode } from "../vendor/bb-canvas/lib/types";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const nodes: CanvasNode[] = [
  { id: "t1", kind: "thread", label: "Architect", parentId: null },
  { id: "u1", kind: "turn", label: "Turn", parentId: "t1" },
  { id: "c1", kind: "tool-call", label: "Bash", parentId: "u1", meta: { workKind: "command", command: "pnpm test", duration: "1.0s" } },
  { id: "c2", kind: "tool-call", label: "Read canvas-page.tsx", parentId: "u1", meta: { toolName: "Read", duration: "0.1s" } },
  { id: "t2", kind: "thread", label: "Developer", parentId: null },
  { id: "c3", kind: "tool-call", label: "gh run watch", status: "running", parentId: "t2", meta: { workKind: "command", command: "gh run watch 1" } },
];

describe("terminalLines", () => {
  it("lists every tool call on the canvas while nothing is selected", () => {
    const { lines, scope } = terminalLines(nodes, null);
    expect(lines.map((line) => line.id)).toEqual(["c1", "c2", "c3"]);
    expect(scope).toBeNull();
  });

  it("narrows to the selected node's thread and names it", () => {
    const { lines, scope } = terminalLines(nodes, "u1");
    expect(lines.map((line) => line.id)).toEqual(["c1", "c2"]);
    expect(scope).toBe("Architect");
  });

  it("shows the command, the duration bar relative to the longest, and running work", () => {
    const { lines } = terminalLines(nodes, null);
    expect(lines[0]!.text).toBe("pnpm test");
    expect(lines[0]!.bar).toBe(1);
    expect(lines[1]!.bar).toBeCloseTo(0.1);
    expect(lines[2]!.detail).toBe("running");
  });

  it("negative: turns and threads are no lines, and a call without a command shows its label", () => {
    const { lines } = terminalLines(nodes, null);
    expect(lines.some((line) => line.id === "u1" || line.id === "t1")).toBe(false);
    expect(lines[1]!.text).toBe("Read canvas-page.tsx");
  });
});

describe("terminalLines with loaded calls", () => {
  const loaded = (id: string, at: number | undefined, threadId = "z", sourceSeq?: number): CanvasNode => ({
    id,
    kind: "tool-call",
    label: id,
    parentId: "turn:z",
    meta: { threadId, ...(at === undefined ? {} : { startedAtMs: at }), ...(sourceSeq === undefined ? {} : { sourceSeq }) },
  });

  it("merges them with the canvas's, oldest first, each call once", () => {
    const { lines } = terminalLines([...nodes, loaded("c9", 2)], null, [loaded("c9", 2), loaded("c8", 1)], () => "Reviewer");
    expect(lines.slice(0, 2).map((line) => line.id)).toEqual(["c8", "c9"]);
    expect(lines.filter((line) => line.id === "c9")).toHaveLength(1);
    expect(lines[0]!.thread).toBe("Reviewer");
  });

  it("negative: a selection inside a thread ignores the loaded calls and names no thread", () => {
    const { lines } = terminalLines(nodes, "u1", [loaded("c8", 1)], () => "Reviewer");
    expect(lines.map((line) => line.id)).toEqual(["c1", "c2"]);
    expect(lines.every((line) => line.thread === undefined)).toBe(true);
  });

  // BBP-320 follow-up: file edits and subagents come without a start.
  it("places an untimed call after the call before it in its thread, across threads", () => {
    const calls = [loaded("b", 20, "z", 3), loaded("x", 15, "y", 1), loaded("e", undefined, "z", 2), loaded("a", 10, "z", 1)];
    expect(terminalLines([], null, calls).lines.map((line) => line.id)).toEqual(["a", "e", "x", "b"]);
  });

  it("an untimed call first in its thread takes the start of the call after it", () => {
    const calls = [loaded("x", 15, "y", 1), loaded("b", 20, "z", 2), loaded("e", undefined, "z", 1)];
    expect(terminalLines([], null, calls).lines.map((line) => line.id)).toEqual(["x", "e", "b"]);
  });

  it("negative: calls without any time in their thread keep their load order, after the timed ones", () => {
    const { lines } = terminalLines([], null, [loaded("a", undefined, "q"), loaded("b", 3), loaded("c", undefined, "r")]);
    expect(lines.map((line) => line.id)).toEqual(["b", "a", "c"]);
  });

  it("shows the clock time BB recorded, and none for a borrowed one", () => {
    const at = new Date(2026, 9, 17, 9, 5, 7).getTime();
    const { lines } = terminalLines([], null, [loaded("a", at, "z", 1), loaded("e", undefined, "z", 2)]);
    expect(lines.map((line) => line.time)).toEqual(["09:05:07", undefined]);
  });

  it("orders a selected thread's calls by time too", () => {
    const thread: CanvasNode[] = [
      { id: "t", kind: "thread", label: "T", parentId: null },
      { id: "late", kind: "tool-call", label: "late", parentId: "t", meta: { startedAtMs: 20 } },
      { id: "early", kind: "tool-call", label: "early", parentId: "t", meta: { startedAtMs: 10 } },
    ];
    expect(terminalLines(thread, "t").lines.map((line) => line.id)).toEqual(["early", "late"]);
  });
});

describe("clock", () => {
  const now = new Date(2026, 9, 17, 12, 0, 0).getTime();

  it("shows a call from an earlier day with its date", () => {
    expect(clock(new Date(2026, 9, 16, 23, 54, 30).getTime(), now)).toBe("10-16 23:54");
  });

  it("negative: today's call shows no date, only the time with seconds", () => {
    expect(clock(new Date(2026, 9, 17, 9, 5, 7).getTime(), now)).toBe("09:05:07");
  });
});

describe("clampBox", () => {
  const area = { width: 1000, height: 600 };
  it("moves a box dragged past an edge back inside", () => {
    const box = clampBox({ x: 900, y: -50, width: 400, height: 200, minimized: false }, area);
    expect(box.x + box.width).toBeLessThanOrEqual(1000 - 12);
    expect(box.y).toBe(12);
  });

  it("shrinks a box larger than the area, never below the minimum that fits", () => {
    const box = clampBox({ x: 0, y: 0, width: 3000, height: 3000, minimized: false }, area);
    expect(box.width).toBe(1000 - 24);
    expect(box.height).toBe(600 - 24);
    // Too small grows to the minimum.
    expect(clampBox({ x: 0, y: 0, width: 10, height: 10, minimized: false }, area).width).toBe(MIN_SIZE.width);
  });

  it("negative: an unmeasured area leaves the box alone", () => {
    const box = { x: -5, y: -5, width: 5000, height: 5000, minimized: false };
    expect(clampBox(box, { width: 0, height: 0 })).toEqual(box);
  });
});

describe("shownBox", () => {
  const area = { width: 1000, height: 600 };
  const box = { x: 100, y: 200, width: 400, height: 150, minimized: false };

  it("maximized, fills the area but a margin all round, and keeps its own place for the way back", () => {
    expect(shownBox({ ...box, maximized: true }, area)).toMatchObject({ x: 12, y: 12, width: 976, height: 576, maximized: true });
    expect(shownBox(box, area)).toMatchObject({ x: 100, y: 200, width: 400, height: 150 });
  });

  it("negative: an unmeasured area does not maximize into nothing", () => {
    expect(shownBox({ ...box, maximized: true }, { width: 0, height: 0 })).toMatchObject({ x: 100, width: 400 });
  });
});

describe("ToolCallTerminal", () => {
  it("maximizes and restores with its button, and the state survives a remount", () => {
    render(<ToolCallTerminal nodes={nodes} selectedId={null} onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Maximize tool calls" }));
    expect(screen.getByRole("button", { name: "Restore size" }).getAttribute("aria-pressed")).toBe("true");
    cleanup();
    render(<ToolCallTerminal nodes={nodes} selectedId={null} onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore size" }));
    expect(screen.getByRole("button", { name: "Maximize tool calls" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("selects a call's card on a click and marks the selected line", () => {
    const onSelect = vi.fn();
    const { rerender } = render(<ToolCallTerminal nodes={nodes} selectedId={null} onSelect={onSelect} onClose={vi.fn()} />);
    const log = screen.getByRole("region", { name: "Tool calls" });
    fireEvent.click(within(log).getByRole("button", { name: /pnpm test/ }));
    expect(onSelect).toHaveBeenCalledWith("c1");
    rerender(<ToolCallTerminal nodes={nodes} selectedId="c1" onSelect={onSelect} onClose={vi.fn()} />);
    expect(within(log).getByRole("button", { name: /pnpm test/ }).getAttribute("aria-current")).toBe("true");
  });

  it("filters by type", () => {
    render(<ToolCallTerminal nodes={nodes} selectedId={null} onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Tool call type" }), { target: { value: "shell" } });
    expect(screen.queryByRole("button", { name: /Read canvas-page/ })).toBeNull();
    expect(screen.getByRole("button", { name: /pnpm test/ })).toBeTruthy();
  });

  it("folds to a capsule that says what runs, and the fold survives a remount", () => {
    render(<ToolCallTerminal nodes={nodes} selectedId={null} onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Minimize tool calls" }));
    expect(screen.queryByRole("region", { name: "Tool calls" })).toBeNull();
    expect(screen.getByRole("button", { name: "Restore tool calls" }).textContent).toContain("1 running");
    cleanup();
    render(<ToolCallTerminal nodes={nodes} selectedId={null} onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore tool calls" }));
    expect(screen.getByRole("region", { name: "Tool calls" })).toBeTruthy();
  });

  it("closes with its ✕", () => {
    const onClose = vi.fn();
    render(<ToolCallTerminal nodes={nodes} selectedId={null} onSelect={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close tool calls (T)" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("negative: with no tool calls anywhere it says so", () => {
    render(<ToolCallTerminal nodes={nodes.filter((node) => node.kind !== "tool-call")} selectedId={null} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("No tool calls yet.")).toBeTruthy();
  });

  it("shows loaded calls of closed threads with their thread's name while nothing is selected", () => {
    const loaded: CanvasNode[] = [{ id: "x1", kind: "tool-call", label: "Read", parentId: "turn:z", meta: { workKind: "command", command: "ls", threadId: "z", startedAtMs: 5 } }];
    render(<ToolCallTerminal nodes={nodes} extraCalls={loaded} threadLabel={(id) => (id === "z" ? "Reviewer" : undefined)} selectedId={null} onSelect={vi.fn()} onClose={vi.fn()} />);
    const line = screen.getByTitle("ls");
    expect(line.textContent).toContain("Reviewer");
  });
});

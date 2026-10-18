// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PurposeBar } from "@/components/purpose-bar";
import type { Purpose } from "@/lib/purpose";

afterEach(cleanup);

const purpose: Purpose = {
  threadId: "t1",
  headline: "Thread Board plugin",
  purpose: "Long purpose text.",
  progress: 80,
  state: "waiting",
  nextStep: "Reload the board",
  actions: [],
  messageCount: 3,
  evaluatedAt: 0,
  model: "claude-opus-5-5",
};

describe("PurposeBar", () => {
  it("shows the headline in the header, not the purpose text or a state pill", () => {
    render(<PurposeBar purpose={purpose} evaluating={false} compact={false} now={0} onRefresh={vi.fn()} onSend={vi.fn()} />);
    expect(screen.getByText("Thread Board plugin")).toBeTruthy();
    expect(screen.queryByText("Long purpose text.")).toBeNull();
    expect(screen.queryByText("waiting for you")).toBeNull();
  });

  it("opens a panel inside the plugin's CSS scope", () => {
    render(<PurposeBar purpose={purpose} evaluating={false} compact={false} now={0} onRefresh={vi.fn()} onSend={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Purpose/ }));
    const panel = screen.getByRole("dialog", { name: "Thread purpose" });
    expect(panel.hasAttribute("data-bb-plugin-root")).toBe(true);
    expect(panel.textContent).toContain("Long purpose text.");
    expect(panel.textContent).toContain("Reload the board");
  });

  it("sends an action with its number key while the panel is open, and only then", () => {
    const onSend = vi.fn();
    const withActions = { ...purpose, actions: [{ label: "Reload", reply: "Reload the board." }, { label: "Stop", reply: "Stop here." }] };
    render(<PurposeBar purpose={withActions} evaluating={false} compact={false} now={0} onRefresh={vi.fn()} onSend={onSend} />);
    fireEvent.keyDown(document, { key: "2" });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Purpose/ }));
    expect(screen.getByText("Stop")).toBeTruthy();
    fireEvent.keyDown(document, { key: "2" });
    expect(onSend).toHaveBeenCalledWith("Stop here.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not pick an action while typing in a field", () => {
    const onSend = vi.fn();
    render(
      <>
        <input aria-label="composer" />
        <PurposeBar purpose={{ ...purpose, actions: [{ label: "A", reply: "A." }] }} evaluating={false} compact={false} now={0} onRefresh={vi.fn()} onSend={onSend} />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Purpose/ }));
    fireEvent.keyDown(screen.getByLabelText("composer"), { key: "1" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("drops the text on a compact viewport", () => {
    render(<PurposeBar purpose={purpose} evaluating={false} compact now={0} onRefresh={vi.fn()} onSend={vi.fn()} />);
    expect(screen.queryByText("Thread Board plugin")).toBeNull();
  });
});

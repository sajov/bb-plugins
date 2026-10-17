// @vitest-environment jsdom
//
// BBP-317: the node view's inline chat — the thread's newest messages and a
// composer that sends to exactly that thread, queued while it is busy.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatComposer, ChatHistory, chatMessages, CHAT_MESSAGES } from "../components/chat";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const say = (id: string, role: string, text: string) => ({ id, kind: "conversation", role, text });

describe("chatMessages", () => {
  it("keeps user and agent messages, oldest first, newest last", () => {
    const rows = [say("1", "user", "hi"), { id: "w", kind: "work" }, say("2", "assistant", "hello")];
    expect(chatMessages(rows).map((message) => message.text)).toEqual(["hi", "hello"]);
  });

  it("keeps only the newest few", () => {
    const rows = Array.from({ length: CHAT_MESSAGES + 3 }, (_, index) => say(String(index), "user", `m${index}`));
    const kept = chatMessages(rows);
    expect(kept).toHaveLength(CHAT_MESSAGES);
    expect(kept.at(-1)!.text).toBe(`m${CHAT_MESSAGES + 2}`);
  });

  it("negative: drops system rows, other roles and empty texts", () => {
    const rows = [say("1", "system", "x"), say("2", "user", ""), { id: "3", kind: "system", text: "cleared" }];
    expect(chatMessages(rows)).toEqual([]);
  });
});

function fakeSdk(send: (...args: unknown[]) => Promise<unknown> = vi.fn(async () => ({ ok: true, delivery: "sent" }))) {
  return { sdk: { threads: { timeline: vi.fn(async () => ({ rows: [say("1", "assistant", "Diff is clean.")] })), send } } as never, send };
}

describe("ChatHistory", () => {
  it("shows the thread's messages and a working line while the agent runs", async () => {
    const { sdk } = fakeSdk();
    render(<ChatHistory sdk={sdk} threadId="t1" threadLabel="Architect" version={0} working pending={[]} />);
    expect(await screen.findByText("Diff is clean.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Chat · Architect" })).toBeTruthy();
    expect(screen.getAllByText("working…").length).toBeGreaterThan(0);
  });

  it("negative: no working line while the thread is idle", async () => {
    const { sdk } = fakeSdk();
    render(<ChatHistory sdk={sdk} threadId="t1" threadLabel="Architect" version={0} working={false} pending={[]} />);
    await screen.findByText("Diff is clean.");
    expect(screen.queryByText("working…")).toBeNull();
  });

  it("shows a message sent from here before the timeline has it, and only once after", async () => {
    const { sdk } = fakeSdk();
    const pending = [{ id: "p", role: "user" as const, text: "Diff is clean." }, { id: "q", role: "user" as const, text: "Wait for CI" }];
    render(<ChatHistory sdk={sdk} threadId="t1" threadLabel="Architect" version={0} working={false} pending={pending} />);
    expect(await screen.findByText("Wait for CI")).toBeTruthy();
    expect(screen.getAllByText("Diff is clean.")).toHaveLength(1);
  });
});

describe("ChatComposer", () => {
  const renderComposer = (send?: (...args: unknown[]) => Promise<unknown>) => {
    const { sdk, send: sent } = fakeSdk(send);
    const onSent = vi.fn();
    render(<ChatComposer sdk={sdk} threadId="t1" threadLabel="Architect" onSent={onSent} onOpenThread={vi.fn()} />);
    return { send: sent, onSent, field: screen.getByRole("textbox", { name: "Message to Architect" }) };
  };

  it("sends to exactly this thread on ⌘↵, queued if it is busy, and clears the field", async () => {
    const { send, onSent, field } = renderComposer();
    fireEvent.change(field, { target: { value: "Wait for CI" } });
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith({ threadId: "t1", input: [{ type: "text", text: "Wait for CI", mentions: [] }], mode: "queue-if-active" });
    expect((field as HTMLTextAreaElement).value).toBe("");
  });

  it("says when a message was queued behind the current turn", async () => {
    const { field } = renderComposer(vi.fn(async () => ({ ok: true, delivery: "queued" })));
    fireEvent.change(field, { target: { value: "next" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Queued — delivered after the current turn")).toBeTruthy();
  });

  it("keeps the text and names the error when sending fails", async () => {
    const { field, onSent } = renderComposer(vi.fn(async () => Promise.reject(new Error("offline"))));
    fireEvent.change(field, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toContain("offline");
    expect((field as HTMLTextAreaElement).value).toBe("hello");
    expect(onSent).not.toHaveBeenCalled();
  });

  it("negative: a plain Enter is a new line, and an empty field sends nothing", () => {
    const { send, field } = renderComposer();
    fireEvent.keyDown(field, { key: "Enter" });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    expect(send).not.toHaveBeenCalled();
  });

  it("negative: keys typed here never reach the canvas's shortcuts", () => {
    const onKey = vi.fn();
    const { sdk } = fakeSdk();
    render(
      <div onKeyDown={onKey}>
        <ChatComposer sdk={sdk} threadId="t1" threadLabel="Architect" onSent={vi.fn()} onOpenThread={vi.fn()} />
      </div>,
    );
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "j" });
    expect(onKey).not.toHaveBeenCalled();
  });
});

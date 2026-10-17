// The inline chat of a node's view (BBP-317): the thread's last messages as a
// section, and a composer pinned at the panel's foot that sends to exactly
// that thread. A busy thread gets the message queued, as BB's own chat does.
import { useEffect, useRef, useState } from "react";
import type { useSdk } from "@get-bb/plugin-sdk/app";
import { Accordion } from "../vendor/bb-canvas/components/Accordion";
import type { TimelineRowLike } from "../vendor/bb-canvas/lib/canvas-threads";

type Sdk = ReturnType<typeof useSdk>;

/** The chat shows this many of the thread's newest messages. */
export const CHAT_MESSAGES = 6;

export type ChatMessage = { id: string; role: "user" | "assistant"; text: string };

/** The newest `limit` user and agent messages, oldest first. */
export function chatMessages(rows: readonly TimelineRowLike[], limit = CHAT_MESSAGES): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const row of rows) {
    if (row.kind !== "conversation" || (row.role !== "user" && row.role !== "assistant") || !row.text) continue;
    messages.push({ id: row.id, role: row.role, text: row.text });
  }
  return messages.slice(-limit);
}

export type ChatHistoryProps = {
  sdk: Sdk;
  threadId: string;
  threadLabel: string;
  /** Raised on every `thread:changed`: the history reloads. */
  version: number;
  /** The agent is at work: a "working…" line closes the list. */
  working: boolean;
  /** Messages sent from here that the timeline has not caught up with yet. */
  pending: readonly ChatMessage[];
};

export function ChatHistory({ sdk, threadId, threadLabel, version, working, pending }: ChatHistoryProps) {
  const [loaded, setLoaded] = useState<{ threadId: string; messages: ChatMessage[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Through a promise: a timeline that throws at once must fail like one
    // that rejects, not take the panel down with it.
    Promise.resolve()
      .then(() => sdk.threads.timeline({ threadId }))
      .then(
      (response) => {
        if (!cancelled) setLoaded({ threadId, messages: chatMessages(response.rows as unknown as readonly TimelineRowLike[]) });
      },
      // A failed reload keeps the last list; a first failure shows none.
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [sdk, threadId, version]);

  const messages = loaded?.threadId === threadId ? loaded.messages : [];
  const known = new Set(messages.map((message) => message.text));
  const shown = [...messages, ...pending.filter((message) => !known.has(message.text))];
  return (
    <Accordion title={`Chat · ${threadLabel}`} summary={working ? "working…" : undefined} storageKey="node:chat">
      {shown.length === 0 ? <div className="text-[11px] text-muted-foreground">No messages yet.</div> : null}
      <ol className="flex flex-col gap-1.5">
        {shown.map((message) => (
          <li
            key={message.id}
            className={`max-w-[92%] whitespace-pre-wrap break-words rounded-lg px-2.5 py-1.5 text-xs ${message.role === "user" ? "self-end bg-primary/15 text-foreground" : "self-start bg-muted text-foreground"}`}
          >
            {message.text.length > 600 ? `${message.text.slice(0, 600)}…` : message.text}
          </li>
        ))}
        {working ? (
          <li className="self-start rounded-lg bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
            <span aria-hidden className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary align-middle" />
            working…
          </li>
        ) : null}
      </ol>
    </Accordion>
  );
}

export type ChatComposerProps = {
  sdk: Sdk;
  threadId: string;
  threadLabel: string;
  onSent: (message: ChatMessage) => void;
  onOpenThread: () => void;
};

export function ChatComposer({ sdk, threadId, threadLabel, onSent, onOpenThread }: ChatComposerProps) {
  const [text, setText] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "sending" } | { kind: "queued" } | { kind: "error"; message: string }>({ kind: "idle" });
  const field = useRef<HTMLTextAreaElement>(null);
  // Another thread selected: a half-typed message must not go to it.
  useEffect(() => {
    setText("");
    setState({ kind: "idle" });
  }, [threadId]);

  const send = async () => {
    const message = text.trim();
    if (message === "" || state.kind === "sending") return;
    setState({ kind: "sending" });
    try {
      const result = await sdk.threads.send({ threadId, input: [{ type: "text", text: message, mentions: [] }], mode: "queue-if-active" });
      setText("");
      onSent({ id: `pending:${Date.now()}`, role: "user", text: message });
      setState(result.delivery === "queued" ? { kind: "queued" } : { kind: "idle" });
      field.current?.focus();
    } catch (cause) {
      setState({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-2 focus-within:border-primary/60">
      <textarea
        ref={field}
        aria-label={`Message to ${threadLabel}`}
        value={text}
        rows={2}
        placeholder={`Message ${threadLabel}…`}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // The canvas's own shortcuts must not fire while typing here.
          event.stopPropagation();
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
        }}
        className="max-h-40 min-h-[2.5rem] w-full resize-y bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
      />
      <div className="flex items-center gap-2">
        <span className={`min-w-0 flex-1 truncate text-[10px] ${state.kind === "error" ? "text-destructive" : "text-muted-foreground"}`} role={state.kind === "error" ? "alert" : undefined}>
          {state.kind === "error"
            ? `Not sent: ${state.message}`
            : state.kind === "queued"
              ? "Queued — delivered after the current turn"
              : state.kind === "sending"
                ? "Sending…"
                : "⌘↵ to send"}
        </span>
        <button
          type="button"
          onClick={onOpenThread}
          className="rounded-md border border-border px-2 py-1 text-[11px] text-foreground hover:bg-muted focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary"
        >
          Open thread
        </button>
        <button
          type="button"
          disabled={text.trim() === "" || state.kind === "sending"}
          onClick={() => void send()}
          className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50 focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary"
        >
          Send
        </button>
      </div>
    </div>
  );
}

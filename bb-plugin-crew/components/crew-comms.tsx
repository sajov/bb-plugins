// The crew's communication as a sequence, next to the canvas.
//
// Graph Studio's run timeline, applied to messages: one tick per message in
// the order it was sent. A tick selects the message — the canvas draws its
// flow strongest and moves the pair into view — and Replay walks the ticks
// one after another, so a conversation can be watched instead of read.
import { useEffect, useRef, useState } from "react";
import type { MessageDto } from "../server";
import { shortAddress } from "../lib/comms";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** How long the replay stays on one message. */
export const REPLAY_STEP_MS = 1600;

const TICK_TONE: Record<string, string> = {
  delivered: "border-border bg-card",
  queued: "border-border bg-card",
  pending: "border-sky-500/40 bg-sky-500/10",
  on_hold: "border-amber-500/40 bg-amber-500/10",
  throttled: "border-amber-500/40 bg-amber-500/10",
  stopped_loop: "border-red-500/40 bg-red-500/10",
  rejected: "border-red-500/40 bg-red-500/10",
  failed: "border-red-500/40 bg-red-500/10",
};

export function CommsStrip({
  messages,
  crewName,
  selectedId,
  onSelect,
}: {
  /** Oldest first, already cut to the strip's length (lib/comms.ts timeline). */
  messages: readonly MessageDto[];
  crewName: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const index = messages.findIndex((message) => message.id === selectedId);

  // One step per tick; the replay ends on the newest message.
  useEffect(() => {
    if (!playing) return;
    if (index >= messages.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => onSelect(messages[index + 1]!.id), REPLAY_STEP_MS);
    return () => clearTimeout(timer);
  }, [playing, index, messages, onSelect]);

  // Keep the selected tick visible while the replay walks the strip.
  useEffect(() => {
    if (!selectedId) return;
    const tick = list.current?.querySelector<HTMLElement>(`[data-tick="${selectedId}"]`);
    tick?.scrollIntoView?.({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [selectedId]);

  if (messages.length === 0) {
    return <p className="text-xs text-muted-foreground">No messages inside this crew yet — the canvas lights up once members talk.</p>;
  }
  const step = (delta: number) => {
    setPlaying(false);
    const next = index === -1 ? (delta > 0 ? 0 : messages.length - 1) : Math.min(messages.length - 1, Math.max(0, index + delta));
    onSelect(messages[next]!.id);
  };
  return (
    <div className="flex items-center gap-2" aria-label="Communication timeline">
      <div className="flex shrink-0 items-center gap-0.5">
        <Button size="sm" variant="ghost" className="h-7 px-1.5" aria-label="Previous message" disabled={index === 0} onClick={() => step(-1)}>
          <Icon name="ChevronLeft" className="size-4" />
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-xs"
          aria-pressed={playing}
          onClick={() => {
            if (playing) return setPlaying(false);
            // From the start unless a message in the middle is picked.
            if (index === -1 || index >= messages.length - 1) onSelect(messages[0]!.id);
            setPlaying(true);
          }}
        >
          <Icon name={playing ? "Pause" : "Play"} className="size-3.5" />
          {playing ? "Pause" : "Replay"}
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-1.5" aria-label="Next message" disabled={index === messages.length - 1} onClick={() => step(1)}>
          <Icon name="ChevronRight" className="size-4" />
        </Button>
      </div>
      <ol ref={list} aria-label="Messages in order" className="flex min-w-0 flex-1 gap-1 overflow-x-auto pb-1 text-[11px]">
        {messages.map((message) => {
          const selected = message.id === selectedId;
          return (
            <li key={message.id} className="shrink-0">
              <button
                type="button"
                data-tick={message.id}
                aria-pressed={selected}
                title={message.subject}
                onClick={() => {
                  setPlaying(false);
                  onSelect(selected ? null : message.id);
                }}
                className={cn(
                  "flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono",
                  TICK_TONE[message.status] ?? "border-border bg-card",
                  selected && "ring-2 ring-primary/60",
                )}
              >
                {shortAddress(message.fromAddress, crewName)}
                <Icon name="ArrowRight" className="size-3 text-muted-foreground" />
                {shortAddress(message.toAddress, crewName)}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The selected message in the side card's place: what was said, between whom, and where it stands. */
export function MessageCard({
  message,
  crewName,
  onClose,
  onOpenSender,
}: {
  message: MessageDto;
  crewName: string;
  onClose: () => void;
  onOpenSender?: (key: string) => void;
}) {
  const sender = message.fromAddress.endsWith(`@${crewName}`) ? shortAddress(message.fromAddress, crewName) : null;
  return (
    <aside aria-label="Message card" className="w-full flex-none rounded-lg border border-border bg-card p-4 text-xs lg:w-[300px]">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="m-0 min-w-0 flex-1 truncate text-sm font-semibold" title={message.subject}>
          {message.subject || "(no subject)"}
        </h3>
        <Button size="sm" variant="ghost" className="h-6 px-1.5" aria-label="Close message" onClick={onClose}>
          <Icon name="X" className="size-3.5" />
        </Button>
      </div>
      <div className="mb-3 flex items-center gap-1 font-mono text-muted-foreground">
        {shortAddress(message.fromAddress, crewName)}
        <Icon name="ArrowRight" className="size-3" />
        {shortAddress(message.toAddress, crewName)}
      </div>
      <p className="mb-3 max-h-60 overflow-y-auto whitespace-pre-wrap text-[12px] leading-5 [overflow-wrap:anywhere]">{message.body}</p>
      <dl className="mb-3 grid grid-cols-[90px_1fr] gap-x-2.5 gap-y-1.5">
        <dt className="text-muted-foreground">Status</dt>
        <dd className="m-0" data-message-status={message.status}>
          {message.status}
          {message.reason ? <span className="text-amber-400"> · {message.reason}</span> : null}
        </dd>
        <dt className="text-muted-foreground">Sent</dt>
        <dd className="m-0">{new Date(message.createdAt).toISOString().slice(0, 16).replace("T", " ")}</dd>
        <dt className="text-muted-foreground">Chain</dt>
        <dd className="m-0 font-mono">
          {message.chainId} · step {message.step}
        </dd>
        {message.priority === "urgent" ? (
          <>
            <dt className="text-muted-foreground">Priority</dt>
            <dd className="m-0 text-[#ef6b6b]">urgent</dd>
          </>
        ) : null}
      </dl>
      {sender && onOpenSender ? (
        <Button size="sm" variant="outline" className="h-7" onClick={() => onOpenSender(sender)}>
          Open {sender}
        </Button>
      ) : null}
    </aside>
  );
}

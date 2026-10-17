// A turn's steps as a terminal (BBP-320): no frame, no background, no
// scrollbar of its own — the canvas shows through, older lines fade out at
// the top, and a small count sits above. Each message is the same card as
// before, its tool calls the same log lines, indented under it. It follows
// the newest line until the reader scrolls back; "↓ live" returns.
import { useLayoutEffect, useRef, useState } from "react";
import { NodeCard, type NodeCardProps } from "./NodeCard";
import { STREAM_HEAD, STREAM_LINE } from "../lib/stream";

export type StreamLine = { id: string; card: NodeCardProps };
export type StreamViewGroup = { message?: StreamLine; steps: StreamLine[] };

export type StreamViewProps = {
  groups: readonly StreamViewGroup[];
  label: string;
  dimmed?: boolean;
};

const ROW = STREAM_LINE - 6;
const INDENT = 18;
/** Room between the stream's rail and its lines. */
const RAIL_GAP = 10;
const EXPANDER_ROOM = 34;
const FADE = "linear-gradient(to bottom, transparent 0, #000 36px)";

export function StreamView({ groups, label, dimmed = false }: StreamViewProps) {
  const viewport = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);
  // Folded by the reader, or opened: absent means the default, where only
  // the newest group (and steps before any message) are open.
  const [toggled, setToggled] = useState<ReadonlyMap<number, boolean>>(new Map());
  const isOpen = (index: number) => toggled.get(index) ?? (index === groups.length - 1 || !groups[index]!.message);
  const [overflows, setOverflows] = useState(false);

  // A new line, a fold, a new group: stay at the bottom while following.
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    if (follow) element.scrollTop = element.scrollHeight;
    const more = element.scrollHeight > element.clientHeight + 1;
    if (more !== overflows) setOverflows(more);
  });

  const onScroll = () => {
    const element = viewport.current;
    if (!element) return;
    setFollow(element.scrollTop + element.clientHeight >= element.scrollHeight - 4);
  };
  const toggle = (index: number) => setToggled((map) => new Map(map).set(index, !isOpen(index)));

  return (
    <div
      data-bb-stream
      style={{ position: "relative", width: "100%", height: "100%", opacity: dimmed ? 0.35 : 1, pointerEvents: dimmed ? "none" : "auto" }}
    >
      <button
        type="button"
        title="Jump to the first line"
        onClick={() => viewport.current?.scrollTo({ top: 0 })}
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          height: STREAM_HEAD - 6,
          padding: "0 8px",
          border: "1px solid var(--border)",
          borderRadius: 999,
          background: "var(--background)",
          color: "var(--muted-foreground)",
          fontSize: 10,
          cursor: "pointer",
          zIndex: 1,
        }}
      >
        {label}
      </button>
      {/* `nowheel`: a wheel over the stream scrolls it, not the canvas. */}
      <div
        ref={viewport}
        className="nowheel nodrag"
        role="log"
        aria-label={label}
        aria-live="off"
        onScroll={onScroll}
        style={{
          position: "absolute",
          inset: `${STREAM_HEAD}px 0 0 0`,
          overflowY: "auto",
          scrollbarWidth: "none",
          // Older lines fade out at the top — only once there are any.
          ...(overflows ? { maskImage: FADE, WebkitMaskImage: FADE } : {}),
          display: "flex",
          flexDirection: "column",
          // One rail down the stream's whole left edge: the turn's edge
          // arrives on it at any height, and every line hangs off it.
          borderLeft: "1px solid var(--border)",
          paddingLeft: RAIL_GAP,
          // A card's expander sits past its right edge; room for it here,
          // or the scroll box clips it.
          paddingRight: EXPANDER_ROOM,
        }}
      >
        {/* Bottom-anchored like a terminal: a short stream sits at the foot. */}
        <div style={{ flex: 1 }} />
        {groups.map((group, index) => {
          const open = isOpen(index);
          return (
            <div key={group.message?.id ?? `loose-${index}`}>
              {group.message ? (
                <div style={{ height: ROW, marginTop: 6 }}>
                  <NodeCard
                    {...group.message.card}
                    expander={
                      group.steps.length > 0 ? { expanded: open, childCount: group.steps.length, onToggle: () => toggle(index) } : undefined
                    }
                  />
                </div>
              ) : null}
              {open && group.steps.length > 0 ? (
                <div style={{ marginLeft: group.message ? INDENT : 0, paddingLeft: group.message ? 10 : 0, borderLeft: group.message ? "1px solid var(--border)" : "none" }}>
                  {group.steps.map((step) => (
                    <div key={step.id} style={{ height: ROW, marginTop: 6 }}>
                      <NodeCard {...step.card} />
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {follow ? null : (
        <button
          type="button"
          onClick={() => {
            const element = viewport.current;
            if (element) element.scrollTop = element.scrollHeight;
            setFollow(true);
          }}
          style={{
            position: "absolute",
            bottom: 4,
            left: "50%",
            transform: "translateX(-50%)",
            padding: "1px 10px",
            border: "1px solid var(--border)",
            borderRadius: 999,
            background: "var(--background)",
            color: "var(--foreground)",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          ↓ live
        </button>
      )}
    </div>
  );
}

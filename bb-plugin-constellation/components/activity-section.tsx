// The selected thread's full Activity list in the canvas sidebar (BBP-291,
// see BBP-264): every turn and row of its timeline, also the ones the turn
// limit keeps out of the canvas. Reloads whenever `version` changes (live).
import { useEffect, useState } from "react";
import type { useSdk } from "@get-bb/plugin-sdk/app";
import { activityList, type ActivityList } from "../vendor/bb-canvas/lib/activity";
import { threadNodeId, timelineToCanvas, type TimelineRowLike } from "../vendor/bb-canvas/lib/canvas-threads";
import { KindIcon } from "../vendor/bb-canvas/components/KindIcon";
import { Accordion } from "../vendor/bb-canvas/components/Accordion";

export type ActivitySectionProps = {
  sdk: ReturnType<typeof useSdk>;
  threadId: string;
  turnsPerThread: number | null;
  version: number;
  onReveal: (nodeId: string, inCanvas: boolean) => void;
};

export function ActivitySection({ sdk, threadId, turnsPerThread, version, onReveal }: ActivitySectionProps) {
  // Tagged with its thread, so a switch never shows the previous thread's list.
  const [loaded, setLoaded] = useState<{ threadId: string; list: ActivityList } | null>(null);
  useEffect(() => {
    let cancelled = false;
    // A failing or missing timeline leaves the section out until a load
    // succeeds; a failing live reload keeps the last list (BBP-283 review).
    Promise.resolve()
      .then(() => sdk.threads.timeline({ threadId }))
      .then(
        (response) => {
          if (cancelled) return;
          const { nodes } = timelineToCanvas(threadId, { rows: response.rows as unknown as readonly TimelineRowLike[] });
          setLoaded({ threadId, list: activityList(nodes, threadNodeId(threadId), turnsPerThread) });
        },
        () => {},
      );
    return () => {
      cancelled = true;
    };
  }, [sdk, threadId, turnsPerThread, version]);

  if (loaded === null || loaded.threadId !== threadId) return null;
  const { list } = loaded;
  // Turns newest first; a system row (context cleared, an error, …) stays in
  // place among them, at the turn it happened after (BBP-298).
  const entries = [...list.entries].reverse();
  return (
    <Accordion title="Turns" summary={list.header} storageKey="node:thread:turns">
      <ul className="flex flex-col gap-0.5">
        {entries.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              onClick={() => onReveal(entry.id, entry.inCanvas)}
              title={entry.inCanvas ? undefined : "Not in the canvas yet: click to show it"}
              className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary ${entry.inCanvas ? "text-foreground" : "text-muted-foreground opacity-70 hover:opacity-100"}`}
            >
              <KindIcon kind={entry.kind} />
              <span className={`min-w-0 flex-1 truncate ${entry.kind === "turn" ? "" : "text-muted-foreground"}`}>{entry.label}</span>
              {entry.detail ? <span className="shrink-0 text-[10px] text-muted-foreground">{entry.detail}</span> : null}
              {/* What the canvas shows carries a mark; the rest is one click away. */}
              {entry.inCanvas ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
            </button>
          </li>
        ))}
      </ul>
    </Accordion>
  );
}

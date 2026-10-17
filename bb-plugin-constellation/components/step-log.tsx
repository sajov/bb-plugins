// The selected thread's step log in the canvas sidebar (BBP-298): every
// command and tool call of its newest turns, newest first, also the ones the
// canvas folds behind "+N earlier". A finished turn's steps load per turn
// (`timelineTurnSummaryDetails`); a running turn's arrive loose in the
// thread's own timeline. Reloads whenever `version` changes (live).
import { useEffect, useState } from "react";
import type { useSdk } from "@get-bb/plugin-sdk/app";
import { threadNodeId, timelineToCanvas, turnDetailsToCanvas, type TimelineRowLike } from "../vendor/bb-canvas/lib/canvas-threads";
import { KindIcon } from "../vendor/bb-canvas/components/KindIcon";
import type { CanvasNode } from "../vendor/bb-canvas/lib/types";
import { Accordion } from "../vendor/bb-canvas/components/Accordion";

/** How many of the newest turns the log reads; older ones stay in the chat. */
export const LOG_TURNS = 10;

export type LogEntry = {
  id: string;
  /** The node the canvas can show for this entry: the step, else its turn. */
  revealId: string;
  label: string;
  detail: string;
  failed: boolean;
};

const STEP_KINDS = new Set(["tool-call", "subagent"]);

function entryOf(node: CanvasNode, revealId: string): LogEntry {
  const meta = node.meta ?? {};
  const exitCode = typeof meta.exitCode === "number" ? meta.exitCode : undefined;
  const facts = [
    typeof meta.toolName === "string" && meta.toolName !== node.label ? meta.toolName : undefined,
    typeof meta.duration === "string" ? meta.duration : undefined,
    exitCode !== undefined && exitCode !== 0 ? `exit ${exitCode}` : undefined,
  ].filter((fact): fact is string => fact !== undefined);
  return { id: node.id, revealId, label: node.label, detail: facts.join(" · "), failed: node.status === "failed" };
}

/** Steps of `nodes` in timeline order (earlier-folding removed). */
function stepsOf(nodes: readonly CanvasNode[]): CanvasNode[] {
  return nodes.filter((node) => STEP_KINDS.has(node.kind));
}

type Sdk = ReturnType<typeof useSdk>;

/** Every tool call and subagent of a thread's newest `turns` turns, oldest
 *  first: a finished turn's steps per turn, a running turn's loose ones last. */
export async function loadThreadSteps(sdk: Sdk, threadId: string, turns: number): Promise<CanvasNode[]> {
  const response = await sdk.threads.timeline({ threadId });
  const { nodes } = timelineToCanvas(threadId, { rows: response.rows as unknown as readonly TimelineRowLike[] });
  const thread = threadNodeId(threadId);
  const newest = nodes.filter((node) => node.kind === "turn" && node.parentId === thread).slice(-turns);
  const perTurn = await Promise.all(
    newest.map(async (turn) => {
      const { turnId, sourceSeqStart, sourceSeqEnd, summaryCount } = turn.meta ?? {};
      if (typeof turnId !== "string" || typeof sourceSeqStart !== "number" || typeof sourceSeqEnd !== "number" || summaryCount === 0) return [];
      try {
        const details = await sdk.threads.timelineTurnSummaryDetails({ threadId, turnId, sourceSeqStart: String(sourceSeqStart), sourceSeqEnd: String(sourceSeqEnd) });
        return stepsOf(turnDetailsToCanvas(turn.id, { rows: details.rows as unknown as readonly TimelineRowLike[] }, threadId).nodes);
      } catch {
        return [];
      }
    }),
  );
  return [...perTurn.flat(), ...stepsOf(nodes.filter((node) => node.parentId === thread))];
}

export async function loadStepLog(sdk: Sdk, threadId: string): Promise<LogEntry[]> {
  const steps = await loadThreadSteps(sdk, threadId, LOG_TURNS);
  return steps.map((step) => entryOf(step, step.id)).reverse();
}

export type StepLogProps = {
  sdk: Sdk;
  threadId: string;
  version: number;
  onReveal: (nodeId: string) => void;
};

export function StepLog({ sdk, threadId, version, onReveal }: StepLogProps) {
  // Tagged with its thread, so a switch never shows the previous thread's log.
  const [loaded, setLoaded] = useState<{ threadId: string; entries: LogEntry[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    // A failing load leaves the section out (first load) or keeps the last
    // log (live reload), as the Activity list does.
    loadStepLog(sdk, threadId).then(
      (entries) => {
        if (!cancelled) setLoaded({ threadId, entries });
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [sdk, threadId, version]);

  if (loaded === null || loaded.threadId !== threadId || loaded.entries.length === 0) return null;
  return (
    <Accordion
      title="Tool calls"
      summary={`${loaded.entries.length} in the last ${LOG_TURNS} turns`}
      defaultOpen={false}
      storageKey="node:thread:tools"
    >
      <ul className="flex flex-col gap-0.5">
        {loaded.entries.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              onClick={() => onReveal(entry.revealId)}
              title={entry.label}
              className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary"
            >
              <KindIcon kind="tool-call" />
              <span className={`min-w-0 flex-1 truncate font-mono text-[11px] ${entry.failed ? "text-destructive" : ""}`}>{entry.label}</span>
              {entry.detail ? <span className="shrink-0 text-[10px] text-muted-foreground">{entry.detail}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </Accordion>
  );
}

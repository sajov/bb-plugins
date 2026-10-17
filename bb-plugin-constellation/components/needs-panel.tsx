// The "Needs you" answer in the canvas sidebar (BBP-303): the question a
// graph run's approval or a crew member asks, a notes field and the answer
// buttons. The answer goes through the canvas backend to the plugin that
// asked; the card loses its amber state with the next layer poll.
import { useState } from "react";
import type { Needs } from "../lib/extensions";
import { Accordion } from "../vendor/bb-canvas/components/Accordion";

export type NeedsInfo = Needs & { question?: string; label?: string };

/** The node's `meta.needsYou` / `meta.waitsForYou`, when it names something answerable. */
export function needsOf(meta: Record<string, unknown> | undefined): NeedsInfo | null {
  const raw = (meta?.needsYou ?? meta?.waitsForYou) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return null;
  const question = typeof raw.question === "string" ? raw.question : undefined;
  const label = typeof raw.label === "string" ? raw.label : undefined;
  if (raw.kind === "graph-studio" && typeof raw.runId === "string") {
    return { kind: "graph-studio", runId: raw.runId, nodeId: typeof raw.nodeId === "string" ? raw.nodeId : undefined, question, label };
  }
  if (raw.kind === "crew" && typeof raw.projectId === "string" && typeof raw.address === "string") {
    return { kind: "crew", projectId: raw.projectId, address: raw.address, question, label };
  }
  return null;
}

export type NeedsPanelProps = {
  needs: NeedsInfo;
  answer: (needs: Needs, answer: string) => Promise<{ ok: boolean; error: string | null }>;
};

export function NeedsPanel({ needs, answer }: NeedsPanelProps) {
  const [notes, setNotes] = useState("");
  const [state, setState] = useState<{ busy: boolean; sent: boolean; error: string | null }>({ busy: false, sent: false, error: null });
  const send = async (verdict: string | null) => {
    const text = verdict === null ? notes.trim() : [verdict, notes.trim()].filter(Boolean).join("\n\n");
    if (!text) return;
    setState({ busy: true, sent: false, error: null });
    try {
      const result = await answer(needs, text);
      setState({ busy: false, sent: result.ok, error: result.error });
      if (result.ok) setNotes("");
    } catch (error) {
      setState({ busy: false, sent: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
  // An approval answers OK or REVISE; a crew question takes free text.
  const verdicts = needs.kind === "graph-studio" ? ["OK", "REVISE"] : [];
  const button =
    "rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary";
  return (
    <Accordion title="Needs you" summary={needs.label} storageKey="node:needs">
      {needs.question ? (
        <div className="whitespace-pre-wrap rounded border border-amber-500/50 bg-amber-500/10 px-2 py-1.5 text-xs text-foreground">{needs.question}</div>
      ) : null}
      <textarea
        aria-label="Notes"
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
        placeholder={verdicts.length ? "Notes (optional)" : "Your answer"}
        rows={4}
        className="w-full resize-y rounded border border-border bg-background px-2 py-1 text-xs text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary"
      />
      <div className="flex flex-wrap gap-1.5">
        {verdicts.map((verdict) => (
          <button key={verdict} type="button" disabled={state.busy} onClick={() => send(verdict)} className={`${button} ${verdict === "OK" ? "bg-primary text-primary-foreground hover:bg-primary/90" : "border border-border text-foreground hover:bg-muted"}`}>
            {verdict}
          </button>
        ))}
        {verdicts.length === 0 ? (
          <button type="button" disabled={state.busy || !notes.trim()} onClick={() => send(null)} className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`}>
            Send
          </button>
        ) : null}
      </div>
      {state.sent ? <div className="text-[11px] text-muted-foreground">Answer sent.</div> : null}
      {state.error ? <div className="text-[11px] text-destructive">{state.error}</div> : null}
    </Accordion>
  );
}

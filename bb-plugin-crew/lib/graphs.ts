// Bridge to bb-plugin-graph-studio for crew.yaml's `graphs: [...]` (BBP-30):
// the names used to validate that field, and running one to completion for
// `crew_graph_run`. Pure over the RPC call and the clock, so both are
// fakeable in tests without a real graph-studio or real timers.

export type GraphSummary = { id: string; name: string };

export type RunStatus = "running" | "stopping" | "waiting-human" | "done" | "failed" | "stopped";

export type GraphRun = {
  id: string;
  status: RunStatus;
  error: string | null;
  /** The run's state (graph-studio's `RunDto.state`); opaque here, formatted by the caller. */
  state: unknown;
  /** Worker thread ids of its member nodes (`NodeRunDto.childThreadId`), for BBP-31's delete cleanup. */
  childThreadIds: string[];
};

export type GraphsRpc = {
  listGraphs(): Promise<GraphSummary[]>;
  /** `threadId` is required: graph-studio's startRun rejects a run without a parent thread, whose environment the workers inherit. */
  startRun(args: { graphId: string; input: string; threadId: string; projectId: string | null }): Promise<GraphRun>;
  getRun(id: string): Promise<GraphRun | null>;
  /** BBP-31: `bb crew stop` cancels open runs with this. */
  stopRun(id: string): Promise<GraphRun | null>;
};

/** `bb.sdk.plugins.callRpc({ pluginId: "graph-studio", ... })`, wrapped the way `createTasksRpcPort` wraps the tasks plugin. */
export function createGraphsRpc(callRpc: (method: string, input: unknown) => Promise<unknown>): GraphsRpc {
  const toRun = (run: unknown): GraphRun => {
    const r = run as { id: string; status: RunStatus; error: string | null; state?: unknown; nodeRuns?: { childThreadId: string | null }[] };
    return {
      id: r.id,
      status: r.status,
      error: r.error,
      state: r.state ?? null,
      childThreadIds: (r.nodeRuns ?? []).map((node) => node.childThreadId).filter((id): id is string => typeof id === "string"),
    };
  };
  return {
    async listGraphs() {
      const result = (await callRpc("listGraphs", null)) as { graphs: GraphSummary[]; templates: GraphSummary[] };
      return [...result.graphs, ...result.templates];
    },
    async startRun(args) {
      const result = (await callRpc("startRun", { graphId: args.graphId, input: args.input, threadId: args.threadId, projectId: args.projectId })) as { run: unknown };
      return toRun(result.run);
    },
    async getRun(id) {
      const result = (await callRpc("getRun", { id })) as { run: unknown | null };
      return result.run ? toRun(result.run) : null;
    },
    async stopRun(id) {
      const result = (await callRpc("stopRun", { runId: id })) as { run: unknown | null };
      return result.run ? toRun(result.run) : null;
    },
  };
}

const TERMINAL: ReadonlySet<RunStatus> = new Set(["done", "failed", "stopped"]);

export type RunToCompletionOptions = {
  /** Between polls; default 500ms. */
  pollMs?: number;
  /** Give up and report timedOut once this much time has passed; default 60s. */
  timeoutMs?: number;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Fires right after the run starts, so the caller can record it durably (BBP-31). */
  onStart?: (run: GraphRun) => void;
  /** Fires after every status change seen while polling, including the final one. */
  onPoll?: (run: GraphRun) => void;
};

export type RunOutcome = { run: GraphRun; timedOut: boolean };

/** Start a run and poll until it reaches a terminal status or the timeout passes. */
export async function runToCompletion(
  rpc: Pick<GraphsRpc, "startRun" | "getRun">,
  args: { graphId: string; input: string; threadId: string; projectId: string | null },
  options: RunToCompletionOptions = {},
): Promise<RunOutcome> {
  const pollMs = options.pollMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const started = now();
  let run = await rpc.startRun(args);
  options.onStart?.(run);
  while (!TERMINAL.has(run.status)) {
    if (now() - started >= timeoutMs) return { run, timedOut: true };
    await wait(pollMs);
    const polled = await rpc.getRun(run.id);
    // getRun returning null mid-poll means the run is gone, not that it succeeded.
    if (!polled) {
      const vanished: GraphRun = { ...run, status: "failed", error: "The run vanished (graph-studio no longer has it)." };
      options.onPoll?.(vanished);
      return { run: vanished, timedOut: false };
    }
    run = polled;
    options.onPoll?.(run);
  }
  return { run, timedOut: false };
}

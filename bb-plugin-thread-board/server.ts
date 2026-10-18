// bb-plugin-thread-board — every thread on a kanban board by what it needs
// next, with a model-written purpose line per thread.
//
// The purpose comes from a hidden worker thread (the Listen pattern): it runs
// on a model the user already pays for, set in this plugin's settings, and is
// archived and stopped straight after. Results live in bb.storage.kv.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  MESSAGE_EVENT_TYPES,
  buildPrompt,
  buildTranscript,
  messagesFromEvents,
  needsEvaluation,
  parseAssessment,
  purposeSchema,
  type Message,
  type Purpose,
} from "./lib/purpose";

export const rpcContract = defineRpcContract({
  purposes: {
    input: z.null(),
    output: z.object({
      purposes: z.record(z.string(), purposeSchema),
      markedDone: z.array(z.string()),
      staleDays: z.number(),
      model: z.string(),
      evaluating: z.array(z.string()),
    }),
  },
  refresh: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ queued: z.boolean() }),
  },
  evaluateMany: {
    input: z.object({ threadIds: z.array(z.string().min(1)).max(500) }),
    output: z.object({ queued: z.number() }),
  },
  setDone: {
    input: z.object({ threadId: z.string().min(1), done: z.boolean() }),
    output: z.object({ ok: z.boolean() }),
  },
  send: {
    input: z.object({ threadId: z.string().min(1), text: z.string().trim().min(1).max(2000) }),
    output: z.object({ ok: z.boolean() }),
  },
  archive: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ ok: z.boolean() }),
  },
});

/** Realtime channel the board and the header bar refetch on. */
export const CHANGED = "purposes-changed";

const PURPOSES_KEY = "purposes";
const DONE_KEY = "marked-done";
// The events API rejects pages above 100.
const EVENT_PAGE = 100;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    model: {
      type: "string",
      label: "Evaluation model",
      description: "The BB model id the hidden evaluation thread runs on. Empty uses the project default.",
      default: "claude-opus-5-5",
    },
    provider: {
      type: "string",
      label: "Evaluation provider",
      description: "The BB provider that owns the model above. Empty uses the project default.",
      default: "claude-code",
    },
    autoEvaluate: {
      type: "boolean",
      label: "Evaluate automatically",
      description: "Re-assess a thread each time its agent goes idle with something new said. Off: only the refresh button evaluates.",
      default: true,
    },
    minIntervalMinutes: {
      type: "number",
      label: "Minimum minutes between evaluations",
      description: "Per thread. Keeps a busy thread from paying for an evaluation on every turn.",
      default: 10,
    },
    staleDays: {
      type: "number",
      label: "Stale after (days)",
      description: "An idle thread with no activity for this long moves to the Stale column.",
      default: 7,
    },
  });

  async function readPurposes(): Promise<Record<string, Purpose>> {
    return (await bb.storage.kv.get<Record<string, Purpose>>(PURPOSES_KEY)) ?? {};
  }
  async function readMarkedDone(): Promise<string[]> {
    return (await bb.storage.kv.get<string[]>(DONE_KEY)) ?? [];
  }

  async function threadMessages(threadId: string): Promise<Message[]> {
    const events: { type: string; data: unknown }[] = [];
    let afterSeq: string | undefined;
    for (;;) {
      const page = await bb.sdk.threads.events.list({
        threadId,
        afterSeq,
        limit: String(EVENT_PAGE),
        types: [...MESSAGE_EVENT_TYPES],
      });
      events.push(...page);
      if (page.length < EVENT_PAGE) break;
      afterSeq = String(page[page.length - 1].seq);
    }
    return messagesFromEvents(events);
  }

  /** Hidden workers we started, so their own idle events do not loop back. */
  const ourWorkers = new Set<string>();

  async function evaluate(threadId: string, force: boolean): Promise<void> {
    const values = await settings.get();
    const thread = await bb.sdk.threads.get({ threadId });
    const messages = await threadMessages(threadId);
    const stored = (await readPurposes())[threadId];
    if (messages.length === 0) return;
    // The refresh button means "now": it skips the unchanged and interval checks.
    if (!force && !needsEvaluation(stored, messages.length, Date.now(), values.minIntervalMinutes * 60000)) return;

    const model = values.model.trim();
    const providerId = values.provider.trim();
    const title = thread.title ?? thread.titleFallback ?? "Untitled";
    let workerId: string | null = null;
    try {
      const worker = await bb.sdk.threads.spawn({
        projectId: thread.projectId,
        environment: { type: "project-default" },
        prompt: buildPrompt(title, buildTranscript(messages)),
        title: "Thread Board: purpose",
        visibility: "hidden",
        // Omitted rather than passed empty: BB then resolves the project's
        // own defaults, which is what "no opinion" has to mean here.
        ...(model === "" ? {} : { model }),
        ...(providerId === "" ? {} : { providerId }),
        pluginMetadata: { purpose: "thread-assessment" },
      });
      workerId = worker.id;
      ourWorkers.add(worker.id);
      await bb.sdk.threads.wait({ threadId: worker.id, status: "idle" });
      const { output } = await bb.sdk.threads.output({ threadId: worker.id });
      const assessment = parseAssessment(output);
      if (assessment === null) {
        bb.log.warn(`could not read an assessment for ${threadId} from: ${String(output).slice(0, 200)}`);
        return;
      }
      // Re-read: another evaluation may have written while this one ran.
      const purposes = await readPurposes();
      purposes[threadId] = {
        ...assessment,
        threadId,
        messageCount: messages.length,
        evaluatedAt: Date.now(),
        model: model || "project default",
      };
      await bb.storage.kv.set(PURPOSES_KEY, purposes);
    } finally {
      if (workerId !== null) {
        ourWorkers.delete(workerId);
        // A hidden worker holds an agent process until it is stopped.
        await bb.sdk.threads.archive({ threadId: workerId }).catch(() => {});
        await bb.sdk.threads.stop({ threadId: workerId }).catch(() => {});
      }
    }
  }

  // One evaluation at a time: each one is a full agent session, and a burst
  // of idle events must not start a dozen of them.
  const queued = new Set<string>();
  let chain: Promise<void> = Promise.resolve();
  function enqueue(threadId: string, force: boolean): boolean {
    if (queued.has(threadId)) return false;
    queued.add(threadId);
    bb.realtime.publish(CHANGED, {});
    chain = chain
      .then(() => evaluate(threadId, force))
      .catch((cause) => bb.log.warn(`evaluation of ${threadId} failed: ${String(cause)}`))
      .finally(() => {
        queued.delete(threadId);
        bb.realtime.publish(CHANGED, {});
      });
    return true;
  }

  bb.events.on("thread.idle", ({ thread }) => {
    void (async () => {
      if (ourWorkers.has(thread.id)) return;
      if (thread.originPluginId === bb.pluginId) return;
      if (!(await settings.get()).autoEvaluate) return;
      enqueue(thread.id, false);
    })();
  });

  bb.rpc.register(rpcContract, {
    purposes: async () => {
      const values = await settings.get();
      return {
        purposes: await readPurposes(),
        markedDone: await readMarkedDone(),
        staleDays: values.staleDays,
        model: values.model.trim() || "project default",
        evaluating: [...queued],
      };
    },
    refresh: async ({ threadId }) => ({ queued: enqueue(threadId, true) }),
    // Not forced: threads whose stored assessment is still current are skipped
    // inside the queue, so pressing the button twice costs nothing extra.
    evaluateMany: async ({ threadIds }) => ({
      queued: threadIds.filter((threadId) => enqueue(threadId, false)).length,
    }),
    setDone: async ({ threadId, done }) => {
      const marked = new Set(await readMarkedDone());
      if (done) marked.add(threadId);
      else marked.delete(threadId);
      await bb.storage.kv.set(DONE_KEY, [...marked]);
      bb.realtime.publish(CHANGED, {});
      return { ok: true };
    },
    send: async ({ threadId, text }) => {
      await bb.sdk.threads.send({ threadId, input: [{ type: "text", text, mentions: [] }], mode: "queue-if-active" });
      return { ok: true };
    },
    archive: async ({ threadId }) => {
      await bb.sdk.threads.archive({ threadId });
      bb.realtime.publish(CHANGED, {});
      return { ok: true };
    },
  });

  const usage = [
    "Usage:",
    "  bb thread-board purpose <thread-id> [--json]     Show a thread's stored purpose",
    "  bb thread-board refresh <thread-id>              Re-evaluate a thread now",
  ].join("\n");
  bb.cli.register({
    name: "thread-board",
    summary: "Read or refresh the model-written purpose of a thread",
    commands: [
      { name: "purpose", summary: "Show a thread's purpose, progress and state", usage: "bb thread-board purpose <thread-id> [--json]" },
      { name: "refresh", summary: "Queue a fresh evaluation of a thread", usage: "bb thread-board refresh <thread-id>" },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const [command, rawId] = argv.filter((arg) => arg !== "--json");
      const threadId = rawId ?? ctx.threadId;
      if (command === undefined || command === "help" || command === "--help") return { exitCode: 0, stdout: usage };
      if (threadId === undefined) return { exitCode: 1, stderr: `A thread id is required.\n${usage}` };
      if (command === "purpose") {
        const purpose = (await readPurposes())[threadId];
        if (purpose === undefined) {
          return { exitCode: 1, stderr: `No purpose stored for ${threadId}. Run "bb thread-board refresh ${threadId}".` };
        }
        if (json) return { exitCode: 0, stdout: JSON.stringify(purpose) };
        const lines = [
          `${purpose.state} · ${purpose.progress}%`,
          purpose.purpose,
          ...(purpose.nextStep ? [`Next: ${purpose.nextStep}`] : []),
          `evaluated ${new Date(purpose.evaluatedAt).toISOString()} with ${purpose.model}`,
        ];
        return { exitCode: 0, stdout: lines.join("\n") };
      }
      if (command === "refresh") {
        const fresh = enqueue(threadId, true);
        return { exitCode: 0, stdout: fresh ? `Queued ${threadId}.` : `${threadId} is already queued.` };
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  return () => {
    queued.clear();
  };
}

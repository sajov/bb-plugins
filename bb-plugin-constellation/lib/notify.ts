// BBP-174 spike 2: canvas.notify as a pure invalidation signal (no payload).
// Requires @get-bb/plugin-sdk >= 0.6.15, where `experimental_caller` on the
// rpc handler's second argument names the calling plugin with a per-load
// token only the server knows (see Spike 1 finding: 0.5.x has no such thing).
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const notifyContract = defineRpcContract({
  "canvas.notify": {
    input: z.object({ pluginId: z.string().min(1), scope: z.record(z.string(), z.unknown()).optional() }),
    output: z.object({ accepted: z.boolean() }),
  },
});

export type ReloadTracker = {
  /** Re-pulls `canvasExtension.layer(scope)` from the extension — stubbed in this prototype. */
  reload(pluginId: string, scope: unknown): void;
};

const DEBOUNCE_MS = 600;

export function registerCanvasNotify(bb: BbPluginApi, tracker: ReloadTracker, options: { knownExtensions: ReadonlySet<string> }): void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  bb.rpc.register(notifyContract, {
    "canvas.notify": ({ pluginId, scope }, { experimental_caller }) => {
      const accepted = experimental_caller.kind === "plugin" && experimental_caller.pluginId === pluginId && options.knownExtensions.has(pluginId);
      if (!accepted) return { accepted: false };

      const key = `${pluginId}:${JSON.stringify(scope ?? null)}`;
      const existing = timers.get(key);
      if (existing) clearTimeout(existing);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          tracker.reload(pluginId, scope);
        }, DEBOUNCE_MS),
      );
      return { accepted: true };
    },
  });
}

const POLL_MS = 10_000;

/** For an extension that never sends `notify` (no push support, or still on SDK 0.5.x). */
export function startPollingFallback(pluginId: string, scope: unknown, tracker: ReloadTracker): () => void {
  const timer = setInterval(() => tracker.reload(pluginId, scope), POLL_MS);
  return () => clearInterval(timer);
}

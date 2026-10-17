// bb-plugin-constellation — backend entry.
//
// The page reads threads and projects straight from the SDK in the frontend;
// the backend only declares the overview window's settings (BBP-287, same
// names and ranges as agent-graph), which the page reads with useSettings.
// `lib/notify.ts` (canvas.notify, SDK >= 0.6.15) is wired in once extensions
// push their layers (FT4/FT5).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { answerNeeds, collectLayers, extensionContract } from "./lib/extensions";

/** collectLayers checks each answer itself; the call only has to deliver it. */
const anyOutput = z.unknown();

/** Plugin states that answer RPC (as crew's own check, canvas-layer.ts). */
const ACTIVE = new Set(["running", "starting", "degraded", "needs-configuration"]);

export default function canvas(bb: BbPluginApi) {
  // BBP-190: crews (and later graph runs) from the plugins that know them.
  bb.rpc.register(extensionContract, {
    extensionLayers: async ({ projectIds, sinceMs }) => {
      let active = new Set<string>();
      try {
        const { plugins } = await bb.sdk.plugins.list();
        active = new Set(plugins.filter((plugin) => plugin.enabled && ACTIVE.has(plugin.status)).map((plugin) => plugin.id));
      } catch {
        // Unsure which plugins run: ask them all, a missing one just fails its call.
        active = new Set(["crew"]);
      }
      return collectLayers(projectIds, active, (pluginId, method, input) => bb.sdk.plugins.callRpc({ pluginId, method, input: input as Record<string, string>, outputSchema: anyOutput }), sinceMs);
    },
    answerNeeds: ({ needs, answer }) =>
      answerNeeds(needs, answer, (pluginId, method, input) => bb.sdk.plugins.callRpc({ pluginId, method, input: input as Record<string, string>, outputSchema: anyOutput })),
  });
  bb.settings.define({
    windowHours: {
      type: "number",
      label: "Overview window (hours)",
      description: "Threads updated within this many hours, 1–720. Running, waiting and failed threads always show.",
      default: 12,
    },
    maxThreads: {
      type: "number",
      label: "Threads in the overview",
      description: "At most this many threads, newest first, 1–100.",
      default: 20,
    },
    overviewTurns: {
      type: "number",
      label: "Turns per thread",
      description: "The newest turns an opened thread shows, 0–10.",
      default: 1,
    },
  });
}

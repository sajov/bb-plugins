// BBP-190: the canvas pulls crews (and later graph runs) from the plugins
// that know them, server-side, over each plugin's own `canvasLayer` RPC. The
// canvas knows nothing about their internals: a layer is plain bb-canvas
// nodes, edges and frames hung under the project nodes the canvas already
// draws. A plugin that is not installed, disabled or failing simply adds
// nothing — the canvas works without it.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const loose = z.record(z.string(), z.unknown());

export const layerSchema = z.object({
  nodes: z.array(loose),
  edges: z.array(loose),
  expanded: z.array(z.string()),
  frames: z.array(loose),
});

export const needsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("graph-studio"), runId: z.string().min(1), nodeId: z.string().optional() }),
  z.object({ kind: z.literal("crew"), projectId: z.string().min(1), address: z.string().min(1) }),
]);

export type ExtensionLayer = z.infer<typeof layerSchema>;

export const extensionContract = defineRpcContract({
  /** Every installed extension's layer for these projects, merged. */
  extensionLayers: {
    /** `sinceMs`: the overview window's start, passed on to each extension. */
    input: z.object({ projectIds: z.array(z.string().min(1)), sinceMs: z.number().optional() }),
    output: layerSchema.extend({ sources: z.array(z.string()) }),
  },
  /** BBP-303: answers a "Needs you" from the canvas sidebar, in the plugin that asked. */
  answerNeeds: {
    input: z.object({ needs: needsSchema, answer: z.string().min(1).max(4000) }),
    output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
  },
});

/** What a node's `meta.needsYou` names: a graph run's approval or a crew member's question. */
export type Needs = z.infer<typeof needsSchema>;

/** Routes an answer to the plugin that asked; a failing call becomes the error. */
export async function answerNeeds(needs: Needs, answer: string, call: CallRpc): Promise<{ ok: boolean; error: string | null }> {
  try {
    if (needs.kind === "graph-studio") {
      await call("graph-studio", "answerHuman", { runId: needs.runId, answer, nodeId: needs.nodeId });
    } else {
      const result = (await call("crew", "sendMessage", { projectId: needs.projectId, to: needs.address, body: answer, crew: null, replyTo: null })) as { error?: string | null } | null;
      if (result?.error) return { ok: false, error: result.error };
    }
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The plugins the canvas asks, by id, with the method they answer. */
export const EXTENSIONS: readonly { pluginId: string; method: string }[] = [
  { pluginId: "crew", method: "canvasLayer" },
  // BBP-191: graph runs, hung under the thread they were started from.
  { pluginId: "graph-studio", method: "canvasExtensionLayer" },
];

export type CallRpc = (pluginId: string, method: string, input: unknown) => Promise<unknown>;

const EMPTY: ExtensionLayer = { nodes: [], edges: [], expanded: [], frames: [] };

/** Asks each active extension for each project and merges the answers. A
 *  failing call costs only that extension's part. */
export async function collectLayers(
  projectIds: readonly string[],
  active: ReadonlySet<string>,
  call: CallRpc,
  sinceMs?: number,
): Promise<ExtensionLayer & { sources: string[] }> {
  const merged: ExtensionLayer & { sources: string[] } = { ...EMPTY, nodes: [], edges: [], expanded: [], frames: [], sources: [] };
  for (const { pluginId, method } of EXTENSIONS) {
    if (!active.has(pluginId)) continue;
    const layers = await Promise.all(
      projectIds.map(async (projectId) => {
        try {
          return layerSchema.parse(await call(pluginId, method, sinceMs === undefined ? { projectId } : { projectId, sinceMs }));
        } catch {
          return null;
        }
      }),
    );
    let answered = false;
    for (const layer of layers) {
      if (!layer) continue;
      answered = true;
      merged.nodes.push(...layer.nodes);
      merged.edges.push(...layer.edges);
      merged.expanded.push(...layer.expanded);
      merged.frames.push(...layer.frames);
    }
    if (answered) merged.sources.push(pluginId);
  }
  return merged;
}

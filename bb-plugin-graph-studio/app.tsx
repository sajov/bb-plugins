// bb-plugin-graph-studio — frontend entry.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { GraphStudioPanel } from "./components/graph-studio-panel";
import { GraphStudioRunBanner } from "./components/run-banner";
import { GraphRunCard } from "./components/run-card";
import { GRAPH_STUDIO_ICON, GraphStudioFlow } from "./components/graph-studio-icon";

/** `params` crosses the host boundary as JSON — read it, never trust it. */
function runIdFrom(params: unknown): string | null {
  if (typeof params !== "object" || params === null) return null;
  const value = (params as Record<string, unknown>).runId;
  return typeof value === "string" && value !== "" ? value : null;
}

export default definePluginApp((app) => {
  // One glyph everywhere, the same as the sidebar's branding icon.
  app.experimental_icons.register({ name: GRAPH_STUDIO_ICON, component: GraphStudioFlow });
  app.slots.navPanel({
    id: "studio",
    title: "Graph Studio",
    icon: GRAPH_STUDIO_ICON,
    path: "studio",
    component: () => <GraphStudioPanel />,
  });

  app.slots.threadPanelAction({
    id: "studio",
    title: "Graph Studio",
    icon: GRAPH_STUDIO_ICON,
    layout: "flush",
    run: async ({ openPanel }) => {
      openPanel({ title: "Graph Studio" });
    },
    component: ({ threadId, params }) => (
      <GraphStudioPanel threadId={threadId} initialRunId={runIdFrom(params)} />
    ),
  });

  // Above the composer of the thread that owns the run: with several windows
  // open, the panel alone does not say which conversation it belongs to.
  app.composer.customize({
    id: "graph-studio-run",
    scopes: ["thread"],
    banners: [{ id: "run", component: GraphStudioRunBanner, chrome: "bare" }],
  });

  // The run inline in the message that started it: `::graph-run{run="…"}`,
  // which graph_studio_run tells the agent to put in its reply.
  app.slots.messageDirective({ id: "graph-run", component: GraphRunCard });

  app.slots.commandPaletteAction({
    id: "open-graph-studio",
    title: "Graph Studio: open the panel",
    isAvailable: ({ threadId }) => threadId != null,
    run: ({ openPanel }) => {
      openPanel({ actionId: "studio", title: "Graph Studio" });
    },
  });
});

// @vitest-environment jsdom
import { expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import pluginApp from "../app";
import type { RecallStatus } from "../server";

const status: RecallStatus = {
  qmdAvailable: false, phase: "inactive", documents: 0, lastIndexedAt: null,
  progress: null, error: null, counts: { threads: 0, tasks: 0, files: 0 },
  folders: [], invalidFolders: [], hostId: null, defaultMode: "smart",
};

it("the real panel explains an inactive source choice before any qmd warning", async () => {
  const app = await loadPluginApp(pluginApp);
  const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_fixture", params: null }, {
    rpc: { status: () => status, search: () => ({ hits: [], mode: "smart", fallback: true, tookMs: 0 }) },
  });
  try {
    expect(await slot.findByText("Recall is inactive · choose sources in plugin settings")).toBeTruthy();
    expect(slot.queryByText("qmd not installed · keyword search only")).toBeNull();
    expect(slot.queryByText(/Indexing · inactive/)).toBeNull();
  } finally { slot.lifecycle.unmount(); }
});

it("an explicitly active source still shows the existing qmd-missing explanation", async () => {
  const app = await loadPluginApp(pluginApp);
  const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_fixture", params: null }, {
    rpc: { status: () => ({ ...status, phase: "idle", documents: 1, counts: { threads: 0, tasks: 1, files: 0 } }), search: () => ({ hits: [], mode: "smart", fallback: true, tookMs: 0 }) },
  });
  try {
    expect(await slot.findByText("qmd not installed · keyword search only")).toBeTruthy();
    expect(slot.queryByText(/Recall is inactive/)).toBeNull();
  } finally { slot.lifecycle.unmount(); }
});

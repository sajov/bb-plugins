import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { rpcContract } from "../server.js";
import type { QmdHit } from "../lib/qmd.js";

// Every corpus and external effect is synthetic. Unexpected paths/commands fail closed.
const external = vi.hoisted(() => ({
  disk: new Map<string, string>(), io: [] as { method: string; path: string }[],
  commands: [] as { binary: string; args: string[] }[], qmd: false, hits: [] as QmdHit[],
}));
vi.mock("node:fs/promises", () => {
  const check = (method: string, path: string) => {
    if (!path.startsWith("/fictional-bb/") && !path.startsWith("/fiction/docs")) throw new Error(`Forbidden test access: ${path}`);
    external.io.push({ method, path });
  };
  return {
    mkdir: async (path: string) => { check("mkdir", path); },
    writeFile: async (path: string, text: string) => { check("write", path); external.disk.set(path, text); },
    readFile: async (path: string) => { check("read", path); const value = external.disk.get(path); if (value === undefined) throw new Error("missing fixture"); return value; },
    rm: async (path: string) => { check("remove", path); external.disk.delete(path); },
    readdir: async (path: string, options?: { withFileTypes?: boolean }) => {
      check("list", path);
      if (path === "/fiction/docs" && options?.withFileTypes) return [{ name: "note.md", isDirectory: () => false, isFile: () => true }];
      return [...external.disk.keys()].filter(key => key.startsWith(path + "/")).map(key => key.slice(path.length + 1));
    },
  };
});
vi.mock("node:child_process", () => ({
  execFile: (binary: string, args: string[], _options: unknown, done: (error: Error | null, stdout: string, stderr: string) => void) => {
    external.commands.push({ binary, args: [...args] });
    if (args[0] === "tasks" && args[1] === "list") {
      done(null, JSON.stringify({ tasks: [{ id: "task_fixture", key: "TEST-1", title: "Fictional task", description: "Only synthetic text", status: "todo", priority: "none", updatedAt: "2026-01-01T00:00:00Z" }], nextCursor: null }), "");
    } else if (binary === "qmd") {
      done(external.qmd ? null : new Error("qmd fixture unavailable"), args.includes("--json") ? JSON.stringify(external.hits) : "", "");
    } else throw new Error(`Forbidden external command: ${binary} ${args.join(" ")}`);
  },
}));

type Running = { controller: AbortController; done: Promise<void> };
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => { vi.useFakeTimers(); external.disk.clear(); external.io.length = 0; external.commands.length = 0; external.qmd = false; external.hits = []; });
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });
async function setup(settings: Record<string, string | number | boolean> = {}) {
  const list = vi.fn(async ({ archived }: { archived?: boolean } = {}) => [makeThreadResponse({ id: archived ? "thr_archived_fixture" : "thr_active_fixture", projectId: "project_fixture", title: "Fictional thread", updatedAt: 1 })]);
  const events = vi.fn(async () => [{ seq: 1, type: "client/turn/requested", data: { input: [{ type: "text", text: "Fictional conversation" }] } }]);
  const search = vi.fn(async () => ({ active: { results: [] }, archived: { results: [] } }));
  const { bb, harness } = createFakePluginHost({ pluginId: "recall", dataDir: "/fictional-bb", settings,
    sdk: { projects: { list: async () => [] }, hosts: { list: async () => [] }, threads: { list, events: { list: events }, search } },
  });
  plugin(bb);
  let service: Running | undefined;
  cleanups.push(async () => { if (service) { service.controller.abort(); await service.done; } await harness.lifecycle.dispose(); });
  const status = async () => rpcContract.status.output.parse(await harness.behavior.callRpc("status", null));
  const get = async (input: { kind: "thread" | "task" | "file"; id: string }) => rpcContract.get.output.parse(await harness.behavior.callRpc("get", input));
  const query = async () => rpcContract.search.output.parse(await harness.behavior.callRpc("search", { query: "fictional", limit: 5 }));
  const begin = () => { service = harness.behavior.runService("indexer"); return service; };
  const start = async () => {
    begin();
    await vi.waitFor(async () => expect((await status()).phase).toMatch(/^(idle|inactive)$/));
  };
  const settingsChanged = async (values: Record<string, string | number | boolean>) => {
    await harness.behavior.setSettings(values);
    for (let i = 0; i < 80; i++) await Promise.resolve();
  };
  return { harness, list, events, search, status, get, query, begin, start, settingsChanged, service: () => service };
}
const copies = () => external.io.filter(entry => entry.method === "write");
const taskCalls = () => external.commands.filter(call => call.args[0] === "tasks");
const tasksOnly = { sourceThreads: false, sourceArchived: false, sourceTasks: true, folders: "" };

describe("safe first load — real Recall factory and service", () => {
  it("first load never copies an unchosen source, even without qmd and before any timer", async () => {
    const e = await setup();
    await e.start();
    expect(copies()).toEqual([]);
    expect(external.io).toEqual([]);
    expect(external.commands).toEqual([]);
    expect(e.list).not.toHaveBeenCalled();
    expect(e.events).not.toHaveBeenCalled();
    expect((await e.status()).phase).toBe("inactive");
  });

  it("an explicit Tasks-only first load copies tasks and no active/archived threads or folders", async () => {
    const e = await setup(tasksOnly);
    await e.start();
    expect(taskCalls()).toHaveLength(1);
    expect(copies()).toHaveLength(1);
    expect(copies()[0].path).toContain("task-task_fixture.md");
    expect(e.list).not.toHaveBeenCalled();
    expect(e.events).not.toHaveBeenCalled();
    expect(external.io.some(entry => entry.path.startsWith("/fiction/docs"))).toBe(false);
    expect((await e.status()).counts).toEqual({ threads: 0, tasks: 1, files: 0 });
  });

  it("stored explicit choices survive: threads true, archived false, tasks false", async () => {
    const e = await setup({ sourceThreads: true, sourceArchived: false, sourceTasks: false, folders: "" });
    await e.start();
    expect(e.list).toHaveBeenCalledTimes(1);
    expect(e.list.mock.calls[0][0]?.archived).toBe(false);
    expect(copies()).toHaveLength(1);
    expect(copies()[0].path).toContain("thread-thr_active_fixture.md");
    expect(taskCalls()).toEqual([]);
  });

  it("an explicitly selected archived source is retained with its parent threads source", async () => {
    const e = await setup({ sourceThreads: true, sourceArchived: true, sourceTasks: false });
    await e.start();
    expect(e.list.mock.calls.map(([args]) => args?.archived)).toEqual([false, true]);
    expect(copies()).toHaveLength(2);
    expect(taskCalls()).toEqual([]);
  });

  const noSources: Record<string, string | number | boolean>[] = [{ sourceThreads: false, sourceArchived: false, sourceTasks: false }, { sourceArchived: true }];
  it.each(noSources)("no effective source stays inert: %j", async settings => {
    const e = await setup(settings);
    await e.start();
    expect(copies()).toEqual([]);
    expect(e.list).not.toHaveBeenCalled();
    expect(taskCalls()).toEqual([]);
    expect(external.commands).toEqual([]);
    expect((await e.status()).phase).toBe("inactive");
  });

  it("timer and explicit reindex never bypass a source choice", async () => {
    external.qmd = true;
    const e = await setup();
    await e.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await e.harness.behavior.callRpc("reindex", null)).toEqual({ started: false });
    for (let i = 0; i < 80; i++) await Promise.resolve();
    expect(copies()).toEqual([]);
    expect(external.commands).toEqual([]);
    expect(e.list).not.toHaveBeenCalled();
  });

  it("live settings wake the same service: tasks opt-in then empty sources", async () => {
    const e = await setup();
    await e.start();
    expect(copies()).toEqual([]);
    await e.settingsChanged(tasksOnly);
    await vi.waitFor(() => expect(copies()).toHaveLength(1));
    expect(taskCalls()).toHaveLength(1);
    const calls = external.commands.length;
    await e.settingsChanged({ sourceTasks: false });
    expect((await e.status()).phase).toBe("inactive");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(copies()).toHaveLength(1);
    expect(external.commands).toHaveLength(calls);
    expect((await e.get({ kind: "task", id: "task_fixture" })).content).toBeNull();
    expect((await e.query()).hits).toEqual([]);
  });

  it("an added folder is an explicit source, with no default conversations or tasks", async () => {
    const e = await setup();
    await e.start();
    await e.settingsChanged({ folders: "/fiction/docs" });
    await vi.waitFor(async () => expect((await e.status()).counts.files).toBe(1));
    expect(e.list).not.toHaveBeenCalled();
    expect(taskCalls()).toEqual([]);
    expect(copies()).toEqual([]);
    expect(external.io.some(entry => entry.path === "/fiction/docs")).toBe(true);
    await e.settingsChanged({ folders: "" });
    const reads = external.io.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(external.io).toHaveLength(reads);
    expect((await e.status()).phase).toBe("inactive");
  });

  it("inactive CLI, RPC and agent retrieval never read old mirrored text", async () => {
    external.disk.set("/fictional-bb/plugins/recall/mirror/thread-thr_active_fixture.md", "Old synthetic text");
    const e = await setup();
    await e.start();
    external.io.length = 0;
    expect((await e.harness.behavior.runCli(["status"])).stdout).toContain("inactive");
    expect((await e.harness.behavior.runCli(["search", "fictional"])).stdout).toBe("No matches.");
    expect(await e.harness.behavior.callAgentTool("recall_get", { kind: "thread", id: "thr_active_fixture" })).toBe("No indexed thread thr_active_fixture.");
    expect((await e.get({ kind: "thread", id: "thr_active_fixture" })).content).toBeNull();
    expect(e.search).not.toHaveBeenCalled();
    expect(external.io).toEqual([]);
    const reindex = await e.harness.behavior.runCli(["reindex"]);
    expect(reindex.exitCode).toBe(1);
    expect(reindex.stderr).toContain("choose sources");
    for (let i = 0; i < 80; i++) await Promise.resolve();
    expect(copies()).toEqual([]);
  });

  it("rejects invalid settings at the SDK boundary without starting a source", async () => {
    const e = await setup();
    await e.start();
    await expect(e.harness.behavior.setSettings({ sourceTasks: "true" })).rejects.toThrow();
    expect(external.io).toEqual([]);
    expect(taskCalls()).toEqual([]);
  });


  it("a lone Tasks opt-in leaves every other default source off", async () => {
    const e = await setup({ sourceTasks: true });
    await e.start();
    expect(copies()).toHaveLength(1);
    expect(e.list).not.toHaveBeenCalled();
    expect(taskCalls()).toHaveLength(1);
    expect((await e.get({ kind: "task", id: "task_fixture" })).content).toContain("Fictional task");
    expect((await e.get({ kind: "thread", id: "thr_active_fixture" })).content).toBeNull();
  });

  it("explicit stored folders are preserved and retrieval stays inside selected roots", async () => {
    external.disk.set("/fiction/docs/note.md", "# Fictional note");
    const e = await setup({ folders: "/fiction/docs", sourceThreads: false, sourceTasks: false });
    await e.start();
    expect((await e.status()).counts).toEqual({ threads: 0, tasks: 0, files: 1 });
    expect((await e.get({ kind: "file", id: "/fiction/docs/note.md" })).content).toBe("# Fictional note");
    const before = external.io.length;
    expect((await e.get({ kind: "file", id: "/outside/note.md" })).content).toBeNull();
    expect(external.io).toHaveLength(before);
    expect(e.list).not.toHaveBeenCalled();
    expect(taskCalls()).toEqual([]);
  });

  it("qmd present cannot start work until selection, but selected tasks may update and embed", async () => {
    external.qmd = true;
    const e = await setup();
    await e.start();
    expect(external.commands).toEqual([]);
    await e.settingsChanged({ sourceTasks: true });
    await vi.waitFor(async () => expect((await e.status()).phase).toBe("idle"));
    expect(copies()).toHaveLength(1);
    expect(external.commands.some(call => call.binary === "qmd" && call.args.includes("update"))).toBe(true);
    expect(external.commands.some(call => call.binary === "qmd" && call.args.includes("embed"))).toBe(true);
    expect(e.list).not.toHaveBeenCalled();
  });

  it("explicit reindex still wakes a selected source", async () => {
    const e = await setup(tasksOnly);
    await e.start();
    const before = taskCalls().length;
    expect(await e.harness.behavior.callRpc("reindex", null)).toEqual({ started: true });
    await vi.waitFor(() => expect(taskCalls().length).toBeGreaterThan(before));
  });

  it("turning threads off while tasks stay selected prevents cached thread retrieval", async () => {
    const e = await setup({ sourceThreads: true, sourceTasks: true });
    await e.start();
    expect((await e.get({ kind: "thread", id: "thr_active_fixture" })).content).toContain("Fictional conversation");
    await e.settingsChanged({ sourceThreads: false });
    expect((await e.get({ kind: "thread", id: "thr_active_fixture" })).content).toBeNull();
    expect((await e.get({ kind: "task", id: "task_fixture" })).content).toContain("Fictional task");
  });

  it.each([false, true])("cached archived eligibility follows the explicit choice %s even when the next pass fails", async archived => {
    external.qmd = true;
    external.hits = ["thr_active_fixture", "thr_archived_fixture"].map(id => ({
      file: `qmd://bb/thread-${id}.md`, title: "Fictional thread", snippet: "Fictional conversation", score: 1,
    }));
    const e = await setup({ sourceThreads: true, sourceArchived: true, sourceTasks: false });
    await e.start();
    expect((await e.get({ kind: "thread", id: "thr_archived_fixture" })).content).toContain("Fictional conversation");
    expect(await e.harness.behavior.callAgentTool("recall_get", { kind: "thread", id: "thr_archived_fixture" })).toContain("Fictional conversation");
    expect((await e.query()).hits.map(hit => hit.id)).toEqual(["thr_active_fixture", "thr_archived_fixture"]);

    e.list.mockRejectedValue(new Error("Synthetic source read failure"));
    await e.settingsChanged({ sourceArchived: archived, intervalSeconds: 61 });
    await vi.waitFor(async () => expect((await e.status()).phase).toBe("error"));
    external.io.length = 0;
    expect((await e.get({ kind: "thread", id: "thr_active_fixture" })).content).toContain("Fictional conversation");
    const content = (await e.get({ kind: "thread", id: "thr_archived_fixture" })).content;
    const agent = await e.harness.behavior.callAgentTool("recall_get", { kind: "thread", id: "thr_archived_fixture" });
    if (archived) {
      expect(content).toContain("Fictional conversation");
      expect(agent).toContain("Fictional conversation");
    } else {
      expect(content).toBeNull();
      expect(agent).toBe("No indexed thread thr_archived_fixture.");
      expect(external.io.some(entry => entry.path.endsWith("thread-thr_archived_fixture.md"))).toBe(false);
      external.disk.set("/fictional-bb/plugins/recall/mirror/thread-thr_unknown_fixture.md", "Unclassified synthetic cache");
      expect((await e.get({ kind: "thread", id: "thr_unknown_fixture" })).content).toBeNull();
    }
    expect((await e.query()).hits.map(hit => hit.id)).toEqual(archived ? ["thr_active_fixture", "thr_archived_fixture"] : ["thr_active_fixture"]);
  });

  it("abort during the first settings read does not copy or leave a sleep timer", async () => {
    const e = await setup(tasksOnly);
    const service = e.begin();
    service.controller.abort();
    for (let i = 0; i < 80; i++) await Promise.resolve();
    expect(external.io).toEqual([]);
    expect(external.commands).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await service.done;
  });

  it("abort/disposal leaves no index timer or external work behind", async () => {
    const e = await setup(tasksOnly);
    await e.start();
    e.service()!.controller.abort();
    await e.service()!.done;
    const before = external.io.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(external.io).toHaveLength(before);
    expect(vi.getTimerCount()).toBe(0);
  });
});

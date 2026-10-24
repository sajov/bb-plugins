import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { GRAPH_TOOL_NAME, INTEGRATOR_TOOL_NAMES, LEAD_ADMIN_TOOL_NAMES, LEAD_TOOL_NAMES, TOOL_NAMES, WORK_TOOL_NAMES } from "../lib/agent";
import plugin from "../server";
import { createStore } from "../lib/store";
import { duoYaml } from "./helpers";

describe("server wiring", () => {
  it("registers the crew CLI and the RPC methods, migrates the DB", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "crew" });
    await plugin(bb);
    const help = await harness.behavior.runCli(["help"]);
    expect(help.stdout).toContain("bb crew apply");
    expect(await harness.behavior.callRpc("listCrews", { projectId: null })).toEqual({ crews: [] });
    const saved = (await harness.behavior.callRpc("saveCrewFile", {
      projectId: "p1",
      yaml: "version: 1\nname: solo\ngroups:\n  - id: g\n    members:\n      - id: me\n        provider: claude-code\n        model: m\n",
    })) as { crew: { name: string; fileVersion: number } | null };
    expect(saved.crew).toMatchObject({ name: "solo", fileVersion: 1 });
    const file = (await harness.behavior.callRpc("getCrewFile", { projectId: "p1", name: "solo" })) as { version: number };
    expect(file.version).toBe(1);
    await harness.lifecycle.dispose();
  });

  it("getCrew decorates the crew with its project's name, like listCrews (BBP-79)", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "crew" });
    harness.sdk.stub("projects.get", async () => ({ id: "p1", name: "My Project", sources: [] }));
    await plugin(bb);
    await harness.behavior.callRpc("saveCrewFile", {
      projectId: "p1",
      yaml: "version: 1\nname: solo\ngroups:\n  - id: g\n    members:\n      - id: me\n        provider: claude-code\n        model: m\n",
    });
    const result = (await harness.behavior.callRpc("getCrew", { projectId: "p1", name: "solo" })) as { crew: { projectName: string | null } | null };
    expect(result.crew?.projectName).toBe("My Project");
    await harness.lifecycle.dispose();
  });

  it("negative: getCrew falls back to no project name when the lookup fails", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "crew" });
    harness.sdk.stub("projects.get", async () => {
      throw new Error("no such project");
    });
    await plugin(bb);
    await harness.behavior.callRpc("saveCrewFile", {
      projectId: "p1",
      yaml: "version: 1\nname: solo\ngroups:\n  - id: g\n    members:\n      - id: me\n        provider: claude-code\n        model: m\n",
    });
    const result = (await harness.behavior.callRpc("getCrew", { projectId: "p1", name: "solo" })) as { crew: { projectName: string | null } | null };
    expect(result.crew?.projectName).toBeNull();
    await harness.lifecycle.dispose();
  });

  it("negative: saving an invalid crew file stores nothing", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "crew" });
    await plugin(bb);
    const saved = (await harness.behavior.callRpc("saveCrewFile", { projectId: "p1", yaml: "version: 1\nname: a.b\ngroups: []\n" })) as {
      crew: unknown;
      problems: unknown[];
    };
    expect(saved.crew).toBeNull();
    expect(saved.problems.length).toBeGreaterThan(0);
    expect(await harness.behavior.callRpc("listCrews", { projectId: null })).toEqual({ crews: [] });
    await harness.lifecycle.dispose();
  });
});

describe("server wiring — deleteCrew", () => {
  it("deletes a stored, stopped crew over RPC", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "crew" });
    await plugin(bb);
    await harness.behavior.callRpc("saveCrewFile", {
      projectId: "p1",
      yaml: "version: 1\nname: solo\ngroups:\n  - id: g\n    members:\n      - id: me\n        provider: claude-code\n        model: m\n",
    });
    const result = (await harness.behavior.callRpc("deleteCrew", { projectId: "p1", name: "solo" })) as { deleted: boolean; error: string | null; rows: Record<string, number> };
    expect(result).toMatchObject({ deleted: true, error: null });
    expect(result.rows).toMatchObject({ crews: 1, crew_files: 1 });
    expect(await harness.behavior.callRpc("listCrews", { projectId: null })).toEqual({ crews: [] });
    await harness.lifecycle.dispose();
  });

  it("negative: an unknown crew is an error answer, not a throw", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "crew" });
    await plugin(bb);
    const result = (await harness.behavior.callRpc("deleteCrew", { projectId: "p1", name: "ghost", threads: "delete" })) as { deleted: boolean; error: string };
    expect(result.deleted).toBe(false);
    expect(result.error).toContain('No crew "ghost"');
    await harness.lifecycle.dispose();
  });
});

describe("server wiring (E2)", () => {
  it("registers the crew tools, configure, the delivery and activity services and the messaging RPCs", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "crew", agentSkillIds: ["crew"] });
    await plugin(bb);
    const tools = harness.registrations.agentTools.map((tool) => tool.name).sort();
    expect(tools).toEqual(
      [...TOOL_NAMES, ...WORK_TOOL_NAMES, ...LEAD_TOOL_NAMES, ...LEAD_ADMIN_TOOL_NAMES, "crew_directory", ...INTEGRATOR_TOOL_NAMES, GRAPH_TOOL_NAME].sort(),
    );
    expect(harness.registrations.agentConfigurationProvider).not.toBeNull();
    expect(harness.registrations.services.map((service) => service.name).sort()).toEqual(["activity", "delivery"]);
    // E3: follow-ups and the dependency poll run every minute.
    expect(harness.registrations.schedules.map((entry: { name: string; cron: string }) => `${entry.name} ${entry.cron}`).sort()).toEqual([
      "dependencies * * * * *",
      "follow-ups * * * * *",
    ]);
    for (const method of ["projectOverview", "listChannel", "postChannel", "listWork", "listMerges", "mergeAction"]) {
      expect(harness.registrations.rpcMethods).toContain(method);
    }
    for (const method of ["getActivity", "listMessages", "sendMessage", "messageAction", "stopChain", "rowStatuses"]) {
      expect(harness.registrations.rpcMethods).toContain(method);
    }
    expect(harness.registrations.threadEventHandlers["thread.idle"]).toBe(1);
    expect(harness.registrations.threadEventHandlers["interaction.pending"]).toBe(1);
    expect(await harness.behavior.callRpc("rowStatuses", {})).toEqual({ rows: [], needsYou: 0, errors: 0, decisions: 0, byProject: {} });
    const refused = (await harness.behavior.callRpc("sendMessage", { projectId: "p1", to: "dev@nowhere", body: "x" })) as { error: string };
    expect(refused.error).toContain('no crew "nowhere"');
    await harness.lifecycle.dispose();
  });
});

describe("server wiring — teardown (BBP-260)", () => {
  it("negative: an activity publish pending at dispose never fires against the stale context", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "crew" });
    await plugin(bb);
    const errors: unknown[] = [];
    const onError = (error: unknown) => errors.push(error);
    process.on("uncaughtException", onError);
    try {
      await harness.behavior.callRpc("stopChain", { chainId: "none" });
      await harness.lifecycle.dispose();
      await new Promise((resolve) => setTimeout(resolve, 400));
    } finally {
      process.off("uncaughtException", onError);
    }
    expect(errors.map((error) => (error as Error).name)).toEqual([]);
  });
});


it("listWork RPC exposes blocked prerequisites and an empty list for independent work", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "crew" });
  await plugin(bb);
  try {
    const store = createStore(bb.storage.database());
    const { crew } = store.saveCrewFile("p1", "duo", duoYaml());
    const insert = (id: string) => store.insertWork({ id, crewId: crew.id, title: id, body: "", ownerMember: null, createdBy: "human", tier: "p2", dueAt: null, taskKey: null });
    insert("wi_before");
    insert("wi_after");
    store.saveWorkDependency({ itemId: "wi_after", dependsOn: ["wi_before"], satisfied: false, failedNotified: [], detail: null });
    const result = await harness.behavior.callRpc("listWork", { projectId: "p1", name: "duo" }) as { items: { id: string; blockedBy: string[]; waitsFor: string[] }[] };
    expect(result.items.find((item) => item.id === "wi_after")).toMatchObject({ blockedBy: ["wi_before"], waitsFor: ["wi_before"] });
    expect(result.items.find((item) => item.id === "wi_before")?.blockedBy).toEqual([]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

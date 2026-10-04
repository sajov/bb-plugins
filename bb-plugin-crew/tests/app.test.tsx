// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, mountPluginContentScripts, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ActivityDto, MemberDto, MessageDto, OverviewDto } from "../server";

const member = (overrides: Partial<MemberDto>): MemberDto => ({
  key: "dev-impl",
  groupId: "dev",
  address: "dev-impl@trio",
  lead: false,
  provider: "claude-code",
  model: "claude-haiku-4-5-20251001",
  permissions: "accept-edits",
  shift: 1,
  threadId: "th_1",
  thread: "present",
  status: "idle",
  actualProvider: "claude-code",
  actualModel: "claude-haiku-4-5-20251001",
  ...overrides,
});

const crew = { id: "p1:trio", projectId: "p1", name: "trio", fileVersion: 2, status: "running" as const, updatedAt: 1 };

const view = (overrides: Partial<ActivityDto>): ActivityDto => ({
  key: "dev-impl",
  address: "dev-impl@trio",
  lead: false,
  crewName: "trio",
  threadId: "th_1",
  status: "idle",
  thread: "present",
  activity: "idle",
  needsYou: [],
  question: null,
  held: 0,
  diagnoses: [],
  rowStatus: null,
  openWork: 0,
  context: null,
  graphRuns: [],
  graphQuestion: null,
  ...overrides,
});

const message = (overrides: Partial<MessageDto>): MessageDto => ({
  id: "msg_1",
  chainId: "ch_1",
  step: 1,
  replyTo: null,
  kind: "message",
  fromAddress: "orch-lead@trio",
  fromCrew: "p1:trio",
  toAddress: "dev-impl@trio",
  toCrew: "p1:trio",
  subject: "Task",
  body: "Build it.",
  priority: "normal",
  status: "delivered",
  reason: null,
  deliveryMode: "start",
  attempts: 1,
  lastError: null,
  crossCrew: false,
  openQuestion: false,
  createdAt: Date.UTC(2026, 8, 30, 9, 12),
  deliveredAt: null,
  ...overrides,
});

/** Backend stubs for the panel; each test overrides what it needs. */
const backend = (overrides: Record<string, (input: never) => unknown> = {}) => ({
  listCrews: () => ({ crews: [crew] }),
  getCrew: () => ({ crew, members: [member({})] }),
  getActivity: () => ({ members: [] }),
  listMessages: () => ({ messages: [] }),
  rowStatuses: () => ({ rows: [], needsYou: 0 }),
  projectOverview: () => overview({}),
  listChannel: () => ({ posts: [] }),
  listWork: () => ({ items: [] }),
  ...overrides,
});

const card = (overrides: Partial<OverviewDto["crews"][number]>): OverviewDto["crews"][number] => ({
  name: "trio",
  status: "running",
  summary: "",
  task: "CRD-1",
  branch: "bb/trio-1",
  behind: 2,
  merge: null,
  needsYou: 0,
  members: [{ key: "orch-lead", lead: true, activity: "idle", needsYou: [] }],
  labelTasks: [],
  ...overrides,
});
const overview = (overrides: Partial<OverviewDto>): OverviewDto => ({
  crews: [card({})],
  leadLinks: [],
  dependencies: [],
  threads: { limit: 16, source: "bb", running: 1, members: 3 },
  ...overrides,
});

/** The overview is the entry; the crew view opens from the crew list. */
async function openCrew(slot: { findByRole: (role: string, options: { name: string }) => Promise<HTMLElement> }, tab = "Table & Feed") {
  await clickNode(slot as never, '[data-crew-node="trio"]');
  // Topology is the first tab; most tests look at Table & Feed.
  fireEvent.click(await slot.findByRole("button", { name: tab }));
}

describe("Crews panel", () => {
  it("registers the Crews nav panel with header counter, sidebar accessory and the row-status content script", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.navPanels.map((panel) => panel.title)).toEqual(["Crews"]);
    expect(app.navPanels[0]!.headerContent).toBeTypeOf("function");
    expect(app.navPanels[0]!.experimental_sidebarAccessory).toBeTypeOf("function");
    expect(app.contentScripts.map((script) => script.id)).toEqual(["row-status"]);
  });

  it("shows the members table with lead and full markers only where they apply", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        ...backend(),
        getCrew: () => ({
          crew,
          members: [
            member({ key: "orch-lead", address: "orch-lead@trio", lead: true }),
            member({ permissions: "full" }),
            member({ key: "dev-review", address: "dev-review@trio", thread: "archived", shift: 3 }),
          ],
        }),
      },
    });
    await openCrew(slot);
    // The canvas draws the members too; the table lives in the crew panel.
    const panel = within(slot.getByRole("complementary", { name: "Crew details" }));
    await panel.findByText("orch-lead@trio");
    expect(panel.getByText("file v2", { exact: false })).toBeTruthy();
    expect(panel.getAllByText("lead")).toHaveLength(1);
    expect(panel.getAllByText("full")).toHaveLength(1);
    expect(panel.getByText("archived")).toBeTruthy();
    expect(panel.getByText("3")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("negative: no crews shows the empty state, not a table", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: backend({ listCrews: () => ({ crews: [] }) }) });
    await slot.findByText("No crews yet.", { exact: false });
    expect(slot.queryByRole("table")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("Table & Feed: a Needs-you member is on top, marked, with its question and a reply button", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const sent: unknown[] = [];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: backend({
        getCrew: () => ({
          crew,
          members: [member({ key: "orch-lead", address: "orch-lead@trio", lead: true }), member({})],
        }),
        getActivity: () => ({
          members: [
            view({ key: "orch-lead", address: "orch-lead@trio", lead: true }),
            view({ activity: "needs-you", needsYou: ["human-question"], question: "API: v1 or v2?" }),
          ],
        }),
        sendMessage: (input: never) => {
          sent.push(input);
          return { messages: [], error: null };
        },
      }),
    });
    await openCrew(slot);
    await slot.findByText("API: v1 or v2?");
    expect(slot.getByText("Table & Feed")).toBeTruthy();
    const rows = slot.container.querySelectorAll("tbody tr");
    expect(rows[0]!.getAttribute("data-needs-you")).toBe("true");
    expect(rows[0]!.textContent).toContain("dev-impl@trio");
    expect(rows[1]!.getAttribute("data-needs-you")).toBeNull();
    expect(slot.getAllByText("1 waiting on you")).toHaveLength(1);
    fireEvent.click(slot.getByRole("button", { name: "Reply" }));
    fireEvent.change(slot.getByLabelText("Reply text"), { target: { value: "v2" } });
    fireEvent.click(slot.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ projectId: "p1", to: "dev-impl@trio", body: "v2", crew: "trio" });
    slot.lifecycle.unmount();
  });

  it("negative: without Needs you there is no counter and no marked row", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: backend({ getActivity: () => ({ members: [view({})] }) }) });
    await openCrew(slot);
    await slot.findByText("dev-impl@trio");
    await slot.findByText("No messages.");
    expect(slot.queryByText(/waiting on you|error/)).toBeNull();
    expect(slot.container.querySelector("[data-needs-you]")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("feed: cross-crew and open-question markers only where they apply, actions only on held messages", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const calls: { method: string; input: unknown }[] = [];
    const log = (method: string, result: unknown) => (input: never) => {
      calls.push({ method, input });
      return result;
    };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: backend({
        listMessages: log("listMessages", {
          messages: [
            message({}),
            message({ id: "msg_2", subject: "Cross", crossCrew: true, status: "rejected", reason: "crossCrew: leads — …", toAddress: "core-lead@duo" }),
            message({ id: "msg_3", subject: "Held", status: "on_hold", reason: "waiting for an open approval" }),
            message({ id: "msg_4", subject: "Ask", toAddress: "human", toCrew: null, openQuestion: true, fromAddress: "dev-impl@trio" }),
          ],
        }),
        messageAction: log("messageAction", { message: null, error: null }),
        stopChain: log("stopChain", { stopped: 1 }),
      }),
    });
    await openCrew(slot);
    await slot.findByText("Cross");
    expect(slot.getAllByText("cross-crew")).toHaveLength(1);
    expect(slot.getAllByText("open question")).toHaveLength(1);
    expect(slot.getAllByRole("button", { name: "Release" })).toHaveLength(1);
    fireEvent.click(slot.getByRole("button", { name: "Release" }));
    await waitFor(() => expect(calls.some((c) => c.method === "messageAction")).toBe(true));
    expect(calls.find((c) => c.method === "messageAction")!.input).toEqual({ id: "msg_3", action: "release" });

    fireEvent.change(slot.getByLabelText("Filter by status"), { target: { value: "on_hold" } });
    await waitFor(() => expect(calls.some((c) => (c.input as { status?: string }).status === "on_hold")).toBe(true));

    fireEvent.click(slot.getByText("Held"));
    await slot.findByLabelText("Chain");
    expect(calls.some((c) => (c.input as { chainId?: string }).chainId === "ch_1")).toBe(true);
    slot.lifecycle.unmount();
  });

  it("table: an archived member shows archived, not unknown; negative: a live idle member shows idle", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: backend({
        getCrew: () => ({ crew, members: [member({ key: "orch-lead", address: "orch-lead@trio", lead: true }), member({ thread: "archived" })] }),
        getActivity: () => ({
          members: [view({ key: "orch-lead", address: "orch-lead@trio", lead: true }), view({ thread: "archived", activity: "unknown", status: null })],
        }),
      }),
    });
    await openCrew(slot);
    await slot.findByText("dev-impl@trio");
    const labels = await waitFor(() => {
      const found = Array.from(slot.container.querySelectorAll("[data-activity-label]")).map((el) => el.textContent);
      expect(found).toHaveLength(2);
      return found;
    });
    expect(labels).toEqual(["idle", "archived"]);
    expect(labels).not.toContain("unknown");
    slot.lifecycle.unmount();
  });

  it("feed: an info to the human is marked info and not open question; negative: a question carries no info marker", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: backend({
        listMessages: () => ({
          messages: [
            message({ id: "msg_5", subject: "Weekly report", kind: "info", toAddress: "human", toCrew: null, fromAddress: "dev-impl@trio" }),
            message({ id: "msg_6", subject: "Ask", toAddress: "human", toCrew: null, openQuestion: true, fromAddress: "dev-impl@trio" }),
          ],
        }),
      }),
    });
    await openCrew(slot);
    await slot.findByText("Weekly report");
    expect(slot.getAllByText("info")).toHaveLength(1);
    expect(slot.getAllByText("open question")).toHaveLength(1);
    const statusItem = slot.getByText("Weekly report").closest("li")!;
    expect(statusItem.textContent).toContain("info");
    expect(statusItem.textContent).not.toContain("open question");
    slot.lifecycle.unmount();
  });

  it("row icons: the sidebar accessory applies server statuses through the content script and clears stale ones", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const mounted = await mountPluginContentScripts(app, { pluginId: "crew" });
    let rows = [
      { threadId: "th_1", status: { icon: "CircleAlert", label: "Needs you: loop", tone: "error" as const } },
      { threadId: "th_2", status: { icon: "LoaderCircle", label: "Working", tone: "running" as const } },
      { threadId: "th_3", status: null },
    ];
    const slot = renderSlot({ component: app.navPanels[0]!.experimental_sidebarAccessory! }, {}, {
      rpc: { rowStatuses: () => ({ rows, needsYou: 1, errors: 1, decisions: 0 }) },
    });
    await slot.findByLabelText("1 Needs you");
    expect(mounted.inspection.getThreadRowStatus("th_1")).toMatchObject({ tone: "error" });
    expect(mounted.inspection.getThreadRowStatus("th_2")).toMatchObject({ tone: "running" });
    expect(mounted.inspection.getThreadRowStatus("th_3")).toBeNull();
    rows = [{ threadId: "th_2", status: { icon: "LoaderCircle", label: "Working", tone: "running" as const } }];
    await slot.emitRealtime("crew-activity", {});
    await waitFor(() => expect(mounted.inspection.getThreadRowStatus("th_1")).toBeNull());
    expect(mounted.inspection.threadRowStatusCalls.filter((call) => call.threadId === "th_2")).toHaveLength(1);
    slot.lifecycle.unmount();
    await mounted.lifecycle.dispose();
  });

  it("negative: on a client without the row-status API nothing is set and nothing breaks", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const mounted = await mountPluginContentScripts(app, { pluginId: "crew", omitExperimentalThreadRowStatus: true });
    const { applyRowStatuses } = await import("../app");
    expect(applyRowStatuses([{ threadId: "th_1", status: { icon: "X", label: "x", tone: "error" } }])).toBe(false);
    expect(mounted.inspection.threadRowStatusCalls).toEqual([]);
    await mounted.lifecycle.dispose();
  });
});

describe("row icons without any mounted React surface", () => {
  const unread = { icon: "CircleCheck", label: "Unread result", tone: "success" as const };
  const reply = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

  it("fetchRowStatuses reads the plugin RPC route and returns its rows", async () => {
    const { fetchRowStatuses } = await import("../app");
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => (seen.push({ url, init }), { ok: true, json: async () => ({ ok: true, result: { rows: [{ threadId: "th_1", status: unread }], needsYou: 0 } }) })) as unknown as typeof fetch;
    expect(await fetchRowStatuses("crew", fetcher)).toEqual([{ threadId: "th_1", status: unread }]);
    expect(seen[0]!.url).toBe("/api/v1/plugins/crew/rpc/rowStatuses");
    expect(seen[0]!.init).toMatchObject({ method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  });

  it("negative: an HTTP error, an ok:false body or a network failure yield null", async () => {
    const { fetchRowStatuses } = await import("../app");
    expect(await fetchRowStatuses("crew", reply({}, false))).toBeNull();
    expect(await fetchRowStatuses("crew", reply({ ok: false, error: { code: "x", message: "x" } }))).toBeNull();
    expect(await fetchRowStatuses("crew", (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBeNull();
  });

  it("the content script alone applies an unread result as a success icon (panel and accessory closed)", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = reply({ ok: true, result: { rows: [{ threadId: "th_lead", status: unread }, { threadId: "th_idle", status: null }], needsYou: 0 } });
    try {
      const app = await loadPluginApp(() => import("../app"));
      const mounted = await mountPluginContentScripts(app, { pluginId: "crew" });
      await waitFor(() => expect(mounted.inspection.getThreadRowStatus("th_lead")).toMatchObject({ tone: "success", icon: "CircleCheck" }));
      expect(mounted.inspection.getThreadRowStatus("th_idle")).toBeNull();
      await mounted.lifecycle.dispose();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rows fetched before the setter exists are kept and applied when the content script mounts", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = reply({}, false); // the script's own read fails: only the kept rows can set the icon
    try {
      const app = await loadPluginApp(() => import("../app"));
      const { applyRowStatuses } = await import("../app");
      expect(applyRowStatuses([{ threadId: "th_early", status: unread }])).toBe(false);
      const mounted = await mountPluginContentScripts(app, { pluginId: "crew" });
      expect(mounted.inspection.getThreadRowStatus("th_early")).toMatchObject({ tone: "success" });
      await mounted.lifecycle.dispose();
    } finally {
      globalThis.fetch = original;
    }
  });
});

/** Waits for a node on the zoom canvas and clicks it. */
async function clickNode(slot: { container: HTMLElement }, selector: string) {
  const node = await waitFor(() => {
    const found = slot.container.querySelector<HTMLElement>(selector);
    expect(found).not.toBeNull();
    return found!;
  });
  fireEvent.click(node);
}
const crumbs = (slot: { getByRole: (role: string, options: { name: string }) => HTMLElement }) =>
  within(slot.getByRole("navigation", { name: "Breadcrumb" }))
    .getAllByRole("button")
    .map((b) => b.textContent);

describe("Crews zoom canvas (BBP-83)", () => {
  const foreign = { ...crew, id: "p2:gs15", projectId: "p2", name: "gs15", projectName: "Graph Studio" };
  const twoProjects = (extra: Record<string, unknown> = {}) =>
    backend({
      listCrews: () => ({ crews: [{ ...crew, projectName: "BB Plugins" }, foreign] }),
      projectOverview: (input: never) =>
        (input as { projectId: string }).projectId === "p2"
          ? overview({ crews: [card({ name: "gs15", status: "running", needsYou: 1 })] })
          : overview({ crews: [card({}), card({ name: "beta", status: "idle" })] }),
      ...extra,
    });

  it("level 0 shows every project as a cluster with crew count, running and waiting; no Diagram button, zoom bottom-left", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: twoProjects() });
    await waitFor(() => expect(slot.container.querySelectorAll("[data-project-frame]")).toHaveLength(2));
    const p2 = slot.container.querySelector('[data-project-frame="p2"]')!;
    expect(p2.textContent).toContain("Graph Studio");
    expect(p2.textContent).toContain("1 crew");
    expect(p2.querySelector('[data-cluster="running"]')!.textContent).toContain("1");
    expect(p2.querySelector('[data-cluster="needs-you"]')!.textContent).toContain("1");
    // negative: a project nobody waits on shows no waiting count
    expect(slot.container.querySelector('[data-project-frame="p1"] [data-cluster="needs-you"]')).toBeNull();
    expect(crumbs(slot)).toEqual(["All"]);
    expect(slot.queryByRole("button", { name: "Diagram" })).toBeNull();
    expect(slot.queryByRole("region", { name: "Lead communication" })).toBeNull();
    const canvas = slot.getByLabelText("Crews canvas");
    expect(canvas.querySelector(".react-flow__panel.bottom.left")).not.toBeNull();
    slot.lifecycle.unmount();
  });

  it("level 1: a cluster zooms into its project with its lead communication; Esc goes back to all projects", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const asked: unknown[] = [];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: twoProjects({ listMessages: (input: never) => (asked.push(input), { messages: [message({ subject: "Is the schema stable?", crossCrew: true })] }) }),
    });
    await clickNode(slot, '[data-project-frame="p2"]');
    await waitFor(() => expect(crumbs(slot)).toEqual(["All", "Graph Studio"]));
    const feed = await slot.findByRole("region", { name: "Lead communication" });
    expect(feed.className).toContain("bg-card");
    expect(feed.className).not.toMatch(/#0b0b0c|#1f1f22/);
    await waitFor(() => expect(asked).toContainEqual(expect.objectContaining({ projectId: "p2", crossCrew: true })));
    // The other project's crews fade, they do not vanish.
    expect(slot.container.querySelector('[data-crew-node="trio"]')!.closest("[data-dim]")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(crumbs(slot)).toEqual(["All"]));
    slot.lifecycle.unmount();
  });

  it("level 2 and 3 stay on the canvas: the crew opens into its members, a member into its agent card; Esc climbs one level at a time", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const calls: unknown[] = [];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: twoProjects({
        getCrew: () => ({ crew, members: [member({ actualModel: "opus" })], links: [] }),
        getActivity: () => ({ members: [view({ key: "dev-impl", context: 0.42, openWork: 2, held: 1 })] }),
        listWork: () => ({
          items: [
            { id: "wi_9", title: "Fix the zoom", body: "", owner: "dev-impl@trio", state: "claimed", tier: "p1", dueAt: null, taskKey: null, closureNote: null, rung: 0 },
            { id: "wi_8", title: "Someone else's", body: "", owner: "dev-review@trio", state: "claimed", tier: "p1", dueAt: null, taskKey: null, closureNote: null, rung: 0 },
          ],
        }),
        handover: (input: never) => (calls.push(input), { error: null }),
      }),
    });
    await clickNode(slot, '[data-project-frame="p1"]');
    await clickNode(slot, '[data-crew-node="trio"]');
    await waitFor(() => expect(crumbs(slot)).toEqual(["All", "BB Plugins", "trio"]));
    const canvas = slot.getByLabelText("Crews canvas");
    // The members are drawn on the same canvas, inside the crew.
    await waitFor(() => expect(canvas.querySelector('[data-member-node="dev-impl"]')).not.toBeNull());
    expect(canvas.querySelector("[data-agent-node]")).toBeNull();
    const panel = slot.getByRole("complementary", { name: "Crew details" });
    expect(within(panel).getByRole("button", { name: "Edit" })).toBeTruthy();
    await clickNode(slot, '[data-member-node="dev-impl"]');
    await waitFor(() => expect(crumbs(slot)).toEqual(["All", "BB Plugins", "trio", "dev-impl"]));
    const agent = await waitFor(() => {
      const found = canvas.querySelector<HTMLElement>('[data-agent-node="dev-impl"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(agent.textContent).toContain("opus");
    expect(agent.textContent).toContain("42%");
    expect(agent.textContent).toContain("Fix the zoom");
    // negative: another member's work item is not this agent's
    expect(agent.textContent).not.toContain("Someone else's");
    fireEvent.click(within(agent).getByRole("button", { name: "Handover" }));
    await waitFor(() => expect(calls).toContainEqual({ projectId: "p1", name: "trio", member: "dev-impl" }));
    expect(within(agent).getByRole("button", { name: "Open" })).toBeTruthy();
    expect(within(agent).getByRole("button", { name: "Reset" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(crumbs(slot)).toEqual(["All", "BB Plugins", "trio"]));
    expect(canvas.querySelector("[data-agent-node]")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(crumbs(slot)).toEqual(["All", "BB Plugins"]));
    expect(canvas.querySelector("[data-member-node]")).toBeNull();
    fireEvent.click(within(slot.getByRole("navigation", { name: "Breadcrumb" })).getByRole("button", { name: "All" }));
    await waitFor(() => expect(crumbs(slot)).toEqual(["All"]));
    slot.lifecycle.unmount();
  });

  it("level 0 keeps the project filter with counts and the search; negative: not on level 1", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: twoProjects() });
    await waitFor(() => expect(slot.container.querySelectorAll("[data-project-frame]")).toHaveLength(2));
    const chips = slot.getByRole("group", { name: "Projects" });
    expect(within(chips).getAllByRole("button").map((b) => b.textContent)).toEqual(["All", "BB Plugins1", "Graph Studio1"]);
    fireEvent.click(within(chips).getByRole("button", { name: /Graph Studio/ }));
    await waitFor(() => expect(slot.container.querySelector('[data-project-frame="p2"]')).toBeNull());
    fireEvent.click(within(chips).getByRole("button", { name: "All" }));
    await waitFor(() => expect(slot.container.querySelector('[data-project-frame="p2"]')).not.toBeNull());
    fireEvent.change(slot.getByRole("searchbox", { name: "Search crews, members and tasks" }), { target: { value: "beta" } });
    await waitFor(() => expect(slot.container.querySelector('[data-crew-node="trio"]')!.closest("[data-dim]")).not.toBeNull());
    expect(slot.container.querySelector('[data-crew-node="beta"]')!.closest("[data-dim]")).toBeNull();
    await clickNode(slot, '[data-project-frame="p1"]');
    await waitFor(() => expect(slot.queryByRole("group", { name: "Projects" })).toBeNull());
    slot.lifecycle.unmount();
  });

  it("negative: Esc typed in a field does not zoom out", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: twoProjects() });
    await clickNode(slot, '[data-project-frame="p1"]');
    const select = await slot.findByLabelText("Filter by crew");
    fireEvent.keyDown(select, { key: "Escape" });
    expect(crumbs(slot)).toEqual(["All", "BB Plugins"]);
    slot.lifecycle.unmount();
  });

  it("level 1 lists a waiting merge with Merge and Reject; negative: a merged one has no buttons", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const calls: unknown[] = [];
    const merge = { id: "mr_1", crew: "trio", branch: "bb/trio-1", base: "main", state: "open" as const, reason: null, commitSha: null, mergedBy: null, createdAt: 1 };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: backend({
        projectOverview: () => overview({ crews: [card({ merge }), card({ name: "beta", merge: { ...merge, id: "mr_0", crew: "beta", state: "merged" } })] }),
        mergeAction: (input: never) => (calls.push(input), { merge: null, error: null }),
      }),
    });
    await clickNode(slot, '[data-project-frame="p1"]');
    const merges = await slot.findByRole("region", { name: "Waiting merges" });
    expect(within(merges).getAllByRole("button", { name: "Merge" })).toHaveLength(1);
    fireEvent.click(within(merges).getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(calls).toContainEqual({ id: "mr_1", action: "approve", note: "" }));
    slot.lifecycle.unmount();
  });

  it("crew view shows open work with its follow-up rung and the channel; a human post goes to postChannel", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const posted: unknown[] = [];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: backend({
        listWork: () => ({
          items: [
            { id: "wi_1", title: "Docs", body: "", owner: "dev-impl@trio", state: "open", tier: "p0", dueAt: null, taskKey: null, closureNote: null, rung: 4 },
            { id: "wi_2", title: "Fresh", body: "", owner: null, state: "open", tier: "p2", dueAt: null, taskKey: null, closureNote: null, rung: 0 },
          ],
        }),
        listChannel: () => ({ posts: [{ id: "cm_1", author: "dev-impl@trio", topic: "status", body: "Parser half done", createdAt: 1 }] }),
        postChannel: (input: never) => {
          posted.push(input);
          return { post: null, error: null };
        },
      }),
    });
    await openCrew(slot);
    await slot.findByText("Parser half done");
    expect(slot.getByText("follow-up 4/4")).toBeTruthy();
    expect(slot.container.querySelector('[data-rung="4"]')).not.toBeNull();
    expect(slot.container.querySelector('[data-rung="0"]')!.textContent).not.toContain("follow-up");
    fireEvent.change(slot.getByLabelText("Channel post"), { target: { value: "@dev-impl ping" } });
    fireEvent.click(slot.getByRole("button", { name: "Post" }));
    await waitFor(() => expect(posted).toEqual([{ projectId: "p1", name: "trio", body: "@dev-impl ping", topic: null }]));
    slot.lifecycle.unmount();
  });
});

describe("Crews panel — delete crew", () => {
  it("the ⋯ menu opens a confirmation; confirming calls deleteCrew with the chosen thread mode", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const calls: unknown[] = [];
    const stopped = { ...crew, status: "stopped" as const };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: backend({
        listCrews: () => ({ crews: [stopped] }),
        getCrew: () => ({ crew: stopped, members: [member({})] }),
        deleteCrew: (input: never) => {
          calls.push(input);
          return { deleted: true, threads: [{ key: "dev-impl", threadId: "th_1", shift: 1, retired: false, outcome: "deleted", children: 0, error: null }], rows: {}, warnings: [], blockers: [], error: null };
        },
      }),
    });
    await openCrew(slot);
    fireEvent.click(slot.getByRole("button", { name: "More crew actions" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Delete crew…" }));
    const form = await slot.findByRole("region", { name: "Delete crew" });
    expect(calls).toHaveLength(0);
    fireEvent.change(within(form).getByLabelText("Member threads"), { target: { value: "delete" } });
    fireEvent.click(within(form).getByRole("button", { name: "Delete crew" }));
    await waitFor(() => expect(calls).toEqual([{ projectId: "p1", name: "trio", threads: "delete", force: false }]));
    slot.lifecycle.unmount();
  });

  it("negative: a running crew cannot be deleted from the panel, the form says to stop it", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: backend() });
    await openCrew(slot);
    fireEvent.click(slot.getByRole("button", { name: "More crew actions" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Delete crew…" }));
    const form = await slot.findByRole("region", { name: "Delete crew" });
    expect(within(form).getByText(/Stop it first/)).toBeTruthy();
    expect((within(form).getByRole("button", { name: "Delete crew" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(form).queryByLabelText("Member threads")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("blockers are listed and the delete needs 'Delete anyway'; negative: without blockers there is no such box", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const calls: { force: boolean }[] = [];
    const stopped = { ...crew, status: "stopped" as const };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: backend({
        listCrews: () => ({ crews: [stopped] }),
        getCrew: () => ({ crew: stopped, members: [member({})] }),
        deleteCrew: (input: never) => {
          calls.push(input);
          const force = (input as { force: boolean }).force;
          return force
            ? { deleted: true, threads: [], rows: {}, warnings: ["forced past: crew beta waits for CRD-1 until merged"], blockers: [], error: null }
            : { deleted: false, threads: [], rows: {}, warnings: [], blockers: ["crew beta waits for CRD-1 until merged"], error: "Crew trio is still needed" };
        },
      }),
    });
    await openCrew(slot);
    fireEvent.click(slot.getByRole("button", { name: "More crew actions" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Delete crew…" }));
    const form = await slot.findByRole("region", { name: "Delete crew" });
    expect(within(form).queryByLabelText("Delete anyway")).toBeNull();
    fireEvent.click(within(form).getByRole("button", { name: "Delete crew" }));
    await within(form).findByText("crew beta waits for CRD-1 until merged");
    const button = within(form).getByRole("button", { name: "Delete crew" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(within(form).getByLabelText("Delete anyway"));
    fireEvent.click(button);
    await waitFor(() => expect(calls.map((call) => call.force)).toEqual([false, true]));
    slot.lifecycle.unmount();
  });
});

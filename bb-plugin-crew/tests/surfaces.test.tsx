// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { formatPlan } from "../lib/format";
import { validateCrew } from "../lib/spec";
import { buildCrewCanvas, TopologyLegend } from "../components/crew-topology";
import type { ActivityDto, MemberDto } from "../server";
import { PROJECT, running, setup, trioYaml } from "./helpers";

const crew = { id: "p1:trio", projectId: "p1", name: "trio", fileVersion: 2, status: "running" as const, updatedAt: 1 };
const member = (overrides: Partial<MemberDto>): MemberDto => ({
  key: "dev-impl",
  groupId: "dev",
  address: "dev-impl@trio",
  lead: false,
  provider: "claude-code",
  model: "claude-haiku-4-5-20251001",
  permissions: "accept-edits",
  shift: 1,
  threadId: "th_2",
  thread: "present",
  status: "idle",
  actualProvider: "claude-code",
  actualModel: "claude-haiku-4-5-20251001",
  ...overrides,
});
const view = (overrides: Partial<ActivityDto>): ActivityDto => ({
  key: "dev-impl",
  address: "dev-impl@trio",
  lead: false,
  crewName: "trio",
  threadId: "th_2",
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
const members = [member({ key: "orch-lead", groupId: "orch", address: "orch-lead@trio", lead: true, threadId: "th_1" }), member({})];
const badgeMember = { key: "dev-impl", address: "dev-impl@trio", crew: "trio", projectId: "p1", shift: 3, lead: false, handover: null, leadThreadId: "th_1" };

const backend = (overrides: Record<string, (input: unknown) => unknown> = {}) => ({
  listCrews: () => ({ crews: [crew] }),
  getCrew: () => ({ crew, members, links: [{ from: "orch-lead", to: "dev-impl", kind: "assigns_to" }] }),
  getActivity: () => ({ members: [view({ key: "orch-lead", address: "orch-lead@trio", lead: true }), view({})] }),
  listMessages: () => ({ messages: [] }),
  rowStatuses: () => ({ rows: [], needsYou: 0 }),
  projectOverview: () => ({ crews: [], leadLinks: [], dependencies: [], threads: { limit: null, source: "none", running: 0, members: 0 } }),
  listChannel: () => ({ posts: [] }),
  listWork: () => ({ items: [] }),
  getCrewFile: () => ({ yaml: trioYaml(), version: 2 }),
  plan: () => ({ problems: [], items: [] }),
  ...overrides,
});

async function openCrew(slot: ReturnType<typeof renderSlot>, tab: string) {
  const list = await slot.findByRole("list", { name: "Crews" });
  fireEvent.click(within(list).getByRole("button", { name: "trio" }));
  fireEvent.click(await slot.findByRole("button", { name: tab }));
}

describe("registrations (E4)", () => {
  it("registers the header badge, the ::crew directive, the confirmation renderer and the crew thread panel", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.threadHeaderActions.map((entry) => entry.id)).toEqual(["member-badge"]);
    expect(app.messageDirectives.map((entry) => entry.id)).toEqual(["crew"]);
    expect(app.pendingInteractions.map((entry) => entry.id)).toEqual(["crew-confirm"]);
    expect(app.threadPanelActions.map((entry) => entry.id)).toEqual(["crew"]);
  });
});

describe("thread header badge", () => {
  it("renders address · Shift n for a member thread, with Reset / Handover / Detach", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const calls: { method: string; input: unknown }[] = [];
    const slot = renderSlot(app.threadHeaderActions[0]!, { threadId: "th_2", projectId: "p1", isCompactViewport: false }, {
      rpc: {
        memberOfThread: () => ({ member: badgeMember }),
        handover: (input: unknown) => (calls.push({ method: "handover", input }), { handover: "ho_1", state: "writing", error: null }),
        reset: (input: unknown) => (calls.push({ method: "reset", input }), { results: [], problems: [], error: null }),
        detach: (input: unknown) => (calls.push({ method: "detach", input }), { threadId: "th_2", error: null }),
      },
    });
    const button = await slot.findByRole("button", { name: "Crew member dev-impl@trio, shift 3" });
    expect(button.textContent).toContain("dev-impl@trio · Shift 3");
    fireEvent.click(button);
    const menu = slot.getByRole("menu", { name: "Member actions" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Reset (clear context)",
      "Reset (new thread)",
      "Handover",
      "Detach from crew",
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Handover" }));
    await waitFor(() => expect(calls).toEqual([{ method: "handover", input: { projectId: "p1", name: "trio", member: "dev-impl" } }]));
    slot.lifecycle.unmount();
  });

  it("negative: renders nothing on a thread that is not a crew member's", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const asked: unknown[] = [];
    const slot = renderSlot(app.threadHeaderActions[0]!, { threadId: "thr_plain", projectId: "p1", isCompactViewport: false }, {
      rpc: { memberOfThread: (input: unknown) => (asked.push(input), { member: null }) },
    });
    await waitFor(() => expect(asked).toEqual([{ threadId: "thr_plain" }]));
    expect(slot.container.querySelector("[data-crew-badge]")).toBeNull();
    expect(slot.container.textContent).toBe("");
    slot.lifecycle.unmount();
  });
});

describe("::crew directive", () => {
  it("renders the crew live: status, members with activity, Needs you", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.messageDirectives[0]!, {
      attributes: { crew: "trio" },
      source: '::crew{crew="trio"}',
      message: { id: "m1", threadId: "th_9", turnId: null, projectId: "p1" },
      openWorkspaceFile: null,
    }, {
      rpc: backend({ getActivity: () => ({ members: [view({ key: "orch-lead", lead: true }), view({ needsYou: ["human-question"], question: "Which API?" })] }) }),
      openThreadPanel: () => true,
    });
    const card = await waitFor(() => {
      const found = slot.container.querySelector('[data-crew-directive="trio"]');
      expect(found).not.toBeNull();
      return found!;
    });
    await waitFor(() => expect(card.textContent).toContain("1 Needs you"));
    expect(card.textContent).toContain("running · 2 members · file v2");
    expect(card.textContent).toContain("★ orch-lead");
    fireEvent.click(slot.getByRole("button", { name: "Open in Crews" }));
    expect(slot.navigateCalls).toEqual([
      { method: "openThreadPanel", options: { actionId: "crew", title: "Crew trio", params: { crew: "trio", projectId: "p1" } } },
    ]);
    slot.lifecycle.unmount();
  });

  it("BBP-49: falls back to the Crews nav panel when the surface has no thread side panel", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.messageDirectives[0]!,
      { attributes: { crew: "trio" }, source: '::crew{crew="trio"}', message: { id: "m1", threadId: "th_9", turnId: null, projectId: "p1" }, openWorkspaceFile: null },
      { rpc: backend(), openThreadPanel: () => false },
    );
    await waitFor(() => expect(slot.container.querySelector('[data-crew-directive="trio"]')).not.toBeNull());
    fireEvent.click(slot.getByRole("button", { name: "Open in Crews" }));
    expect(slot.navigateCalls.map((call) => call.method)).toEqual(["openThreadPanel", "toPluginPanel"]);
    slot.lifecycle.unmount();
  });

  it("negative: an invalid crew attribute renders a note and calls nothing; an unknown crew says so", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const bad = renderSlot(app.messageDirectives[0]!, {
      attributes: { crew: "../etc" },
      source: "::crew",
      message: { id: "m1", threadId: "th_9", turnId: null, projectId: "p1" },
      openWorkspaceFile: null,
    }, { rpc: backend() });
    expect(bad.getByText("Crew: this card names no valid crew.")).toBeTruthy();
    expect(bad.rpcCalls).toEqual([]);
    bad.lifecycle.unmount();
    const unknown = renderSlot(app.messageDirectives[0]!, {
      attributes: { crew: "ghost" },
      source: '::crew{crew="ghost"}',
      message: { id: "m1", threadId: "th_9", turnId: null, projectId: "p1" },
      openWorkspaceFile: null,
    }, { rpc: backend({ getCrew: () => ({ crew: null, members: [], links: [] }) }) });
    await unknown.findByText("There is no crew “ghost” in this project.");
    unknown.lifecycle.unmount();
  });
});

describe("crew thread panel (BBP-49)", () => {
  it("opened from the directive's params: the member graph on top, the crew log below", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "th_9", params: { crew: "trio", projectId: "p1" } },
      {
        rpc: backend({
          listMessages: () => ({
            messages: [
              {
                id: "msg1",
                chainId: "ch1",
                step: 1,
                replyTo: null,
                kind: "message",
                fromAddress: "orch-lead@trio",
                fromCrew: "trio",
                toAddress: "dev-impl@trio",
                toCrew: "trio",
                subject: "s",
                body: "b",
                priority: "normal",
                status: "delivered",
                reason: null,
                deliveryMode: null,
                attempts: 1,
                lastError: null,
                crossCrew: false,
                openQuestion: false,
                createdAt: 1,
              },
            ],
          }),
        }),
      },
    );
    const canvas = await waitFor(() => {
      const found = slot.container.querySelector('[aria-label="Topology"]');
      expect(found).not.toBeNull();
      return found!;
    });
    const log = await slot.findByRole("list", { name: "Crew log" });
    expect(canvas.compareDocumentPosition(log) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("opened without params (header/palette): falls back to the panel thread's own crew", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "th_2", params: null },
      { rpc: backend({ memberOfThread: () => ({ member: badgeMember }) }) },
    );
    await waitFor(() => expect(slot.container.querySelector('[aria-label="Topology"]')).not.toBeNull());
    slot.lifecycle.unmount();
  });

  it("negative: a thread with no crew and no params shows no graph", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "th_plain", params: null },
      { rpc: backend({ memberOfThread: () => ({ member: null }) }) },
    );
    await slot.findByText("This thread has no crew.");
    expect(slot.container.querySelector('[aria-label="Topology"]')).toBeNull();
    slot.lifecycle.unmount();
  });
});

describe("confirmation form", () => {
  it("Confirm submits confirmed: true, Decline confirmed: false", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const submitted: unknown[] = [];
    const props = {
      interaction: { id: "i1", threadId: "th_1", title: "Remove dev-review?", payload: { kind: "remove-member", title: "Remove dev-review from crew trio?", detail: "archived, not deleted" }, createdAt: 1, expiresAt: null },
      submit: async (value: unknown) => void submitted.push(value),
      cancel: async () => undefined,
    };
    const slot = renderSlot(app.pendingInteractions[0]!, props as never);
    expect(slot.getByText("Remove dev-review from crew trio?")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Confirm" }));
    fireEvent.click(slot.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(submitted).toEqual([{ confirmed: true }, { confirmed: false }]));
    slot.lifecycle.unmount();
  });
});

describe("topology", () => {
  it("layout: the lead on top, then one layer per group (the lead's own first), only known links", () => {
    const members = [member({ key: "dev-impl", groupId: "dev" }), member({ key: "orch-lead", groupId: "orch", lead: true }), member({ key: "dev-review", groupId: "dev" })];
    const canvas = buildCrewCanvas(members, [
      { from: "orch-lead", to: "dev-impl", kind: "assigns_to" },
      { from: "orch-lead", to: "ghost", kind: "assigns_to" },
    ], [], new Set(), null);
    const at = new Map(canvas.boxes.map((box) => [box.id, box]));
    expect(at.get("orch-lead")!.layer).toBe(0);
    expect([at.get("dev-impl")!.layer, at.get("dev-review")!.layer]).toEqual([1, 1]);
    expect(at.get("dev-impl")!.y).toBeGreaterThan(at.get("orch-lead")!.y);
    expect(at.get("dev-impl")!.y).toBe(at.get("dev-review")!.y);
    expect(canvas.edges.map((e) => e.id)).toEqual(["orch-lead->dev-impl:assigns_to"]);
  });

  it("the tab draws members coloured by activity and a card with the Needs-you question and answer button", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const sent: unknown[] = [];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: backend({
        getActivity: () => ({ members: [view({ key: "orch-lead", lead: true, activity: "working" }), view({ activity: "needs-you", needsYou: ["human-question"], question: "v1 or v2?" })] }),
        sendMessage: (input: unknown) => (sent.push(input), { messages: [], error: null }),
      }),
    });
    await openCrew(slot, "Topology");
    await waitFor(() => expect(slot.container.querySelector('[data-member-node="dev-impl"]')?.getAttribute("data-activity")).toBe("needs-you"));
    expect(slot.container.querySelector('[data-member-node="orch-lead"]')!.getAttribute("data-activity")).toBe("working");
    const card = slot.getByRole("complementary", { name: "Member card" });
    expect(card.textContent).toContain("dev-impl@trio · Shift 1");
    expect(card.textContent).toContain("v1 or v2?");
    fireEvent.change(within(card).getByLabelText("Answer"), { target: { value: "v2" } });
    fireEvent.click(within(card).getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(sent).toEqual([{ projectId: "p1", to: "dev-impl@trio", body: "v2", crew: "trio", replyTo: null }]));
    expect(within(slot.getByRole("list", { name: "Links" })).getByText("orch-lead assigns_to dev-impl")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("negative: without Needs you the card has no question box; Open and Reset call the server", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const calls: { method: string; input: unknown }[] = [];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: backend({
        openMembers: (input: unknown) => (calls.push({ method: "openMembers", input }), { opened: ["th_1"], error: null }),
        reset: (input: unknown) => (calls.push({ method: "reset", input }), { results: [], problems: [], error: null }),
      }),
    });
    await openCrew(slot, "Topology");
    const card = await slot.findByRole("complementary", { name: "Member card" });
    expect(card.querySelector("[data-needs-you]")).toBeNull();
    expect(card.textContent).toContain("orch-lead@trio");
    fireEvent.click(within(card).getByRole("button", { name: "Open" }));
    fireEvent.click(within(card).getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(calls.map((c) => c.method)).toEqual(["openMembers", "reset"]));
    expect(calls[1]!.input).toEqual({ projectId: "p1", name: "trio", member: "orch-lead", mode: "clear" });
    slot.lifecycle.unmount();
  });

  it("BBP-31: a member with open graph runs shows a sub-row per run; negative: none means no list", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: backend({
        getActivity: () => ({
          members: [
            view({ key: "orch-lead", lead: true }),
            view({ graphRuns: [{ runId: "run_1", graphId: "release", status: "running" }, { runId: "run_2", graphId: "triage", status: "failed" }] }),
          ],
        }),
      }),
    });
    await openCrew(slot, "Topology");
    // negative: the initially selected lead card has no runs, so none of this shows.
    const leadCard = await slot.findByRole("complementary", { name: "Member card" });
    expect(leadCard.textContent).not.toContain("release");
    fireEvent.click(slot.container.querySelector('[data-member-node="dev-impl"]')!);
    const card = await slot.findByRole("complementary", { name: "Member card" });
    expect(card.textContent).toContain("release");
    expect(card.textContent).toContain("running");
    expect(card.textContent).toContain("triage");
    expect(card.textContent).toContain("failed");
    slot.lifecycle.unmount();
  });
});

describe("topology edges (research template)", () => {
  const research = () =>
    buildCrewCanvas(
      [member({ key: "orch-lead", groupId: "orch", lead: true }), member({ key: "res-one", groupId: "res" }), member({ key: "res-two", groupId: "res" })],
      [
        { from: "orch-lead", to: "res-one", kind: "assigns_to" },
        { from: "orch-lead", to: "res-two", kind: "assigns_to" },
        { from: "res-one", to: "orch-lead", kind: "escalates_to" },
        { from: "res-two", to: "orch-lead", kind: "escalates_to" },
      ],
      [],
      new Set(),
      null,
    );

  it("links down run as Graph Studio's forward edge; links back up run through the gaps and the right lane", () => {
    const canvas = research();
    const box = new Map(canvas.boxes.map((b) => [b.id, b]));
    const byId = new Map(canvas.edges.map((edge) => [edge.id, edge]));
    const lead = box.get("orch-lead")!;
    const one = box.get("res-one")!;
    // down: leaves the lead's bottom edge
    expect(byId.get("orch-lead->res-one:assigns_to")!.data!.path).toContain(` ${lead.y + lead.height} C `);
    // back up: leaves res-one at its bottom edge, into the gap under its row, and enters the lead from above
    const back = byId.get("res-one->orch-lead:escalates_to")!.data!.path;
    expect(back.split(" ")[2]).toBe(String(one.y + one.height));
    expect(back.endsWith(` ${lead.y}`)).toBe(true);
    expect(byId.get("res-one->orch-lead:escalates_to")!.ariaLabel).toBe("res-one escalates orch-lead");
  });

  it("negative: a pair A→B / B→A never shares a path", () => {
    const edges = research().edges;
    const there = edges.find((edge) => edge.id === "orch-lead->res-one:assigns_to")!;
    const back = edges.find((edge) => edge.id === "res-one->orch-lead:escalates_to")!;
    expect(there.data!.path).not.toBe(back.data!.path);
    expect(new Set(edges.map((edge) => edge.data!.path)).size).toBe(edges.length);
  });

  it("negative: links to unknown members produce no edge", () => {
    const canvas = buildCrewCanvas([member({ key: "orch-lead", groupId: "orch", lead: true })], [{ from: "ghost", to: "orch-lead", kind: "escalates_to" }], [], new Set(), null);
    expect(canvas.edges).toEqual([]);
  });

  it("BBP-48: the legend shows every link kind without hiding it below a panel-width breakpoint", () => {
    const { container } = render(<TopologyLegend kinds={["assigns_to", "escalates_to"]} messages={false} />);
    const items = within(container).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    for (const item of items) expect(item.className).not.toContain("hidden");
  });

  it("negative: without any known link kind and no messages, the legend renders nothing", () => {
    const { container } = render(<TopologyLegend kinds={[]} messages={false} />);
    expect(container.querySelector("ul")).toBeNull();
  });

  it("a narrow panel wraps a wide group onto more rows instead of shrinking it", () => {
    const members = [member({ key: "orch-lead", groupId: "orch", lead: true }), ...["a", "b", "c", "d"].map((k) => member({ key: `dev-${k}`, groupId: "dev" }))];
    const wide = buildCrewCanvas(members, [], [], new Set(), null);
    const narrow = buildCrewCanvas(members, [], [], new Set(), null, 2);
    expect(narrow.width).toBeLessThan(wide.width);
    expect(narrow.height).toBeGreaterThan(wide.height);
    expect(new Set(narrow.boxes.filter((b) => b.layer === 1).map((b) => b.y)).size).toBe(2);
  });
});

describe("topology canvas surfaces", () => {
  it("cards name their group in Graph Studio's kind line; no group boxes are drawn", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: backend({}) });
    await openCrew(slot, "Topology");
    const node = await waitFor(() => {
      const found = slot.container.querySelector('[data-member-node="dev-impl"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(node.textContent).toContain("dev");
    expect(slot.container.querySelector("[data-group-area]")).toBeNull();
    expect(slot.container.querySelector(".react-flow__node-member")).not.toBeNull();
    slot.lifecycle.unmount();
  });

  it("an archived member's node says archived with the status first and Shift N kept (wraps, not cut)", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: backend({
        getActivity: () => ({
          members: [view({ key: "orch-lead", address: "orch-lead@trio", lead: true }), view({ thread: "archived", activity: "unknown", status: null })],
        }),
      }),
    });
    await openCrew(slot, "Topology");
    const meta = await waitFor(() => {
      const found = slot.container.querySelector('[data-member-node="dev-impl"] [data-member-meta]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(meta.textContent).toMatch(/^archived · Shift 1 · /);
    expect(meta.className).toContain("line-clamp-2");
    expect(meta.className).not.toMatch(/\btruncate\b/);
    // negative: a live member keeps its activity, and nobody reads "unknown"
    const lead = slot.container.querySelector('[data-member-node="orch-lead"] [data-member-meta]')!;
    expect(lead.textContent).toMatch(/^idle/);
    expect(slot.container.textContent).not.toContain("unknown");
    slot.lifecycle.unmount();
  });

  it("Reset is a split button: the menu offers clear context and new thread; new thread resets with mode new", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const calls: unknown[] = [];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: backend({ reset: (input: unknown) => (calls.push(input), { results: [], problems: [], error: null }) }),
    });
    await openCrew(slot, "Topology");
    const card = await slot.findByRole("complementary", { name: "Member card" });
    // Negative first: no loose "Reset (new thread)" control before the menu is opened.
    expect(within(card).queryByText("Reset (new thread)")).toBeNull();
    expect(within(card).queryByRole("menu")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "More reset options" }));
    const menu = within(card).getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Reset (clear context)", "Reset (new thread)"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Reset (new thread)" }));
    await waitFor(() => expect(calls).toEqual([{ projectId: "p1", name: "trio", member: "orch-lead", mode: "new" }]));
    expect(within(card).queryByRole("menu")).toBeNull();
    slot.lifecycle.unmount();
  });
});

describe("crew header", () => {
  it("dropdown, Open all and the ⋯ menu with Stop, Snapshot, Add member, Attach, Delete", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const calls: { method: string; input: unknown }[] = [];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: backend({
        openMembers: (input: unknown) => (calls.push({ method: "openMembers", input }), { opened: ["th_1", "th_2"], error: null }),
        snapshot: (input: unknown) => (calls.push({ method: "snapshot", input }), { id: "snap_1", bindings: 2, work: 0, messages: 1, error: null }),
        attachCandidates: () => ({ threads: [{ id: "thr_x", title: "scratch", status: "idle", providerId: "claude-code" }] }),
      }),
    });
    await openCrew(slot, "Topology");
    expect((slot.getByLabelText("Crew") as HTMLSelectElement).value).toBe("p1:trio");
    fireEvent.click(slot.getByRole("button", { name: "Open all" }));
    await slot.findByText("Opened 2 thread(s) side by side");
    fireEvent.click(slot.getByRole("button", { name: "More crew actions" }));
    const menu = slot.getByRole("menu", { name: "Crew actions" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Stop", "Snapshot", "Add member", "Attach thread…", "Delete crew…"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Snapshot" }));
    await slot.findByText(/Snapshot snap_1: 2 bindings/);
    fireEvent.click(slot.getByRole("button", { name: "More crew actions" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Attach thread…" }));
    await slot.findByRole("list", { name: "Unassigned threads" });
    expect(slot.getByText("scratch")).toBeTruthy();
    slot.lifecycle.unmount();
  });
});

describe("add member form", () => {
  it("uses BB's picker: without a pick no provider/model is sent (the lead's apply), with a pick the choice is sent", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const sent: Record<string, unknown>[] = [];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: backend({ addMember: (input: unknown) => (sent.push(input as Record<string, unknown>), { results: [{ result: "spawned", address: "dev-x@trio" }], error: null }) }),
    });
    await openCrew(slot, "Topology");
    const open = () => {
      fireEvent.click(slot.getByRole("button", { name: "More crew actions" }));
      fireEvent.click(slot.getByRole("menuitem", { name: "Add member" }));
    };
    open();
    let form = within(slot.getByRole("region", { name: "Add member" }));
    expect(form.queryByLabelText("Provider (inherited if empty)")).toBeNull();
    fireEvent.change(form.getByLabelText("Group"), { target: { value: "dev" } });
    fireEvent.change(form.getByLabelText("Member id"), { target: { value: "x" } });
    fireEvent.click(form.getByRole("button", { name: "Add and apply" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect("provider" in sent[0]!).toBe(false);
    open();
    form = within(slot.getByRole("region", { name: "Add member" }));
    fireEvent.change(form.getByLabelText("Group"), { target: { value: "dev" } });
    fireEvent.change(form.getByLabelText("Member id"), { target: { value: "y" } });
    const picker = within(form.getByLabelText("New member execution"));
    fireEvent.change(picker.getByLabelText("Provider ID"), { target: { value: "codex" } });
    fireEvent.change(picker.getByLabelText("Model"), { target: { value: "gpt-6-astra" } });
    fireEvent.click(picker.getByRole("button", { name: "Apply execution selection" }));
    fireEvent.click(form.getByRole("button", { name: "Add and apply" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ provider: "codex", model: "gpt-6-astra", id: "y" });
    slot.lifecycle.unmount();
  });
});

describe("crew file editor", () => {
  it("validates while typing: an error appears at once, Apply is disabled, no plan is asked for", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const planned: unknown[] = [];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: backend({ plan: (input: unknown) => (planned.push(input), { problems: [], items: [] }) }) });
    await openCrew(slot, "Edit crew file");
    const editor = (await slot.findByLabelText("Crew file YAML")) as HTMLTextAreaElement;
    await waitFor(() => expect(planned.length).toBe(1));
    fireEvent.change(editor, { target: { value: editor.value.replace("lead: true", "lead: true\n        permissions: full") } });
    const problems = slot.getByRole("region", { name: "Problems" });
    expect(problems.textContent).toContain("runs with permissions: full — confirm with --confirm-full");
    expect((slot.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(editor, { target: { value: "version: 1\nname: a.b\ngroups: []\n" } });
    expect(problems.querySelectorAll('[data-level="error"]').length).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(planned.length).toBe(1);
    slot.lifecycle.unmount();
  });

  it("the preview shows exactly the lines of bb crew plan, and Apply sends the edited file", async () => {
    // The real service computes the plan, so the preview is compared with the CLI's own lines.
    const env = setup();
    await running(env.service, env.port);
    const edited = trioYaml({ summary: "edited" }).replace(/(- id: review\n(?:\s+\w+: .*\n)*?\s+model: )\S+/, "$1claude-sonnet-5");
    const planOf = async (yaml: string) => {
      const { validation, items } = await env.service.plan(PROJECT, yaml);
      return { problems: validation.problems, items };
    };
    const expected = formatPlan((await planOf(edited)).items);
    expect(expected.some((line) => line.includes("update"))).toBe(true);
    const applied: unknown[] = [];
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: backend({
        plan: ((input: { yaml: string }) => planOf(input.yaml)) as never,
        apply: (input: unknown) => (applied.push(input), { crew, problems: [], results: [{ key: "dev-review", address: "dev-review@trio", result: "updated", threadId: "th_3", shift: 1, detail: null }] }),
      }),
    });
    await openCrew(slot, "Edit crew file");
    const editor = (await slot.findByLabelText("Crew file YAML")) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: edited } });
    const preview = slot.getByRole("region", { name: "What Apply does" });
    await waitFor(() => expect(Array.from(preview.querySelectorAll("[data-plan-line]")).map((line) => line.textContent)).toEqual(expected));
    fireEvent.click(slot.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0]).toMatchObject({ projectId: "p1", yaml: edited });
    await slot.findByText("updated dev-review@trio");
    slot.lifecycle.unmount();
  });

  it("the form uses BB's provider/model picker per member and writes its choice into the YAML", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: backend({ getCrewFile: () => ({ yaml: trioYaml(), version: 2 }) }) });
    await openCrew(slot, "Edit crew file");
    await slot.findByLabelText("Crew file YAML");
    fireEvent.click(slot.getByRole("tab", { name: "Form" }));
    const pickers = slot.getAllByTestId("bb-provider-model-picker");
    expect(pickers).toHaveLength(3);
    // Negative: the old free-text fields are gone.
    expect(slot.queryByLabelText("dev-impl provider")).toBeNull();
    const impl = within(slot.getByLabelText("dev-impl execution"));
    fireEvent.change(impl.getByLabelText("Model"), { target: { value: "claude-sonnet-5" } });
    fireEvent.change(impl.getByLabelText("Reasoning level"), { target: { value: "high" } });
    fireEvent.click(impl.getByRole("button", { name: "Apply execution selection" }));
    fireEvent.click(slot.getByRole("tab", { name: "YAML" }));
    const yaml = (slot.getByLabelText("Crew file YAML") as HTMLTextAreaElement).value;
    const members = new Map(validateCrew(yaml).members.map((m) => [m.key, m]));
    expect(members.get("dev-impl")).toMatchObject({ provider: "claude-code", model: "claude-sonnet-5", reasoningLevel: "high" });
    // Negative: the other members keep what they had.
    expect(members.get("dev-review")!.reasoningLevel).toBeNull();
    slot.lifecycle.unmount();
  });

  it("form and YAML are two views of one file: a form edit shows up in the YAML, comments kept", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: backend({ getCrewFile: () => ({ yaml: `# keep me\n${trioYaml()}`, version: 2 }) }) });
    await openCrew(slot, "Edit crew file");
    await slot.findByLabelText("Crew file YAML");
    fireEvent.click(slot.getByRole("tab", { name: "Form" }));
    fireEvent.change(slot.getByLabelText("dev-impl role"), { target: { value: "Builds carefully." } });
    fireEvent.click(slot.getByRole("tab", { name: "YAML" }));
    const yaml = (slot.getByLabelText("Crew file YAML") as HTMLTextAreaElement).value;
    expect(yaml).toContain("role: Builds carefully.");
    expect(yaml).toContain("# keep me");
    slot.lifecycle.unmount();
  });
});

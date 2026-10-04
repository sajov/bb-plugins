// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { flowOf, memberKeyOf, messageFlows, recentFlowIds, RECENT_MS, shortAddress, timeline } from "../lib/comms";
import type { CrewDto, MemberDto, MessageDto, OverviewDto } from "../server";

const KNOWN = new Set(["orch-lead", "dev-impl", "dev-review"]);
const msg = (id: string, from: string, to: string, createdAt: number) => ({ id, fromAddress: from, toAddress: to, createdAt });

describe("lib/comms", () => {
  it("maps addresses of this crew to member keys", () => {
    expect(memberKeyOf("dev-impl@trio", "trio", KNOWN)).toBe("dev-impl");
  });

  it("negative: human, system, other crews and unknown keys have no node", () => {
    expect(memberKeyOf("human", "trio", KNOWN)).toBeNull();
    expect(memberKeyOf("system", "trio", KNOWN)).toBeNull();
    expect(memberKeyOf("dev-impl@beta", "trio", KNOWN)).toBeNull();
    expect(memberKeyOf("ghost@trio", "trio", KNOWN)).toBeNull();
    expect(memberKeyOf("@trio", "trio", KNOWN)).toBeNull();
  });

  it("aggregates one flow per ordered pair, counting and keeping the newest message", () => {
    const flows = messageFlows(
      [
        msg("m1", "orch-lead@trio", "dev-impl@trio", 10),
        msg("m2", "orch-lead@trio", "dev-impl@trio", 30),
        msg("m3", "dev-impl@trio", "orch-lead@trio", 20),
      ],
      "trio",
      KNOWN,
    );
    expect(flows).toEqual([
      { id: "msg:orch-lead->dev-impl", from: "orch-lead", to: "dev-impl", count: 2, lastAt: 30, lastId: "m2" },
      { id: "msg:dev-impl->orch-lead", from: "dev-impl", to: "orch-lead", count: 1, lastAt: 20, lastId: "m3" },
    ]);
  });

  it("negative: self-messages and messages with an end off the canvas make no flow", () => {
    const flows = messageFlows(
      [msg("a", "dev-impl@trio", "dev-impl@trio", 1), msg("b", "human", "dev-impl@trio", 2), msg("c", "orch-lead@trio", "orch-lead@beta", 3)],
      "trio",
      KNOWN,
    );
    expect(flows).toEqual([]);
    expect(flowOf(msg("b", "human", "dev-impl@trio", 2), "trio", KNOWN)).toBeNull();
  });

  it("a flow is recent inside the window and not after it", () => {
    const flows = messageFlows([msg("m1", "orch-lead@trio", "dev-impl@trio", 1000)], "trio", KNOWN);
    expect([...recentFlowIds(flows, 1000 + RECENT_MS)]).toEqual(["msg:orch-lead->dev-impl"]);
    expect([...recentFlowIds(flows, 1001 + RECENT_MS)]).toEqual([]);
  });

  it("the timeline is oldest first and keeps the newest when cut", () => {
    const list = [msg("c", "a", "b", 3), msg("a", "a", "b", 1), msg("b", "a", "b", 2)];
    expect(timeline(list).map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(timeline(list, 2).map((m) => m.id)).toEqual(["b", "c"]);
  });

  it("shortens this crew's addresses only", () => {
    expect(shortAddress("dev-impl@trio", "trio")).toBe("dev-impl");
    expect(shortAddress("orch-lead@beta", "trio")).toBe("orch-lead@beta");
    expect(shortAddress("human", "trio")).toBe("human");
  });

  it("message edges mark the recent and the active flow, and only those", async () => {
    const { buildCrewCanvas } = await import("../components/crew-topology");
    const flows = messageFlows([msg("m1", "orch-lead@trio", "dev-impl@trio", 1), msg("m2", "dev-impl@trio", "orch-lead@trio", 2)], "trio", KNOWN);
    const canvas = buildCrewCanvas([member("orch-lead", true), member("dev-impl")], [], flows, new Set(["msg:orch-lead->dev-impl"]), "msg:dev-impl->orch-lead");
    expect(canvas.edges.map((e) => [e.id, e.data!.kind, e.data!.recent, e.data!.active])).toEqual([
      ["msg:orch-lead->dev-impl", "message", true, false],
      ["msg:dev-impl->orch-lead", "message", false, true],
    ]);
  });
});

describe("lib/canvas-layout", () => {
  it("pathBetween: below is a vertical S, above bows into the lane, same row goes side to side or under", async () => {
    const { pathBetween } = await import("../lib/canvas-layout");
    const box = (id: string, x: number, y: number) => ({ id, x, y, width: 100, height: 50, layer: 0 });
    expect(pathBetween(box("a", 0, 0), box("b", 0, 100)).shape).toBe("down");
    const back = pathBetween(box("a", 0, 100), box("b", 0, 0), 0, 300);
    // out of a's bottom centre, through the gaps and the lane, in from above at b's top centre
    expect(back.shape).toBe("back");
    expect(back.path.startsWith("M 50 150 ")).toBe(true);
    expect(back.path).toContain(" 300 ");
    expect(back.path.endsWith("L 50 0")).toBe(true);
    expect(pathBetween(box("a", 0, 0), box("b", 124, 0)).shape).toBe("side");
    expect(pathBetween(box("a", 200, 0), box("b", 0, 0)).shape).toBe("under");
  });

  it("slots spread edges of one pair in both directions; a lone edge keeps slot 0", async () => {
    const { slots } = await import("../lib/canvas-layout");
    expect(slots([{ from: "a", to: "b" }, { from: "b", to: "a" }, { from: "a", to: "b" }, { from: "c", to: "d" }])).toEqual([0, 1, -1, 0]);
  });

  it("perRow fits at least one box", async () => {
    const { perRow } = await import("../lib/canvas-layout");
    expect(perRow(1000, 172)).toBe(4);
    expect(perRow(100, 172)).toBe(1);
  });

  it("boardLayers: a crew that waits sits below its source; negative: no waits, one layer; a cycle stays bounded", async () => {
    const { boardLayers } = await import("../lib/canvas-layout");
    expect(boardLayers(["a", "b", "c"], [{ crew: "b", source: "a" }])).toEqual([["a", "c"], ["b"]]);
    expect(boardLayers(["a", "b"], [])).toEqual([["a", "b"]]);
    expect(boardLayers(["a", "b"], [{ crew: "a", source: "b" }, { crew: "b", source: "a" }]).flat().sort()).toEqual(["a", "b"]);
  });

  it("crewLayers: lead alone on top, groups below in order; negative: without a lead there is no empty top layer", async () => {
    const { crewLayers } = await import("../lib/canvas-layout");
    expect(crewLayers([{ key: "d1", groupId: "dev", lead: false }, { key: "l", groupId: "orch", lead: true }, { key: "o2", groupId: "orch", lead: false }])).toEqual([["l"], ["o2"], ["d1"]]);
    expect(crewLayers([{ key: "d1", groupId: "dev", lead: false }])).toEqual([["d1"]]);
  });
});

describe("panel helpers", () => {
  const crewDto = (id: string, projectId: string, projectName: string | null = null): CrewDto => ({
    id,
    projectId,
    name: id,
    fileVersion: 1,
    status: "running",
    updatedAt: 1,
    projectName,
  });

  it("shownProject: the picked project, then BB's current one, then the first", async () => {
    const { shownProject } = await import("../app");
    const crews = [crewDto("a", "p1"), crewDto("b", "p2")];
    expect(shownProject(crews, "p2", "p1")).toBe("p2");
    expect(shownProject(crews, null, "p2")).toBe("p2");
    expect(shownProject(crews, null, null)).toBe("p1");
  });

  it("negative: a picked or current project without crews does not win", async () => {
    const { shownProject } = await import("../app");
    const crews = [crewDto("a", "p1")];
    expect(shownProject(crews, "p9", "p8")).toBe("p1");
    expect(shownProject([], null, "p1")).toBeNull();
  });

  it("crewProjects counts crews per project and falls back to the id without a name", async () => {
    const { crewProjects } = await import("../app");
    expect(crewProjects([crewDto("a", "p1", "Plugins"), crewDto("b", "p1", "Plugins"), crewDto("c", "p2")])).toEqual([
      { id: "p1", name: "Plugins", count: 2 },
      { id: "p2", name: "p2", count: 1 },
    ]);
  });

  it("boardLines: a lead line is live while its crews talk, a wait line never", async () => {
    const { boardLines } = await import("../app");
    const overview = {
      leadLinks: [{ from: "beta", to: "trio", count: 2 }],
      dependencies: [{ crew: "beta", task: "T-1", until: "merged", state: "open", source: "trio" }],
    } as unknown as OverviewDto;
    const talk = { crossCrew: true, fromAddress: "orch-lead@trio", toAddress: "orch-lead@beta", createdAt: 1000 } as MessageDto;
    const live = boardLines(overview, [talk], 1000 + RECENT_MS);
    expect(live.map((l) => [l.kind, l.live])).toEqual([
      ["lead", true],
      ["wait", false],
    ]);
    // negative: old talk, or talk inside one crew, does not light the line
    expect(boardLines(overview, [talk], 1001 + RECENT_MS)[0]!.live).toBe(false);
    expect(boardLines(overview, [{ ...talk, crossCrew: false }], 1000)[0]!.live).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Topology tab: the crew's own communication next to the canvas

const crew = { id: "p1:trio", projectId: "p1", name: "trio", fileVersion: 2, status: "running" as const, updatedAt: 1, projectName: null };
const member = (key: string, lead = false): MemberDto => ({
  key,
  groupId: key.split("-")[0]!,
  address: `${key}@trio`,
  lead,
  provider: "claude-code",
  model: "claude-haiku-4-5-20251001",
  permissions: "accept-edits",
  shift: 1,
  threadId: `th_${key}`,
  thread: "present",
  status: "idle",
  actualProvider: null,
  actualModel: null,
});
const message = (id: string, from: string, to: string, subject: string, createdAt: number): MessageDto => ({
  id,
  chainId: "ch_1",
  step: 1,
  replyTo: null,
  kind: "message",
  fromAddress: from,
  fromCrew: "p1:trio",
  toAddress: to,
  toCrew: "p1:trio",
  subject,
  body: `${subject} body`,
  priority: "normal",
  status: "delivered",
  reason: null,
  deliveryMode: "start",
  attempts: 1,
  lastError: null,
  crossCrew: false,
  openQuestion: false,
  createdAt,
  deliveredAt: null,
});

const backend = (messages: MessageDto[], calls: unknown[] = []) => ({
  listCrews: () => ({ crews: [crew] }),
  getCrew: () => ({ crew, members: [member("orch-lead", true), member("dev-impl")], links: [] }),
  getActivity: () => ({ members: [] }),
  listMessages: (input: unknown) => (calls.push(input), { messages }),
  rowStatuses: () => ({ rows: [], needsYou: 0 }),
  projectOverview: () => ({ crews: [{ name: "trio", status: "running", summary: "", task: null, branch: null, behind: 0, merge: null, needsYou: 0, members: [] }], leadLinks: [], dependencies: [], threads: { limit: null, source: "bb", running: null, members: 0 } }),
  listChannel: () => ({ posts: [] }),
  listWork: () => ({ items: [] }),
  openMembers: () => ({ opened: [], error: null }),
});

async function openTopology(slot: { findByRole: (role: string, options: { name: string }) => Promise<HTMLElement> }) {
  fireEvent.click(await slot.findByRole("button", { name: "trio" }));
}

describe("topology communication", () => {
  it("asks for this crew's own messages, lists them in order and in the log", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const calls: unknown[] = [];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: backend([message("m1", "orch-lead@trio", "dev-impl@trio", "Build it", 1), message("m2", "dev-impl@trio", "orch-lead@trio", "Done", 2)], calls),
    });
    await openTopology(slot);
    const strip = await slot.findByRole("list", { name: "Messages in order" });
    expect(within(strip).getAllByRole("button").map((b) => b.textContent)).toEqual(["orch-leaddev-impl", "dev-implorch-lead"]);
    expect(calls).toContainEqual({ projectId: "p1", crew: "trio", crossCrew: false, limit: 200 });
    const log = slot.getByRole("list", { name: "Crew log" });
    // newest first in the log
    expect(Array.from(log.querySelectorAll("[data-message]")).map((li) => li.getAttribute("data-message"))).toEqual(["m2", "m1"]);
    slot.lifecycle.unmount();
  });

  it("a tick opens the message card in place of the member card; closing brings the member back", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: backend([message("m1", "orch-lead@trio", "dev-impl@trio", "Build it", 1)]) });
    await openTopology(slot);
    // negative first: no message card before a pick
    await slot.findByRole("complementary", { name: "Member card" });
    expect(slot.queryByRole("complementary", { name: "Message card" })).toBeNull();
    const strip = await slot.findByRole("list", { name: "Messages in order" });
    fireEvent.click(within(strip).getByRole("button"));
    const card = await slot.findByRole("complementary", { name: "Message card" });
    expect(card.textContent).toContain("Build it body");
    expect(card.querySelector('[data-message-status="delivered"]')).not.toBeNull();
    expect(slot.queryByRole("complementary", { name: "Member card" })).toBeNull();
    expect(slot.container.querySelector('[data-message="m1"]')!.getAttribute("aria-current")).toBe("true");
    fireEvent.click(within(card).getByRole("button", { name: "Close message" }));
    await slot.findByRole("complementary", { name: "Member card" });
    slot.lifecycle.unmount();
  });

  it("Replay walks the messages one after another and stops on the newest", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: backend([message("m1", "orch-lead@trio", "dev-impl@trio", "First", 1), message("m2", "dev-impl@trio", "orch-lead@trio", "Second", 2)]),
    });
    await openTopology(slot);
    await slot.findByRole("list", { name: "Messages in order" });
    const { vi } = await import("vitest");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fireEvent.click(slot.getByRole("button", { name: "Replay" }));
      await waitFor(() => expect(slot.container.querySelector('[data-tick="m1"]')!.getAttribute("aria-pressed")).toBe("true"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1700);
      });
      await waitFor(() => expect(slot.container.querySelector('[data-tick="m2"]')!.getAttribute("aria-pressed")).toBe("true"));
      // ends on the newest: the button reads Replay again
      await waitFor(() => expect(slot.getByRole("button", { name: "Replay" })).toBeTruthy());
    } finally {
      vi.useRealTimers();
    }
    slot.lifecycle.unmount();
  });

  it("negative: without messages there is no strip, only the hint, and an empty log", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: backend([]) });
    await openTopology(slot);
    await slot.findByText("No messages inside this crew yet", { exact: false });
    expect(slot.queryByRole("list", { name: "Messages in order" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Replay" })).toBeNull();
    expect(slot.queryByRole("list", { name: "Crew log" })).toBeNull();
    slot.lifecycle.unmount();
  });
});

describe("Needs you with context", () => {
  it("a loop explains itself and lists the held message with Release and Discard — no empty answer box", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const actions: unknown[] = [];
    const held = { ...message("m9", "orch-lead@trio", "dev-impl@trio", "Again", 5), status: "stopped_loop" as const, reason: "loop: 6 rounds" };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        ...backend([held]),
        getActivity: () => ({
          members: [
            {
              key: "orch-lead", address: "orch-lead@trio", lead: true, crewName: "trio", threadId: "th_orch-lead", status: "idle", thread: "present",
              activity: "needs-you", needsYou: ["loop"], question: null, held: 0, diagnoses: [], rowStatus: null, openWork: 0, context: null, graphRuns: [],
            },
          ],
        }),
        messageAction: (input: unknown) => (actions.push(input), { message: null, error: null }),
      },
    });
    await openTopology(slot);
    const card = await slot.findByRole("complementary", { name: "Member card" });
    await waitFor(() => expect(card.querySelector('[data-reason="loop"]')).not.toBeNull());
    expect(card.textContent).toContain("Stopped as a loop");
    expect(within(card).queryByLabelText("Answer")).toBeNull();
    const list = within(card).getByRole("list", { name: "Held messages" });
    expect(list.textContent).toContain("Again");
    fireEvent.click(within(list).getByRole("button", { name: "Release" }));
    await waitFor(() => expect(actions).toEqual([{ id: "m9", action: "release" }]));
    slot.lifecycle.unmount();
  });

  it("negative: a member without Needs you shows no reasons and no held list", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: backend([]) });
    await openTopology(slot);
    const card = await slot.findByRole("complementary", { name: "Member card" });
    expect(card.querySelector("[data-needs-you]")).toBeNull();
    expect(within(card).queryByRole("list", { name: "Held messages" })).toBeNull();
    slot.lifecycle.unmount();
  });
});

describe("overview cards", () => {
  it("clicking anywhere on a crew card opens the crew view", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        ...backend([]),
        projectOverview: () => ({
          crews: [{ name: "trio", status: "running", summary: "", task: null, branch: null, behind: null, merge: null, needsYou: 0, members: [] }],
          leadLinks: [],
          dependencies: [],
          threads: { limit: null, source: "bb", running: null, members: 0 },
        }),
      },
    });
    const node = await waitFor(() => {
      const found = slot.container.querySelector(".react-flow__node-card");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    // negative first: still on the overview
    expect(slot.queryByRole("button", { name: "Topology" })).toBeNull();
    fireEvent.click(node.querySelector("[data-crew-card]")!.lastElementChild as HTMLElement);
    await slot.findByRole("button", { name: "Topology" });
    slot.lifecycle.unmount();
  });
});

describe("feed preview", () => {
  it("collapses newlines into one paragraph and cuts long bodies", async () => {
    const { preview } = await import("../app");
    expect(preview("a\n\n\nb   c")).toBe("a b c");
    expect(preview("x".repeat(300), 10)).toBe(`${"x".repeat(9)}…`);
  });
  it("negative: a short body stays as it is", async () => {
    const { preview } = await import("../app");
    expect(preview("short")).toBe("short");
  });
});

describe("less wool on the canvas", () => {
  const flow = (id: string, lastAt: number) => ({ id, from: "a", to: "b", count: 1, lastAt, lastId: id });

  it("shownFlows: the active and the recent flows only", async () => {
    const { shownFlows } = await import("../lib/comms");
    const flows = [flow("f1", 1), flow("f2", 2), flow("f3", 3)];
    expect(shownFlows(flows, new Set(["f1"]), "f3").map((f) => f.id)).toEqual(["f1", "f3"]);
  });

  it("negative: with nothing recent or active, only the last few, newest first", async () => {
    const { shownFlows } = await import("../lib/comms");
    const flows = [flow("f1", 1), flow("f2", 2), flow("f3", 3), flow("f4", 4)];
    expect(shownFlows(flows, new Set(), null).map((f) => f.id)).toEqual(["f4", "f3", "f2"]);
    expect(shownFlows([], new Set(), null)).toEqual([]);
  });

  it("an edge that skips a row takes the lane; negative: the next row keeps the straight S", async () => {
    const { pathBetween, LAYER_GAP } = await import("../lib/canvas-layout");
    const box = (id: string, x: number, y: number) => ({ id, x, y, width: 100, height: 50, layer: 0 });
    expect(pathBetween(box("a", 0, 0), box("b", 0, 2 * (50 + LAYER_GAP))).shape).toBe("skip");
    expect(pathBetween(box("a", 0, 0), box("b", 0, 50 + LAYER_GAP)).shape).toBe("down");
  });

  it("side by side only between neighbours; past a card the edge goes under the row", async () => {
    const { pathBetween, SIBLING_GAP } = await import("../lib/canvas-layout");
    const box = (id: string, x: number) => ({ id, x, y: 0, width: 100, height: 50, layer: 0 });
    expect(pathBetween(box("a", 0), box("b", 100 + SIBLING_GAP)).shape).toBe("side");
    expect(pathBetween(box("a", 0), box("c", 2 * (100 + SIBLING_GAP))).shape).toBe("under");
  });
});

describe("roundedPath", () => {
  it("rounds each corner with a quadratic curve", async () => {
    const { roundedPath } = await import("../lib/canvas-layout");
    expect(roundedPath([[0, 0], [0, 100], [100, 100]])).toBe("M 0 0 L 0 90 Q 0 100 10 100 L 100 100");
  });
  it("negative: a straight two-point line has no curve", async () => {
    const { roundedPath } = await import("../lib/canvas-layout");
    expect(roundedPath([[0, 0], [0, 50]])).toBe("M 0 0 L 0 50");
  });
});

describe("overview card members", () => {
  const card = (n: number) => ({
    name: "trio", status: "running", summary: "", task: null, branch: null, behind: null, merge: null, needsYou: 0,
    members: Array.from({ length: n }, (_, i) => ({ key: `m${i}`, lead: i === 0, activity: "idle", needsYou: [] })),
  });
  it("names three members and counts the rest", async () => {
    const { CrewCard } = await import("../app");
    const { render } = await import("@testing-library/react");
    const view = render(<CrewCard card={card(5)} />);
    expect(view.container.querySelector("[data-more-members]")!.textContent).toBe("+2");
    expect(view.container.textContent).not.toContain("m3");
    view.unmount();
  });
  it("negative: three or fewer members, no counter", async () => {
    const { CrewCard } = await import("../app");
    const { render } = await import("@testing-library/react");
    const view = render(<CrewCard card={card(3)} />);
    expect(view.container.querySelector("[data-more-members]")).toBeNull();
    view.unmount();
  });
});

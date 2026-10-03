// @vitest-environment jsdom
//
// BBP-17: one glyph everywhere — the sidebar's branding icon.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadPluginApp, type CapturedPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import graphStudio from "../server";
import { GRAPH_STUDIO_ICON } from "../lib/icon";
import { GraphStudioFlow } from "../components/graph-studio-icon";

let app: CapturedPluginApp;

beforeAll(async () => {
  app = await loadPluginApp(() => import("../app"));
});
afterEach(cleanup);

describe("the Graph Studio icon", () => {
  it("is registered once under its own name", () => {
    expect(app.icons.map((entry) => entry.name)).toEqual([GRAPH_STUDIO_ICON]);
  });

  it("is the icon of the nav panel and the thread panel action, not Workflow", () => {
    expect(app.navPanels.map((entry) => entry.icon)).toEqual([GRAPH_STUDIO_ICON]);
    expect(app.threadPanelActions.map((entry) => entry.icon)).toEqual([GRAPH_STUDIO_ICON]);
    expect([...app.navPanels, ...app.threadPanelActions].some((entry) => entry.icon === "Workflow")).toBe(false);
  });

  it("draws the same paths as the branding icon assets/icon.svg", () => {
    const branding = readFileSync(join(__dirname, "..", "assets", "icon.svg"), "utf8");
    const { container } = render(<GraphStudioFlow />);
    const svg = container.querySelector(`svg[data-icon="${GRAPH_STUDIO_ICON}"]`);
    expect(svg).not.toBeNull();
    const shapes = [...svg!.querySelectorAll("circle, path")].map((node) =>
      node.tagName === "circle"
        ? `circle ${node.getAttribute("cx")} ${node.getAttribute("cy")} ${node.getAttribute("r")}`
        : `path ${node.getAttribute("d")}`,
    );
    const expected = [...branding.matchAll(/<(circle|path)\s([^>]*)\/>/g)].map(([, tag, attrs]) => {
      const attr = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(attrs!)?.[1];
      return tag === "circle" ? `circle ${attr("cx")} ${attr("cy")} ${attr("r")}` : `path ${attr("d")}`;
    });
    expect(expected.length).toBeGreaterThan(0);
    expect(shapes).toEqual(expected);
  });

  it("is the icon of the # mention rows", async () => {
    const host = createFakePluginHost({ pluginId: "graph-studio" });
    graphStudio(host.bb);
    const provider = host.harness.inspection.registrations.mentionProviders.find((entry) => entry.id === "graphs")!;
    const items = await provider.search({ query: "" } as never);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.icon === GRAPH_STUDIO_ICON)).toBe(true);
    await host.harness.lifecycle.dispose();
  });
});

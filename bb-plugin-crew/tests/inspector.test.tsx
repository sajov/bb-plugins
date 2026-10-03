// @vitest-environment jsdom
//
// The config panel vocabulary shared with the crew plugin (BBP-50). The file
// exists in both plugins; the twin check keeps them from drifting apart, the
// render checks pin each optional part both ways.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { InspectorFooter, InspectorHeader, InspectorRows, InspectorSection } from "../components/inspector";

// Crew's Icon is the SDK's runtime icon, which needs the plugin runtime.
beforeAll(() => installTestPluginRuntime());
afterEach(cleanup);

const OWN = resolve(__dirname, "../components/inspector.tsx");
const TWINS = [
  resolve(__dirname, "../../bb-plugin-graph-studio/components/inspector.tsx"),
  resolve(__dirname, "../../bb-plugin-crew/components/inspector.tsx"),
];

describe("inspector", () => {
  it("is byte-identical in graph-studio and crew", () => {
    const own = readFileSync(OWN, "utf8");
    for (const twin of TWINS) expect(readFileSync(twin, "utf8")).toBe(own);
  });

  it("header shows the subtitle and actions only when given", () => {
    const { rerender } = render(<InspectorHeader title="Lead" subtitle="lead@crew" actions={<button type="button">Close</button>} />);
    expect(screen.getByRole("heading", { name: "Lead" })).toBeTruthy();
    expect(screen.queryByText("lead@crew")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeNull();
    rerender(<InspectorHeader title="Lead" />);
    expect(screen.queryByText("lead@crew")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("section is folded unless opened, and shows its summary", () => {
    const { container, rerender } = render(
      <InspectorSection title="Model" summary="inherited">
        <p>body</p>
      </InspectorSection>,
    );
    expect(container.querySelector("details")!.open).toBe(false);
    expect(screen.queryByText("inherited")).not.toBeNull();
    rerender(
      <InspectorSection title="Model" open>
        <p>body</p>
      </InspectorSection>,
    );
    expect(container.querySelector("details")!.open).toBe(true);
    expect(screen.queryByText("inherited")).toBeNull();
  });

  it("rows skip falsy entries and keep the rest", () => {
    render(<InspectorRows rows={[{ label: "Model", value: "opus" }, false, null, { label: "Queue", value: "0 open" }]} />);
    const terms = screen.getAllByRole("term").map((term) => term.textContent);
    expect(terms).toEqual(["Model", "Queue"]);
  });

  it("footer renders the note and actions only when given", () => {
    const { container, rerender } = render(<InspectorFooter note="a note"><button type="button">Go</button></InspectorFooter>);
    expect(screen.queryByText("a note")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Go" })).not.toBeNull();
    rerender(<InspectorFooter />);
    expect(screen.queryByText("a note")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });
});

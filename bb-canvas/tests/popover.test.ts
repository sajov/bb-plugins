// @vitest-environment jsdom
// BBP-179: where the project dropdown opens, so it never leaves the canvas.
import { describe, expect, it } from "vitest";
import { placePopover, visibleBounds } from "../lib/popover";

const bounds = { left: 0, right: 400 };

describe("placePopover", () => {
  it("aligns its right edge to the anchor's when that fits", () => {
    expect(placePopover({ left: 300, right: 380 }, bounds, 200)).toEqual({ offset: -120, width: 200 });
  });

  it("shifts right when opening left would cross the left edge", () => {
    expect(placePopover({ left: 20, right: 100 }, bounds, 200)).toEqual({ offset: -12, width: 200 });
  });

  it("shifts left when the anchor itself sits past the right edge", () => {
    expect(placePopover({ left: 380, right: 460 }, bounds, 200)).toEqual({ offset: -188, width: 200 });
  });

  it("negative: never wider than the bounds allow", () => {
    expect(placePopover({ left: 100, right: 180 }, { left: 0, right: 150 }, 200)).toEqual({ offset: -92, width: 134 });
  });
});

// BBP-320: the side panel scrolls, so it clips a popover that only stays
// inside the canvas.
describe("visibleBounds", () => {
  const box = (el: HTMLElement, left: number, right: number) => {
    el.getBoundingClientRect = () => ({ left, right, width: right - left, top: 0, bottom: 0, height: 0, x: left, y: 0, toJSON: () => ({}) });
  };

  it("narrows to an ancestor that clips its overflow", () => {
    const canvas = document.createElement("div");
    canvas.setAttribute("data-canvas-view", "");
    const panel = document.createElement("div");
    panel.style.overflowY = "auto";
    const anchor = document.createElement("div");
    panel.appendChild(anchor);
    canvas.appendChild(panel);
    document.body.appendChild(canvas);
    box(canvas, 0, 1000);
    box(panel, 700, 1000);
    expect(visibleBounds(anchor)).toEqual({ left: 700, right: 1000 });
    canvas.remove();
  });

  it("negative: an ancestor with visible overflow does not narrow it", () => {
    const canvas = document.createElement("div");
    canvas.setAttribute("data-canvas-view", "");
    const wrapper = document.createElement("div");
    const anchor = document.createElement("div");
    wrapper.appendChild(anchor);
    canvas.appendChild(wrapper);
    document.body.appendChild(canvas);
    box(canvas, 0, 1000);
    box(wrapper, 700, 1000);
    expect(visibleBounds(anchor)).toEqual({ left: 0, right: 1000 });
    canvas.remove();
  });
});

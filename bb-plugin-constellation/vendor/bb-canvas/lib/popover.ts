// Where a toolbar dropdown opens (BBP-179): under its button, right edges
// aligned, but always inside the canvas — in BB's slim panel (370px beside
// an open file tree) a fixed `right: 0` pushed it past the left edge.

export type Span = { left: number; right: number };

const MARGIN = 8;

/** `offset` is relative to the anchor's left edge, ready for `left:` on a
 *  popover positioned inside the anchor's wrapper. */
export function placePopover(anchor: Span, bounds: Span, preferredWidth: number): { offset: number; width: number } {
  const width = Math.min(preferredWidth, bounds.right - bounds.left - 2 * MARGIN);
  let left = anchor.right - width;
  left = Math.min(left, bounds.right - MARGIN - width);
  left = Math.max(left, bounds.left + MARGIN);
  return { offset: left - anchor.left, width };
}

/** The horizontal span a popover inside `el` can actually show (BBP-320):
 *  the canvas, narrowed by every ancestor that clips its overflow — the
 *  side panel scrolls, so a popover reaching past its left edge was cut off
 *  even though it stayed inside the canvas. */
export function visibleBounds(el: Element): Span {
  let bounds: Span = { left: 0, right: window.innerWidth };
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const clips = node.hasAttribute("data-canvas-view") || [style.overflowX, style.overflowY].some((value) => value !== "" && value !== "visible");
    if (!clips) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0) continue;
    bounds = { left: Math.max(bounds.left, rect.left), right: Math.min(bounds.right, rect.right) };
  }
  return bounds;
}

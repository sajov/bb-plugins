// Bounds for the resizable details sidebar (BBP-182). Narrower than 300px
// the meta grid wraps every value; wider than 640px it eats the canvas.
export const MIN_WIDTH = 300;
export const MAX_WIDTH = 640;
export const DEFAULT_WIDTH = 360;

/** Keeps a sidebar width inside the bounds. A non-finite value (a garbage
 *  stored width, a NaN from arithmetic) falls back to the default rather
 *  than snapping to an edge. */
export function clampWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value));
}

/** How narrow the sidebar may get in a narrow panel. Below the 240px clamp
 *  on purpose: in a 370px canvas, 240px would leave the tree a sliver. */
export const NARROW_FLOOR = 160;

/** Canvas width a wide row always keeps beside the sidebar. */
export const CANVAS_RESERVE = 560;

/** The widest the sidebar may be next to a canvas row of `containerWidth`.
 *  It may take whatever leaves the canvas `CANVAS_RESERVE`, or half the row,
 *  whichever is more — so a narrow panel (BB with the file tree open, the
 *  canvas 370–700px wide) keeps half its width for the tree, while a normal
 *  window (row ≥ 1200px) gets the plain 240–640 clamp, with no jump between.
 *  `0` means not measured yet (or no layout, as in jsdom): plain clamp. */
export function maxWidthFor(containerWidth: number): number {
  if (!(containerWidth > 0)) return MAX_WIDTH;
  const room = Math.max(Math.floor(containerWidth / 2), containerWidth - CANVAS_RESERVE);
  return Math.max(NARROW_FLOOR, Math.min(MAX_WIDTH, room));
}

/** The width actually shown: the user's chosen width, capped for the container. */
export function fitWidth(width: number, containerWidth: number): number {
  return Math.min(width, maxWidthFor(containerWidth));
}

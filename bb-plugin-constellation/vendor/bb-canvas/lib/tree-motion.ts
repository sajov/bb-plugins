// BBP-200: a polled tree must change in place, not jump. Diffs the previous
// and the next React Flow nodes by id: a new node fades in, a kept one glides
// to its new position (a CSS transition on React Flow's own transform), a
// removed one stays behind briefly as a fading ghost. The CSS lives in
// `MOTION_CSS`, so the shell only has to mount it.

export const MOTION_MS = 250;
export const MOTION_ENTER = "bb-canvas-enter";
export const MOTION_EXIT = "bb-canvas-exit";
export const MOTION_MOVE = "bb-canvas-move";

export const MOTION_CSS = `
.react-flow__node.${MOTION_MOVE} { transition: transform ${MOTION_MS}ms ease; }
.react-flow__node.${MOTION_ENTER} { animation: bb-canvas-fade-in ${MOTION_MS}ms ease both; }
.react-flow__node.${MOTION_EXIT} { animation: bb-canvas-fade-out ${MOTION_MS}ms ease both; pointer-events: none; }
@keyframes bb-canvas-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes bb-canvas-fade-out { from { opacity: 1; } to { opacity: 0; } }
`;

type MotionNode = { id: string; className?: string };

export type MotionPlan<T extends MotionNode> = {
  /** The next nodes, each tagged with how it arrived. */
  nodes: T[];
  /** Nodes gone from the tree, to be shown fading out for `MOTION_MS`. */
  exiting: T[];
};

function withClass<T extends MotionNode>(node: T, name: string): T {
  return { ...node, className: node.className ? `${node.className} ${name}` : name };
}

/** `previous` is `null` on the first render: the whole tree is not "new",
 *  so nothing fades in. Reduced motion yields the same end state, untagged. */
export function planMotion<T extends MotionNode>(previous: readonly T[] | null, next: readonly T[], reducedMotion: boolean): MotionPlan<T> {
  if (previous === null || reducedMotion) return { nodes: [...next], exiting: [] };
  const before = new Set(previous.map((node) => node.id));
  const after = new Set(next.map((node) => node.id));
  return {
    nodes: next.map((node) => withClass(node, before.has(node.id) ? MOTION_MOVE : MOTION_ENTER)),
    exiting: previous.filter((node) => !after.has(node.id)).map((node) => withClass(node, MOTION_EXIT)),
  };
}

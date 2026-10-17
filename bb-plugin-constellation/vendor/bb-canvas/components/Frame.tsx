// A plain box behind a group of node cards — no state, no interaction. Where
// a frame's members sit inside it (lead above, members below, …) is the
// calling plugin's concern, decided by the order it hands nodes to
// `layoutTree`; this component only draws the rectangle `layoutTree` placed.
export type FrameProps = {
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Outside the frame being edited (BBP-166): faded, same as its member
   *  cards. */
  dimmed?: boolean;
};

export function Frame({ label, x, y, width, height, dimmed = false }: FrameProps) {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: x,
        top: y,
        width,
        height,
        // Behind every NodeCard, which React Flow stacks in render order —
        // frames are appended to the node list ahead of the cards they hold.
        zIndex: 0,
        borderRadius: 12,
        border: "1px dashed var(--border)",
        opacity: dimmed ? 0.35 : 1,
        pointerEvents: "none",
      }}
    >
      {label ? (
        <span
          style={{
            // Inside the frame's head room, not across its border: no card
            // can sit over it there (BBP-191).
            position: "absolute",
            top: 5,
            left: 12,
            padding: 0,
            whiteSpace: "nowrap",
            fontSize: 11,
            fontWeight: 600,
            color: "var(--muted-foreground)",
          }}
        >
          {label}
        </span>
      ) : null}
    </div>
  );
}

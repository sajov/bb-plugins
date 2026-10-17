// The empty state a focus leaves behind once every focused node is gone
// (BBP-204/240): vanished in a live update or hidden by the project filter.
// Takes the canvas's place, centred, so "Show all" is the obvious way back
// instead of a bare line of text in the top corner.
export type FocusUnavailableProps = {
  onShowAll: () => void;
};

export function FocusUnavailable({ onShowAll }: FocusUnavailableProps) {
  return (
    <div
      role="status"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        height: "100%",
        minHeight: 240,
        padding: 24,
        textAlign: "center",
        color: "var(--muted-foreground)",
        fontSize: 13,
      }}
    >
      {/* Viewfinder with a slash: the focus has nothing left to point at. */}
      <svg aria-hidden width={24} height={24} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 5V3.5A1.5 1.5 0 0 1 3.5 2H5M11 2h1.5A1.5 1.5 0 0 1 14 3.5V5M14 11v1.5a1.5 1.5 0 0 1-1.5 1.5H11M5 14H3.5A1.5 1.5 0 0 1 2 12.5V11M4.5 11.5l7-7" />
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ color: "var(--foreground)", fontWeight: 500 }}>Focused items are no longer available</span>
        <span>They were removed, or their project is filtered out.</span>
      </div>
      <button
        type="button"
        onClick={onShowAll}
        style={{
          display: "inline-flex",
          alignItems: "center",
          height: 28,
          padding: "0 12px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "var(--card)",
          color: "var(--foreground)",
          fontSize: 12,
          fontWeight: 500,
          cursor: "pointer",
        }}
      >
        Show all
      </button>
    </div>
  );
}

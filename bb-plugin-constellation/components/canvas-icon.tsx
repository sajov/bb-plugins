/**
 * The plugin's own glyph: one card above two, joined by a branching line —
 * the tree the page draws. Matches `assets/icon.svg` (the host-rendered
 * branding icon) stroke for stroke so both surfaces show the same mark.
 */

interface GlyphProps {
  className?: string;
}

export const CANVAS_ICON = "CanvasTree";

export function CanvasTree({ className }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x="8.5" y="3" width="7" height="5" rx="1.2" />
      <rect x="3" y="16" width="7" height="5" rx="1.2" />
      <rect x="14" y="16" width="7" height="5" rx="1.2" />
      <path d="M12 8v4" />
      <path d="M6.5 16v-2.5a1.5 1.5 0 0 1 1.5-1.5h8a1.5 1.5 0 0 1 1.5 1.5V16" />
    </svg>
  );
}

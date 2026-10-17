// The canvas's right-hand panel (BBP-313): a resizable column with a fixed
// 44 px header and a scrolling body. What goes in it — the overview, a node's
// details — is the caller's; the width, its handle and its memory are here.
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { clampWidth, DEFAULT_WIDTH, fitWidth, maxWidthFor, MIN_WIDTH } from "../lib/clampWidth";

const WIDTH_KEY = "bb-canvas:sidebar-width";
const KEY_STEP = 16;

/** Never throws — no or a broken `localStorage` means the default width,
 *  not a crashed canvas. */
function loadWidth(): number {
  try {
    const stored = localStorage.getItem(WIDTH_KEY);
    // `Number(null)` is 0, which would clamp to the minimum instead of the default.
    return stored === null ? DEFAULT_WIDTH : clampWidth(Number(stored));
  } catch {
    return DEFAULT_WIDTH;
  }
}

function saveWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    // Not persisted; the width still holds for this session.
  }
}

const STYLE_ID = "bb-canvas-sidebar-styles";

/** Hover and focus states need real selectors; injected once, like the
 *  pulse in NodeCard. */
const PANEL_CSS = `
  .bb-canvas-action:hover { background: var(--muted); }
  .bb-canvas-action:focus-visible, .bb-canvas-accordion:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
  .bb-canvas-accordion:hover { color: var(--foreground) !important; }
  .bb-canvas-resize::after {
    content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 1px;
    background: transparent; transition: background 120ms ease-out;
  }
  .bb-canvas-resize:hover::after { background: var(--border); width: 2px; left: 2px; }
  .bb-canvas-resize:focus-visible { outline: none; }
  .bb-canvas-resize:focus-visible::after, .bb-canvas-resize:active::after {
    background: var(--primary); width: 2px; left: 2px;
  }
`;

export function ensurePanelStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = PANEL_CSS;
  document.head.appendChild(style);
}

export type SidePanelProps = {
  /** The panel's accessible name. */
  label: string;
  /** The 44 px header row's content. */
  header: ReactNode;
  children: ReactNode;
};

export function SidePanel({ label, header, children }: SidePanelProps) {
  const [width, setWidth] = useState(loadWidth);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const asideRef = useRef<HTMLElement>(null);
  // The row the panel shares with the canvas; 0 until measured.
  const [containerWidth, setContainerWidth] = useState(0);
  // `width` stays the user's choice (and what is stored); `shown` is that
  // choice capped for a narrow panel, so widening the panel brings it back.
  const shown = fitWidth(width, containerWidth);
  const shownMax = maxWidthFor(containerWidth);

  useEffect(() => {
    const container = asideRef.current?.parentElement;
    if (!container) return;
    setContainerWidth(container.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setContainerWidth(container.clientWidth));
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => saveWidth(width), [width]);
  useEffect(ensurePanelStyles, []);

  useEffect(() => {
    // The handle sits on the left edge, so moving the pointer left widens.
    const onMove = (event: globalThis.MouseEvent) => {
      if (!drag.current) return;
      setWidth(clampWidth(drag.current.startWidth + drag.current.startX - event.clientX));
    };
    const onUp = () => {
      drag.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const startDrag = (event: MouseEvent) => {
    event.preventDefault();
    drag.current = { startX: event.clientX, startWidth: shown };
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const next: Record<string, number> = {
      // From what is on screen, so a key always moves the visible edge.
      ArrowLeft: shown + KEY_STEP,
      ArrowRight: shown - KEY_STEP,
      Home: MIN_WIDTH,
      End: shownMax,
    };
    if (!(event.key in next)) return;
    event.preventDefault();
    setWidth(clampWidth(next[event.key]));
  };

  return (
    <aside
      ref={asideRef}
      aria-label={label}
      // Scrolling a long list must not pan the canvas underneath it
      // (BBP-199) — React Flow skips its own wheel handling for this class.
      className="nowheel"
      style={{
        position: "relative",
        // border-box: the clamped value is the width on screen, border included.
        boxSizing: "border-box",
        width: shown,
        flexShrink: 0,
        borderLeft: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--background)",
        color: "var(--foreground)",
      }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuenow={shown}
        aria-valuemin={Math.min(MIN_WIDTH, shownMax)}
        aria-valuemax={shownMax}
        tabIndex={0}
        onMouseDown={startDrag}
        onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
        onKeyDown={onKeyDown}
        className="bb-canvas-resize"
        style={{ position: "absolute", left: -4, top: 0, bottom: 0, width: 8, cursor: "col-resize", zIndex: 1 }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8, height: 44, flexShrink: 0, padding: "0 8px 0 12px", borderBottom: "1px solid var(--border)", minWidth: 0 }}>
        {header}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>{children}</div>
    </aside>
  );
}

// One section of the side panel (BBP-313): below the panel's own header there
// is nothing but these, in the overview and in a node's view alike. The
// header stays a 32 px row and carries a short summary, so a closed section
// still says what is inside it.
import { useEffect, useId, useState, type ReactNode } from "react";

const PREFIX = "bb-canvas:accordion:";

/** `null` when nothing is stored (or storage is blocked): the default wins. */
function loadOpen(storageKey: string | undefined): boolean | null {
  if (storageKey === undefined) return null;
  try {
    const raw = localStorage.getItem(PREFIX + storageKey);
    return raw === null ? null : raw === "true";
  } catch {
    return null;
  }
}

function saveOpen(storageKey: string | undefined, open: boolean): void {
  if (storageKey === undefined) return;
  try {
    localStorage.setItem(PREFIX + storageKey, String(open));
  } catch {
    // Not persisted; the section still opens and closes for this page.
  }
}

export type AccordionProps = {
  title: string;
  /** Right-aligned in the header — a count or a state, shown open or closed. */
  summary?: ReactNode;
  defaultOpen?: boolean;
  /** Remembers open/closed across reloads; absent: the default every time. */
  storageKey?: string;
  children: ReactNode;
};

export function Accordion({ title, summary, defaultOpen = true, storageKey, children }: AccordionProps) {
  const [open, setOpen] = useState(() => loadOpen(storageKey) ?? defaultOpen);
  // The same component instance can be handed a different key (another
  // node's kind): it then shows that key's own remembered state.
  useEffect(() => setOpen(loadOpen(storageKey) ?? defaultOpen), [storageKey, defaultOpen]);
  const bodyId = useId();
  const toggle = () => {
    saveOpen(storageKey, !open);
    setOpen(!open);
  };
  return (
    <section aria-label={title} style={{ borderBottom: "1px solid var(--border)" }}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={toggle}
        className="bb-canvas-accordion"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          height: 32,
          padding: "0 12px",
          border: "none",
          background: "transparent",
          color: "var(--muted-foreground)",
          font: "inherit",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <svg
          aria-hidden
          width={10}
          height={10}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          style={{ flexShrink: 0, transform: open ? undefined : "rotate(-90deg)", transition: "transform 120ms ease-out" }}
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{title}</span>
        {summary !== undefined && summary !== null ? (
          <span style={{ marginLeft: "auto", fontSize: 11, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary}</span>
        ) : null}
      </button>
      {/* Kept in the DOM while closed, as <details> did: `aria-controls`
          always has a target, and a section's state survives a fold. */}
      <div id={bodyId} hidden={!open} style={{ padding: "2px 12px 12px", display: open ? "flex" : "none", flexDirection: "column", gap: 8 }}>
        {children}
      </div>
    </section>
  );
}

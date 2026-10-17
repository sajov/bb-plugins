// The `/`-search bar: filters by label, jumps to the first match on submit.
// Staying open with no match is the point — it says "no match" instead of
// closing on a query that found nothing, which would read as a jump that
// silently failed.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export type SearchBoxProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => boolean;
  onClose: () => void;
};

export function SearchBox({ value, onChange, onSubmit, onClose }: SearchBoxProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [noMatch, setNoMatch] = useState(false);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      onClose();
      return;
    }
    if (event.key === "Enter") {
      setNoMatch(!onSubmit());
    }
  };

  return (
    <div
      role="search"
      // Keeps a wheel gesture over the search bar from panning the canvas
      // underneath it (BBP-199).
      className="nowheel"
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px" }}
    >
      <input
        ref={ref}
        type="text"
        aria-label="Search nodes"
        placeholder="Search…"
        value={value}
        onChange={(event) => {
          setNoMatch(false);
          onChange(event.target.value);
        }}
        onKeyDown={handleKeyDown}
        style={{
          flex: 1,
          font: "inherit",
          fontSize: 12,
          padding: "2px 6px",
          border: "1px solid var(--border)",
          borderRadius: 6,
          background: "var(--background)",
          color: "var(--foreground)",
        }}
      />
      {noMatch && value ? (
        <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>no match</span>
      ) : null}
    </div>
  );
}

// The path from the tree's root to the selected node. Nothing selected shows
// nothing — a breadcrumb with no destination is noise, not orientation.
import type { CanvasNode } from "../lib/types";

export type BreadcrumbProps = {
  nodes: readonly CanvasNode[];
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
};

/** The chain from the root down to `nodeId`, root first. A parent id missing
 *  from the set stops the chain there instead of throwing — the same rule
 *  `layoutTree` applies when it roots an orphaned node. */
export function pathTo(nodes: readonly CanvasNode[], nodeId: string): CanvasNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path: CanvasNode[] = [];
  let current = byId.get(nodeId) ?? null;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    path.unshift(current);
    seen.add(current.id);
    current = current.parentId !== null ? (byId.get(current.parentId) ?? null) : null;
  }
  return path;
}

export function Breadcrumb({ nodes, selectedId, onSelect }: BreadcrumbProps) {
  if (selectedId === null) return null;
  const path = pathTo(nodes, selectedId);
  if (path.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", fontSize: 12 }}>
      {path.map((node, index) => (
        <span key={node.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {index > 0 ? <span aria-hidden>/</span> : null}
          <button
            type="button"
            onClick={() => onSelect(node.id)}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              font: "inherit",
              color: index === path.length - 1 ? "var(--foreground)" : "var(--muted-foreground)",
              fontWeight: index === path.length - 1 ? 600 : 400,
              cursor: "pointer",
            }}
          >
            {node.label}
          </button>
        </span>
      ))}
    </nav>
  );
}

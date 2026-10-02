// Topology tab (§4.6): how links are drawn and what a member is doing, in
// words and colour. The layout itself lives in lib/canvas-layout.ts.
/** How each link kind is drawn on the canvas and named in the legend. */
export const LINK_STYLE: Record<string, { stroke: string; dash?: string; arrow: boolean; label: string }> = {
  assigns_to: { stroke: "var(--muted-foreground)", arrow: true, label: "assigns" },
  works_with: { stroke: "var(--muted-foreground)", dash: "5 4", arrow: false, label: "works with" },
  escalates_to: { stroke: "var(--destructive)", dash: "3 3", arrow: true, label: "escalates" },
  can_read: { stroke: "var(--muted-foreground)", dash: "1 4", arrow: true, label: "can read" },
};

/**
 * What a member is doing, in one word. Activity is only known for a live
 * thread, so for an archived or missing one the thread axis says more than
 * "unknown" does.
 */
export function activityLabel(view: { activity: string; thread: string; needsYou: readonly string[] } | null, fallback: string): string {
  if (!view) return fallback;
  if (view.needsYou.length > 0) return "needs you";
  if (view.thread === "archived") return "archived";
  if (view.thread === "missing") return "no thread";
  return view.activity;
}

/** Node colour by activity; Needs you wins over everything else. */
export function activityTone(activity: string, needsYou: boolean): string {
  if (needsYou) return "#ef6b6b";
  switch (activity) {
    case "working":
      return "#d9a441";
    case "idle":
      return "#8b8b90";
    case "error":
      return "#ef6b6b";
    default:
      return "#3a3a3e";
  }
}

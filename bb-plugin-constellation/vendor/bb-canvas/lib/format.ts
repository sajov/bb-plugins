// Display formatting shared by the plugins that fill node `meta`, so a
// thread's and a run's times read the same in the sidebar.

/** Epoch milliseconds as "2026-10-12 08:53 UTC". UTC rather than local time
 *  so the value is the same in every test run and every viewer. A missing,
 *  zero, or invalid time is `undefined`, which `curateMeta` drops. */
export function formatTimestamp(ms: number | null | undefined): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return undefined;
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A step's start and end, readable at a glance: the start with seconds
 *  ("2026-10-06 17:15:02 UTC"), the end as a bare clock time when it falls on
 *  the same day ("17:15:03 UTC") — a tool call rarely crosses midnight, and
 *  repeating the date twice reads as noise (BBP-206 design). */
export function formatTimeRange(
  startedAt: number | null | undefined,
  completedAt: number | null | undefined,
): { startedAt?: string; completedAt?: string } {
  const iso = (ms: number | null | undefined) =>
    typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
  const start = iso(startedAt);
  const end = iso(completedAt);
  const full = (value: string) => `${value.slice(0, 19).replace("T", " ")} UTC`;
  return {
    ...(start ? { startedAt: full(start) } : {}),
    ...(end ? { completedAt: start && start.slice(0, 10) === end.slice(0, 10) ? `${end.slice(11, 19)} UTC` : full(end) } : {}),
  };
}

// BBP-200: a canvas page refreshes itself, but only for someone looking at it —
// a background tab makes no calls at all.
export const POLL_MS = 5000;

export function startVisiblePoll(
  tick: () => void,
  doc: { readonly visibilityState: DocumentVisibilityState } = document,
  intervalMs = POLL_MS,
): () => void {
  const timer = setInterval(() => {
    if (doc.visibilityState === "visible") tick();
  }, intervalMs);
  return () => clearInterval(timer);
}

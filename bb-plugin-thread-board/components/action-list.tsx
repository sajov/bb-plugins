import type { NextAction } from "@/lib/purpose";

/** Next actions sit on the number keys, in the model's order. */
export const ACTION_KEYS = ["1", "2", "3", "4"] as const;

/** The action index a key press picks, or -1. Typing into a field never picks one. */
export function actionIndexFor(event: KeyboardEvent, count: number): number {
  if (event.metaKey || event.ctrlKey || event.altKey) return -1;
  const target = event.target;
  if (target instanceof Element && target.closest("input, textarea, [contenteditable='true']")) return -1;
  const index = (ACTION_KEYS as readonly string[]).indexOf(event.key);
  return index < count ? index : -1;
}

export function ActionList({ actions, title, onPick }: { actions: readonly NextAction[]; title: string; onPick: (index: number) => void }) {
  if (actions.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">{title}</div>
      <ul className="flex flex-col gap-1">
        {actions.map((action, index) => (
          <li key={index}>
            <button
              type="button"
              onClick={() => onPick(index)}
              title={action.reply}
              className="flex w-full items-start gap-2.5 rounded-md border border-border px-3 py-2 text-left text-sm hover:border-ring hover:bg-accent"
            >
              <kbd className="mt-px rounded border border-border px-1.5 font-mono text-[11px] text-muted-foreground">
                {ACTION_KEYS[index]}
              </kbd>
              <span className="min-w-0">
                <span className="block font-medium">{action.label}</span>
                <span className="block truncate text-xs text-muted-foreground">{action.reply}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The config panel ("inspector") vocabulary shared by Graph Studio and Crew.
 *
 * Both plugins come from one product family, so a node card in Graph Studio
 * and a member card in Crew should read as the same kind of surface: an
 * icon-tile head, folded sections with a one-line summary, label/value rows
 * and form controls of one height. The plugins share no dependency, so this
 * file exists twice — bb-plugin-graph-studio/components/inspector.tsx and
 * bb-plugin-crew/components/inspector.tsx — and a test in each plugin keeps
 * the two copies byte-identical.
 */
import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** Field caption above a control. */
export const FIELD_LABEL = "block text-[11px] font-medium text-muted-foreground";
/** Explanation under a control: lighter than the caption, never a caption itself. */
export const FIELD_HINT = "text-[11px] leading-snug text-muted-foreground/80";
/** Native <select> and compact <Input>: one height so a row of mixed controls lines up. */
export const FIELD_CONTROL =
  "h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Head of a config panel: what is being configured, in one glance. */
export function InspectorHeader({
  icon,
  title,
  subtitle,
  actions,
}: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned, e.g. a close button. */
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5 pb-3">
      {icon ? (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50 text-muted-foreground">
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <h3 className="m-0 truncate text-sm font-semibold leading-5">{title}</h3>
        {subtitle ? <p className="m-0 truncate text-[11px] text-muted-foreground">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}

/**
 * One folded section. The summary is the overview while folded, so it gets
 * the foreground colour; the title is a quiet sentence-case label rather
 * than tracked capitals, which shouted louder than the values they named.
 */
export function InspectorSection({
  title,
  summary,
  open = false,
  children,
}: {
  title: string;
  summary?: ReactNode;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={open || undefined} className="group border-t border-border/60">
      <summary className="-mx-1.5 flex cursor-pointer list-none items-center gap-1.5 rounded-md px-1.5 py-2 text-xs hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
        <Icon
          name="ChevronRight"
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
        />
        <span className="shrink-0 font-medium">{title}</span>
        {summary !== undefined ? (
          <span className="ml-auto min-w-0 truncate pl-3 text-right text-muted-foreground">{summary}</span>
        ) : null}
      </summary>
      <div className="space-y-3 pb-3 pl-5 pt-1">{children}</div>
    </details>
  );
}

/** Read-only label/value rows. */
export function InspectorRows({ rows }: { rows: ReadonlyArray<{ label: string; value: ReactNode; className?: string } | null | false> }) {
  return (
    <dl className="m-0 grid grid-cols-[minmax(80px,auto)_1fr] gap-x-3 gap-y-1.5 text-xs">
      {rows.map((row) =>
        row ? (
          <div key={row.label} className="contents">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className={cn("m-0 min-w-0 [overflow-wrap:anywhere]", row.className)}>{row.value}</dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}

/** Foot of a config panel: actions on the left, a quiet note below. */
export function InspectorFooter({ children, note }: { children?: ReactNode; note?: ReactNode }) {
  return (
    <div className="space-y-2 border-t border-border/60 pt-3">
      {children ? <div className="flex flex-wrap items-center gap-1.5">{children}</div> : null}
      {note ? <p className="m-0 text-[11px] leading-snug text-muted-foreground">{note}</p> : null}
    </div>
  );
}

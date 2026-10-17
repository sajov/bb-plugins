// A project's view as a dashboard: key figures, a week of activity, its
// branches and providers, the newest threads and the repository — all from
// the thread list BB already gave the canvas, so it costs no extra request.
import type { ReactNode } from "react";
import { Accordion } from "../vendor/bb-canvas/components/Accordion";
import { STATUS_COLORS } from "../vendor/bb-canvas/lib/kind-colors";
import type { ThreadListItem } from "../vendor/bb-canvas/lib/thread-tree";

const DAY = 86_400_000;
const RUNNING = new Set(["active", "pending", "starting"]);
/** The dashboard lists this many of the project's newest threads. */
export const RECENT_THREADS = 5;

export type ProjectStats = {
  threads: number;
  running: number;
  failed: number;
  active24h: number;
  lastActive: number | null;
  /** Threads last active per day, oldest first, today last. */
  week: number[];
  branches: [string, number][];
  providers: [string, number][];
  recent: ThreadListItem[];
};

const byCount = (counts: Map<string, number>): [string, number][] => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

/** Figures for one project's live (not archived) threads. */
export function projectStats(threads: readonly ThreadListItem[], projectId: string, now: number): ProjectStats {
  const own = threads.filter((thread) => thread.projectId === projectId && thread.archivedAt === null);
  const branches = new Map<string, number>();
  const providers = new Map<string, number>();
  const week = Array.from({ length: 7 }, () => 0);
  const today = new Date(now).setHours(0, 0, 0, 0);
  for (const thread of own) {
    if (thread.environmentBranchName) branches.set(thread.environmentBranchName, (branches.get(thread.environmentBranchName) ?? 0) + 1);
    providers.set(thread.providerId, (providers.get(thread.providerId) ?? 0) + 1);
    const daysAgo = Math.floor((today - new Date(thread.updatedAt).setHours(0, 0, 0, 0)) / DAY);
    if (daysAgo >= 0 && daysAgo < 7) week[6 - daysAgo]! += 1;
  }
  return {
    threads: own.length,
    running: own.filter((thread) => RUNNING.has(thread.status)).length,
    failed: own.filter((thread) => thread.status === "error").length,
    active24h: own.filter((thread) => now - thread.updatedAt < DAY).length,
    lastActive: own.length === 0 ? null : Math.max(...own.map((thread) => thread.updatedAt)),
    week,
    branches: byCount(branches),
    providers: byCount(providers),
    recent: [...own].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT_THREADS),
  };
}

export function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** `git@github.com:org/repo.git` and `https://…/org/repo(.git)` as a web link. */
export function repoLink(remote: string | null | undefined): { href: string; label: string } | null {
  if (!remote) return null;
  const ssh = /^git@([^:]+):(.+?)(\.git)?$/.exec(remote);
  const url = ssh ? `https://${ssh[1]}/${ssh[2]}` : /^https?:\/\//.test(remote) ? remote.replace(/\.git$/, "") : null;
  if (!url) return null;
  return { href: url, label: url.replace(/^https?:\/\//, "") };
}

function Tile({ value, label, color }: { value: ReactNode; label: string; color?: string }) {
  return (
    <div className="flex flex-col rounded-md border border-border px-2 py-1.5">
      <span className="text-base font-semibold tabular-nums" style={color ? { color } : undefined}>
        {value}
      </span>
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </div>
  );
}

function Bars({ rows }: { rows: [string, number][] }) {
  const max = Math.max(1, ...rows.map(([, count]) => count));
  return (
    <ul className="flex flex-col gap-1">
      {rows.map(([name, count]) => (
        <li key={name} className="grid items-center gap-2 text-xs" style={{ gridTemplateColumns: "minmax(0,1fr) 64px 24px" }}>
          <span className="truncate font-mono text-[11px]" title={name}>
            {name}
          </span>
          <span className="h-1.5 rounded bg-muted">
            <span className="block h-full rounded bg-primary/60" style={{ width: `${(count / max) * 100}%` }} />
          </span>
          <span className="text-right tabular-nums text-muted-foreground">{count}</span>
        </li>
      ))}
    </ul>
  );
}

const WEEKDAY = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export type ProjectDashboardProps = {
  projectId: string;
  threads: readonly ThreadListItem[];
  remote?: string | null;
  now: number;
  onSelectThread: (threadId: string) => void;
};

export function ProjectDashboard({ projectId, threads, remote, now, onSelectThread }: ProjectDashboardProps) {
  const stats = projectStats(threads, projectId, now);
  const link = repoLink(remote);
  const peak = Math.max(1, ...stats.week);
  return (
    <>
      <Accordion title="At a glance" summary={stats.lastActive === null ? undefined : `active ${ago(stats.lastActive, now)}`} storageKey="node:project:glance">
        <div className="grid grid-cols-4 gap-1.5">
          <Tile value={stats.threads} label="Threads" />
          <Tile value={stats.running} label="Running" color={stats.running > 0 ? STATUS_COLORS.running : undefined} />
          <Tile value={stats.active24h} label="Last 24 h" />
          <Tile value={stats.failed} label="Failed" color={stats.failed > 0 ? STATUS_COLORS.failed : undefined} />
        </div>
        <div aria-label="Threads active per day, last 7 days" role="img" className="flex h-12 items-end gap-1">
          {stats.week.map((count, index) => {
            const day = new Date(now - (6 - index) * DAY).getDay();
            return (
              <div key={index} className="flex flex-1 flex-col items-center gap-0.5" title={`${count} threads`}>
                <div className={`w-full rounded-sm ${index === 6 ? "bg-primary" : "bg-primary/40"}`} style={{ height: `${Math.max(2, (count / peak) * 32)}px` }} />
                <span className="text-[9px] text-muted-foreground">{WEEKDAY[day]}</span>
              </div>
            );
          })}
        </div>
      </Accordion>

      {stats.recent.length > 0 ? (
        <Accordion title="Recent threads" summary={stats.threads} storageKey="node:project:recent">
          <ul className="flex flex-col">
            {stats.recent.map((thread) => (
              <li key={thread.id}>
                <button
                  type="button"
                  onClick={() => onSelectThread(thread.id)}
                  className="flex h-8 w-full items-center gap-2 rounded px-1 text-left text-xs hover:bg-muted focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary"
                >
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: RUNNING.has(thread.status) ? STATUS_COLORS.running : thread.status === "error" ? STATUS_COLORS.failed : "var(--border)" }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{thread.title ?? thread.titleFallback ?? "Untitled"}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {thread.providerId}
                      {thread.environmentBranchName ? ` · ${thread.environmentBranchName}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{ago(thread.updatedAt, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Accordion>
      ) : null}

      {stats.branches.length > 0 ? (
        <Accordion title="Branches" summary={stats.branches.length} storageKey="node:project:branches">
          <Bars rows={stats.branches} />
        </Accordion>
      ) : null}

      {stats.providers.length > 0 ? (
        <Accordion title="Providers" summary={stats.providers.length} defaultOpen={false} storageKey="node:project:providers">
          <Bars rows={stats.providers} />
        </Accordion>
      ) : null}

      {link ? (
        <Accordion title="Repository" storageKey="node:project:repo">
          <a href={link.href} target="_blank" rel="noreferrer" className="truncate font-mono text-[11px] text-primary underline-offset-2 hover:underline">
            {link.label}
          </a>
        </Accordion>
      ) : null}
    </>
  );
}

// @vitest-environment jsdom
//
// A project's view as a dashboard: figures, a week of activity, branches,
// providers, the newest threads and the repository link.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ago, projectStats, ProjectDashboard, repoLink } from "../components/project-dashboard";
import type { ThreadListItem } from "../vendor/bb-canvas/lib/thread-tree";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const now = new Date(2026, 9, 16, 12).getTime();
const HOUR = 3_600_000;
const thread = (id: string, extra: Partial<ThreadListItem> = {}): ThreadListItem => ({
  id,
  projectId: "p1",
  title: id,
  titleFallback: null,
  status: "idle",
  providerId: "claude-code",
  archivedAt: null,
  updatedAt: now - HOUR,
  environmentBranchName: "main",
  ...extra,
});

const threads = [
  thread("a", { status: "active" }),
  thread("b", { status: "error", providerId: "pi", environmentBranchName: "feature/x" }),
  thread("c", { updatedAt: now - 3 * 24 * HOUR }),
  thread("old", { archivedAt: 1 }),
  thread("other", { projectId: "p2" }),
];

describe("projectStats", () => {
  it("counts the project's live threads: running, failed, active in 24 h", () => {
    const stats = projectStats(threads, "p1", now);
    expect(stats).toMatchObject({ threads: 3, running: 1, failed: 1, active24h: 2 });
  });

  it("puts each thread on its day, today last", () => {
    const { week } = projectStats(threads, "p1", now);
    expect(week[6]).toBe(2);
    expect(week[3]).toBe(1);
  });

  it("ranks branches and providers by count", () => {
    const stats = projectStats(threads, "p1", now);
    expect(stats.branches).toEqual([["main", 2], ["feature/x", 1]]);
    expect(stats.providers[0]).toEqual(["claude-code", 2]);
  });

  it("negative: archived threads and other projects count nowhere", () => {
    const stats = projectStats(threads, "p1", now);
    expect(stats.recent.map((item) => item.id)).not.toContain("old");
    expect(stats.recent.map((item) => item.id)).not.toContain("other");
  });

  it("negative: a thread without a branch adds no branch row", () => {
    expect(projectStats([thread("x", { environmentBranchName: null })], "p1", now).branches).toEqual([]);
  });
});

describe("repoLink and ago", () => {
  it("turns ssh and https remotes into a web link", () => {
    expect(repoLink("git@github.com:org/repo.git")).toEqual({ href: "https://github.com/org/repo", label: "github.com/org/repo" });
    expect(repoLink("https://gitlab.com/a/b.git")?.href).toBe("https://gitlab.com/a/b");
  });

  it("negative: no remote or an unknown form gives no link", () => {
    expect(repoLink(null)).toBeNull();
    expect(repoLink("/local/path")).toBeNull();
  });

  it("says how long ago", () => {
    expect(ago(now - 30_000, now)).toBe("just now");
    expect(ago(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(ago(now - 3 * HOUR, now)).toBe("3 h ago");
    expect(ago(now - 48 * HOUR, now)).toBe("2 d ago");
  });
});

describe("ProjectDashboard", () => {
  it("shows the figures, recent threads and branches; a thread selects its card", () => {
    const onSelect = vi.fn();
    render(<ProjectDashboard projectId="p1" threads={threads} remote="git@github.com:org/repo.git" now={now} onSelectThread={onSelect} />);
    const glance = screen.getByRole("region", { name: "At a glance" });
    expect(within(glance).getByText("Threads").previousSibling?.textContent).toBe("3");
    expect(screen.getByRole("region", { name: "Branches" }).textContent).toContain("feature/x");
    fireEvent.click(within(screen.getByRole("region", { name: "Recent threads" })).getByRole("button", { name: /^b/ }));
    expect(onSelect).toHaveBeenCalledWith("b");
    expect(screen.getByRole("link", { name: "github.com/org/repo" })).toBeTruthy();
  });

  it("negative: an empty project shows no recent, branch or repository section", () => {
    render(<ProjectDashboard projectId="empty" threads={threads} now={now} onSelectThread={vi.fn()} />);
    expect(screen.queryByRole("region", { name: "Recent threads" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Branches" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Repository" })).toBeNull();
  });
});

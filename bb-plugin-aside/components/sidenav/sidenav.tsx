// The sidenav — the replacement for bb's thread list.
//
// The host stays the truth: threads, projects and their order come live from
// `experimental_useSidebarThreads`. We own exactly three pieces of state: the
// view (sort, collapse, condense, tag filter), the project colours and the
// project tags. All three live on the server so they are the same on every
// device.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_useProviders as useProviders,
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
  useRealtime,
  useRpc,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import type { rpcContract } from "@/server";
import {
  countFamilies,
  displayOrder,
  familyState,
  latestActivity,
  placePersonal,
  familyWaits,
  groupThreads,
  needsUser,
  nextAttention,
  pinnedFamilies,
  projectState,
  sectionReach,
  sortProjects,
  moveInOrder,
  splitQuiet,
  threadTitle,
  withoutEmptyProjects,
  waitingThreads,
  type Family,
} from "@/lib/tree";
import {
  accordionCollapse,
  allCollapsed,
  allSectionsFolded,
  DEFAULT_VIEW,
  isDefaultView,
  parseViewState,
  resetViewSettings,
  sectionKey,
  toggleAllSections,
  MAX_IDS,
  toggleId,
  type ViewState,
} from "@/lib/view";
import { buildProviderMap } from "@/components/sidenav/provider-glyph";
import { ProjectRow } from "@/components/sidenav/project-row";
import { SectionRow } from "@/components/sidenav/section-row";
import { StateMark } from "@/components/sidenav/marks";
import { Icon } from "@/components/ui/icon";
import { RowCount } from "@/components/sidenav/row-slots";
import {
  ThreadCard,
  type CardCallbacks,
  type SelectionProps,
} from "@/components/sidenav/thread-card";
import { SelectionBar } from "@/components/sidenav/selection-bar";
import { DisplayMenu, MoreMenu, SortMenu } from "@/components/sidenav/header-menus";
import { ScopeBar } from "@/components/sidenav/scope-bar";
import { SearchSlot } from "@/components/sidenav/search-slot";
import { PinGlyph } from "@/components/sidenav/marks";
import { matchesQuery, normalizeQuery, tagPrefix } from "@/lib/search";
import { activeScopes, type ScopeKind } from "@/lib/scope";
import { badgeColor } from "@/lib/colors";
import {
  matchesTagFilter,
  pruneTagFilter,
  sortedTags,
  tagCounts,
  type TagMap,
} from "@/lib/tags";
import { planDeletion } from "@/lib/deletion";

interface Section {
  id: string;
  name: string;
}

/**
 * The magnifier. Pressed while the slot is open, because the slot narrows the
 * list: a control that hides rows says so in the bar, not only by the row it
 * adds — the slot scrolls out of reach of nothing, but the bar never moves.
 */
function SearchToggle({
  open,
  active,
  onToggle,
}: {
  open: boolean;
  /** Something is typed — the search is not just open, it is narrowing. */
  active: boolean;
  onToggle: () => void;
}) {
  const label = open ? "Close search" : "Search projects";
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={open}
      title={`${label} · ⌥F`}
      onClick={onToggle}
      className={cn(
        "grid size-6 place-items-center rounded-md hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        open || active ? "bg-sidebar-accent text-foreground" : "text-muted-foreground",
      )}
    >
      <Icon name="Search" className="size-3.5" aria-hidden />
    </button>
  );
}

/** A `now` that keeps ticking so relative times age. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function Sidenav({
  activeThreadId,
  activeProjectId,
  onNavigate,
}: PluginThreadListProps) {
  const rpc = useRpc<typeof rpcContract>();
  const { threads, projects, status } = useSidebarThreads();
  const actions = useSidebarThreadActions();
  const { providers } = useProviders();
  const now = useNow();

  const [view, setView] = useState<ViewState>(DEFAULT_VIEW);
  const [sections, setSections] = useState<Section[]>([]);
  const [colors, setColors] = useState<Record<string, string>>({});
  const [tags, setTags] = useState<TagMap>({});
  const [renaming, setRenaming] = useState<
    { kind: "project" | "thread" | "section"; id: string } | null
  >(null);
  const [openChildren, setOpenChildren] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);
  // Deliberately not in `view`: a search is a question you are asking now, not
  // a setting. See lib/search.ts.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchFocus, setSearchFocus] = useState(0);
  const viewLoaded = useRef(false);

  const refetch = useCallback(() => {
    void rpc.call("view_get", null).then((result) => {
      setView(parseViewState(result.view));
      viewLoaded.current = true;
    });
    void rpc.call("sections_list", null).then((result) => setSections([...result.sections]));
    void rpc.call("projects_state", null).then((result) => {
      setColors(Object.fromEntries(result.colors.map((entry) => [entry.projectId, entry.color])));
      setTags(Object.fromEntries(result.tags.map((entry) => [entry.projectId, entry.tags])));
    });
  }, [rpc]);

  useEffect(refetch, [refetch]);
  useRealtime("aside-changed", refetch);

  /** Set optimistically, then write — the list must not wait on the network. */
  const patchView = useCallback(
    (patch: Partial<ViewState>) => {
      setView((current) => {
        const next = { ...current, ...patch };
        if (viewLoaded.current) void rpc.call("view_set", { view: next });
        return next;
      });
    },
    [rpc],
  );

  const report = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 4000);
  }, []);

  const grouped = useMemo(
    () =>
      sortProjects(
        groupThreads(threads, projects, {
          archived: view.archived,
          sections,
          threadSort: view.threadSort,
          threadOrder: view.threadOrder,
          sectionOrder: view.sectionOrder,
        }),
        view.projectSort,
      ),
    [
      threads,
      projects,
      sections,
      view.archived,
      view.threadSort,
      view.threadOrder,
      view.sectionOrder,
      view.projectSort,
    ],
  );

  const activeProject = useMemo(() => {
    const active = threads.find((thread) => thread.id === activeThreadId);
    return active?.projectId ?? activeProjectId;
  }, [threads, activeThreadId, activeProjectId]);

  const personalProjectId = useMemo(
    () => projects.find((project) => project.isPersonal)?.id ?? null,
    [projects],
  );

  // Counted against the live project list, so the filter never offers a tag
  // whose last project is gone.
  const counts = useMemo(
    () => tagCounts(tags, projects.map((project) => project.id)),
    [tags, projects],
  );
  const knownTags = useMemo(() => sortedTags(counts), [counts]);

  // A tag that lost its last project stops filtering. Otherwise the list would
  // stay narrowed by something the filter menu no longer even offers.
  const tagFilter = useMemo(
    () => pruneTagFilter(view.tagFilter, knownTags),
    [view.tagFilter, knownTags],
  );

  // Projects as their own filter entries, offered under the tags.
  const knownProjects = useMemo(
    () => projects.map((project) => ({ id: project.id, name: project.name })),
    [projects],
  );
  const projectIds = useMemo(() => projects.map((project) => project.id), [projects]);
  // A renamed project keeps its pick (ids, not names); a deleted one is
  // pruned the same way a tag is when its last project disappears.
  const projectFilter = useMemo(
    () => pruneTagFilter(view.projectFilter, projectIds),
    [view.projectFilter, projectIds],
  );

  // A `#` query picks tags; it is not a name search and narrows nothing itself.
  const searching = normalizeQuery(query).length > 0 && tagPrefix(query) === null;

  const { blocks, total } = useMemo(() => {
    const placed =
      personalProjectId === null || view.projectSort !== "manual"
        ? grouped
        : placePersonal(grouped, personalProjectId, view.personalAfter);
    // While a name is being searched, a project without threads stays: you are
    // looking for the project, and a search that cannot find an empty one is a
    // search you have to second-guess.
    const shown =
      view.emptyProjects || searching
        ? placed
        : withoutEmptyProjects(placed, activeProject);
    // The project you are working in survives the tag filter, the way it
    // survives `withoutEmptyProjects`: the thread on screen must have a row in
    // the list it belongs to, or the sidenav contradicts the pane next to it.
    const tagged =
      tagFilter.length === 0 && projectFilter.length === 0
        ? shown
        : shown.filter(
            (block) =>
              block.project.id === activeProject ||
              matchesTagFilter(
                tags[block.project.id] ?? [],
                tagFilter,
                block.project.id,
                projectFilter,
              ),
          );
    // The search does not spare the active project. A tag filter is a standing
    // setting you may have forgotten; a query is a question you are typing this
    // second, and a row that ignores it would read as a bad match.
    return {
      blocks: searching
        ? tagged.filter((block) => matchesQuery(block.project.name, query))
        : tagged,
      // What the list would hold without search and tags — the "of" in the
      // scope bar's "12 / 58".
      total: shown.length,
    };
  }, [
    grouped,
    personalProjectId,
    view.personalAfter,
    view.projectSort,
    view.emptyProjects,
    activeProject,
    tagFilter,
    projectFilter,
    tags,
    searching,
    query,
  ]);

  const providerMap = useMemo(() => buildProviderMap(providers), [providers]);
  const waiting = useMemo(() => waitingThreads(threads), [threads]);
  const threadCount = useMemo(() => countFamilies(blocks), [blocks]);
  const pinned = useMemo(
    () => (view.pinnedGroup ? pinnedFamilies(blocks) : []),
    [blocks, view.pinnedGroup],
  );
  const projectFilterNames = useMemo(
    () =>
      projectFilter
        .map((id) => knownProjects.find((project) => project.id === id)?.name)
        .filter((name): name is string => name !== undefined),
    [projectFilter, knownProjects],
  );
  const scopes = useMemo(
    () =>
      activeScopes({
        query,
        tagFilter,
        projectNames: projectFilterNames,
        archived: view.archived,
      }),
    [query, tagFilter, projectFilterNames, view.archived],
  );
  const clearScope = useCallback(
    (kind: ScopeKind) => {
      if (kind === "search") setQuery("");
      if (kind === "tags") patchView({ tagFilter: [] });
      if (kind === "projects") patchView({ projectFilter: [] });
      if (kind === "archived") patchView({ archived: false });
    },
    [patchView],
  );
  const clearAllScopes = useCallback(() => {
    setQuery("");
    patchView({ tagFilter: [], projectFilter: [], archived: false });
  }, [patchView]);

  const openThread = useCallback(
    (threadId: string, split: boolean) => {
      actions.open(threadId, { split });
      onNavigate();
    },
    [actions, onNavigate],
  );

  const callbacks: CardCallbacks = useMemo(
    () => ({
      onOpen: openThread,
      onToggleChildren: (threadId) =>
        setOpenChildren((current) => ({
          ...current,
          [threadId]: current[threadId] === undefined ? false : !current[threadId],
        })),
      onRename: (threadId, title) => {
        setRenaming(null);
        void actions.rename(threadId, title);
      },
      onSetSection: (threadId, sectionId) => {
        void rpc.call("thread_set_section", { threadId, sectionId });
      },
      onCreateSection: (threadId) => {
        void rpc.call("section_create", { name: "New section", threadId }).then((section) => {
          setSections((current) => [...current, section]);
          setRenaming({ kind: "section", id: section.id });
        });
      },
      onReorder: (threadId, targetThreadId, where) => {
        const dragged = threads.find((thread) => thread.id === threadId);
        const target = threads.find((thread) => thread.id === targetThreadId);
        if (dragged === undefined || target === undefined) return;
        if (dragged.projectId !== target.projectId) {
          report("A thread does not change projects.");
          return;
        }
        // "State" is a computed order; a drag inside it would write something
        // the list then ignores.
        if (view.threadSort !== "newest") {
          report("To reorder by dragging: Sort → Threads → Newest first.");
          return;
        }
        const shown =
          grouped
            .find((block) => block.project.id === dragged.projectId)
            ?.families.map((family) => family.root.id) ?? [];
        const threadOrder = moveInOrder(
          view.threadOrder,
          shown,
          threadId,
          targetThreadId,
          where,
        ).slice(-MAX_IDS);
        patchView({ threadOrder });
        // Pins also keep their order in the host, so bb's own sidebar agrees.
        if (dragged.isPinned && target.isPinned) {
          const pinned = new Set(
            threads.filter((thread) => thread.isPinned).map((thread) => thread.id),
          );
          const ownOrder = threadOrder.filter((id) => shown.includes(id) && pinned.has(id));
          const at = ownOrder.indexOf(threadId);
          void rpc
            .call("thread_reorder", {
              threadId,
              previousThreadId: ownOrder[at - 1] ?? null,
              nextThreadId: ownOrder[at + 1] ?? null,
            })
            .catch((cause: unknown) =>
              report(cause instanceof Error ? cause.message : String(cause)),
            );
        }
      },
      onNewSubThread: (threadId) => {
        const parent = threads.find((thread) => thread.id === threadId);
        if (parent === undefined) return;
        void rpc
          .call("thread_create_child", { projectId: parent.projectId, parentThreadId: threadId })
          .then((result) => {
            setOpenChildren((current) => ({ ...current, [threadId]: true }));
            openThread(result.threadId, false);
          })
          .catch((cause: unknown) =>
            report(cause instanceof Error ? cause.message : String(cause)),
          );
      },
      onNest: (threadId, parentThreadId) => {
        const dragged = threads.find((thread) => thread.id === threadId);
        const target = threads.find((thread) => thread.id === parentThreadId);
        if (dragged === undefined || target === undefined) return;
        // A thread does not change projects: `updateThread` has no projectId.
        // We say so instead of swallowing it silently.
        if (dragged.projectId !== target.projectId) {
          report("A thread does not change projects.");
          return;
        }
        void rpc
          .call("thread_set_parent", { threadId, parentThreadId })
          .then(() => setOpenChildren((current) => ({ ...current, [parentThreadId]: true })))
          .catch((cause: unknown) =>
            report(cause instanceof Error ? cause.message : String(cause)),
          );
      },
      onDropRejected: report,
    }),
    [actions, grouped, openThread, patchView, report, rpc, threads, view.threadOrder, view.threadSort],
  );

  const selection: SelectionProps | null = useMemo(
    () =>
      selecting
        ? {
            selected,
            onToggle: (threadId, on) =>
              setSelected((current) => {
                const next = new Set(current);
                if (on) next.add(threadId);
                else next.delete(threadId);
                return next;
              }),
          }
        : null,
    [selecting, selected],
  );

  // What the confirmation is allowed to claim. Recomputed from the live thread
  // list, so a family that grows an agent while you are deciding is counted.
  const plan = useMemo(() => planDeletion(threads, selected), [threads, selected]);

  const leaveSelection = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
  }, []);

  const deleteSelected = useCallback(() => {
    if (plan.chosen.length === 0) return;
    setDeleting(true);
    void rpc
      .call("threads_delete", { threadIds: plan.chosen })
      .then((result) => {
        leaveSelection();
        report(
          result.failed.length === 0
            ? `${result.deletedCount} deleted.`
            : `${result.deletedCount} deleted, ${result.failed.length} refused: ${result.failed[0].reason}`,
        );
      })
      .catch((cause: unknown) =>
        report(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setDeleting(false));
  }, [leaveSelection, plan.chosen, report, rpc]);

  // Closing clears: a query left behind in a closed field would keep narrowing
  // the list with no field on screen to explain it.
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
  }, []);

  // ⌥F opens the slot and puts the caret in it. Same ⌥ family as the fold
  // shortcuts, and matched on `event.code` for the same reason: with Alt held,
  // macOS reports the composed character (⌥F arrives as "ƒ").
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.code !== "KeyF") return;
      event.preventDefault();
      setSearchOpen(true);
      setSearchFocus((tick) => tick + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const everythingCollapsed = useMemo(
    () => allCollapsed(projects.map((project) => project.id), view.collapsedProjects),
    [projects, view.collapsedProjects],
  );

  const setFold = useCallback(
    (collapsed: boolean) => {
      patchView({
        collapsedProjects: collapsed ? projects.map((project) => project.id) : [],
      });
    },
    [patchView, projects],
  );

  const toggleFold = useCallback(
    () => setFold(!everythingCollapsed),
    [setFold, everythingCollapsed],
  );

  // Keyboard: ⌥C collapses everything, ⌥⇧C expands it again.
  //
  // Matched on `event.code`, not `event.key`: with Alt held down macOS reports
  // the composed character — ⌥C arrives as "ç" — so a comparison against "c"
  // never fired and both shortcuts were silently dead.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.code !== "KeyC") return;
      event.preventDefault();
      setFold(!event.shiftKey);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setFold]);

  // Focus follows the active thread: when the thread on screen moves to another
  // project, every other project folds. Only on a change, so unfolding one by
  // hand afterwards sticks until you move again.
  const lastFocused = useRef<string | null>(null);
  useEffect(() => {
    if (!view.focusFollows || activeProject === null || activeProject === undefined) return;
    if (lastFocused.current === activeProject) return;
    lastFocused.current = activeProject;
    patchView({
      collapsedProjects: accordionCollapse(
        projects.map((project) => project.id),
        activeProject,
      ),
    });
  }, [view.focusFollows, activeProject, projects, patchView]);

  // ⌥↓ / ⌥↑ jump to the next thread that waits for you or failed, across
  // projects and into folded ones. `event.code` for the same reason as ⌥C.
  const order = useMemo(() => displayOrder(blocks), [blocks]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey) return;
      if (event.code !== "ArrowDown" && event.code !== "ArrowUp") return;
      const next = nextAttention(order, activeThreadId, event.code === "ArrowDown" ? 1 : -1);
      if (next === null) return;
      event.preventDefault();
      if (view.collapsedProjects.includes(next.projectId)) {
        patchView({
          collapsedProjects: view.collapsedProjects.filter((id) => id !== next.projectId),
        });
      }
      openThread(next.id, false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, activeThreadId, view.collapsedProjects, patchView, openThread]);

  if (status === "loading") return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border-hairline px-3">
        <span className="text-xs font-semibold text-muted-foreground">Workspaces</span>
        {/* The header counts like every other row does. It was the one bare
            number left in the list, which made it read as a different kind of
            thing than the identical count on a project. */}
        <RowCount count={threadCount} open />
        <span className="flex-1" />
        {/* Three zones: find · order and display · actions. */}
        <SearchToggle
          open={searchOpen}
          active={searching || tagFilter.length > 0 || projectFilter.length > 0}
          onToggle={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
        />
        <span aria-hidden className="mx-0.5 h-3.5 w-px bg-border-hairline" />
        <SortMenu view={view} onPatch={patchView} />
        <DisplayMenu view={view} onPatch={patchView} />
        <span aria-hidden className="mx-0.5 h-3.5 w-px bg-border-hairline" />
        <MoreMenu
          selecting={selecting}
          filterCount={scopes.length}
          viewIsDefault={isDefaultView(view)}
          onCollapseAll={() => setFold(true)}
          onExpandAll={() => setFold(false)}
          onToggleSelecting={() => (selecting ? leaveSelection() : setSelecting(true))}
          onClearFilters={clearAllScopes}
          onResetView={() => {
            setQuery("");
            setView((current) => {
              const next = resetViewSettings(current);
              if (viewLoaded.current) void rpc.call("view_set", { view: next });
              return next;
            });
          }}
        />
      </div>

      {searchOpen ? (
        <SearchSlot
          query={query}
          matchCount={blocks.length}
          focusTick={searchFocus}
          onQuery={setQuery}
          onClose={closeSearch}
          knownTags={knownTags}
          tagCounts={counts}
          activeTags={tagFilter}
          onToggleTag={(tag) => patchView({ tagFilter: toggleId(tagFilter, tag) })}
          knownProjects={knownProjects}
          activeProjects={projectFilter}
          onToggleProject={(projectId) =>
            patchView({ projectFilter: toggleId(projectFilter, projectId) })
          }
        />
      ) : null}

      <ScopeBar
        chips={scopes}
        shown={blocks.length}
        total={total}
        onClear={clearScope}
        onClearAll={clearAllScopes}
      />

      {waiting.length > 0 ? (
        <button
          type="button"
          onClick={() => {
            const next = waiting[0];
            patchView({
              collapsedProjects: view.collapsedProjects.filter((id) => id !== next.projectId),
            });
            openThread(next.id, false);
          }}
          className="flex shrink-0 items-center gap-2 border-b border-border-hairline px-3 py-1.5 text-left hover:bg-sidebar-accent/60"
        >
          <StateMark state="needs-you" className="size-3" />
          <span className="shrink-0 text-xs">
            {waiting.length} {waiting.length === 1 ? "waits" : "wait"}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {threadTitle(waiting[0])}
          </span>
          <span className="shrink-0 text-2xs text-muted-foreground/70">›</span>
        </button>
      ) : null}

      {notice === null ? null : (
        <div className="shrink-0 border-b border-border-hairline px-3 py-1.5 text-2xs text-muted-foreground">
          {notice}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {pinned.length > 0 ? (
          <div className="mb-2 border-b border-border-hairline pb-1.5">
            <button
              type="button"
              aria-expanded={!view.pinnedCollapsed}
              onClick={() => patchView({ pinnedCollapsed: !view.pinnedCollapsed })}
              className="flex h-6 w-full items-center gap-1.5 rounded-md px-2 text-left hover:bg-sidebar-accent/60"
            >
              <PinGlyph className="text-muted-foreground" />
              <span className="text-2xs uppercase tracking-wider text-muted-foreground/70">
                Pinned
              </span>
              <RowCount count={pinned.length} open={!view.pinnedCollapsed} />
            </button>
            {view.pinnedCollapsed
              ? null
              : pinned.map(({ family, project }) => (
                  <ThreadCard
                    key={`pinned:${family.root.id}`}
                    family={family}
                    providers={providerMap}
                    sections={sections}
                    activeThreadId={activeThreadId}
                    childrenOpen={false}
                    compact
                    now={now}
                    selection={selection}
                    renaming={false}
                    onStartRename={(threadId) => setRenaming({ kind: "thread", id: threadId })}
                    onCancelRename={() => setRenaming(null)}
                    callbacks={callbacks}
                    pinnedIn={{
                      name: project.name,
                      color: badgeColor(project.id, colors[project.id] ?? null),
                    }}
                  />
                ))}
          </div>
        ) : null}
        {blocks.map((block) => {
          const collapsed = view.collapsedProjects.includes(block.project.id);
          const waitingHere = block.families.filter(familyWaits).length;
          return (
            <div key={block.project.id} className="mt-1.5 first:mt-0">
              <ProjectRow
                project={block.project}
                color={colors[block.project.id] ?? null}
                tags={tags[block.project.id] ?? []}
                knownTags={knownTags}
                threadCount={block.families.length}
                waitingCount={waitingHere}
                state={projectState(block.families)}
                age={latestActivity(block.families)}
                now={now}
                collapsed={collapsed}
                renaming={renaming?.kind === "project" && renaming.id === block.project.id}
                onToggle={() =>
                  patchView({
                    collapsedProjects: toggleId(view.collapsedProjects, block.project.id),
                  })
                }
                onSolo={() =>
                  patchView({
                    collapsedProjects: accordionCollapse(
                      projects.map((project) => project.id),
                      block.project.id,
                    ),
                  })
                }
                sectionsCollapsed={allSectionsFolded(
                  block.blocks
                    .filter((entry) => entry.section !== null)
                    .map((entry) => sectionKey(block.project.id, entry.section!.id)),
                  view.collapsedSections,
                )}
                onToggleSections={() => {
                  const keys = block.blocks
                    .filter((entry) => entry.section !== null)
                    .map((entry) => sectionKey(block.project.id, entry.section!.id));
                  patchView({
                    collapsedSections: toggleAllSections(view.collapsedSections, keys),
                  });
                }}
                onStartRename={() => setRenaming({ kind: "project", id: block.project.id })}
                onCancelRename={() => setRenaming(null)}
                onRename={(name) => {
                  setRenaming(null);
                  void rpc
                    .call("project_rename", { projectId: block.project.id, name })
                    .catch((cause: unknown) =>
                      report(cause instanceof Error ? cause.message : String(cause)),
                    );
                }}
                onSetColor={(color) => {
                  setColors((current) => {
                    const next = { ...current };
                    if (color === null) delete next[block.project.id];
                    else next[block.project.id] = color;
                    return next;
                  });
                  void rpc.call("project_set_color", { projectId: block.project.id, color });
                }}
                onSetTags={(next) => {
                  setTags((current) => {
                    const updated = { ...current };
                    if (next.length === 0) delete updated[block.project.id];
                    else updated[block.project.id] = next;
                    return updated;
                  });
                  void rpc
                    .call("project_set_tags", { projectId: block.project.id, tags: next })
                    .catch((cause: unknown) =>
                      report(cause instanceof Error ? cause.message : String(cause)),
                    );
                }}
                onReorder={(sourceProjectId, position) => {
                  // Manual mode only: in the other modes the list shows a
                  // computed order, and a drag inside it would write something
                  // nobody can see.
                  if (view.projectSort !== "manual") {
                    report("To reorder by dragging: Sort → Projects → Manual.");
                    return;
                  }
                  const before = position === "before";
                  const shown = blocks.map((entry) => entry.project.id);

                  // The host does not sort the personal project (404) — we
                  // remember its position ourselves.
                  if (sourceProjectId === personalProjectId) {
                    const withoutPersonal = shown.filter((id) => id !== personalProjectId);
                    const targetIndex = withoutPersonal.indexOf(block.project.id);
                    patchView({
                      personalAfter: before
                        ? (withoutPersonal[targetIndex - 1] ?? null)
                        : block.project.id,
                    });
                    return;
                  }

                  // The target is the personal project: the host does not know
                  // it, so its own anchor is moved instead.
                  if (block.project.id === personalProjectId) {
                    report("The personal project is not a drop target — drag it itself.");
                    return;
                  }

                  // The neighbours must come from the order WITHOUT the dragged
                  // and without the personal project: otherwise the neighbour is
                  // the project itself, or one the host does not track.
                  const order = shown.filter(
                    (id) => id !== sourceProjectId && id !== personalProjectId,
                  );
                  const targetIndex = order.indexOf(block.project.id);
                  if (targetIndex < 0) return;
                  void rpc
                    .call("project_reorder", {
                      projectId: sourceProjectId,
                      previousProjectId: before
                        ? (order[targetIndex - 1] ?? null)
                        : block.project.id,
                      nextProjectId: before
                        ? block.project.id
                        : (order[targetIndex + 1] ?? null),
                    })
                    .catch((cause: unknown) =>
                      report(
                        cause instanceof Error
                          ? `Order not saved: ${cause.message}`
                          : String(cause),
                      ),
                    );
                }}
              >
                {block.blocks.map((sectionBlock, index) => {
                  const key =
                    sectionBlock.section === null
                      ? null
                      : sectionKey(block.project.id, sectionBlock.section.id);
                  const sectionCollapsed =
                    key !== null && view.collapsedSections.includes(key);
                  return (
                    <div key={sectionBlock.section?.id ?? `loose-${index}`}>
                      {sectionBlock.section === null || key === null ? null : (
                        <SectionRow
                          id={sectionBlock.section.id}
                          name={sectionBlock.section.name}
                          count={sectionBlock.families.length}
                          state={projectState(sectionBlock.families)}
                          age={latestActivity(sectionBlock.families)}
                          now={now}
                          collapsed={sectionCollapsed}
                          renaming={
                            renaming?.kind === "section" &&
                            renaming.id === sectionBlock.section.id
                          }
                          threadCount={sectionReach(threads, sectionBlock.section.id).threads}
                          projectCount={sectionReach(threads, sectionBlock.section.id).projects}
                          onNewThread={() =>
                            actions.openNewThread({
                              projectId: block.project.id,
                              sectionId: sectionBlock.section!.id,
                              focusPrompt: true,
                            })
                          }
                          onToggle={() =>
                            patchView({
                              collapsedSections: toggleId(view.collapsedSections, key),
                            })
                          }
                          onStartRename={() =>
                            setRenaming({ kind: "section", id: sectionBlock.section!.id })
                          }
                          onCancelRename={() => setRenaming(null)}
                          onRename={(name) => {
                            setRenaming(null);
                            const reach = sectionReach(threads, sectionBlock.section!.id);
                            void rpc
                              .call("section_rename", {
                                sectionId: sectionBlock.section!.id,
                                name,
                              })
                              .then(() => {
                                // A section belongs to no project: say that the
                                // name changed everywhere it is used.
                                if (reach.projects > 1) {
                                  report(`Section renamed in ${reach.projects} projects.`);
                                }
                              });
                          }}
                          onDissolve={() => {
                            void rpc
                              .call("section_delete", { sectionId: sectionBlock.section!.id })
                              .then((result) =>
                                report(
                                  `Section dissolved — ${result.updatedThreadCount} threads left without a section, none deleted.`,
                                ),
                              );
                          }}
                          onDropThread={(threadId) =>
                            void rpc.call("thread_set_section", {
                              threadId,
                              sectionId: sectionBlock.section!.id,
                            })
                          }
                          onReorder={(sourceSectionId, position) => {
                            const shown = block.blocks
                              .filter((entry) => entry.section !== null)
                              .map((entry) => entry.section!.id);
                            const sectionOrder = moveInOrder(
                              view.sectionOrder,
                              shown,
                              sourceSectionId,
                              sectionBlock.section!.id,
                              position,
                            ).slice(-MAX_IDS);
                            patchView({ sectionOrder });
                          }}
                        />
                      )}
                      {sectionCollapsed ? null : key === null ? (
                        renderFamilies(sectionBlock.families, block.project.id)
                      ) : (
                        // Indent a section's threads behind a guide line so it is
                        // visible where the section ends.
                        <div className="mb-1 ml-3 border-l border-sidebar-border pl-1">
                          {renderFamilies(sectionBlock.families, block.project.id)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </ProjectRow>
            </div>
          );
        })}
      </div>

      <SelectionBar
        selectedCount={selected.size}
        chosenCount={plan.chosen.length}
        alsoDeletedCount={plan.alsoDeleted.length}
        busy={deleting}
        onDelete={deleteSelected}
        onClear={leaveSelection}
        selecting={selecting}
        onPin={() => {
          const ids = [...selected];
          void Promise.all(ids.map((id) => actions.setPinned(id, true))).then(() => {
            leaveSelection();
            report(`${ids.length} pinned.`);
          });
        }}
        onArchive={() => {
          // Archive covers a thread's agents too, so only the outermost picks
          // are sent — archiving a child after its parent would be a no-op
          // that still reports as an error.
          const picked = new Set(selected);
          const roots = [...picked].filter((id) => {
            let parent = threads.find((thread) => thread.id === id)?.parentThreadId ?? null;
            while (parent !== null) {
              if (picked.has(parent)) return false;
              parent = threads.find((thread) => thread.id === parent)?.parentThreadId ?? null;
            }
            return true;
          });
          for (const id of roots) actions.archive(id);
          leaveSelection();
          report(`${roots.length} archived.`);
        }}
      />
    </div>
  );

  function renderFamilies(families: readonly Family[], projectId: string) {
    const { loud, quiet } = view.foldQuiet
      ? splitQuiet(families)
      : { loud: [...families], quiet: [] as Family[] };
    const quietOpen = view.openQuiet.includes(projectId);
    const shown = quietOpen ? [...loud, ...quiet] : loud;
    return (
      <>
        {shown.map((family) => (
          <ThreadCard
            key={family.root.id}
            family={family}
            providers={providerMap}
            sections={sections}
            activeThreadId={activeThreadId}
            childrenOpen={
              openChildren[family.root.id] ??
              (familyState(family) !== "quiet" ||
                family.children.some((child) => needsUser(child)))
            }
            compact={view.compact}
            now={now}
            selection={selection}
            renaming={renaming?.kind === "thread" && renaming.id === family.root.id}
            onStartRename={(threadId) => setRenaming({ kind: "thread", id: threadId })}
            onCancelRename={() => setRenaming(null)}
            callbacks={callbacks}
          />
        ))}
        {!quietOpen && quiet.length > 0 ? (
          <button
            type="button"
            onClick={() => patchView({ openQuiet: toggleId(view.openQuiet, projectId) })}
            className={cn(
              "mx-2 my-0.5 rounded-md px-1 py-1 text-left text-2xs text-muted-foreground/70",
              "hover:bg-sidebar-accent/60 hover:text-muted-foreground",
            )}
          >
            ⋯ {quiet.length} quiet
          </button>
        ) : null}
      </>
    );
  }
}

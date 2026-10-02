// Activity (§3.7): three orthogonal axes per member, derived diagnoses, and
// "Needs you" as a state of the member rather than a list of its own.
//
// Sources are BB facts only — thread status and read markers from
// `threads.get`, open interactions from `threads.interactions.list`, and the
// plugin's own `messages` rows. Nothing is read off the screen.
import type { CrewRow, MemberRow, MessageRow, Store } from "./store";
import type { ContextUsage, OpenInteraction, ThreadInfo, ThreadPort } from "./thread-port";

export type ThreadAxis = "present" | "archived" | "missing";
export type ActivityState = "working" | "idle" | "needs-you" | "error" | "unknown";
export type NeedsReason =
  | "approval"
  | "question"
  | "human-question"
  | "loop"
  | "error"
  | "merge-request"
  | "merge-conflict"
  | "follow-up"
  | "context";
export type Diagnosis = "On hold" | "Unread result" | "Stopped: loop" | "Idle with open work" | "Handover suggested" | "Throttled";

/** §3.9.4: leads are relieved earlier than members, since all cross-crew traffic runs through them. */
export const CONTEXT_THRESHOLDS = { leadSuggest: 0.6, leadNeedsYou: 0.8, memberSuggest: 0.8 } as const;

export type ActivityInput = {
  thread: ThreadInfo | null;
  interactions: readonly OpenInteraction[];
  humanQuestion: Pick<MessageRow, "subject" | "body"> | null;
  /** Stopped-loop messages this member sent that the human has not dealt with yet. */
  stoppedLoops: number;
  /** Messages to this member waiting on hold. */
  held: number;
  lead?: boolean;
  /** Open (unclaimed or claimed) work items the member owns. */
  openWork?: number;
  /** Open items of this member that reached follow-up rung 4. */
  escalated?: number;
  /** A merge request of this lead's crew waits for the human. */
  mergeRequest?: string | null;
  /** Plugin-raised reasons (merge-conflict) with their detail. */
  needs?: readonly { reason: string; detail: string | null }[];
  context?: ContextUsage | null;
  throttled?: number;
  /** BBP-31: this member's graph_runs rows, newest first. */
  graphRuns?: readonly { runId: string; graphId: string; status: string }[];
};

export type Derived = {
  thread: ThreadAxis;
  activity: ActivityState;
  needsYou: NeedsReason[];
  /** What the human is asked, when there is a question. */
  question: string | null;
  held: number;
  diagnoses: Diagnosis[];
  openWork: number;
  /** Context usage as a fraction 0–1; null when BB did not report it. */
  context: number | null;
  /** BBP-31: this member's graph_runs rows, newest first. */
  graphRuns: readonly { runId: string; graphId: string; status: string }[];
};

const WORKING = new Set(["active", "pending", "starting", "stopping"]);

export function deriveActivity(input: ActivityInput): Derived {
  const { thread } = input;
  const axis: ThreadAxis = !thread ? "missing" : thread.archived ? "archived" : "present";
  const live = axis === "present" && thread !== null;
  const interactions = live ? input.interactions : [];
  const needsYou: NeedsReason[] = [];
  for (const interaction of interactions) {
    const reason: NeedsReason = interaction.kind === "approval" ? "approval" : "question";
    if (!needsYou.includes(reason)) needsYou.push(reason);
  }
  if (input.humanQuestion) needsYou.push("human-question");
  if (input.stoppedLoops > 0) needsYou.push("loop");
  if (live && thread.status === "error") needsYou.push("error");
  if (input.mergeRequest) needsYou.push("merge-request");
  if ((input.needs ?? []).some((need) => need.reason === "merge-conflict")) needsYou.push("merge-conflict");
  if ((input.escalated ?? 0) > 0) needsYou.push("follow-up");
  const context = input.context && input.context.contextWindow > 0 ? input.context.usedTokens / input.context.contextWindow : null;
  if (context !== null && input.lead && context >= CONTEXT_THRESHOLDS.leadNeedsYou) needsYou.push("context");

  let activity: ActivityState;
  if (!live) activity = "unknown";
  else if (interactions.length > 0 || input.humanQuestion) activity = "needs-you";
  else if (thread.status === "error") activity = "error";
  else if (WORKING.has(thread.status)) activity = "working";
  else if (thread.status === "idle") activity = "idle";
  else activity = "unknown";

  const unread =
    live && thread.status === "idle" && thread.latestAttentionAt > 0 && thread.latestAttentionAt > (thread.lastReadAt ?? 0);
  const diagnoses: Diagnosis[] = [];
  if (input.held > 0) diagnoses.push("On hold");
  if (unread) diagnoses.push("Unread result");
  if (input.stoppedLoops > 0) diagnoses.push("Stopped: loop");
  const openWork = input.openWork ?? 0;
  if (activity === "idle" && openWork > 0) diagnoses.push("Idle with open work");
  const suggestAt = input.lead ? CONTEXT_THRESHOLDS.leadSuggest : CONTEXT_THRESHOLDS.memberSuggest;
  if (context !== null && context >= suggestAt) diagnoses.push("Handover suggested");
  if ((input.throttled ?? 0) > 0) diagnoses.push("Throttled");

  const conflict = (input.needs ?? []).find((need) => need.reason === "merge-conflict");
  const question = input.humanQuestion
    ? `${input.humanQuestion.subject}: ${input.humanQuestion.body}`.slice(0, 2000)
    : (interactions[0]?.title ??
      (input.mergeRequest ? input.mergeRequest : null) ??
      (conflict ? `Rebase conflict: ${conflict.detail ?? "see the member thread"}` : null));
  return { thread: axis, activity, needsYou, question, held: input.held, diagnoses, openWork, context, graphRuns: input.graphRuns ?? [] };
}

export type RowStatus = { icon: string; label: string; tone: "default" | "error" | "running" | "success" };

/** The sidebar row icon (§4.6): error for Needs you, running while working, success for an unread result. */
export function rowStatusFor(derived: Derived): RowStatus | null {
  if (derived.needsYou.length > 0) return { icon: "CircleAlert", label: `Needs you: ${derived.needsYou.join(", ")}`, tone: "error" };
  if (derived.activity === "working") return { icon: "LoaderCircle", label: "Working", tone: "running" };
  if (derived.diagnoses.includes("Unread result")) return { icon: "CircleCheck", label: "Unread result", tone: "success" };
  return null;
}

export type ActivityView = Derived & {
  memberRow: string;
  key: string;
  address: string;
  lead: boolean;
  crewId: string;
  crewName: string;
  projectId: string;
  threadId: string | null;
  status: string | null;
  rowStatus: RowStatus | null;
};

export type ActivityTracker = ReturnType<typeof createActivityTracker>;

/**
 * The views that still belong to a member with a thread. The tracker's cache
 * keeps views of members that were removed, replaced or whose crew was
 * deleted; counted, they made the panel header say 4 where the crew's card
 * said 3.
 */
export function liveViews<V extends { memberRow: string; threadId: string | null }>(views: readonly V[], memberIds: ReadonlySet<string>): V[] {
  return views.filter((view) => view.threadId !== null && memberIds.has(view.memberRow));
}

/**
 * Keeps the derived view per member and says when it changed, so the server
 * publishes only real changes to the frontend.
 */
export type ActivityExtras = (crew: CrewRow, member: MemberRow) => Partial<ActivityInput>;

export function createActivityTracker(deps: {
  store: Store;
  port: ThreadPort;
  onChange?: (view: ActivityView) => void;
  /** E3 facts owned by other modules (work items, merges, follow-ups). */
  extras?: ActivityExtras;
  now?: () => number;
}) {
  const { store, port } = deps;
  const cache = new Map<string, ActivityView>();

  async function compute(crew: CrewRow, member: MemberRow): Promise<ActivityView> {
    const binding = store.currentBinding(member.id);
    const thread = binding ? await port.get(binding.threadId).catch(() => null) : null;
    const interactions = thread && !thread.archived ? await port.openInteractions(thread.id).catch(() => []) : [];
    const humanQuestion = store.openHumanQuestion(member.id);
    const stoppedLoops = store
      .listMessages({ crewId: crew.id, status: "stopped_loop", limit: 1000 })
      .filter((message) => message.fromMember === member.id && message.answeredAt === null).length;
    const held = store.countByMember(member.id, "to", "on_hold");
    const context = thread && !thread.archived ? await port.contextUsage(thread.id).catch(() => null) : null;
    if (thread && !thread.archived) store.markBusy(member.id, WORKING.has(thread.status), deps.now?.() ?? Date.now());
    const derived = deriveActivity({
      thread,
      interactions,
      humanQuestion,
      stoppedLoops,
      held,
      lead: member.lead,
      openWork: store.listWork({ owner: member.id, states: ["open", "claimed"] }).length,
      needs: store.listNeeds(member.id),
      throttled: store.countByMember(member.id, "to", "throttled"),
      context,
      graphRuns: store.listGraphRuns(member.id).map((row) => ({ runId: row.runId, graphId: row.graphId, status: row.status })),
      ...deps.extras?.(crew, member),
    });
    return {
      ...derived,
      memberRow: member.id,
      key: member.key,
      address: member.address,
      lead: member.lead,
      crewId: crew.id,
      crewName: crew.name,
      projectId: crew.projectId,
      threadId: binding?.threadId ?? null,
      status: thread?.status ?? null,
      rowStatus: rowStatusFor(derived),
    };
  }

  async function refreshMember(member: MemberRow): Promise<ActivityView | null> {
    const crew = store.getCrew(member.crewId);
    if (!crew) return null;
    const view = await compute(crew, member);
    const before = cache.get(member.id);
    cache.set(member.id, view);
    if (!before || JSON.stringify(before) !== JSON.stringify(view)) deps.onChange?.(view);
    return view;
  }

  async function refreshCrew(crew: CrewRow): Promise<ActivityView[]> {
    const views: ActivityView[] = [];
    const members = store.listMembers(crew.id);
    const alive = new Set(members.map((member) => member.id));
    for (const [id, view] of cache) if (view.crewId === crew.id && !alive.has(id)) cache.delete(id);
    for (const member of members) {
      const view = await refreshMember(member);
      if (view) views.push(view);
    }
    return views;
  }

  return {
    refreshMember,
    refreshCrew,
    /** A thread event: refresh the member bound to it, if any. */
    async refreshThread(threadId: string): Promise<ActivityView | null> {
      const member = store.memberByThread(threadId);
      return member ? refreshMember(member) : null;
    },
    /** Initial reconcile and the periodic safety net. */
    async refreshAll(projectId?: string): Promise<ActivityView[]> {
      const views: ActivityView[] = [];
      for (const crew of store.listCrews(projectId)) views.push(...(await refreshCrew(crew)));
      return views;
    },
    /** Cached views; members never computed yet are computed now. */
    async views(crew: CrewRow): Promise<ActivityView[]> {
      const members = store.listMembers(crew.id);
      if (members.every((member) => cache.has(member.id))) return members.map((member) => cache.get(member.id)!);
      return refreshCrew(crew);
    },
    cached(): ActivityView[] {
      return [...cache.values()];
    },
  };
}

// Sync: crew file ↔ threads (§3.3). `plan` reads, `apply` acts, `stop` halts.
//
// Both walk the members in topological order (lead first) and give every
// member an honest result — nothing is restarted silently. All BB access goes
// through the ThreadPort, all state through the Store, so the functions run
// unchanged against the fakes in tests.
import { messagingRules } from "./delivery";
import type { Journal } from "./journal";
import { workRules } from "./queue";
import { buildInstructions, hasErrors, type CrewSpec, type ResolvedMember, type Validation } from "./spec";
import { memberRowId, type CrewRow, type CrewStatus, type MemberRow, type Store } from "./store";
import type { PortEnvironment, ThreadInfo, ThreadPatch, ThreadPort } from "./thread-port";

export type SyncContext = {
  store: Store;
  port: ThreadPort;
  journal: Journal;
  /** Short directory of the project's crews for a lead's kickoff brief (§3.9.3). */
  directoryFor?: (projectId: string, crewName: string) => string;
};

export type PlanAction = "reuse" | "unarchive" | "spawn" | "update" | "remove";
export type PlanItem = {
  key: string;
  address: string;
  action: PlanAction;
  reasons: string[];
  threadId: string | null;
};

export type ResultKind = "reused" | "unarchived" | "spawned" | "updated" | "removed" | "failed";
export type MemberResult = {
  key: string;
  address: string;
  result: ResultKind;
  threadId: string | null;
  shift: number | null;
  detail: string | null;
};

type Expected = { title: string; provider: string | null; model: string | null; parentThreadId: string | null };

/** What differs between the thread and the member; provider is not patchable. */
async function drift(
  port: ThreadPort,
  thread: ThreadInfo,
  expected: Expected,
): Promise<{ patch: ThreadPatch; reasons: string[]; providerMismatch: boolean }> {
  const patch: ThreadPatch = {};
  const reasons: string[] = [];
  if (thread.title !== expected.title) {
    patch.title = expected.title;
    reasons.push(`title "${thread.title ?? ""}" → "${expected.title}"`);
  }
  if (expected.parentThreadId !== null && thread.parentThreadId !== expected.parentThreadId) {
    patch.parentThreadId = expected.parentThreadId;
    reasons.push(`parent ${thread.parentThreadId ?? "none"} → ${expected.parentThreadId}`);
  }
  if (expected.model !== null) {
    const model = await port.model(thread.id).catch(() => null);
    if (model !== null && model !== expected.model) {
      patch.model = expected.model;
      reasons.push(`model ${model} → ${expected.model}`);
    }
  }
  const providerMismatch = expected.provider !== null && thread.providerId !== expected.provider;
  if (providerMismatch) reasons.push(`provider ${thread.providerId} → ${expected.provider} (needs --fresh)`);
  return { patch, reasons, providerMismatch };
}

function expectedFor(member: ResolvedMember, leadThreadId: string | null): Expected {
  return {
    title: member.address,
    provider: member.provider,
    model: member.model,
    parentThreadId: member.lead ? null : leadThreadId,
  };
}

/** Read-only diff between crew file and threads, one action per member. */
export async function plan(
  ctx: SyncContext,
  projectId: string,
  validation: Validation,
  options: { fresh?: readonly string[] } = {},
): Promise<PlanItem[]> {
  const spec = validation.spec;
  if (!spec) return [];
  const crew = ctx.store.findCrew(projectId, spec.name);
  const fresh = new Set(options.fresh ?? []);
  const items: PlanItem[] = [];
  const lead = validation.members.find((member) => member.lead);
  const leadBinding = crew && lead ? ctx.store.currentBinding(memberRowId(crew.id, lead.key)) : null;
  let leadThreadId = leadBinding?.threadId ?? null;

  for (const member of validation.members) {
    const binding = crew ? ctx.store.currentBinding(memberRowId(crew.id, member.key)) : null;
    const base = { key: member.key, address: member.address, threadId: binding?.threadId ?? null };
    if (fresh.has(member.key)) {
      items.push({ ...base, action: "spawn", reasons: ["--fresh: new shift"] });
      if (member.lead) leadThreadId = null;
      continue;
    }
    const thread = binding ? await ctx.port.get(binding.threadId) : null;
    if (!thread) {
      const reasons = [binding ? `bound thread ${binding.threadId} is gone` : "no thread bound"];
      if (crew && ctx.store.openOps(memberRowId(crew.id, member.key)).length > 0) {
        reasons.push("unfinished spawn in the journal — apply looks for its thread first");
      }
      items.push({ ...base, threadId: null, action: "spawn", reasons });
      if (member.lead) leadThreadId = null;
      continue;
    }
    // A lead that is about to be spawned has no id yet; its children get
    // re-parented during apply, so plan does not call that drift.
    const { reasons } = await drift(ctx.port, thread, expectedFor(member, leadThreadId));
    if (thread.archived) items.push({ ...base, action: "unarchive", reasons: ["thread is archived", ...reasons] });
    else if (reasons.length > 0) items.push({ ...base, action: "update", reasons });
    else items.push({ ...base, action: "reuse", reasons: [] });
  }

  if (crew) {
    const wanted = new Set(validation.members.map((member) => member.key));
    for (const row of ctx.store.listMembers(crew.id)) {
      if (wanted.has(row.key)) continue;
      const binding = ctx.store.currentBinding(row.id);
      items.push({
        key: row.key,
        address: row.address,
        action: "remove",
        reasons: ["no longer in the crew file — archived, not deleted"],
        threadId: binding?.threadId ?? null,
      });
    }
  }
  return items;
}

/** First message of a new thread: role, address, peers, rules, first task. */
export function kickoffBrief(spec: CrewSpec, member: ResolvedMember, members: readonly ResolvedMember[], directory: string | null = null): string {
  const peers = members
    .filter((peer) => peer.key !== member.key)
    .map((peer) => `- ${peer.key} (${peer.address})${peer.lead ? " (lead)" : ""}${peer.role ? `: ${peer.role}` : ""}`);
  const policy = {
    name: spec.name,
    messaging: spec.messaging,
    crossCrew: spec.crossCrew,
    maxSteps: spec.maxSteps,
    maxMessagesPerChainPerHour: spec.maxMessagesPerChainPerHour,
  };
  return [
    `[crew] Kickoff brief for ${member.address}`,
    buildInstructions(spec, member),
    peers.length > 0 ? `Peers:\n${peers.join("\n")}` : "Peers: none — you are the whole crew.",
    messagingRules(member, policy),
    workRules(member.lead, member.integrator),
    member.lead && directory ? `Crews in this project (crew_directory for details):\n${directory}` : "",
    `First task: ${member.kickoff ?? "Wait for instructions from your lead."}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export class ApplyRefused extends Error {}

export type ApplyInput = {
  projectId: string;
  yaml: string;
  validation: Validation;
  fresh?: readonly string[];
};

export type ApplyOutcome = { crew: CrewRow; results: MemberResult[] };

export async function apply(ctx: SyncContext, input: ApplyInput): Promise<ApplyOutcome> {
  const { validation, projectId } = input;
  const spec = validation.spec;
  if (!spec || hasErrors(validation.problems)) {
    throw new ApplyRefused(
      `The crew file has errors:\n${validation.problems
        .filter((problem) => problem.level === "error")
        .map((problem) => `- ${problem.message}`)
        .join("\n")}`,
    );
  }
  const items = await plan(ctx, projectId, validation, { fresh: input.fresh });
  const { store, port, journal } = ctx;
  const { crew } = store.saveCrewFile(projectId, spec.name, input.yaml);
  store.setCrewStatus(crew.id, "starting");
  const rows = new Map<string, MemberRow>();
  for (const member of validation.members) {
    rows.set(
      member.key,
      store.upsertMember(crew.id, {
        groupId: member.groupId,
        memberId: member.memberId,
        address: member.address,
        lead: member.lead,
        config: {
          provider: member.provider,
          model: member.model,
          reasoningLevel: member.reasoningLevel,
          serviceTier: member.serviceTier,
          permissions: member.permissions,
          environment: member.environment,
          placement: member.placement,
          role: member.role,
          skills: member.skills,
          graphs: member.graphs,
          integrator: member.integrator,
        },
      }),
    );
  }
  store.replaceLinks(crew.id, spec.links);
  const leadMember = validation.members.find((member) => member.lead)!;
  store.setLead(crew.id, rows.get(leadMember.key)!.id);

  const results: MemberResult[] = [];
  let leadThreadId: string | null = null;
  const byKey = new Map(validation.members.map((member) => [member.key, member]));

  for (const item of items) {
    if (item.action === "remove") {
      results.push(await removeMember(ctx, crew.id, item));
      continue;
    }
    const member = byKey.get(item.key)!;
    const row = rows.get(item.key)!;
    let result: MemberResult;
    if (!member.lead && leadThreadId === null) {
      result = failed(member, item.threadId, "the lead has no thread, so there is nothing to nest under");
    } else if (item.action === "spawn") {
      result = await spawnMember(ctx, { crew, spec, member, row, members: validation.members, leadThreadId, fresh: item.threadId });
    } else {
      result = await reconcile(ctx, member, row, item.threadId!, leadThreadId);
    }
    // A lead that failed verification still has a thread; its children can
    // nest under it. Only a lead without any thread blocks the rest.
    if (member.lead) leadThreadId = result.threadId;
    results.push(result);
  }

  const status: CrewStatus = results.some((result) => result.result === "failed") ? "degraded" : "running";
  store.setCrewStatus(crew.id, status);
  return { crew: store.getCrew(crew.id)!, results };
}

function failed(member: ResolvedMember, threadId: string | null, detail: string): MemberResult {
  return { key: member.key, address: member.address, result: "failed", threadId, shift: null, detail };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function reconcile(
  ctx: SyncContext,
  member: ResolvedMember,
  row: MemberRow,
  threadId: string,
  leadThreadId: string | null,
): Promise<MemberResult> {
  const shift = ctx.store.currentBinding(row.id)?.shift ?? null;
  try {
    const thread = await ctx.port.get(threadId);
    if (!thread) return failed(member, threadId, "the bound thread disappeared during apply");
    let unarchived = false;
    if (thread.archived) {
      await ctx.port.unarchive(threadId);
      unarchived = true;
    }
    const { patch, reasons, providerMismatch } = await drift(ctx.port, thread, expectedFor(member, leadThreadId));
    if (Object.keys(patch).length > 0) await ctx.port.update(threadId, patch);
    if (providerMismatch) {
      return failed(member, threadId, `provider cannot change on an existing thread; run apply --fresh ${member.key}`);
    }
    const result: ResultKind = unarchived ? "unarchived" : reasons.length > 0 ? "updated" : "reused";
    return { key: member.key, address: member.address, result, threadId, shift, detail: reasons.join("; ") || null };
  } catch (error) {
    return failed(member, threadId, message(error));
  }
}

async function environmentFor(
  ctx: SyncContext,
  member: ResolvedMember,
  leadThreadId: string | null,
): Promise<PortEnvironment> {
  const placement = member.placement;
  switch (placement.kind) {
    case "crew-root":
      return placement.workspace === "managed-worktree" ? { kind: "managed-worktree" } : { kind: "project-default" };
    case "own-worktree":
      return { kind: "managed-worktree" };
    case "host":
      return { kind: "host", hostId: placement.hostId };
    case "shared": {
      const environmentId = leadThreadId ? await ctx.port.environmentOf(leadThreadId) : null;
      if (!environmentId) throw new Error("the lead's environment is not ready, cannot share it");
      return { kind: "reuse", environmentId };
    }
  }
}

export async function spawnMember(
  ctx: SyncContext,
  args: {
    crew: CrewRow;
    spec: CrewSpec;
    member: ResolvedMember;
    row: MemberRow;
    members: readonly ResolvedMember[];
    leadThreadId: string | null;
    /** Set when `--fresh` replaces this thread. */
    fresh: string | null;
    /** Appended to the kickoff brief (a handover names its brief here). */
    note?: string;
  },
): Promise<MemberResult> {
  const { store, port, journal } = ctx;
  const { crew, member, row } = args;

  // A crash between intent and done left a thread behind: bind it instead of
  // spawning a second one. `--fresh` skips this, it wants a new shift.
  if (args.fresh === null) {
    const orphan = await journal.recoverOrphan(row.id, crew.projectId, port).catch(() => null);
    if (orphan) {
      if (orphan.thread.archived) await port.unarchive(orphan.thread.id);
      const shift = store.lastShift(row.id) + 1;
      store.bind(row.id, orphan.thread.id, shift);
      return {
        key: member.key,
        address: member.address,
        result: "spawned",
        threadId: orphan.thread.id,
        shift,
        detail: `recovered thread from unfinished journal entry ${orphan.opId}`,
      };
    }
  } else {
    // The old shift ends: archived, not deleted, so its transcript stays;
    // `retired` in its metadata says it is no longer the member's thread.
    await port.setMetadata(args.fresh, { retired: true }).catch(() => undefined);
    await port.archive(args.fresh).catch(() => undefined);
    store.retireBinding(row.id);
  }

  if (member.provider === null || member.model === null) {
    return failed(member, null, "provider and model are required");
  }
  const shift = store.lastShift(row.id) + 1;
  const opId = journal.begin(row.id, "spawn");
  let thread: ThreadInfo;
  try {
    thread = await port.spawn({
      projectId: crew.projectId,
      prompt: [
        kickoffBrief(args.spec, member, args.members, member.lead ? (ctx.directoryFor?.(crew.projectId, crew.name) ?? null) : null),
        args.note ?? "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      title: member.address,
      providerId: member.provider,
      model: member.model,
      reasoningLevel: member.reasoningLevel,
      serviceTier: member.serviceTier,
      permissions: member.permissions,
      parentThreadId: member.lead ? null : args.leadThreadId,
      environment: await environmentFor(ctx, member, args.leadThreadId),
      metadata: {
        crew: crew.name,
        crewId: crew.id,
        member: member.key,
        address: member.address,
        shift,
        opId,
        lead: member.lead,
      },
    });
  } catch (error) {
    journal.failed(opId, message(error));
    return failed(member, null, message(error));
  }
  journal.done(opId, thread.id);
  store.bind(row.id, thread.id, shift);

  // Verify what BB actually chose (§6). Provider comes back on the thread,
  // the model only through defaultExecutionOptions.
  const mismatches: string[] = [];
  if (thread.providerId !== member.provider) mismatches.push(`provider is ${thread.providerId}, wanted ${member.provider}`);
  const model = await port.model(thread.id).catch(() => null);
  if (model !== null && model !== member.model) mismatches.push(`model is ${model}, wanted ${member.model}`);
  if (mismatches.length > 0) {
    return { key: member.key, address: member.address, result: "failed", threadId: thread.id, shift, detail: mismatches.join("; ") };
  }
  return {
    key: member.key,
    address: member.address,
    result: "spawned",
    threadId: thread.id,
    shift,
    detail: model === null ? "model not verifiable: BB did not report it" : null,
  };
}

async function removeMember(ctx: SyncContext, crewId: string, item: PlanItem): Promise<MemberResult> {
  const row = ctx.store.listMembers(crewId).find((candidate) => candidate.key === item.key)!;
  try {
    if (item.threadId) {
      await ctx.port.stop(item.threadId).catch(() => undefined);
      await ctx.port.setMetadata(item.threadId, { retired: true }).catch(() => undefined);
      await ctx.port.archive(item.threadId);
    }
    ctx.store.retireBinding(row.id);
    ctx.store.markMemberRemoved(row.id);
    return { key: item.key, address: item.address, result: "removed", threadId: item.threadId, shift: null, detail: "archived" };
  } catch (error) {
    return { key: item.key, address: item.address, result: "failed", threadId: item.threadId, shift: null, detail: message(error) };
  }
}

export type StopResult = { key: string; threadId: string | null; stopped: boolean; archived: boolean; error: string | null };

/** Stop running turns; with `archive`, archive the threads too. Crew → stopped. */
export async function stop(ctx: SyncContext, crew: CrewRow, options: { archive?: boolean } = {}): Promise<StopResult[]> {
  const results: StopResult[] = [];
  // Children first, lead last: the lead is the parent and gets their reports.
  const members = [...ctx.store.listMembers(crew.id)].sort((a, b) => Number(a.lead) - Number(b.lead));
  for (const row of members) {
    const binding = ctx.store.currentBinding(row.id);
    if (!binding) {
      results.push({ key: row.key, threadId: null, stopped: false, archived: false, error: null });
      continue;
    }
    const entry: StopResult = { key: row.key, threadId: binding.threadId, stopped: false, archived: false, error: null };
    try {
      const thread = await ctx.port.get(binding.threadId);
      if (!thread) {
        entry.error = "thread is gone";
      } else {
        if (!thread.archived) {
          await ctx.port.stop(binding.threadId);
          entry.stopped = true;
        }
        if (options.archive && !thread.archived) {
          await ctx.port.archive(binding.threadId);
          entry.archived = true;
        }
      }
    } catch (error) {
      entry.error = message(error);
    }
    results.push(entry);
  }
  ctx.store.setCrewStatus(crew.id, "stopped");
  return results;
}

export type MemberView = {
  key: string;
  groupId: string;
  address: string;
  lead: boolean;
  provider: string | null;
  model: string | null;
  permissions: string | null;
  shift: number | null;
  threadId: string | null;
  thread: "present" | "archived" | "missing";
  status: string | null;
  /** What BB reports for the live thread — the check behind "provider/model as in the file". */
  actualProvider: string | null;
  actualModel: string | null;
};

/** Members with their binding and live thread state, for show/ps and the panel. */
export async function describeMembers(ctx: SyncContext, crew: CrewRow): Promise<MemberView[]> {
  const views: MemberView[] = [];
  for (const row of ctx.store.listMembers(crew.id)) {
    const binding = ctx.store.currentBinding(row.id);
    const thread = binding ? await ctx.port.get(binding.threadId).catch(() => null) : null;
    views.push({
      key: row.key,
      groupId: row.groupId,
      address: row.address,
      lead: row.lead,
      provider: (row.config.provider as string | null) ?? null,
      model: (row.config.model as string | null) ?? null,
      permissions: (row.config.permissions as string | null) ?? null,
      shift: binding?.shift ?? null,
      threadId: binding?.threadId ?? null,
      thread: !thread ? "missing" : thread.archived ? "archived" : "present",
      status: thread?.status ?? null,
      actualProvider: thread?.providerId ?? null,
      actualModel: thread ? await ctx.port.model(thread.id).catch(() => null) : null,
    });
  }
  return views;
}

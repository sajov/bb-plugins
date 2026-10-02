// The rest of a crew's lifecycle (§3.3, E4): snapshot/restore, reset,
// handover, attach/detach, add/remove member, export/import.
//
// Every thread change goes through the ThreadPort and is journalled like a
// spawn, so a crash leaves a trail. A new shift always means a new binding
// row; the old one is retired, never deleted, and a thread that stops being
// the member's thread gets `retired: true` in its metadata.
import { randomBytes } from "node:crypto";
import { addMemberToFile, removeMemberFromFile, type NewMember } from "./crewfile";
import { AddressError, type Delivery } from "./delivery";
import type { CrewModels } from "./policy";
import type { Queue } from "./queue";
import { hasErrors, type Validation } from "./spec";
import { memberRowId, type CrewRow, type HandoverRow, type MemberRow, type MessageRow, type WorkItemRow } from "./store";
import { kickoffBrief, spawnMember, type ApplyOutcome, type MemberResult, type PlanItem, type SyncContext } from "./sync";
import type { ThreadInfo } from "./thread-port";

const BUSY = new Set(["active", "pending", "starting", "stopping"]);
const UNDELIVERED: readonly MessageRow["status"][] = ["pending", "on_hold", "throttled"];

export type SnapshotData = {
  version: 1;
  crew: string;
  projectId: string;
  fileVersion: number;
  yaml: string;
  bindings: { key: string; shift: number; threadId: string }[];
  work: WorkItemRow[];
  messages: MessageRow[];
  channel: { lastId: string | null; lastAt: number | null; posts: number };
};

export type RestoreReport = {
  snapshot: string;
  bindings: { key: string; threadId: string; shift: number; change: "same" | "rebound" }[];
  work: { restored: string[]; kept: string[] };
  messages: { requeued: string[]; reinserted: string[]; alreadyDelivered: string[] };
  outcome: ApplyOutcome & { validation: Validation };
};

export type LifecycleDeps = {
  ctx: SyncContext;
  models: CrewModels;
  delivery: Delivery;
  queue: Queue;
  /** The service's apply (it also records environments, directory notes, drains). */
  apply: (projectId: string, yaml: string, options?: { confirmFull?: boolean }) => Promise<ApplyOutcome & { validation: Validation; limit: string }>;
  plan: (projectId: string, yaml: string) => Promise<{ validation: Validation; items: PlanItem[] }>;
  validate: (projectId: string, yaml: string, confirmFull?: boolean) => Promise<Validation>;
  newId?: (prefix: "snap" | "ho") => string;
};

export type Lifecycle = ReturnType<typeof createLifecycle>;

export function createLifecycle(deps: LifecycleDeps) {
  const { ctx, models, delivery, queue } = deps;
  const { store, port, journal } = ctx;
  const newId = deps.newId ?? ((prefix: string) => `${prefix}_${randomBytes(5).toString("hex")}`);

  function requireMember(crew: CrewRow, key: string): MemberRow {
    const bare = key.includes("@") ? key.slice(0, key.indexOf("@")) : key;
    const member = store.listMembers(crew.id).find((entry) => entry.key === bare);
    if (!member) throw new AddressError(`No member "${key}" in crew ${crew.name}.`);
    return member;
  }

  function resolvedMember(crew: CrewRow, member: MemberRow) {
    const model = models(crew);
    const resolved = model.members.find((entry) => entry.key === member.key);
    if (!model.spec || !resolved) throw new AddressError(`Crew ${crew.name} has no readable crew file entry for ${member.key}.`);
    return { spec: model.spec, resolved, members: model.members };
  }

  function lead(crew: CrewRow): MemberRow | null {
    return store.listMembers(crew.id).find((entry) => entry.lead) ?? null;
  }

  async function liveThread(member: MemberRow): Promise<ThreadInfo> {
    const binding = store.currentBinding(member.id);
    if (!binding) throw new AddressError(`${member.address} has no thread; run bb crew apply.`);
    const thread = await port.get(binding.threadId);
    if (!thread) throw new AddressError(`${member.address}'s thread ${binding.threadId} is gone; run bb crew apply.`);
    return thread;
  }

  function metadataFor(crew: CrewRow, member: MemberRow, shift: number, opId: string) {
    return { crew: crew.name, crewId: crew.id, member: member.key, address: member.address, shift, opId, lead: member.lead, retired: false };
  }

  /** A new lead thread: every other member's thread moves under it, so the sidebar keeps nesting. */
  async function reparentChildren(crew: CrewRow, leadThreadId: string): Promise<void> {
    for (const member of store.listMembers(crew.id)) {
      if (member.lead) continue;
      const binding = store.currentBinding(member.id);
      if (binding) await port.update(binding.threadId, { parentThreadId: leadThreadId }).catch(() => undefined);
    }
  }

  async function spawnShift(crew: CrewRow, member: MemberRow, oldThread: string, note?: string): Promise<MemberResult> {
    const { spec, resolved, members } = resolvedMember(crew, member);
    const leadRow = lead(crew);
    const leadThreadId = member.lead ? null : leadRow ? (store.currentBinding(leadRow.id)?.threadId ?? null) : null;
    const result = await spawnMember(ctx, { crew, spec, member: resolved, row: member, members, leadThreadId, fresh: oldThread, note });
    if (member.lead && result.threadId) await reparentChildren(crew, result.threadId);
    return result;
  }

  // --- snapshot / restore -------------------------------------------------

  function snapshot(crew: CrewRow, label: string | null = null): { id: string; data: SnapshotData } {
    const file = store.crewFile(crew.id);
    if (!file) throw new AddressError(`Crew ${crew.name} has no stored crew file.`);
    const posts = store.listChannel(crew.id, { limit: 500 });
    const last = posts.at(-1) ?? null;
    const data: SnapshotData = {
      version: 1,
      crew: crew.name,
      projectId: crew.projectId,
      fileVersion: file.version,
      yaml: file.yaml,
      bindings: store.listMembers(crew.id).flatMap((member) => {
        const binding = store.currentBinding(member.id);
        return binding ? [{ key: member.key, shift: binding.shift, threadId: binding.threadId }] : [];
      }),
      work: store.listWork({ crewId: crew.id, states: ["open", "claimed"] }),
      // Messages *to* this crew that have not reached a thread yet: the delivery queue.
      messages: store.listMessages({ crewId: crew.id, limit: 1000 }).filter((row) => row.toCrew === crew.id && UNDELIVERED.includes(row.status)),
      channel: { lastId: last?.id ?? null, lastAt: last?.createdAt ?? null, posts: posts.length },
    };
    const id = newId("snap");
    store.insertSnapshot({ id, crewId: crew.id, label, json: JSON.stringify(data) });
    return { id, data };
  }

  async function restore(snapshotId: string): Promise<RestoreReport> {
    const row = store.getSnapshot(snapshotId);
    if (!row) throw new AddressError(`There is no snapshot "${snapshotId}".`);
    const data = JSON.parse(row.json) as SnapshotData;
    const crew = store.getCrew(row.crewId);
    if (!crew) throw new AddressError(`The crew of snapshot ${snapshotId} no longer exists.`);

    const bindings: RestoreReport["bindings"] = [];
    for (const entry of data.bindings) {
      const memberRow = memberRowId(crew.id, entry.key);
      const current = store.currentBinding(memberRow);
      if (current && current.threadId === entry.threadId && current.shift === entry.shift) {
        bindings.push({ ...entry, change: "same" });
        continue;
      }
      // The thread bound later (a reset, a handover) loses its place, but stays in BB.
      if (current && current.threadId !== entry.threadId) await port.setMetadata(current.threadId, { retired: true }).catch(() => undefined);
      store.restoreBinding(memberRow, entry.threadId, entry.shift);
      await port.setMetadata(entry.threadId, { shift: entry.shift, retired: false }).catch(() => undefined);
      bindings.push({ ...entry, change: "rebound" });
    }

    const work = { restored: [] as string[], kept: [] as string[] };
    const snapshotItems = new Set(data.work.map((item) => item.id));
    for (const item of data.work) {
      const current = store.getWork(item.id);
      const same = current && current.state === item.state && current.ownerMember === item.ownerMember && current.epoch === item.epoch;
      if (same) continue;
      store.restoreWork(item, "restore");
      work.restored.push(item.id);
    }
    for (const item of store.listWork({ crewId: crew.id, states: ["open", "claimed"] })) if (!snapshotItems.has(item.id)) work.kept.push(item.id);

    const messages = { requeued: [] as string[], reinserted: [] as string[], alreadyDelivered: [] as string[] };
    for (const message of data.messages) {
      const current = store.getMessage(message.id);
      if (!current) {
        store.insertMessage({ ...message, status: "pending", hold: null, delivered: false });
        messages.reinserted.push(message.id);
      } else if (current.status === "delivered" || current.status === "queued") {
        // It reached a thread after the snapshot: sending it again would break "exactly once".
        messages.alreadyDelivered.push(message.id);
      } else if (current.status === "failed" && current.reason !== "discarded by the human") {
        store.updateMessage(message.id, { status: "pending", hold: null, reason: `restored from snapshot ${snapshotId}` });
        messages.requeued.push(message.id);
      }
    }
    const outcome = await deps.apply(crew.projectId, data.yaml, { confirmFull: true });
    // A message that failed on a still-archived thread while apply ran gets one more try now.
    let retried = false;
    for (const message of data.messages) {
      const current = store.getMessage(message.id);
      if (current?.status === "failed" && /is archived$/.test(current.reason ?? "")) {
        store.updateMessage(message.id, { status: "pending", hold: null, reason: `restored from snapshot ${snapshotId}` });
        if (!messages.requeued.includes(message.id)) messages.requeued.push(message.id);
        retried = true;
      }
    }
    if (retried) await delivery.drain();
    return { snapshot: snapshotId, bindings, work, messages, outcome };
  }

  // --- reset / handover ---------------------------------------------------

  async function reset(crew: CrewRow, key: string, mode: "clear" | "new"): Promise<MemberResult> {
    const member = requireMember(crew, key);
    if (store.activeHandover(member.id)) throw new AddressError(`${member.key} is in a handover; finish or cancel it first.`);
    const thread = await liveThread(member);
    if (mode === "new") return spawnShift(crew, member, thread.id);

    const { spec, resolved, members } = resolvedMember(crew, member);
    const shift = store.lastShift(member.id) + 1;
    const opId = journal.begin(member.id, "reset");
    try {
      if (thread.archived) await port.unarchive(thread.id);
      // clearContext needs an idle thread.
      if (BUSY.has(thread.status)) await port.stop(thread.id);
      await port.clearContext(thread.id);
      store.bind(member.id, thread.id, shift);
      await port.setMetadata(thread.id, metadataFor(crew, member, shift, opId));
      journal.done(opId, thread.id);
    } catch (error) {
      journal.failed(opId, error instanceof Error ? error.message : String(error), thread.id);
      throw error;
    }
    // The cleared session knows nothing: the kickoff brief is its first message.
    await port.send(
      thread.id,
      `${kickoffBrief(spec, resolved, members)}\n\nThis is shift ${shift}: your context was cleared by a reset. Work items and messages are kept (crew_work_list, crew_inbox).`,
      "start",
    );
    return { key: member.key, address: member.address, result: "updated", threadId: thread.id, shift, detail: "context cleared, same thread" };
  }

  function handoverText(member: MemberRow, handover: HandoverRow): string {
    return [
      `[crew] Handover requested for ${member.address} (shift ${handover.oldShift} → ${handover.oldShift + 1})`,
      "---",
      "Your shift ends. Write a handover brief for your successor and pass it with crew_handover_note(brief: …):",
      "- what you were doing and where it stands (commits, files, branches)",
      "- open work items and promises to other members",
      "- what you would do next, and what to avoid",
      "Messages to you are held until the new shift starts; the brief reaches the new thread as a work item.",
    ].join("\n");
  }

  /** Start a handover; with a brief (from the human) it completes at once. */
  async function handover(crew: CrewRow, key: string, options: { brief?: string } = {}): Promise<{ handover: HandoverRow; result: MemberResult | null }> {
    const member = requireMember(crew, key);
    const thread = await liveThread(member);
    let row = store.activeHandover(member.id);
    if (!row) {
      const binding = store.currentBinding(member.id)!;
      row = store.insertHandover({ id: newId("ho"), memberId: member.id, oldThread: thread.id, oldShift: binding.shift });
      if (options.brief === undefined) {
        // queue-if-active: a running turn finishes first; an idle thread starts on it.
        await port.send(thread.id, handoverText(member, row), "queue-if-active");
      }
    }
    if (options.brief !== undefined) {
      noteBrief(member, options.brief);
      const result = await complete(store.getHandover(row.id)!, { force: true });
      return { handover: store.getHandover(row.id)!, result };
    }
    return { handover: store.getHandover(row.id)!, result: null };
  }

  /** `crew_handover_note`: store the brief. Without a running handover the member starts one itself. */
  function noteBrief(member: MemberRow, brief: string): HandoverRow {
    const text = brief.trim();
    if (!text) throw new AddressError("The handover brief is empty.");
    let row = store.activeHandover(member.id);
    if (!row) {
      const binding = store.currentBinding(member.id);
      if (!binding) throw new AddressError(`${member.address} has no thread.`);
      row = store.insertHandover({ id: newId("ho"), memberId: member.id, oldThread: binding.threadId, oldShift: binding.shift });
    }
    if (row.state === "completing") throw new AddressError("The handover is already completing.");
    store.updateHandover(row.id, { state: "noted", brief: text.slice(0, 20_000) }, ["writing", "noted"]);
    return store.getHandover(row.id)!;
  }

  /**
   * Noted → new shift. Runs once per handover: the `completing` claim is a
   * guarded update, so a second tick or a racing CLI call does nothing.
   * The old thread must be idle unless forced — archiving it mid-turn would
   * cut off the tool call that wrote the brief.
   */
  async function complete(row: HandoverRow, options: { force?: boolean } = {}): Promise<MemberResult | null> {
    const member = store.getMember(row.memberId);
    const crew = member ? store.getCrew(member.crewId) : null;
    if (!member || !crew) return null;
    const old = await port.get(row.oldThread).catch(() => null);
    if (!options.force && old && BUSY.has(old.status)) return null;
    if (!store.updateHandover(row.id, { state: "completing" }, ["noted"])) return null;
    const next = row.oldShift + 1;
    const item = queue.create(crew, { kind: "member", member }, {
      title: `Handover brief: shift ${row.oldShift} → ${next}`,
      body: row.brief ?? "",
      owner: member.key,
      tier: "p1",
    });
    if (old && BUSY.has(old.status)) await port.stop(old.id).catch(() => undefined);
    let result: MemberResult;
    try {
      result = await spawnShift(
        crew,
        member,
        row.oldThread,
        `Handover: you continue shift ${row.oldShift} of ${member.address}. Your predecessor's brief is work item ${item.id} — read it first: crew_work_claim(id: "${item.id}"), then crew_work_list. Messages held during the handover follow now.`,
      );
    } catch (error) {
      result = { key: member.key, address: member.address, result: "failed", threadId: null, shift: null, detail: error instanceof Error ? error.message : String(error) };
    }
    const ok = result.result !== "failed" || result.threadId !== null;
    store.updateHandover(row.id, { state: ok ? "done" : "failed", newThread: result.threadId, itemId: item.id, detail: result.detail });
    // Held messages go now — to the new binding, since delivery reads it after the hold.
    await delivery.drain();
    return result;
  }

  /** Complete every noted handover whose old thread is idle (delivery loop, thread.idle). */
  async function tick(): Promise<number> {
    let done = 0;
    for (const row of store.listHandovers({ states: ["noted"] })) if (await complete(row)) done += 1;
    return done;
  }

  function cancelHandover(crew: CrewRow, key: string): HandoverRow {
    const member = requireMember(crew, key);
    const row = store.activeHandover(member.id);
    if (!row || row.state === "completing") throw new AddressError(`${member.key} has no handover to cancel.`);
    store.updateHandover(row.id, { state: "failed", detail: "cancelled by the human" }, ["writing", "noted"]);
    return store.getHandover(row.id)!;
  }

  // --- attach / detach ----------------------------------------------------

  /** Threads of the project that no crew member holds: the attach dialog's candidates. */
  async function candidates(projectId: string): Promise<ThreadInfo[]> {
    const threads = await port.listProject(projectId);
    return threads.filter((thread) => !store.memberByThread(thread.id));
  }

  async function attach(
    crew: CrewRow,
    threadId: string,
    key: string,
    options: { replace?: boolean } = {},
  ): Promise<MemberResult & { kickoff: MessageRow | null }> {
    const member = requireMember(crew, key);
    const thread = await port.get(threadId);
    if (!thread) throw new AddressError(`There is no thread ${threadId}.`);
    if (thread.projectId !== crew.projectId) {
      throw new AddressError(`Thread ${threadId} belongs to project ${thread.projectId}; crew ${crew.name} lives in ${crew.projectId}. A crew stays in one project.`);
    }
    if (thread.archived) throw new AddressError(`Thread ${threadId} is archived; unarchive it first.`);
    const holder = store.memberByThread(threadId);
    if (holder) throw new AddressError(`Thread ${threadId} is already bound to ${holder.address}.`);
    const current = store.currentBinding(member.id);
    if (current) {
      const live = await port.get(current.threadId).catch(() => null);
      if (live && !live.archived && !options.replace) {
        throw new AddressError(`${member.address} already has thread ${current.threadId}. Pass --replace to retire it (it is archived, not deleted).`);
      }
      if (live) {
        await port.setMetadata(live.id, { retired: true }).catch(() => undefined);
        if (!live.archived) await port.archive(live.id).catch(() => undefined);
      }
    }
    const shift = store.lastShift(member.id) + 1;
    const opId = journal.begin(member.id, "attach");
    try {
      await port.setMetadata(threadId, metadataFor(crew, member, shift, opId));
      const leadRow = lead(crew);
      const leadThread = !member.lead && leadRow ? (store.currentBinding(leadRow.id)?.threadId ?? null) : null;
      await port.update(threadId, { title: member.address, ...(leadThread ? { parentThreadId: leadThread } : {}) });
      store.bind(member.id, threadId, shift);
      journal.done(opId, threadId);
      if (member.lead) await reparentChildren(crew, threadId);
    } catch (error) {
      journal.failed(opId, error instanceof Error ? error.message : String(error), threadId);
      throw error;
    }
    // No spawn, no restart: the role instruction takes effect at the next
    // session start (§4.5), so the kickoff brief travels as an ordinary message.
    const { spec, resolved, members } = resolvedMember(crew, member);
    const [kickoff] = delivery.send({
      projectId: crew.projectId,
      from: { kind: "system" },
      to: member.address,
      kind: "message",
      subject: `Kickoff brief for ${member.address} (attached, shift ${shift})`,
      body: kickoffBrief(spec, resolved, members),
      crew: crew.name,
    });
    return { key: member.key, address: member.address, result: "updated", threadId, shift, detail: "attached", kickoff: kickoff ?? null };
  }

  async function detach(crew: CrewRow, key: string): Promise<{ member: MemberRow; threadId: string }> {
    const member = requireMember(crew, key);
    const binding = store.currentBinding(member.id);
    if (!binding) throw new AddressError(`${member.address} has no thread to detach.`);
    store.retireBinding(member.id);
    await port.setMetadata(binding.threadId, { retired: true }).catch(() => undefined);
    return { member, threadId: binding.threadId };
  }

  // --- add / remove member, export / import -------------------------------

  function storedYaml(crew: CrewRow): string {
    const file = store.crewFile(crew.id);
    if (!file) throw new AddressError(`Crew ${crew.name} has no stored crew file.`);
    return file.yaml;
  }

  async function checked(projectId: string, yaml: string, confirmFull: boolean): Promise<void> {
    const validation = await deps.validate(projectId, yaml, confirmFull);
    if (hasErrors(validation.problems)) {
      throw new AddressError(`The changed crew file has errors:\n${validation.problems.filter((p) => p.level === "error").map((p) => `- ${p.message}`).join("\n")}`);
    }
  }

  async function addMember(crew: CrewRow, member: NewMember, options: { confirmFull?: boolean } = {}) {
    const yaml = addMemberToFile(storedYaml(crew), member);
    await checked(crew.projectId, yaml, options.confirmFull ?? false);
    return deps.apply(crew.projectId, yaml, { confirmFull: options.confirmFull });
  }

  async function removeMember(crew: CrewRow, key: string) {
    const member = requireMember(crew, key);
    const yaml = removeMemberFromFile(storedYaml(crew), member.key);
    await checked(crew.projectId, yaml, true);
    return deps.apply(crew.projectId, yaml, { confirmFull: true });
  }

  /** Store an imported crew file (no threads touched) and return what apply would do. */
  async function importFile(projectId: string, yaml: string) {
    const validation = await deps.validate(projectId, yaml, true);
    if (!validation.spec || validation.problems.some((p) => p.level === "error" && p.code !== "full-unconfirmed")) {
      return { crew: null, changed: false, validation, items: [] as PlanItem[] };
    }
    const { crew, changed } = store.saveCrewFile(projectId, validation.spec.name, yaml);
    const planned = await deps.plan(projectId, yaml);
    return { crew, changed, validation: planned.validation, items: planned.items };
  }

  return {
    snapshot,
    restore,
    reset,
    handover,
    noteBrief,
    complete,
    tick,
    cancelHandover,
    candidates,
    attach,
    detach,
    addMember,
    removeMember,
    importFile,
    exportFile: storedYaml,
  };
}

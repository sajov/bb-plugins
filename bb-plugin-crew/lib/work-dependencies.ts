// Per-item AND barriers use the same transactional outbox as crew dependencies.
import { randomBytes } from "node:crypto";
import { AddressError, type Delivery } from "./delivery";
import type { CrewRow, Store, WorkItemRow } from "./store";

export function createWorkDependencies(store: Store, delivery: Delivery) {
  function view(item: WorkItemRow): WorkItemRow {
    const row = store.getWorkDependency(item.id);
    return { ...item, waitsFor: row?.dependsOn ?? [], blockedBy: (item.state === "open" || item.state === "claimed" ? row?.dependsOn ?? [] : []).filter((id) => store.getWork(id)?.state !== "done"), dependencyDetail: row?.detail ?? null };
  }

  function declare(item: WorkItemRow, ids: string[], actor: string, initial = false): void {
    const dependsOn = [...new Set(ids)].sort();
    for (const id of dependsOn) {
      const other = store.getWork(id);
      if (!other || other.crewId !== item.crewId) throw new AddressError(`Dependency ${id} must exist in the same crew as ${item.id}.`);
      const pending = [id];
      const visited = new Set<string>();
      while (pending.length) {
        const next = pending.pop()!;
        if (next === item.id) throw new AddressError(`Dependency cycle or self-dependency for ${item.id}.`);
        if (visited.has(next)) continue;
        visited.add(next);
        pending.push(...(store.getWorkDependency(next)?.dependsOn ?? []));
      }
    }
    store.atomically(() => {
      const previous = store.getWorkDependency(item.id);
      if (!dependsOn.length) store.clearWorkDependency(item.id);
      else if (JSON.stringify(previous?.dependsOn) !== JSON.stringify(dependsOn)) {
        store.saveWorkDependency({ itemId: item.id, dependsOn, satisfied: initial && dependsOn.every((id) => store.getWork(id)?.state === "done"), failedNotified: [], detail: null });
      }
      store.insertChannel({ id: `cm_${randomBytes(4).toString("hex")}`, crewId: item.crewId, author: actor, topic: "work", body: `${actor} declared ${item.id} waits for: ${dependsOn.join(", ") || "none (cleared)"}.` });
    });
  }

  function poll(onlyCrew?: CrewRow): number {
    let count = 0;
    for (const crew of onlyCrew ? [onlyCrew] : store.listCrews()) {
      if (crew.status !== "running" && crew.status !== "degraded") continue;
      for (const item of store.listWork({ crewId: crew.id, states: ["open", "claimed"] })) {
        const row = store.getWorkDependency(item.id);
        if (!row) continue;
        const prerequisites = row.dependsOn.map((id) => store.getWork(id));
        const failed = prerequisites.filter((entry) => entry?.state === "failed" && !row.failedNotified.includes(entry.id));
        const ready = !row.satisfied && prerequisites.every((entry) => entry?.state === "done");
        if (!ready && !failed.length) continue;
        try {
          // A crash cannot commit the marker without also committing its queued notice.
          store.atomically(() => {
            const lead = store.listMembers(crew.id).find((member) => member.lead);
            const target = ready ? (item.ownerMember ? store.getMember(item.ownerMember) : lead) : lead;
            if (!target) throw new Error("No recipient for the work dependency notice");
            const summary = prerequisites.map((entry, i) => `${row.dependsOn[i]} "${entry?.title ?? "missing"}" (${entry?.state ?? "missing"})`).join(", ");
            delivery.send({ projectId: crew.projectId, from: { kind: "system" }, to: target.address, crew: crew.name,
              subject: `Work dependencies ${ready ? "fulfilled" : "failed"}: ${item.id}`,
              body: `Work item ${item.id} "${item.title}": ${ready ? "all dependencies are done" : "a dependency failed; this item remains blocked"}.\nDependencies: ${summary}` });
            store.saveWorkDependency({ ...row, satisfied: row.satisfied || ready, failedNotified: [...row.failedNotified, ...failed.map((entry) => entry!.id)], detail: null });
          });
          count++;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          store.saveWorkDependency({ ...row, detail });
          if (row.detail !== detail) store.insertChannel({ id: `cm_${randomBytes(4).toString("hex")}`, crewId: crew.id, author: "system", topic: "notify", body: `Could not queue dependency notice for ${item.id}: ${detail}. The next dependency poll will retry.` });
        }
      }
    }
    return count;
  }
  return { view, declare, poll };
}

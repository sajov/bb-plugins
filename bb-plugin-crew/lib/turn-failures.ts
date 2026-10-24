// Observe core's per-request failure facts; the normal delivery queue owns waking, holds and retries.
import { randomBytes } from "node:crypto";
import type { PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import type { Delivery } from "./delivery";
import type { Store } from "./store";

export function createTurnFailureReporter(deps: { store: Store; delivery: Delivery }) {
  const { store, delivery } = deps;
  const log = (crewId: string, body: string) => store.insertChannel({
    id: `cm_${randomBytes(8).toString("hex")}`, crewId, author: "system", topic: "notify", body,
  });

  return async (event: PluginTurnFailedEvent): Promise<void> => {
    const member = store.memberByThread(event.threadId);
    if (!member || member.lead) return;
    const crew = store.getCrew(member.crewId);
    if (!crew) return;
    // The request id exists even when the provider refused before creating a turn. Each failed retry has its own id.
    const key = `${crew.id}:turn-failed:${JSON.stringify([event.threadId, event.requestId])}`;
    if (store.getSetting(key) !== null) return;
    try {
      const claimed = store.listWork({ crewId: crew.id, owner: member.id, states: ["claimed"] });
      const info = event.errorInfo;
      const body = [
        `Member ${member.address} failed on thread ${event.threadId}.`,
        `Request: ${event.requestId}; turn: ${event.turnId ?? "not created"}; attempt: ${event.attemptNumber}.`,
        info ? `Failure: ${info.category}; provider code: ${info.providerCode ?? "unknown"}; HTTP status: ${info.httpStatusCode ?? "unknown"}.`
          : "Failure reason/code: unknown (BB supplied no structured error).",
        "Retry status is unknown: the failure event does not report whether a retry will be scheduled.",
        `Claimed work items: ${claimed.length ? claimed.map((item) => `${item.id} "${item.title}"`).join(", ") : "none"}.`,
      ].join("\n");
      const ids = store.atomically(() => {
        // The durable marker and outbox row must commit together so replays cannot enqueue twice.
        if (store.getSetting(key) !== null) return [];
        const lead = store.listMembers(crew.id).find((entry) => entry.lead);
        const messages = lead ? delivery.send({ projectId: crew.projectId, from: { kind: "system" },
          to: lead.address, subject: `Member turn failed: ${member.address}`, body, crew: crew.name }) : [];
        store.setSetting(key, messages[0]?.id ?? "channel-only");
        log(crew.id, `${body}\n${lead ? `Leader notice: ${messages.map((message) => message.id).join(", ")}.` : "No crew lead exists; recorded in the channel only."}`);
        return messages.map((message) => message.id);
      });
      if (ids.length === 0) return;
      await delivery.drain();
      for (const id of ids) {
        const message = store.getMessage(id);
        if (message && (message.lastError || ["failed", "rejected", "stopped_loop"].includes(message.status))) {
          log(crew.id, `Could not deliver member failure notice ${id} for request ${event.requestId}: ${message.lastError ?? message.reason ?? message.status}`);
        }
      }
    } catch (error) {
      // An observer never undoes the failed turn. An enqueue failure is durable and does not re-notify on a replay.
      store.atomically(() => {
        store.setSetting(key, store.getSetting(key) ?? "notification-failed");
        log(crew.id, `Could not report failed request ${event.requestId} on ${member.address}, thread ${event.threadId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  };
}

import Database from "better-sqlite3";
import { createFakeTasks } from "../lib/dependencies";
import type { GraphsRpc } from "../lib/graphs";
import { createFakeGit } from "../lib/integration";
import { createCrewService } from "../lib/service";
import { inlineExecution, serializeCrew, type CrewSpecInput } from "../lib/spec";
import { createStore, migrateInPlace } from "../lib/store";
import { createFakeThreadPort } from "../lib/thread-port";

export const PROJECT = "proj_1";

export function setup(options: { bbLimit?: number | null; graphsRpc?: GraphsRpc | null } = {}) {
  const db = new Database(":memory:");
  migrateInPlace(db);
  // A realistic epoch, so rendered timestamps look like dates. The store ticks
  // one millisecond per write to keep ordering strict; `advance` jumps ahead.
  let clock = Date.UTC(2026, 8, 30, 9, 0);
  let ids = 0;
  let messageIds = 0;
  const store = createStore(db, () => ++clock);
  const port = createFakeThreadPort();
  const git = createFakeGit();
  const tasks = createFakeTasks();
  let shortIds = 0;
  const service = createCrewService({
    store,
    port,
    git,
    tasks,
    graphsRpc: options.graphsRpc ?? null,
    bbLimit: async () => options.bbLimit ?? null,
    newId: () => `op_${++ids}`,
    newMessageId: (prefix) => `${prefix}_${++messageIds}`,
    newShortId: (prefix) => `${prefix}_${++shortIds}`,
    now: () => clock,
  });
  const advance = (ms: number) => {
    clock += ms;
  };
  return { db, store, port, service, advance, git, tasks };
}

/** Apply a crew and put every member thread into `status` (spawned threads start active). */
export async function running(
  service: ReturnType<typeof setup>["service"],
  port: ReturnType<typeof setup>["port"],
  yaml = trioYaml(),
  status = "idle",
) {
  const outcome = await service.apply(PROJECT, yaml);
  const threads: Record<string, string> = {};
  for (const result of outcome.results) {
    threads[result.key] = result.threadId!;
    port.threads.get(result.threadId!)!.status = status;
  }
  const members = Object.fromEntries(service.ctx.store.listMembers(outcome.crew.id).map((member) => [member.key, member]));
  const self = (key: string) => ({ kind: "member" as const, member: members[key]!, crew: service.ctx.store.getCrew(outcome.crew.id)! });
  return { crew: outcome.crew, threads, members, self };
}

/**
 * Test crews are written with a crew-level provider/model for brevity and
 * then inlined onto every member — the same rewrite stored files get.
 */
function autonomous(text: string): string {
  return inlineExecution(text) ?? text;
}

export function duoYaml(overrides: Partial<CrewSpecInput> = {}): string {
  return autonomous(serializeCrew({
    version: "1",
    name: "duo",
    provider: "claude-code",
    model: "claude-haiku-4-5-20251001",
    groups: [
      {
        id: "core",
        members: [
          { id: "lead", lead: true, role: "Leads duo." },
          { id: "dev", role: "Builds duo." },
        ],
      },
    ],
    ...overrides,
  }));
}

export function trioYaml(overrides: Partial<CrewSpecInput> = {}): string {
  const spec: CrewSpecInput = {
    version: "1",
    name: "trio",
    provider: "claude-code",
    model: "claude-haiku-4-5-20251001",
    kickoff: "Reply with OK and wait for instructions.",
    groups: [
      { id: "orch", members: [{ id: "lead", lead: true, role: "Plans." }] },
      {
        id: "dev",
        members: [
          { id: "impl", role: "Builds." },
          { id: "review", permissions: "ask", role: "Reviews." },
        ],
      },
    ],
    links: [
      { from: "orch-lead", to: "dev-impl", kind: "assigns_to" },
      { from: "orch-lead", to: "dev-review", kind: "assigns_to" },
    ],
    ...overrides,
  };
  return autonomous(serializeCrew(spec));
}

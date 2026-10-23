// `bb crew …` — argument parsing and text output. The server wires it to
// `bb.cli.register`; tests call `runCli` directly with a fake service.
import { formatMessageLine } from "./agent";
import { LIMIT_SETTING } from "./capacity";
import { formatChannelLine } from "./channel";
import { formatDirectory } from "./directory";
import { formatMerge } from "./integration";
import { formatPlan, formatProblems } from "./format";
import { formatWorkItem, type Actor } from "./queue";
import { AddressError } from "./delivery";
import { hasErrors, PERMISSIONS, TIERS, type Permission, type Tier } from "./spec";
import { DELETE_THREADS_MODES, DeleteRefused, type CrewService, type DeleteThreadsMode } from "./service";
import { MESSAGE_STATUSES, type CrewRow, type MessageRow, type MessageStatus } from "./store";
import type { MemberResult, MemberView } from "./sync";

export const CLI_COMMANDS = [
  { name: "list", summary: "List the crews of the project", usage: "bb crew list [--project <id|name>] [--json]" },
  { name: "show", summary: "Show a crew: file version, status, members", usage: "bb crew show <crew> [--against <crew|template|file.yaml>] [--json]" },
  { name: "plan", summary: "Preview what apply would do (read-only)", usage: "bb crew plan <crew|template|file.yaml> [--fresh <member>…] [--confirm-full] [--confirm-gates]" },
  {
    name: "apply",
    summary: "Create or reconcile the crew's threads",
    usage: "bb crew apply <crew|template|file.yaml> [--fresh <member>…] [--confirm-full] [--confirm-gates]",
  },
  { name: "stop", summary: "Stop running turns, optionally archive", usage: "bb crew stop <crew> [--archive]" },
  {
    name: "delete",
    summary: "Remove a stopped crew and all its data; threads are archived (default), deleted or kept",
    usage: "bb crew delete <crew> [--threads archive|delete|keep] [--force]",
  },
  { name: "ps", summary: "Members and their thread state", usage: "bb crew ps [<crew>] [--json]" },
  { name: "templates", summary: "List bundled crew templates", usage: "bb crew templates" },
  { name: "export", summary: "Print the stored crew file as YAML", usage: "bb crew export <crew> > crew.yaml" },
  {
    name: "send",
    summary: "Send a message as the human to a member (answers its open question)",
    usage: "bb crew send <member@crew|member> <text…> [--subject <s>] [--crew <crew>] [--urgent] [--reply-to <msg>]",
  },
  { name: "broadcast", summary: "Send a message as the human to a whole crew or group", usage: "bb crew broadcast <crew> [--group <g>] <text…> [--subject <s>]" },
  {
    name: "log",
    summary: "Every message: sent, held, stopped and rejected ones",
    usage: "bb crew log [--crew <crew>] [--chain <id>] [--cross-crew] [--status <status>] [--limit <n>] [--full]",
  },
  { name: "needs", summary: "Members that currently need you", usage: "bb crew needs" },
  { name: "whoami", summary: "The crew member this thread is (inside a member thread)", usage: "bb crew whoami" },
  { name: "release", summary: "Deliver a held or loop-stopped message anyway", usage: "bb crew release <msg>" },
  { name: "discard", summary: "Drop a held or loop-stopped message", usage: "bb crew discard <msg>" },
  { name: "stop-chain", summary: "Stop delivering anything more on a chain", usage: "bb crew stop-chain <chain>" },
  { name: "channel", summary: "Read the crew channel, or post to it as the human", usage: "bb crew channel <crew> [post <text…>] [--topic <t>] [--since <iso>]" },
  {
    name: "work",
    summary: "The crew's work queue",
    usage:
      "bb crew work list|create|claim|unclaim|handoff|done|fail … --crew <crew>  (create <title…> [--owner <m>] [--tier p0-p3] [--due <iso>] [--body <b>] [--task <KEY>]; claim <id> --as <m>; handoff <id> <to> [note…]; done <id> [note…]; fail <id> <reason…>; list [--all] [--json])",
  },
  { name: "merges", summary: "Merge requests of the project", usage: "bb crew merges [--all]" },
  { name: "approve", summary: "Merge a merge request into main", usage: "bb crew approve <mr>" },
  { name: "reject", summary: "Reject a merge request", usage: "bb crew reject <mr> [note…]" },
  { name: "directory", summary: "All crews: task, status, branch, lead, dependencies", usage: "bb crew directory" },
  { name: "deps", summary: "waitsFor dependencies and their state", usage: "bb crew deps [--crew <crew>]" },
  {
    name: "thread-limit",
    summary: "Show the thread limit; set a plugin-side limit (BB's own setting is never changed)",
    usage: "bb crew thread-limit [<n>|off]",
  },
  { name: "tick", summary: "Run the follow-up sweep and the dependency poll now", usage: "bb crew tick" },
  { name: "snapshot", summary: "Record bindings, open work, undelivered messages and the channel cursor", usage: "bb crew snapshot <crew> [--label <text>]" },
  { name: "snapshots", summary: "List a crew's snapshots", usage: "bb crew snapshots <crew>" },
  { name: "restore", summary: "Restore a snapshot's bindings, work and messages, then apply", usage: "bb crew restore <snapshot>" },
  { name: "reset", summary: "New shift: clear the context (same thread) or start a new thread", usage: "bb crew reset <member> --crew <crew> [--mode clear|new]" },
  {
    name: "handover",
    summary: "New shift with a brief: the old thread writes it, the new one gets it as a work item; messages are held meanwhile",
    usage: "bb crew handover <member> --crew <crew> [--brief <text>] [--cancel]",
  },
  {
    name: "add-member",
    summary: "Add a member to the crew file and apply",
    usage: "bb crew add-member <group>-<id> --crew <crew> [--role <r>] [--provider <p>] [--model <m>] [--permissions <p>] [--kickoff <k>] [--confirm-full] [--confirm-gates]",
  },
  { name: "remove-member", summary: "Remove a member from the crew file and apply; its thread is archived", usage: "bb crew remove-member <member> --crew <crew>" },
  {
    name: "attach",
    summary: "Bind an existing thread of the project to a member (no spawn, kickoff as a message); without arguments: list candidates",
    usage: "bb crew attach [<threadId> --as <member@crew>] [--replace]",
  },
  { name: "detach", summary: "Release a member's thread from the crew (the thread stays)", usage: "bb crew detach <member> --crew <crew>" },
  { name: "import", summary: "Store a crew.yaml (no threads touched) and show the plan", usage: "bb crew import <file.yaml>" },
] as const;

export const USAGE = ["Usage:", ...CLI_COMMANDS.map((command) => `  ${command.usage}`), "", "Options: --project <id|name> (default: the current thread's project)"].join("\n");

/** Stay well under PLUGIN_CLI_OUTPUT_MAX_BYTES; the tail is what gets cut. */
export const OUTPUT_LIMIT = 60_000;

export function bound(text: string, limit = OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… output truncated (${text.length - limit} more characters)`;
}

export type CliContext = { cwd?: string; projectId?: string; threadId?: string };
export type CliResult = { exitCode: number; stdout?: string; stderr?: string };

type Parsed = { positional: string[]; flags: Set<string>; project: string | null; fresh: string[]; values: Record<string, string> };

/** Options that take a value; every other `--x` is a boolean flag. */
const VALUE_OPTIONS = new Set([
  "--subject",
  "--crew",
  "--chain",
  "--status",
  "--limit",
  "--group",
  "--reply-to",
  "--topic",
  "--since",
  "--owner",
  "--tier",
  "--due",
  "--body",
  "--task",
  "--as",
  "--label",
  "--mode",
  "--brief",
  "--role",
  "--provider",
  "--model",
  "--permissions",
  "--kickoff",
  "--threads",
  "--against",
]);

export function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Set<string>();
  const fresh: string[] = [];
  const values: Record<string, string> = {};
  let project: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--project") project = argv[++i] ?? null;
    else if (VALUE_OPTIONS.has(arg)) {
      const value = argv[i + 1];
      if (value !== undefined) values[arg.slice(2)] = value;
      i += 1;
    }
    else if (arg === "--fresh") {
      // `--fresh a b` and `--fresh a --fresh b` both work.
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) fresh.push(argv[++i]!);
    } else if (arg.startsWith("--")) flags.add(arg);
    else positional.push(arg);
  }
  return { positional, flags, project, fresh, values };
}

/** The reads `--json` replaces the text of. On every other command the flag changes nothing. */
function readsJson(positional: readonly string[]): boolean {
  const [command, sub] = positional;
  return command === "list" || command === "show" || command === "ps" || (command === "work" && (sub === undefined || sub === "list"));
}

/** DRIFT: BB runs a declared member on another provider/model than the file names. */
function drifts(member: MemberView): boolean {
  return member.actualProvider !== null && (member.actualProvider !== member.provider || (member.actualModel !== null && member.actualModel !== member.model));
}

export function formatLog(rows: readonly MessageRow[], full: boolean, crewName: (id: string | null) => string | null): string[] {
  if (rows.length === 0) return ["No messages."];
  return rows.flatMap((row) => {
    const cross = row.fromCrew !== null && row.toCrew !== null && row.fromCrew !== row.toCrew;
    const head = `${formatMessageLine(row)} chain ${row.chainId}${row.deliveryMode ? ` via ${row.deliveryMode}` : ""}${cross ? ` CROSS-CREW ${crewName(row.fromCrew)} → ${crewName(row.toCrew)}` : ""}`;
    const extra = [
      row.reason ? `  reason: ${row.reason}` : "",
      row.lastError ? `  last error: ${row.lastError} (attempts ${row.attempts})` : "",
      row.toAddress === "human" && row.appendedTo === null
        ? `  ${row.kind === "info" ? "INFO (no answer expected)" : row.answeredAt === null ? "OPEN QUESTION" : "answered"}`
        : "",
      full ? row.body.split("\n").map((line) => `  | ${line}`).join("\n") : `  ${row.body.replace(/\s+/g, " ").slice(0, 160)}`,
    ];
    return [head, ...extra.filter(Boolean)];
  });
}

export { formatPlan, formatProblems } from "./format";

export function formatResults(results: readonly MemberResult[]): string[] {
  return results.map(
    (result) =>
      `  ${result.result.padEnd(10)} ${result.address.padEnd(28)} ${result.threadId ?? "-"}${
        result.shift !== null ? `  shift ${result.shift}` : ""
      }${result.detail ? `  (${result.detail})` : ""}`,
  );
}

export async function runCli(
  service: CrewService,
  argv: readonly string[],
  ctx: CliContext,
  resolveProject: (ref: string | null, ctx: CliContext) => Promise<string | null>,
): Promise<CliResult> {
  const ok = (lines: string | string[]) => ({
    exitCode: 0,
    stdout: `${bound(Array.isArray(lines) ? lines.join("\n") : lines)}\n`,
  });
  const args = parseArgs(argv);
  const [command, target] = args.positional;
  const asJson = args.flags.has("--json") && readsJson(args.positional);
  // BB's own envelope: a script parses stdout and checks `.ok`; the readable message stays on stderr.
  const fail = (text: string, code = "error") => ({
    exitCode: 1,
    ...(asJson ? { stdout: `${JSON.stringify({ ok: false, error: { code, message: text } })}\n` } : {}),
    stderr: `${bound(text)}\n`,
  });
  const okJson = (value: unknown) => {
    const text = JSON.stringify(value);
    // A cut-off document is worse than a refusal: bound() would append its note to the tail.
    if (text.length > OUTPUT_LIMIT) return fail(`The JSON is ${text.length} characters, over the ${OUTPUT_LIMIT} a command may print; narrow it (--crew, without --all).`, "output_too_large");
    return { exitCode: 0, stdout: `${text}\n` };
  };

  if (command === undefined || command === "help" || args.flags.has("--help")) return ok(USAGE);
  if (command === "templates") {
    return ok(service.templates().map((template) => `  ${template.id.padEnd(10)} ${template.summary}`));
  }
  if (!CLI_COMMANDS.some((entry) => entry.name === command)) return fail(`Unknown command "${command}".\n${USAGE}`);

  if (command === "whoami") {
    const self = ctx.threadId ? service.memberOfThread(ctx.threadId) : null;
    if (!self) return fail("This thread is not a crew member thread.");
    const binding = service.ctx.store.currentBinding(self.member.id);
    return ok([
      `${self.member.address}${self.member.lead ? "  lead" : ""}`,
      `  crew ${self.crew.name} (${self.crew.status}) · shift ${binding?.shift ?? "?"} · thread ${binding?.threadId ?? "-"}`,
      self.member.config.role ? `  role: ${String(self.member.config.role)}` : "",
    ].filter(Boolean));
  }

  const projectId = await resolveProject(args.project, ctx);
  if (!projectId) {
    // A named project that BB does not know must not read like "run this inside a thread".
    if (args.project) return fail(`No project "${args.project}" on this host: pass --project <id|name> of a project from bb project list.`, "project_not_found");
    return fail("No project: run inside a BB thread or pass --project <id|name>.", "no_project");
  }
  const crewName = (id: string | null) => (id ? (service.ctx.store.getCrew(id)?.name ?? id) : null);
  const sent = (rows: MessageRow[]) => {
    const lines = rows.map((row) => `  ${row.toAddress.padEnd(28)} ${row.status}${row.reason ? `  (${row.reason})` : ""}  msg ${row.id}`);
    const refused = rows.every((row) => ["rejected", "failed", "stopped_loop"].includes(row.status));
    return refused ? { exitCode: 1, stdout: `${bound(lines.join("\n"))}\n` } : ok(lines);
  };

  const human: Actor = { kind: "human" };
  const store = service.ctx.store;
  const addressOf = (id: string | null) => (id ? (store.getMember(id)?.address ?? id) : "nobody");
  /** `--crew`, or the only crew of the project. */
  const pickCrew = (name: string | undefined): CrewRow => {
    if (name) {
      const crew = service.findCrew(projectId, name);
      if (!crew) throw new Error(`No crew "${name}" in this project.`);
      return crew;
    }
    const crews = service.listCrews(projectId);
    if (crews.length === 1) return crews[0]!;
    throw new Error(crews.length === 0 ? "No crews in this project." : "Several crews: pass --crew <crew>.");
  };
  /** `dev-impl@trio` names its crew; a bare key leaves the choice to --crew or the only crew. */
  const crewOf = (address: string): string | undefined => (address.includes("@") ? address.slice(address.indexOf("@") + 1) : undefined);
  const time = (text: string | undefined): number | undefined => {
    if (text === undefined) return undefined;
    const value = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
    if (!Number.isFinite(value)) throw new Error(`"${text}" is not a time.`);
    return value;
  };

  try {
    switch (command) {
      case "channel": {
        const crew = pickCrew(target);
        const [, , sub, ...words] = args.positional;
        if (sub === "post") {
          if (words.length === 0) return fail("Usage: bb crew channel <crew> post <text…>");
          const { post, mentions } = service.channel.post(crew, { kind: "human" }, words.join(" "), args.values.topic ?? null);
          await service.flush();
          return ok([`posted ${post.id}`, ...mentions.map((row) => `  mention → ${row.toAddress}: ${store.getMessage(row.id)?.status}`)]);
        }
        if (sub !== undefined) return fail(`Usage: ${CLI_COMMANDS.find((c) => c.name === "channel")!.usage}`);
        const rows = service.channel.read(crew, { since: time(args.values.since), topic: args.values.topic });
        return ok(rows.length ? rows.map(formatChannelLine) : "The channel is empty.");
      }
      case "work": {
        const crew = pickCrew(args.values.crew);
        const [, sub, id, ...rest] = args.positional;
        const line = (item: Parameters<typeof formatWorkItem>[0]) => ok(formatWorkItem(item, addressOf));
        switch (sub) {
          case undefined:
          case "list": {
            const items = service.queue.list(crew, { all: args.flags.has("--all"), owner: args.values.owner });
            if (asJson) {
              return okJson(
                items.map((item) => ({
                  id: item.id,
                  crew: crew.name,
                  title: item.title,
                  state: item.state,
                  tier: item.tier,
                  owner: item.ownerMember ? addressOf(item.ownerMember) : null,
                  taskKey: item.taskKey,
                  dueAt: item.dueAt ? new Date(item.dueAt).toISOString() : null,
                  closureNote: item.closureNote,
                  stateSince: new Date(item.stateSince).toISOString(),
                  updatedAt: new Date(item.updatedAt).toISOString(),
                })),
              );
            }
            return ok(items.length ? items.map((item) => formatWorkItem(item, addressOf)) : "No work items.");
          }
          case "create": {
            const title = [id, ...rest].filter(Boolean).join(" ");
            const tier = args.values.tier;
            if (tier !== undefined && !(TIERS as readonly string[]).includes(tier)) return fail(`--tier must be one of ${TIERS.join(", ")}`);
            return line(
              service.queue.create(crew, human, {
                title,
                body: args.values.body,
                owner: args.values.owner ?? null,
                tier: tier as Tier | undefined,
                dueAt: time(args.values.due) ?? null,
                taskKey: args.values.task ?? null,
              }),
            );
          }
          case "claim":
            if (!id) return fail("Usage: bb crew work claim <id> --as <member>");
            return line(service.queue.claim(crew, human, id, args.values.as));
          case "unclaim":
            if (!id) return fail("Usage: bb crew work unclaim <id>");
            return line(service.queue.unclaim(crew, human, id));
          case "handoff": {
            const [to, ...note] = rest;
            if (!id || !to) return fail("Usage: bb crew work handoff <id> <to> [note…]");
            const item = await service.queue.handoff(crew, human, id, to, note.join(" "));
            await service.flush();
            return line(item);
          }
          case "done":
            if (!id) return fail("Usage: bb crew work done <id> [note…]");
            return line(await service.queue.done(crew, human, id, rest.join(" ")));
          case "fail":
            if (!id || rest.length === 0) return fail("Usage: bb crew work fail <id> <reason…>");
            return line(service.queue.fail(crew, human, id, rest.join(" ")));
          default:
            return fail(`Unknown work command "${sub}".`);
        }
      }
      case "merges": {
        const rows = store.listMerges({ projectId, states: args.flags.has("--all") ? undefined : ["open", "returned", "parked"] });
        return ok(rows.length ? rows.map((row) => formatMerge(row, (id) => crewName(id) ?? id)) : "No merge requests wait.");
      }
      case "approve":
      case "reject": {
        if (!target) return fail(`Usage: bb crew ${command} <mr>`);
        const merge = store.getMerge(target);
        if (!merge || merge.projectId !== projectId) return fail(`No merge request "${target}" in this project.`);
        const after =
          command === "approve" ? await service.integration.approve(target) : await service.integration.reject(target, args.positional.slice(2).join(" "));
        await service.flush();
        await service.activity.refreshAll(projectId);
        const text = formatMerge(after, (id) => crewName(id) ?? id);
        return command === "approve" && after.state !== "merged" ? { exitCode: 1, stdout: `${text}\n` } : ok(text);
      }
      case "directory":
        return ok(formatDirectory(service.directory(projectId)));
      case "deps": {
        const crews = args.values.crew ? [pickCrew(args.values.crew)] : service.listCrews(projectId);
        const lines = crews.flatMap((crew) =>
          store
            .listDependencies(crew.id)
            .map(
              (row) =>
                `  ${crew.name.padEnd(16)} waits for ${row.taskKey} until ${row.until}: ${row.state}${row.satisfiedAt ? ` at ${new Date(row.satisfiedAt).toISOString().slice(0, 16)}Z` : ""}${
                  row.labelState ? ` · label ${row.labelState}` : ""
                }${row.detail ? ` — ${row.detail}` : ""}`,
            ),
        );
        return ok(lines.length ? lines : "No dependencies.");
      }
      case "thread-limit": {
        if (target === "off") store.setSetting(LIMIT_SETTING, null);
        else if (target !== undefined) {
          const value = Number.parseInt(target, 10);
          if (!Number.isFinite(value) || value < 1 || String(value) !== target) return fail("Usage: bb crew thread-limit [<n>|off]");
          store.setSetting(LIMIT_SETTING, String(value));
        }
        const reading = await service.limit();
        const running = await service.ctx.port.runningCount().catch(() => null);
        return ok([
          reading.limit === null
            ? "Thread limit: not readable (bb concurrency-limit unavailable to the plugin); nothing is throttled."
            : `Thread limit: ${reading.limit} (${reading.source === "plugin" ? "plugin-side, set with bb crew thread-limit; BB's setting is unchanged" : "BB concurrency limit"})`,
          `Running threads: ${running ?? "?"}`,
        ]);
      }
      case "tick": {
        const fired = await service.followUps();
        const satisfied = await service.pollDependencies();
        return ok([
          ...fired.map((entry) => `  follow-up rung ${entry.rung} for ${entry.item} → ${entry.target}`),
          `${fired.length} follow-up(s), ${satisfied} dependenc${satisfied === 1 ? "y" : "ies"} fulfilled`,
        ]);
      }
      case "snapshot": {
        if (!target) return fail("Usage: bb crew snapshot <crew> [--label <text>]");
        const crew = pickCrew(target);
        const { id, data } = service.lifecycle.snapshot(crew, args.values.label ?? null);
        return ok([
          `snapshot ${id} of ${crew.name} (file v${data.fileVersion})`,
          `  ${data.bindings.length} binding(s), ${data.work.length} open work item(s), ${data.messages.length} undelivered message(s), channel at ${data.channel.lastId ?? "start"}`,
          `  restore with: bb crew restore ${id}`,
        ]);
      }
      case "snapshots": {
        const crew = pickCrew(target);
        const rows = store.listSnapshots(crew.id);
        return ok(
          rows.length
            ? rows.map((row) => {
                const data = JSON.parse(row.json) as { fileVersion: number; bindings: unknown[]; work: unknown[]; messages: unknown[] };
                return `  ${row.id}  ${new Date(row.createdAt).toISOString().slice(0, 16)}Z  file v${data.fileVersion}  ${data.bindings.length} bindings, ${data.work.length} work, ${data.messages.length} messages${row.label ? `  "${row.label}"` : ""}`;
              })
            : "No snapshots.",
        );
      }
      case "restore": {
        if (!target) return fail("Usage: bb crew restore <snapshot>");
        const snapshot = store.getSnapshot(target);
        if (!snapshot || store.getCrew(snapshot.crewId)?.projectId !== projectId) return fail(`No snapshot "${target}" in this project.`);
        const report = await service.lifecycle.restore(target);
        const lines = [
          `restored ${target}: ${report.outcome.crew.name} ${report.outcome.crew.status} (file v${report.outcome.crew.fileVersion})`,
          ...report.bindings.map((entry) => `  binding  ${entry.key.padEnd(20)} ${entry.threadId}  shift ${entry.shift}  ${entry.change}`),
          `  work: ${report.work.restored.length} restored${report.work.restored.length ? ` (${report.work.restored.join(", ")})` : ""}, ${report.work.kept.length} newer item(s) kept`,
          `  messages: ${report.messages.requeued.length} requeued, ${report.messages.reinserted.length} reinserted, ${report.messages.alreadyDelivered.length} already delivered (not sent again)`,
          ...formatResults(report.outcome.results),
        ];
        return report.outcome.results.some((result) => result.result === "failed") ? { exitCode: 1, stdout: `${bound(lines.join("\n"))}\n` } : ok(lines);
      }
      case "reset": {
        if (!target) return fail("Usage: bb crew reset <member> --crew <crew> [--mode clear|new]");
        const mode = args.values.mode ?? "clear";
        if (mode !== "clear" && mode !== "new") return fail("--mode must be clear or new");
        const crew = pickCrew(args.values.crew ?? crewOf(target));
        const result = await service.lifecycle.reset(crew, target, mode);
        return result.result === "failed" ? { exitCode: 1, stdout: `${formatResults([result]).join("\n")}\n` } : ok(formatResults([result]));
      }
      case "handover": {
        if (!target) return fail("Usage: bb crew handover <member> --crew <crew> [--brief <text>] [--cancel]");
        const crew = pickCrew(args.values.crew ?? crewOf(target));
        if (args.flags.has("--cancel")) {
          const row = service.lifecycle.cancelHandover(crew, target);
          await service.flush();
          return ok(`handover ${row.id} cancelled; held messages go to the current thread`);
        }
        const { handover, result } = await service.lifecycle.handover(crew, target, { brief: args.values.brief });
        if (result) {
          return ok([`handover ${handover.id}: ${handover.state}, brief as work item ${handover.itemId}`, ...formatResults([result])]);
        }
        return ok([
          `handover ${handover.id}: ${handover.state} — asked ${handover.oldThread} for a brief (crew_handover_note).`,
          "  Messages to the member are held; the new shift starts when the brief is noted and the old thread is idle.",
        ]);
      }
      case "add-member": {
        if (!target || !target.includes("-")) return fail(`Usage: ${CLI_COMMANDS.find((c) => c.name === "add-member")!.usage}`);
        const crew = pickCrew(args.values.crew);
        const cut = target.indexOf("-");
        const permissions = args.values.permissions;
        if (permissions !== undefined && !(PERMISSIONS as readonly string[]).includes(permissions)) return fail(`--permissions must be one of ${PERMISSIONS.join(", ")}`);
        const outcome = await service.lifecycle.addMember(
          crew,
          {
            group: target.slice(0, cut),
            id: target.slice(cut + 1),
            role: args.values.role,
            provider: args.values.provider,
            model: args.values.model,
            permissions: permissions as Permission | undefined,
            kickoff: args.values.kickoff,
          },
          { confirmFull: args.flags.has("--confirm-full"), confirmGates: args.flags.has("--confirm-gates") },
        );
        const lines = [`${outcome.crew.name}: ${outcome.crew.status} (file v${outcome.crew.fileVersion})`, ...formatProblems(outcome.validation.problems), ...formatResults(outcome.results)];
        return outcome.results.some((result) => result.result === "failed") ? { exitCode: 1, stdout: `${bound(lines.join("\n"))}\n` } : ok(lines);
      }
      case "remove-member": {
        if (!target) return fail("Usage: bb crew remove-member <member> --crew <crew>");
        const crew = pickCrew(args.values.crew ?? crewOf(target));
        const outcome = await service.lifecycle.removeMember(crew, target);
        return ok([`${outcome.crew.name}: ${outcome.crew.status} (file v${outcome.crew.fileVersion})`, ...formatResults(outcome.results)]);
      }
      case "attach": {
        if (!target) {
          const threads = await service.lifecycle.candidates(projectId);
          return ok(
            threads.length
              ? ["Unassigned threads of the project (attach with bb crew attach <threadId> --as <member@crew>):", ...threads.map((t) => `  ${t.id}  ${t.status.padEnd(8)} ${t.providerId.padEnd(12)} ${t.title ?? "(untitled)"}`)]
              : "No unassigned threads in this project.",
          );
        }
        const as = args.values.as;
        if (!as) return fail("Usage: bb crew attach <threadId> --as <member@crew> [--replace]");
        const crew = pickCrew(args.values.crew ?? crewOf(as));
        const result = await service.lifecycle.attach(crew, target, as, { replace: args.flags.has("--replace") });
        await service.flush();
        const kickoff = result.kickoff ? store.getMessage(result.kickoff.id) : null;
        return ok([
          `attached ${target} as ${result.address} (shift ${result.shift}); no new thread, no restart`,
          kickoff ? `  kickoff brief: msg ${kickoff.id} ${kickoff.status}${kickoff.deliveryMode ? ` via ${kickoff.deliveryMode}` : ""}` : "",
        ].filter(Boolean));
      }
      case "detach": {
        if (!target) return fail("Usage: bb crew detach <member> --crew <crew>");
        const crew = pickCrew(args.values.crew ?? crewOf(target));
        const { member, threadId } = await service.lifecycle.detach(crew, target);
        return ok(`${member.address} released ${threadId}; the thread stays, the next apply spawns a new one`);
      }
      case "import": {
        if (!target) return fail("Usage: bb crew import <file.yaml>");
        const file = await service.resolveFile(projectId, target.includes("/") || /\.ya?ml$/i.test(target) ? target : `./${target}`, ctx.cwd);
        const imported = await service.lifecycle.importFile(projectId, file.yaml);
        if (!imported.crew) return fail([`Not imported (${file.label}):`, ...formatProblems(imported.validation.problems)].join("\n"));
        return ok([
          `imported ${imported.crew.name}: file v${imported.crew.fileVersion}${imported.changed ? "" : " (unchanged, same file)"} — nothing applied yet`,
          ...formatProblems(imported.validation.problems),
          ...formatPlan(imported.items),
          imported.items.every((item) => item.action === "reuse") ? "  plan: no change" : `  run bb crew apply ${imported.crew.name} to carry it out`,
        ]);
      }
      case "send": {
        const [, to, ...words] = args.positional;
        if (!to || words.length === 0) return fail(`Usage: ${CLI_COMMANDS.find((c) => c.name === "send")!.usage}`);
        const rows = await service.send({
          projectId,
          from: { kind: "human" },
          to,
          body: words.join(" "),
          subject: args.values.subject,
          priority: args.flags.has("--urgent") ? "urgent" : "normal",
          crew: args.values.crew ?? null,
          replyTo: args.values["reply-to"] ?? null,
        });
        return sent(rows);
      }
      case "broadcast": {
        const [, crew, ...words] = args.positional;
        if (!crew || words.length === 0) return fail(`Usage: ${CLI_COMMANDS.find((c) => c.name === "broadcast")!.usage}`);
        const group = args.values.group;
        const rows = await service.send({
          projectId,
          from: { kind: "human" },
          to: group ? `@group:${group}@${crew}` : `@crew@${crew}`,
          body: words.join(" "),
          subject: args.values.subject,
        });
        return sent(rows);
      }
      case "log": {
        const status = args.values.status;
        if (status !== undefined && !(MESSAGE_STATUSES as readonly string[]).includes(status)) {
          return fail(`Unknown status "${status}". One of: ${MESSAGE_STATUSES.join(", ")}`);
        }
        const limit = args.values.limit ? Number.parseInt(args.values.limit, 10) : 100;
        const rows = service.log(projectId, {
          crew: args.values.crew,
          chainId: args.values.chain,
          crossCrew: args.flags.has("--cross-crew"),
          status: status as MessageStatus | undefined,
          limit: Number.isFinite(limit) ? limit : 100,
        });
        return ok(formatLog(rows, args.flags.has("--full"), crewName));
      }
      case "needs": {
        const views = await service.needs(projectId);
        if (views.length === 0) return ok("Nobody needs you right now.");
        return ok(
          views.flatMap((view) => [
            `  ${view.address.padEnd(28)} ${view.needsYou.join(", ")}  ${view.threadId ?? "-"}`,
            ...(view.question ? [`    ${view.question.replace(/\s+/g, " ").slice(0, 200)}`] : []),
          ]),
        );
      }
      case "release":
      case "discard": {
        if (!target) return fail(`Usage: bb crew ${command} <msg>`);
        const row = command === "release" ? service.delivery.release(target) : service.delivery.discard(target);
        if (command === "release") await service.delivery.drain();
        const after = service.ctx.store.getMessage(row.id)!;
        return ok(`  ${after.id} ${after.status}${after.reason ? `  (${after.reason})` : ""}`);
      }
      case "stop-chain": {
        if (!target) return fail("Usage: bb crew stop-chain <chain>");
        const rows = service.delivery.stopChain(target);
        return ok(`chain ${target} stopped; ${rows.length} undelivered message(s) will not be sent.`);
      }
      case "list": {
        const crews = service.listCrews(projectId);
        if (asJson) {
          return okJson(
            await Promise.all(
              crews.map(async (crew) => ({ name: crew.name, status: crew.status, fileVersion: crew.fileVersion, members: (await service.members(crew)).length })),
            ),
          );
        }
        if (crews.length === 0) return ok("No crews in this project. Start with: bb crew templates");
        const lines: string[] = [];
        for (const crew of crews) {
          const members = await service.members(crew);
          lines.push(`  ${crew.name.padEnd(20)} ${crew.status.padEnd(9)} v${crew.fileVersion}  ${members.length} members`);
        }
        return ok(lines);
      }
      case "show":
      case "ps": {
        const crews = target
          ? [service.findCrew(projectId, target)].filter((crew) => crew !== null)
          : command === "ps"
            ? service.listCrews(projectId)
            : [];
        if (!target && command === "show") return fail("Usage: bb crew show <crew>", "usage");
        // `ps --json` of a project without crews is an empty fleet, as `list --json` says; a named crew that is missing is still a refusal.
        if (crews.length === 0 && !(asJson && !target)) {
          return fail(target ? `No crew "${target}" in this project.` : "No crews in this project.", target ? "crew_not_found" : "no_crews");
        }
        const against = command === "show" && args.values.against ? await service.resolveFile(projectId, args.values.against, ctx.cwd) : null;
        if (asJson) {
          const views = [];
          for (const crew of crews) {
            views.push({
              name: crew.name,
              status: crew.status,
              fileVersion: crew.fileVersion,
              members: (await service.members(crew)).map((member) => {
                return {
                  key: member.key,
                  address: member.address,
                  lead: member.lead,
                  provider: member.provider,
                  model: member.model,
                  actualProvider: member.actualProvider,
                  actualModel: member.actualModel,
                  drift: drifts(member),
                  status: member.status,
                  thread: member.thread,
                  threadId: member.threadId,
                  shift: member.shift,
                };
              }),
              drift: against ? { against: against.label, text: await service.driftFrom(crew, against.yaml) } : null,
            });
          }
          return okJson(command === "show" ? views[0] : views);
        }
        const lines: string[] = [];
        for (const crew of crews) {
          lines.push(`${crew.name}  ${crew.status}  file v${crew.fileVersion}`);
          for (const member of await service.members(crew)) {
            lines.push(
              `  ${member.address.padEnd(28)} ${`${member.provider ?? "?"}/${member.model ?? "?"}`.padEnd(40)} ${(member.status ?? member.thread).padEnd(9)} ${
                member.thread === "archived" ? "archived " : ""
              }${member.threadId ?? "-"}${member.shift !== null ? `  shift ${member.shift}` : ""}${member.lead ? "  lead" : ""}${
                drifts(member)
                  ? `  DRIFT: BB reports ${member.actualProvider}/${member.actualModel ?? "?"}`
                  : member.actualProvider !== null
                    ? `  (BB: ${member.actualProvider}/${member.actualModel ?? "?"})`
                    : ""
              }`,
            );
          }
          if (against) lines.push(`  ${await service.driftFrom(crew, against.yaml)} (against ${against.label})`);
        }
        return ok(lines);
      }
      case "export": {
        if (!target) return fail("Usage: bb crew export <crew>");
        const crew = service.findCrew(projectId, target);
        const file = crew ? service.ctx.store.crewFile(crew.id) : null;
        if (!file) return fail(`No stored crew file for "${target}".`);
        return ok(file.yaml.trimEnd());
      }
      case "stop": {
        if (!target) return fail("Usage: bb crew stop <crew> [--archive]");
        const crew = service.findCrew(projectId, target);
        if (!crew) return fail(`No crew "${target}" in this project.`);
        const results = await service.stop(crew, { archive: args.flags.has("--archive") });
        return ok([
          `${crew.name}: stopped`,
          ...results.map(
            (result) =>
              `  ${result.key.padEnd(20)} ${result.threadId ?? "-"}  ${[
                result.stopped ? "stopped" : "",
                result.archived ? "archived" : "",
                result.error ? `error: ${result.error}` : "",
              ]
                .filter(Boolean)
                .join(", ") || "nothing to do"}`,
          ),
        ]);
      }
      case "delete": {
        if (!target) return fail("Usage: bb crew delete <crew> [--threads archive|delete|keep] [--force]");
        const mode = (args.values.threads ?? "archive") as DeleteThreadsMode;
        if (!DELETE_THREADS_MODES.includes(mode)) return fail(`--threads must be one of ${DELETE_THREADS_MODES.join(", ")}, not "${mode}".`);
        const crew = service.findCrew(projectId, target);
        if (!crew) return fail(`No crew "${target}" in this project.`);
        try {
          const result = await service.delete(crew, { threads: mode, force: args.flags.has("--force") });
          const removed = Object.entries(result.rows).filter(([, count]) => count > 0);
          return ok([
            `${result.crew}: deleted (threads: ${mode})`,
            ...result.warnings.map((line) => `  warning: ${line}`),
            ...result.threads.map(
              (entry) =>
                `  ${entry.key.padEnd(20)} ${entry.threadId}  shift ${entry.shift}${entry.retired ? " (retired)" : ""}  ${entry.outcome}${
                  entry.children > 0 ? ` (+${entry.children} sub-thread(s))` : ""
                }`,
            ),
            `  rows: ${removed.length > 0 ? removed.map(([table, count]) => `${table} ${count}`).join(", ") : "none"}`,
          ]);
        } catch (error) {
          if (error instanceof DeleteRefused) return fail(error.message);
          throw error;
        }
      }
      case "plan":
      case "apply": {
        if (!target) return fail(`Usage: bb crew ${command} <crew|template|file.yaml>`);
        const file = await service.resolveFile(projectId, target, ctx.cwd);
        const options = { fresh: args.fresh, confirmFull: args.flags.has("--confirm-full"), confirmGates: args.flags.has("--confirm-gates") };
        if (command === "plan") {
          const { validation, items, limit, behind, remote, drift } = await service.plan(projectId, file.yaml, options);
          const lines = [
            `Plan for ${validation.spec?.name ?? target} (${file.label})`,
            ...formatProblems(validation.problems),
            ...formatPlan(items),
            ...(limit ? [`  ${limit}`] : []),
            ...(behind !== null ? [`  Crew branch is ${behind} commit(s) behind ${validation.spec?.baseBranch ?? "main"}`] : []),
            ...remote.map((line) => `  ${line}`),
            ...(drift ? [`  ${drift}`] : []),
          ];
          return hasErrors(validation.problems) ? fail(lines.join("\n")) : ok(lines);
        }
        const outcome = await service.apply(projectId, file.yaml, options);
        const lines = [
          `${outcome.crew.name}: ${outcome.crew.status} (file v${outcome.crew.fileVersion}, ${file.label})`,
          ...formatProblems(outcome.validation.problems),
          ...formatResults(outcome.results),
          ...(outcome.limit ? [`  ${outcome.limit}`] : []),
          ...outcome.remote.map((line) => `  ${line}`),
        ];
        return outcome.results.some((result) => result.result === "failed") ? { exitCode: 1, stdout: `${bound(lines.join("\n"))}\n` } : ok(lines);
      }
    }
  } catch (error) {
    if (error instanceof AddressError) return fail(error.message);
    return fail(error instanceof Error ? error.message : String(error));
  }
  return fail(USAGE);
}

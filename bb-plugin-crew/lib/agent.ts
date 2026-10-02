// Agent side (§4.5): the crew_* tools and the per-thread configuration.
//
// Identity is never taken from thread metadata alone. Metadata can be written
// by any API client (d.ts:21356–21365, "treat values as untrusted"), so
// `configure` accepts a thread only when the metadata names a member whose
// *current* binding is this very thread, and the tools look the caller up by
// `ctx.threadId` in `member_bindings` without reading metadata at all.
import type { BbPluginApi, PluginAgentConfiguration, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { formatChannelLine } from "./channel";
import { AddressError, messagingRules, type Sender } from "./delivery";
import { directoryRefusal, formatDirectory } from "./directory";
import { formatMerge } from "./integration";
import type { CrewPolicy } from "./policy";
import { formatWorkItem, workRules } from "./queue";
import type { CrewService } from "./service";
import { buildInstructions, INSTRUCTION_LIMIT, isIntegrator, TIERS } from "./spec";
import { memberRowId, type CrewRow, type MemberRow, type MessageRow, type Store } from "./store";

export const TOOL_NAMES = ["crew_whoami", "crew_peers", "crew_send", "crew_broadcast", "crew_inbox"] as const;
/** E3 tools every member gets (§4.5). */
export const WORK_TOOL_NAMES = [
  "crew_channel_post",
  "crew_channel_read",
  "crew_work_create",
  "crew_work_claim",
  "crew_work_handoff",
  "crew_work_done",
  "crew_work_fail",
  "crew_work_list",
  "crew_rebase",
  "crew_handover_note",
] as const;
export const LEAD_TOOL_NAMES = ["crew_deliver"] as const;
/** §4.5: tools that change the team. Other members do not get them at all, and the tools re-check the lead at call time. */
export const LEAD_ADMIN_TOOL_NAMES = ["crew_add_member", "crew_remove_member", "crew_reset", "crew_status"] as const;
export const INTEGRATOR_TOOL_NAMES = ["crew_merges", "crew_merge"] as const;
/** BBP-30: only for members whose crew.yaml lists at least one graph. */
export const GRAPH_TOOL_NAME = "crew_graph_run";

/** The `graphs:` names crew.yaml gave this member (BBP-30), or none. */
export function memberGraphs(config: Record<string, unknown>): string[] {
  return Array.isArray(config.graphs) ? config.graphs.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Tools for one member: role decides; the tools re-check at call time, since a live session keeps its set. */
export function toolsFor(member: Pick<MemberRow, "lead" | "config">, policy: Pick<CrewPolicy, "crossCrew">): string[] {
  return [
    ...TOOL_NAMES,
    ...WORK_TOOL_NAMES,
    ...(member.lead ? [...LEAD_TOOL_NAMES, ...LEAD_ADMIN_TOOL_NAMES] : []),
    ...(directoryRefusal(member, policy.crossCrew) === null ? ["crew_directory"] : []),
    ...(isIntegrator(member.config) ? INTEGRATOR_TOOL_NAMES : []),
    ...(memberGraphs(member.config).length > 0 ? [GRAPH_TOOL_NAME] : []),
  ];
}


export const SKILL_NAME = "crew";
const TOOL_OUTPUT_LIMIT = 12_000;

type Member = Extract<Sender, { kind: "member" }>;

/** The member a thread belongs to, or null when the metadata does not match the DB. */
export function identifyMember(
  store: Store,
  metadata: { readonly [key: string]: unknown },
  threadId: string,
): Member | null {
  const { crewId, member, address } = metadata;
  if (typeof crewId !== "string" || typeof member !== "string") return null;
  const row = store.getMember(memberRowId(crewId, member));
  if (!row || row.removedAt !== null) return null;
  if (typeof address === "string" && address !== row.address) return null;
  const binding = store.currentBinding(row.id);
  if (!binding || binding.threadId !== threadId) return null;
  const crew = store.getCrew(row.crewId);
  return crew ? { kind: "member", member: row, crew } : null;
}

function resolved(service: CrewService, crew: CrewRow, member: MemberRow) {
  const model = service.models(crew);
  return { model, resolvedMember: model.members.find((entry) => entry.key === member.key) ?? null };
}

/**
 * The durable instruction handed to `agents.configure`: address, role, a
 * summary of the inherited instructions, and the messaging rules — always
 * within BB's 4096 characters (d.ts:21444). The summary is what gets cut; the
 * full text is one `crew_whoami` away.
 */
export function agentInstructions(service: CrewService, crew: CrewRow, member: MemberRow): string {
  const { model, resolvedMember } = resolved(service, crew, member);
  const role = String(member.config.role ?? "");
  const head = [
    `You are ${member.address}, ${member.lead ? "the lead" : "a member"} of the crew ${crew.name}.`,
    model.spec?.summary ? `Crew: ${model.spec.summary}` : "",
    role ? `Role: ${role}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const rules = `${messagingRules({ address: member.address, lead: member.lead }, model.policy)}\n\n${workRules(member.lead, isIntegrator(member.config))}`;
  const inherited = (resolvedMember?.instructions ?? []).join("\n\n");
  const skillsHint = (resolvedMember?.skills ?? []).length > 0 ? `Prefer these skills: ${resolvedMember!.skills.join(", ")}` : "";
  const room = INSTRUCTION_LIMIT - head.length - rules.length - skillsHint.length - 80;
  let summary = "";
  if (inherited && room > 40) {
    summary =
      inherited.length <= room
        ? `Instructions:\n${inherited}`
        : `Instructions (summary, full text via crew_whoami):\n${inherited.slice(0, room - 60).trimEnd()}…`;
  }
  const text = [head, summary, skillsHint, rules].filter(Boolean).join("\n\n");
  return text.length <= INSTRUCTION_LIMIT ? text : `${text.slice(0, INSTRUCTION_LIMIT - 1)}…`;
}

/** Tools for verified members only; the skill for every thread, since it also documents the CLI. */
export function configureFor(
  service: CrewService,
  context: { pluginMetadata: { readonly [key: string]: unknown }; thread: { id: string } },
): PluginAgentConfiguration {
  const member = identifyMember(service.ctx.store, context.pluginMetadata, context.thread.id);
  if (!member) return { tools: [], skills: [SKILL_NAME] };
  return {
    tools: toolsFor(member.member, service.models(member.crew).policy),
    skills: [SKILL_NAME],
    instructions: agentInstructions(service, member.crew, member.member),
  };
}

const bounded = (text: string) =>
  text.length <= TOOL_OUTPUT_LIMIT ? text : `${text.slice(0, TOOL_OUTPUT_LIMIT)}\n… truncated (${text.length - TOOL_OUTPUT_LIMIT} more characters)`;
const failure = (text: string): PluginAgentToolResult => ({ content: [{ type: "text", text: bounded(text) }], isError: true });
const NOT_A_MEMBER = "This thread is not bound to a crew member, so crew tools do not apply here.";

function outcome(rows: MessageRow[]): PluginAgentToolResult {
  const lines = rows.map(
    (row) => `${row.toAddress}: ${row.status}${row.kind === "info" ? " as info (no answer expected)" : ""}${row.reason ? ` — ${row.reason}` : ""} (msg ${row.id}, chain ${row.chainId}, step ${row.step})`,
  );
  const refused = rows.filter((row) => row.status === "rejected" || row.status === "stopped_loop" || row.status === "failed");
  if (refused.length === rows.length) return failure(`Not delivered:\n${lines.join("\n")}`);
  return bounded(lines.join("\n"));
}

export function formatMessageLine(row: MessageRow): string {
  return `${new Date(row.createdAt).toISOString().slice(0, 16)}Z ${row.id} ${row.fromAddress} → ${row.toAddress} [${row.status}]${row.kind === "info" ? " info" : ""} step ${row.step} "${row.subject}"`;
}

/**
 * Asks the human before a team change goes through (§4.6 `pendingInteraction`):
 * removing a member, or a new member with `full`. True = confirmed.
 */
export type Confirm = (threadId: string, request: { title: string; kind: "remove-member" | "full-permissions"; detail: string }) => Promise<boolean>;

const LEAD_ONLY = "Only the lead of the crew changes the team.";

export function registerAgentTools(bb: BbPluginApi, service: CrewService, options: { confirm?: Confirm } = {}): void {
  const store = service.ctx.store;
  const me = (threadId: string) => service.memberOfThread(threadId);
  const guard = async (run: () => Promise<PluginAgentToolResult>): Promise<PluginAgentToolResult> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AddressError) return failure(error.message);
      throw error;
    }
  };

  bb.agents.registerTool({
    name: "crew_whoami",
    description: "Your crew identity: address, crew, role, full inherited instructions and the messaging rules.",
    parameters: z.object({}),
    presentation: { label: { pending: "Checking crew identity", completed: "Checked crew identity" }, icon: { glyph: "Users" }, suppress: true },
    execute: async (_params, ctx) => {
      const self = me(ctx.threadId);
      if (!self) return failure(NOT_A_MEMBER);
      const { model, resolvedMember } = resolved(service, self.crew, self.member);
      const body = resolvedMember && model.spec ? buildInstructions(model.spec, resolvedMember) : `You are ${self.member.address}.`;
      const shift = store.currentBinding(self.member.id)?.shift ?? null;
      return bounded(
        [`Address: ${self.member.address}${self.member.lead ? " (lead)" : ""} · shift ${shift ?? "?"}`, body, messagingRules(self.member, model.policy)].join(
          "\n\n",
        ),
      );
    },
  });

  bb.agents.registerTool({
    name: "crew_peers",
    description: "The members of your crew with role, activity and links; for leads also the leads of other crews you may reach.",
    parameters: z.object({}),
    presentation: { label: { pending: "Listing crew peers", completed: "Listed crew peers" }, icon: { glyph: "Users" }, suppress: true },
    execute: async (_params, ctx) => {
      const self = me(ctx.threadId);
      if (!self) return failure(NOT_A_MEMBER);
      const views = new Map((await service.activity.views(self.crew)).map((view) => [view.memberRow, view]));
      const links = store.listLinks(self.crew.id);
      const lines = [`Crew ${self.crew.name}:`];
      for (const member of store.listMembers(self.crew.id)) {
        const view = views.get(member.id);
        const linked = links.filter((link) => link.from === member.key || link.to === member.key).map((link) => `${link.from} ${link.kind} ${link.to}`);
        lines.push(
          `- ${member.key}${member.lead ? " (lead)" : ""}${member.id === self.member.id ? " (you)" : ""} · ${view?.activity ?? "unknown"}${
            member.config.role ? ` · ${String(member.config.role)}` : ""
          }${linked.length ? ` · links: ${linked.join(", ")}` : ""}`,
        );
      }
      const policy = service.models(self.crew).policy;
      if (policy.crossCrew === "open" || (policy.crossCrew === "leads" && self.member.lead)) {
        const others = store.listCrews(self.crew.projectId).filter((crew) => crew.id !== self.crew.id);
        for (const crew of others) {
          const lead = store.listMembers(crew.id).find((member) => member.lead);
          if (lead) lines.push(`Other crew ${crew.name} (${crew.status}): lead ${lead.address}`);
        }
      }
      return bounded(lines.join("\n"));
    },
  });

  const sendParams = z.object({
    to: z.string().min(1).max(200).describe('member (dev-impl), member@crew, @group:<id>, @crew or "human"'),
    subject: z.string().max(200).optional(),
    body: z.string().min(1).max(20_000),
    priority: z.enum(["normal", "urgent"]).optional().describe("urgent steers a running turn; lead only"),
    reply_to: z.string().max(64).optional().describe("msg id from the header of the message you answer"),
    kind: z
      .enum(["info", "question"])
      .optional()
      .describe('to "human" only: info = status report, no answer expected; question (default) = you need an answer and wait on the human\'s list'),
  });
  bb.agents.registerTool({
    name: "crew_send",
    description:
      'Send a message to a crew member, a group, the whole crew or the human ("human"). Reply to a message with reply_to set to its msg id. To the human, use kind "info" for status reports and kind "question" only when you need an answer.',
    parameters: sendParams,
    presentation: { label: { pending: "Sending crew message", completed: "Sent crew message" }, icon: { glyph: "Send" } },
    execute: (params, ctx) =>
      guard(async () => {
        const self = me(ctx.threadId);
        if (!self) return failure(NOT_A_MEMBER);
        const rows = await service.send({
          projectId: self.crew.projectId,
          from: self,
          to: params.to,
          subject: params.subject,
          body: params.body,
          priority: params.priority,
          replyTo: params.reply_to ?? null,
          humanKind: params.kind,
        });
        return outcome(rows);
      }),
  });

  bb.agents.registerTool({
    name: "crew_broadcast",
    description: "Send one message to every member of your crew, or of one group. The copies share one chain.",
    parameters: z.object({
      subject: z.string().max(200).optional(),
      body: z.string().min(1).max(20_000),
      group: z.string().max(64).optional(),
    }),
    presentation: { label: { pending: "Broadcasting to the crew", completed: "Broadcast to the crew" }, icon: { glyph: "Megaphone" } },
    execute: (params, ctx) =>
      guard(async () => {
        const self = me(ctx.threadId);
        if (!self) return failure(NOT_A_MEMBER);
        const rows = await service.send({
          projectId: self.crew.projectId,
          from: self,
          to: params.group ? `@group:${params.group}` : "@crew",
          subject: params.subject,
          body: params.body,
        });
        return outcome(rows);
      }),
  });

  bb.agents.registerTool({
    name: "crew_inbox",
    description: "Recent messages sent to you, newest last, with id, sender, subject and status.",
    parameters: z.object({ limit: z.number().int().min(1).max(50).optional() }),
    presentation: { label: { pending: "Reading crew inbox", completed: "Read crew inbox" }, icon: { glyph: "Inbox" }, suppress: true },
    execute: async (params, ctx) => {
      const self = me(ctx.threadId);
      if (!self) return failure(NOT_A_MEMBER);
      const rows = store.listMessages({ toMember: self.member.id, limit: params.limit ?? 10 });
      if (rows.length === 0) return "No messages to you yet.";
      return bounded(rows.map((row) => `${formatMessageLine(row)}\n  ${row.body.replace(/\s+/g, " ").slice(0, 300)}`).join("\n"));
    },
  });


  const work = service.queue;
  const actor = (self: Member) => ({ kind: "member" as const, member: self.member });
  const withSelf = (run: (self: Member) => Promise<PluginAgentToolResult>) => (_params: unknown, ctx: { threadId: string }) =>
    guard(async () => {
      const self = me(ctx.threadId);
      return self ? run(self) : failure(NOT_A_MEMBER);
    });
  const addressOf = (id: string | null) => (id ? (store.getMember(id)?.address ?? id) : "nobody");
  const flushAfter = async <T,>(value: T): Promise<T> => {
    await service.flush();
    return value;
  };

  bb.agents.registerTool({
    name: "crew_channel_post",
    description: "Post to your crew's channel. Wakes nobody, except members you mention as @member-key.",
    parameters: z.object({ body: z.string().min(1).max(20_000), topic: z.string().max(80).optional() }),
    presentation: { label: { pending: "Posting to the crew channel", completed: "Posted to the crew channel" }, icon: { glyph: "MessagesSquare" } },
    execute: (params, ctx) =>
      withSelf(async (self) => {
        const { post, mentions } = service.channel.post(self.crew, self, params.body, params.topic ?? null);
        await flushAfter(null);
        return bounded(
          [`Posted ${post.id}.`, ...mentions.map((row) => `Mention → ${row.toAddress}: ${store.getMessage(row.id)?.status ?? row.status} (msg ${row.id})`)].join("\n"),
        );
      })(params, ctx),
  });

  bb.agents.registerTool({
    name: "crew_channel_read",
    description: "Read your crew's channel, oldest first. since: ISO time or epoch ms; topic filters by topic.",
    parameters: z.object({ since: z.string().max(40).optional(), topic: z.string().max(80).optional(), limit: z.number().int().min(1).max(100).optional() }),
    presentation: { label: { pending: "Reading the crew channel", completed: "Read the crew channel" }, icon: { glyph: "MessagesSquare" }, suppress: true },
    execute: (params, ctx) =>
      withSelf(async (self) => {
        const since = params.since ? (/^\d+$/.test(params.since) ? Number(params.since) : Date.parse(params.since)) : undefined;
        if (since !== undefined && !Number.isFinite(since)) return failure(`"${params.since}" is not a time.`);
        const rows = service.channel.read(self.crew, { since, topic: params.topic, limit: params.limit ?? 30 });
        return rows.length ? bounded(rows.map(formatChannelLine).join("\n")) : "The channel has nothing newer.";
      })(params, ctx),
  });

  bb.agents.registerTool({
    name: "crew_work_create",
    description: "Create a work item in your crew's queue. owner: member key (optional); tier p0 (urgent) … p3; due: ISO time.",
    parameters: z.object({
      title: z.string().min(1).max(200),
      body: z.string().max(20_000).optional(),
      owner: z.string().max(64).optional(),
      tier: z.enum(TIERS).optional(),
      due: z.string().max(40).optional(),
      task: z.string().max(40).optional().describe("BB task key this item refers to"),
    }),
    presentation: { label: { pending: "Creating work item", completed: "Created work item" }, icon: { glyph: "ListPlus" } },
    execute: (params, ctx) =>
      withSelf(async (self) => {
        const dueAt = params.due ? Date.parse(params.due) : null;
        if (params.due && !Number.isFinite(dueAt)) return failure(`"${params.due}" is not a time.`);
        const item = work.create(self.crew, actor(self), { title: params.title, body: params.body, owner: params.owner ?? null, tier: params.tier, dueAt, taskKey: params.task ?? null });
        if (item.ownerMember && item.ownerMember !== self.member.id) {
          await service.send({
            projectId: self.crew.projectId,
            from: self,
            to: addressOf(item.ownerMember),
            subject: `Work item ${item.id}: ${item.title}`,
            body: `New work item for you: ${item.title}\n${item.body}\nClaim it with crew_work_claim(id: "${item.id}").`,
          });
        }
        return formatWorkItem(item, addressOf);
      })(params, ctx),
  });

  bb.agents.registerTool({
    name: "crew_work_claim",
    description: "Claim a work item: you own it now, follow-ups stop while it is not overdue.",
    parameters: z.object({ id: z.string().min(1).max(64) }),
    presentation: { label: { pending: "Claiming work item", completed: "Claimed work item" }, icon: { glyph: "Hand" } },
    execute: (params, ctx) => withSelf(async (self) => formatWorkItem(work.claim(self.crew, actor(self), params.id), addressOf))(params, ctx),
  });

  bb.agents.registerTool({
    name: "crew_work_handoff",
    description: "Hand a work item to another member with a note; it waits for their claim.",
    parameters: z.object({ id: z.string().min(1).max(64), to: z.string().min(1).max(64), note: z.string().max(4000).default("") }),
    presentation: { label: { pending: "Handing off work item", completed: "Handed off work item" }, icon: { glyph: "ArrowRightLeft" } },
    execute: (params, ctx) =>
      withSelf(async (self) => formatWorkItem(await flushAfter(await work.handoff(self.crew, actor(self), params.id, params.to, params.note)), addressOf))(params, ctx),
  });

  bb.agents.registerTool({
    name: "crew_work_done",
    description: "Close a work item as done, with a closure note.",
    parameters: z.object({ id: z.string().min(1).max(64), note: z.string().max(4000).default("") }),
    presentation: { label: { pending: "Closing work item", completed: "Closed work item" }, icon: { glyph: "CircleCheck" } },
    execute: (params, ctx) => withSelf(async (self) => formatWorkItem(work.done(self.crew, actor(self), params.id, params.note), addressOf))(params, ctx),
  });

  bb.agents.registerTool({
    name: "crew_work_fail",
    description: "Close a work item as failed, with the reason.",
    parameters: z.object({ id: z.string().min(1).max(64), reason: z.string().min(1).max(4000) }),
    presentation: { label: { pending: "Failing work item", completed: "Failed work item" }, icon: { glyph: "CircleX" } },
    execute: (params, ctx) => withSelf(async (self) => formatWorkItem(work.fail(self.crew, actor(self), params.id, params.reason), addressOf))(params, ctx),
  });

  bb.agents.registerTool({
    name: "crew_work_list",
    description: "Open work items of your crew (mine: only yours; all: closed ones too).",
    parameters: z.object({ mine: z.boolean().optional(), all: z.boolean().optional() }),
    presentation: { label: { pending: "Listing work items", completed: "Listed work items" }, icon: { glyph: "ListTodo" }, suppress: true },
    execute: (params, ctx) =>
      withSelf(async (self) => {
        const items = work.list(self.crew, { all: params.all, owner: params.mine ? self.member.key : undefined });
        return items.length ? bounded(items.map((item) => formatWorkItem(item, addressOf)).join("\n")) : "No work items.";
      })(params, ctx),
  });

  bb.agents.registerTool({
    name: "crew_directory",
    description: "All crews of the project: task, status, branch, lead, open dependencies, merge request.",
    parameters: z.object({}),
    presentation: { label: { pending: "Reading the crew directory", completed: "Read the crew directory" }, icon: { glyph: "BookUser" }, suppress: true },
    execute: (params, ctx) =>
      withSelf(async (self) => {
        const refusal = directoryRefusal(self.member, service.models(self.crew).policy.crossCrew);
        if (refusal) return failure(refusal);
        return bounded(formatDirectory(service.directory(self.crew.projectId), self.crew.name).join("\n"));
      })(params, ctx),
  });

  bb.agents.registerTool({
    name: "crew_deliver",
    description: "Lead only: ask to merge your crew branch into main. The human (or the integrator, on green checks) merges.",
    parameters: z.object({}),
    presentation: { label: { pending: "Requesting merge", completed: "Requested merge" }, icon: { glyph: "GitPullRequest" } },
    execute: (params, ctx) =>
      withSelf(async (self) => {
        if (!self.member.lead) return failure("Only the lead delivers the crew branch.");
        const { merge, integrator, warnings } = await service.integration.request(self.crew, self.member.address);
        await service.flush();
        await service.activity.refreshCrew(self.crew);
        return bounded(
          [
            formatMerge(merge, (id) => store.getCrew(id)?.name ?? id),
            integrator ? `The integrator ${integrator.address} merges when checks are green.` : "The human merges it; you are on their list until then.",
            ...warnings.map((warning) => `Warning: ${warning}`),
          ].join("\n"),
        );
      })(params, ctx),
  });

  bb.agents.registerTool({
    name: "crew_merges",
    description: "Integrator: merge requests of the project that wait.",
    parameters: z.object({}),
    presentation: { label: { pending: "Listing merge requests", completed: "Listed merge requests" }, icon: { glyph: "GitMerge" }, suppress: true },
    execute: (params, ctx) =>
      withSelf(async (self) => {
        if (!isIntegrator(self.member.config)) return failure("Only the integrator lists merge requests.");
        const rows = store.listMerges({ projectId: self.crew.projectId, states: ["open", "returned"] });
        return rows.length ? bounded(rows.map((row) => formatMerge(row, (id) => store.getCrew(id)?.name ?? id)).join("\n")) : "No merge requests wait.";
      })(params, ctx),
  });

  bb.agents.registerTool({
    name: "crew_merge",
    description: "Integrator: run the crew's checks and merge the request into main if they are green; otherwise it goes back to the human.",
    parameters: z.object({ id: z.string().min(1).max(64) }),
    presentation: { label: { pending: "Merging", completed: "Merge attempted" }, icon: { glyph: "GitMerge" } },
    execute: (params, ctx) =>
      withSelf(async (self) => {
        const merge = await service.integration.integratorMerge(params.id, self.member);
        await service.flush();
        await service.activity.refreshAll(self.crew.projectId);
        const line = formatMerge(merge, (id) => store.getCrew(id)?.name ?? id);
        return merge.state === "merged" ? line : failure(`Not merged, back to the human: ${line}`);
      })(params, ctx),
  });

  bb.agents.registerTool({
    name: "crew_rebase",
    description: "Rebase your worktree's branch onto main. On conflict the rebase is aborted and you are put on the human's list.",
    parameters: z.object({}),
    presentation: { label: { pending: "Rebasing", completed: "Rebase attempted" }, icon: { glyph: "GitBranch" } },
    execute: (params, ctx) =>
      withSelf(async (self) => {
        const result = await service.integration.rebase(self.member);
        await service.activity.refreshMember(self.member);
        if (result.ok) return `Rebased onto ${result.base}; HEAD ${result.head.slice(0, 10)}.`;
        return failure(
          `Rebase onto ${result.base} failed${result.conflict ? " with conflicts" : ""}${result.files.length ? ` in ${result.files.join(", ")}` : ""}. The rebase was aborted; your branch is unchanged. Resolve it by hand (git rebase ${result.base}), then call crew_rebase again — until then the human sees you as merge-conflict.\n${result.detail}`,
        );
      })(params, ctx),
  });

  bb.agents.registerTool({
    name: "crew_handover_note",
    description:
      "Hand your shift over: pass a brief for your successor (state, open work, next steps). A new thread takes over your address once your turn ends; the brief reaches it as a work item. Messages to you are held meanwhile.",
    parameters: z.object({ brief: z.string().min(1).max(20_000) }),
    presentation: { label: { pending: "Writing handover brief", completed: "Handed over" }, icon: { glyph: "ArrowRightLeft" } },
    execute: (params, ctx) =>
      withSelf(async (self) => {
        const row = service.lifecycle.noteBrief(self.member, params.brief);
        return `Handover ${row.id} noted (shift ${row.oldShift} → ${row.oldShift + 1}). Finish this turn; the new shift starts when your thread is idle.`;
      })(params, ctx),
  });

  bb.agents.registerTool({
    name: GRAPH_TOOL_NAME,
    description: "Run one of this member's allowed graphs (crew.yaml's graphs:) to completion and return its result. Blocks until the run finishes, fails, is stopped, or times out.",
    parameters: z.object({ graph: z.string().min(1).max(64), input: z.string().min(1).max(8000) }),
    presentation: { label: { pending: "Running graph", completed: "Graph run finished" }, icon: { glyph: "Workflow" } },
    execute: (params, ctx) =>
      withSelf(async (self) => {
        const allowed = memberGraphs(self.member.config);
        if (!allowed.includes(params.graph)) {
          return failure(`"${params.graph}" is not one of this member's allowed graphs${allowed.length ? `: ${allowed.join(", ")}` : " (none are configured in crew.yaml)"}.`);
        }
        const role = self.member.config.role ? ` (${String(self.member.config.role)})` : "";
        const context = `Crew: ${self.crew.name}\nMember: ${self.member.key}${role}\n\n${params.input}`;
        try {
          const { run, timedOut } = await service.graphs.run({ graphId: params.graph, input: context, projectId: self.crew.projectId });
          if (timedOut) return failure(`Graph run ${run.id} timed out before it finished (still "${run.status}"); check it in Graph Studio.`);
          if (run.status === "failed") return failure(`Graph run ${run.id} failed: ${run.error ?? "unknown error"}`);
          if (run.status === "stopped") return failure(`Graph run ${run.id} was stopped.`);
          return bounded(`Graph run ${run.id} done.\n${JSON.stringify(run.state)}`);
        } catch (error) {
          return failure(`Could not run graph "${params.graph}": ${error instanceof Error ? error.message : String(error)}`);
        }
      })(params, ctx),
  });

  const leadOnly = (run: (self: Member) => Promise<PluginAgentToolResult>) =>
    withSelf(async (self) => (self.member.lead ? run(self) : failure(LEAD_ONLY)));
  const results = (lines: { result: string; address: string; threadId: string | null; shift: number | null; detail: string | null }[]) =>
    lines.map((line) => `${line.result} ${line.address} ${line.threadId ?? "-"}${line.shift !== null ? ` shift ${line.shift}` : ""}${line.detail ? ` (${line.detail})` : ""}`).join("\n");

  bb.agents.registerTool({
    name: "crew_add_member",
    description: "Lead only: add a member to your crew (the crew file changes, then apply spawns its thread). permissions full asks the human first.",
    parameters: z.object({
      group: z.string().min(1).max(64),
      id: z.string().min(1).max(64),
      role: z.string().max(2000).optional(),
      provider: z.string().max(80).optional(),
      model: z.string().max(120).optional(),
      permissions: z.enum(["ask", "accept-edits", "auto", "full"]).optional(),
      kickoff: z.string().max(4000).optional(),
    }),
    presentation: { label: { pending: "Adding crew member", completed: "Added crew member" }, icon: { glyph: "UserPlus" } },
    execute: (params, ctx) =>
      leadOnly(async (self) => {
        let confirmFull = false;
        if (params.permissions === "full") {
          if (!options.confirm) return failure("permissions: full needs the human's confirmation, which is not available here. Ask the human to run bb crew add-member … --confirm-full.");
          confirmFull = await options.confirm(ctx.threadId, {
            kind: "full-permissions",
            title: `Add ${params.group}-${params.id} with full permissions?`,
            detail: `${self.member.address} wants to add ${params.group}-${params.id}@${self.crew.name} with permissions: full (no approvals).`,
          });
          if (!confirmFull) return failure("The human declined permissions: full.");
        }
        const outcome = await service.lifecycle.addMember(self.crew, { ...params }, { confirmFull });
        return bounded(results(outcome.results));
      })(params, ctx),
  });

  bb.agents.registerTool({
    name: "crew_remove_member",
    description: "Lead only: remove a member from your crew. Asks the human first; the thread is archived, never deleted.",
    parameters: z.object({ member: z.string().min(1).max(64).describe("member key, e.g. dev-review") }),
    presentation: { label: { pending: "Removing crew member", completed: "Removed crew member" }, icon: { glyph: "UserMinus" } },
    execute: (params, ctx) =>
      leadOnly(async (self) => {
        if (!options.confirm) return failure("Removing a member needs the human's confirmation, which is not available here. Ask the human to run bb crew remove-member.");
        const confirmed = await options.confirm(ctx.threadId, {
          kind: "remove-member",
          title: `Remove ${params.member} from crew ${self.crew.name}?`,
          detail: `${self.member.address} wants to remove ${params.member}. Its thread is archived, not deleted.`,
        });
        if (!confirmed) return failure("The human declined the removal.");
        const outcome = await service.lifecycle.removeMember(self.crew, params.member);
        return bounded(results(outcome.results));
      })(params, ctx),
  });

  bb.agents.registerTool({
    name: "crew_reset",
    description: "Lead only: start a new shift for a member. mode clear: same thread, context cleared; new: a fresh thread, the old one archived.",
    parameters: z.object({ member: z.string().min(1).max(64), mode: z.enum(["clear", "new"]).default("clear") }),
    presentation: { label: { pending: "Resetting crew member", completed: "Reset crew member" }, icon: { glyph: "RotateCcw" } },
    execute: (params, ctx) =>
      leadOnly(async (self) => {
        if (params.member === self.member.key) return failure("A reset of yourself would end this turn; ask the human (bb crew reset) or hand over with crew_handover_note.");
        const result = await service.lifecycle.reset(self.crew, params.member, params.mode);
        return bounded(results([result]));
      })(params, ctx),
  });

  bb.agents.registerTool({
    name: "crew_status",
    description: "Lead only: every member of your crew with shift, activity, Needs you, open work, held messages and context usage.",
    parameters: z.object({}),
    presentation: { label: { pending: "Reading crew status", completed: "Read crew status" }, icon: { glyph: "Activity" }, suppress: true },
    execute: (params, ctx) =>
      leadOnly(async (self) => {
        const views = await service.activity.refreshCrew(self.crew);
        const lines = [`Crew ${self.crew.name}: ${self.crew.status}, file v${self.crew.fileVersion}`];
        for (const view of views) {
          const shift = store.currentBinding(view.memberRow)?.shift ?? null;
          const handover = store.activeHandover(view.memberRow);
          lines.push(
            `- ${view.key}${view.lead ? " (lead)" : ""} shift ${shift ?? "-"} · ${view.activity}${view.needsYou.length ? ` · Needs you: ${view.needsYou.join(", ")}` : ""} · work ${view.openWork} · held ${view.held}${
              view.context !== null ? ` · context ${Math.round(view.context * 100)}%` : ""
            }${view.diagnoses.length ? ` · ${view.diagnoses.join(", ")}` : ""}${handover ? ` · handover ${handover.state}` : ""}`,
          );
        }
        return bounded(lines.join("\n"));
      })(params, ctx),
  });

  bb.agents.configure((context) => configureFor(service, context));
}

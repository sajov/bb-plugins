// bb-plugin-crew — frontend entry.
//
// E1: the "Crews" nav panel with the crew list and a members table.
// E2: the "Table & Feed" tab (members with activity, Needs-you rows on top,
// the crew's message feed with chain view and human actions), a "N Needs you"
// counter in the panel header and the sidebar row, and row icons on member
// threads.
// E3: the project overview is the panel's entry (§3.9 "Oberfläche"): crew
// cards with task, status, branch, behind main, members and Needs you; lines
// for lead-to-lead messages and waitsFor; merge requests with approve/reject;
// the project feed with filters below. The crew view gains channel and work.
// E4 (§4.6): crew view header with crew dropdown, status, Needs you, "Open
// all" and a ⋯ menu (stop, snapshot, add member, attach, delete); tabs Topology,
// Table & Feed and Edit crew file; the member badge in the thread header, the
// `::crew` directive, palette commands and the confirmation form.
//
// Row icons: `experimental_setThreadRowStatus` exists only on the content
// script context (bb-plugin-sdk.d.ts:18879–18898), which has no RPC client
// and no realtime hook. The content script is the only surface mounted for as
// long as the app is open — the sidebar accessory is skipped on compact
// viewports and in the icon rail (d.ts:17641–17652), the panel only while it
// is open. So the content script fetches the row statuses itself over the
// plugin's RPC route (POST /api/v1/plugins/<id>/rpc/<method>, "local" auth,
// d.ts:21109–21117) on mount and on a short poll; mounted React surfaces
// still apply them at once on realtime changes. Rows fetched before the
// setter exists are kept and applied when it arrives.
import { useCallback, useEffect, useMemo, useState } from "react";
import { definePluginApp, experimental_ProviderModelPicker as ProviderModelPicker, useBbContext, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginComposerThreadRowStatus } from "@get-bb/plugin-sdk/app";
import type { ActivityDto, ChannelDto, CrewDto, MemberDto, MergeDto, MessageDto, OverviewDto, rpcContract, WorkDto } from "./server";
import { CrewFileEditor } from "./components/crew-file-editor";
import { CREW_ICON, CrewTeam } from "./components/crew-icon";
import { ConfirmInteraction, CREW_NAME, CrewDirectiveCard, MemberBadge } from "./components/crew-surfaces";
import { MemberCard, TopologyCanvas, TopologyLegend, type MemberAction } from "./components/crew-topology";
import { CommsStrip, MessageCard } from "./components/crew-comms";
import { CrewBoardCanvas, type BoardLine } from "./components/crew-board";
import { flowOf, messageFlows, RECENT_MS, recentFlowIds, timeline } from "./lib/comms";
import { activityLabel } from "./lib/topology";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const ACTIVITY_CHANNEL = "crew-activity";
const CREWS_CHANNEL = "crews-changed";

// ---------------------------------------------------------------------------
// Row status bridge

type RowSetter = (threadId: string, status: PluginComposerThreadRowStatus | null) => void;
type RowStatusRows = readonly { threadId: string; status: PluginComposerThreadRowStatus | null }[];
let rowSetter: RowSetter | null = null;
let pendingRows: RowStatusRows | null = null;
const applied = new Map<string, string>();

/** Apply the server's row statuses; clears rows that no longer have one. Returns false without a setter (the rows are kept for it). */
export function applyRowStatuses(rows: RowStatusRows): boolean {
  const setter = rowSetter;
  if (!setter) {
    pendingRows = rows;
    return false;
  }
  pendingRows = null;
  const wanted = new Map<string, PluginComposerThreadRowStatus>();
  for (const row of rows) if (row.status) wanted.set(row.threadId, row.status);
  for (const threadId of [...applied.keys()]) {
    if (!wanted.has(threadId)) {
      setter(threadId, null);
      applied.delete(threadId);
    }
  }
  for (const [threadId, status] of wanted) {
    const key = JSON.stringify(status);
    if (applied.get(threadId) === key) continue;
    setter(threadId, status);
    applied.set(threadId, key);
  }
  return true;
}

/** How often the content script re-reads the row statuses when no React surface is mounted to hear realtime. */
export const ROW_STATUS_POLL_MS = 5000;

/** The content script's own read of `rowStatuses` over the plugin RPC route; null on any failure. */
export async function fetchRowStatuses(pluginId: string, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<RowStatusRows | null> {
  try {
    const response = await fetcher(`/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/rowStatuses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { ok?: boolean; result?: { rows?: RowStatusRows } };
    return body.ok && Array.isArray(body.result?.rows) ? body.result.rows : null;
  } catch {
    return null;
  }
}

/** Row statuses and the Needs-you count, kept current over realtime. */
function useNeedsYou(): { count: number; byProject: Record<string, number> } {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{ count: number; byProject: Record<string, number> }>({ count: 0, byProject: {} });
  const refetch = useCallback(() => {
    rpc.call("rowStatuses", {}).then(
      (result) => {
        applyRowStatuses(result.rows);
        setState({ count: result.needsYou, byProject: result.byProject ?? {} });
      },
      () => undefined,
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(ACTIVITY_CHANNEL, refetch);
  useRealtime(CREWS_CHANNEL, refetch);
  return state;
}

export function NeedsYouBadge({ count, onClick, title }: { count: number; onClick?: () => void; title?: string }) {
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-0.5 text-xs text-red-400"
    >
      <span className="inline-block size-2 rounded-full bg-red-400" />
      {count} Needs you
    </button>
  );
}

function SidebarAccessory() {
  useRpcBridge();
  const { count } = useNeedsYou();
  if (count === 0) return null;
  return (
    <span aria-label={`${count} Needs you`} className="rounded-full bg-red-500/15 px-1.5 text-[10px] font-medium leading-4 text-red-400">
      {count}
    </span>
  );
}

function HeaderContent() {
  useRpcBridge();
  // Every project's crews: the panel below shows one project, so the badge says where the rest are.
  const { count } = useNeedsYou();
  return <NeedsYouBadge count={count} title="Members that need you, across all projects — the project switch shows them per project" />;
}

// ---------------------------------------------------------------------------
// Members table

const STATUS_TONE: Record<string, string> = {
  running: "bg-emerald-500",
  starting: "bg-sky-500",
  degraded: "bg-amber-500",
  stopped: "bg-muted-foreground",
};
const ACTIVITY_TONE: Record<string, string> = {
  working: "bg-amber-400",
  idle: "bg-muted-foreground",
  "needs-you": "bg-red-400",
  error: "bg-red-500",
  unknown: "bg-muted-foreground/40",
};

function Dot({ tone }: { tone: string }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", tone)} />;
}

function StatusDot({ status }: { status: string }) {
  return <Dot tone={STATUS_TONE[status] ?? "bg-muted-foreground"} />;
}

type Row = { member: MemberDto; activity: ActivityDto | null };

export function MembersTable({
  members,
  activity = [],
  onReply,
}: {
  members: MemberDto[];
  activity?: ActivityDto[];
  onReply?: (address: string) => void;
}) {
  if (members.length === 0) {
    return <p className="text-sm text-muted-foreground">No members yet. Run bb crew apply.</p>;
  }
  const byKey = new Map(activity.map((view) => [view.key, view]));
  const rows: Row[] = members.map((member) => ({ member, activity: byKey.get(member.key) ?? null }));
  // Needs you is a state of the member, shown where the member already is: on top, marked.
  rows.sort((a, b) => Number((b.activity?.needsYou.length ?? 0) > 0) - Number((a.activity?.needsYou.length ?? 0) > 0));
  return (
    // Scrolls inside its own box on a phone instead of pushing the whole panel sideways.
    // A table on a wide panel; on a phone each member is a block, label-free, one fact per line.
    <div className="-mx-1 overflow-x-auto px-1">
    <table className="w-full text-sm max-sm:block sm:min-w-[520px]">
      <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground max-sm:hidden">
        <tr>
          <th className="py-2 pr-3 font-medium">Address</th>
          <th className="py-2 pr-3 font-medium">Provider / model</th>
          <th className="py-2 pr-3 font-medium">Activity</th>
          <th className="py-2 pr-3 font-medium">Thread</th>
          <th className="py-2 font-medium">Shift</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border max-sm:block">
        {rows.map(({ member, activity: view }) => {
          const needs = (view?.needsYou.length ?? 0) > 0;
          return (
            <tr key={member.key} data-needs-you={needs ? "true" : undefined} className={cn("max-sm:block max-sm:py-2 [&>td]:max-sm:block [&>td]:max-sm:py-0.5", needs && "bg-red-500/5")}>
              <td className="py-2 pr-3 align-top font-mono text-xs">
                {member.address}
                {member.lead ? <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">lead</span> : null}
                {member.permissions === "full" ? (
                  <span className="ml-2 rounded bg-destructive/20 px-1.5 py-0.5 text-[10px] uppercase text-destructive">full</span>
                ) : null}
              </td>
              <td className="py-2 pr-3 align-top text-muted-foreground">
                {member.provider ?? "?"} / {member.model ?? "?"}
              </td>
              <td className="py-2 pr-3 align-top">
                {view ? (
                  <div className="flex flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-x-1.5">
                      <Dot tone={ACTIVITY_TONE[view.activity] ?? "bg-muted-foreground"} />
                      <span data-activity-label>{activityLabel({ ...view, needsYou: [] }, view.activity)}</span>
                      {needs ? <span className="text-xs text-red-400">Needs you: {view.needsYou.join(", ")}</span> : null}
                    </span>
                    {view.diagnoses.length > 0 ? <span className="text-xs text-amber-400">{view.diagnoses.join(" · ")}</span> : null}
                    {view.question ? (
                      <div className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs">
                        <p className="whitespace-pre-wrap">{view.question}</p>
                        {onReply ? (
                          <Button size="sm" variant="outline" className="mt-2 h-7" onClick={() => onReply(member.address)}>
                            Reply
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <span className="text-muted-foreground">–</span>
                )}
              </td>
              {/* The header row is hidden on a phone, so the bare values get their label there. */}
              <td className="py-2 pr-3 align-top">
                <span className="text-muted-foreground sm:hidden">Thread </span>
                {member.thread === "present" ? member.status : member.thread}
              </td>
              <td className="py-2 align-top">
                <span className="text-muted-foreground sm:hidden">Shift </span>
                {member.shift ?? "–"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feed

const MESSAGE_STATUSES = ["pending", "delivered", "queued", "on_hold", "throttled", "stopped_loop", "rejected", "failed"] as const;
const STATUS_TEXT: Record<string, string> = {
  delivered: "text-emerald-400",
  queued: "text-emerald-400",
  pending: "text-sky-400",
  on_hold: "text-amber-400",
  throttled: "text-amber-400",
  stopped_loop: "text-red-400",
  rejected: "text-red-400",
  failed: "text-red-400",
};
const HOLDABLE = new Set(["on_hold", "stopped_loop", "throttled"]);

/** A body as a one-paragraph preview: whitespace collapsed, cut long before two lines would end. */
export function preview(body: string, max = 240): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function time(ms: number) {
  return new Date(ms).toISOString().slice(11, 16);
}

export function MessageItem({
  message,
  onOpenChain,
  onReply,
  onAction,
  onStopChain,
  onSelect,
  selected = false,
}: {
  message: MessageDto;
  onOpenChain?: (chainId: string) => void;
  onReply?: (address: string, replyTo: string) => void;
  onAction?: (id: string, action: "release" | "discard") => void;
  onStopChain?: (chainId: string) => void;
  /** Picks the message on the canvas instead of opening its chain. */
  onSelect?: (id: string) => void;
  selected?: boolean;
}) {
  const replyTo = message.fromAddress === "human" || message.fromAddress === "system" ? null : message.fromAddress;
  return (
    <li data-message={message.id} aria-current={selected ? "true" : undefined} className={cn("border-b border-border py-2 last:border-b-0", selected && "-mx-2 rounded-md bg-primary/10 px-2")}>
      <button type="button" className="w-full text-left" onClick={() => (onSelect ? onSelect(message.id) : onOpenChain?.(message.chainId))}>
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span className="font-mono">{message.fromAddress}</span>→<span className="font-mono">{message.toAddress}</span>
          <span className={cn("font-medium", STATUS_TEXT[message.status])}>{message.status}</span>
          <span>step {message.step}</span>
          {message.crossCrew ? <span className="rounded bg-sky-500/15 px-1.5 text-[10px] uppercase text-sky-400">cross-crew</span> : null}
          {message.kind === "info" ? <span className="rounded bg-emerald-500/15 px-1.5 text-[10px] uppercase text-emerald-400">info</span> : null}
          {message.openQuestion ? <span className="rounded bg-red-500/15 px-1.5 text-[10px] uppercase text-red-400">open question</span> : null}
          <span className="ml-auto">{time(message.createdAt)}</span>
        </div>
        <div className="mt-0.5 text-sm">{message.subject}</div>
        {/* Flattened and cut here: Safari keeps the full height of a pre-wrapped body under line-clamp, which left a screen of empty space per message. */}
        <div className="line-clamp-2 max-h-8 overflow-hidden break-words text-xs leading-4 text-muted-foreground">{preview(message.body)}</div>
        {message.reason ? <div className="text-xs text-amber-400">{message.reason}</div> : null}
      </button>
      <div className="mt-1 flex gap-1.5">
        {replyTo && onReply ? (
          <Button size="sm" variant="ghost" className="h-7" onClick={() => onReply(replyTo, message.id)}>
            Reply
          </Button>
        ) : null}
        {HOLDABLE.has(message.status) && onAction ? (
          <Button size="sm" variant="ghost" className="h-7" onClick={() => onAction(message.id, "release")}>
            Release
          </Button>
        ) : null}
        {(HOLDABLE.has(message.status) || message.status === "pending") && onAction ? (
          <Button size="sm" variant="ghost" className="h-7" onClick={() => onAction(message.id, "discard")}>
            Discard
          </Button>
        ) : null}
        {onStopChain && message.status !== "rejected" ? (
          <Button size="sm" variant="ghost" className="h-7" onClick={() => onStopChain(message.chainId)}>
            Stop chain
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function ReplyBox({
  to,
  onSend,
  onCancel,
}: {
  to: string;
  onSend: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="mb-3 rounded-lg border border-border bg-background p-3">
      <div className="mb-2 text-xs text-muted-foreground">
        Reply as human to <span className="font-mono">{to}</span>
      </div>
      <textarea
        aria-label="Reply text"
        className="h-20 w-full resize-y rounded-md border border-input bg-transparent p-2 text-sm"
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          disabled={busy || body.trim() === ""}
          onClick={async () => {
            setBusy(true);
            try {
              await onSend(body);
              setBody("");
            } finally {
              setBusy(false);
            }
          }}
        >
          Send
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function TableAndFeed({ crew, members }: { crew: CrewDto; members: MemberDto[] }) {
  const rpc = useRpc<typeof rpcContract>();
  const [activity, setActivity] = useState<ActivityDto[]>([]);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [chain, setChain] = useState<MessageDto[] | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [reply, setReply] = useState<{ to: string; replyTo: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
    rpc.call("getActivity", { projectId: crew.projectId, name: crew.name }).then((r) => setActivity(r.members), fail);
    rpc
      .call("listMessages", {
        projectId: crew.projectId,
        crew: crew.name,
        crossCrew: false,
        limit: 200,
        ...(status ? { status: status as MessageDto["status"] } : {}),
      })
      .then((r) => setMessages(r.messages), fail);
    if (chainId) rpc.call("listMessages", { projectId: crew.projectId, chainId, crossCrew: false, limit: 200 }).then((r) => setChain(r.messages), fail);
  }, [rpc, crew.projectId, crew.name, status, chainId]);
  useEffect(refetch, [refetch]);
  useRealtime(ACTIVITY_CHANNEL, refetch);

  const act = async (run: () => Promise<{ error?: string | null } | unknown>) => {
    try {
      const result = (await run()) as { error?: string | null } | undefined;
      setError(result && typeof result === "object" && "error" in result ? (result.error ?? null) : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    refetch();
  };
  const handlers = {
    onOpenChain: (id: string) => setChainId(id === chainId ? null : id),
    onReply: (to: string, replyTo: string) => setReply({ to, replyTo }),
    onAction: (id: string, action: "release" | "discard") => act(() => rpc.call("messageAction", { id, action })),
    onStopChain: (id: string) => act(() => rpc.call("stopChain", { chainId: id })),
  };
  const newestFirst = useMemo(() => [...messages].reverse(), [messages]);

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <section className="rounded-xl border border-[#1f1f22] bg-[#0b0b0c] p-4">
        <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Members</h4>
        <MembersTable members={members} activity={activity} onReply={(to) => setReply({ to, replyTo: null })} />
      </section>
      <WorkSection crew={crew} />
      <ChannelSection crew={crew} />
      <section className="rounded-xl border border-[#1f1f22] bg-[#0b0b0c] p-4">
        <header className="mb-2 flex items-center gap-3">
          <h4 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Feed</h4>
          <span className="flex-1" />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Status
            <select
              aria-label="Filter by status"
              className="rounded-md border border-input bg-transparent px-2 py-1 text-xs"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">all</option>
              {MESSAGE_STATUSES.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
        </header>
        {reply ? (
          <ReplyBox
            to={reply.to}
            onCancel={() => setReply(null)}
            onSend={async (body) => {
              await act(() => rpc.call("sendMessage", { projectId: crew.projectId, to: reply.to, body, crew: crew.name, replyTo: reply.replyTo }));
              setReply(null);
            }}
          />
        ) : null}
        {chainId && chain ? (
          <div className="mb-3 rounded-lg border border-border bg-background p-3" aria-label="Chain">
            <div className="mb-1 flex items-center text-xs text-muted-foreground">
              Chain <span className="ml-1 font-mono">{chainId}</span>
              <span className="flex-1" />
              <Button size="sm" variant="ghost" className="h-7" onClick={() => setChainId(null)}>
                Close
              </Button>
            </div>
            <ol>
              {chain.map((message) => (
                <MessageItem key={message.id} message={message} {...handlers} />
              ))}
            </ol>
          </div>
        ) : null}
        {newestFirst.length === 0 ? (
          <p className="text-sm text-muted-foreground">No messages{status ? ` with status ${status}` : ""}.</p>
        ) : (
          <ul aria-label="Feed">
            {newestFirst.map((message) => (
              <MessageItem key={message.id} message={message} {...handlers} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Project overview (§3.9 "Oberfläche", §4.6)

type OverviewCard = OverviewDto["crews"][number];

/** The crew part of an address (`key@crew`), or null for human and system. */
function crewOfAddress(address: string): string | null {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1) : null;
}

/** Members named on an overview card; the rest are counted. */
const MEMBERS_ON_CARD = 3;

export function CrewCard({
  card,
  onOpen,
  onMerge,
}: {
  card: OverviewCard;
  onOpen?: (name: string) => void;
  onMerge?: (id: string, action: "approve" | "reject") => void;
}) {
  const waiting = card.merge && (card.merge.state === "open" || card.merge.state === "returned");
  const needs = card.needsYou > 0;
  return (
    // Graph Studio's card: a kind line with the status on the right, the name, then the facts.
    <div
      data-crew-card={card.name}
      className={cn("flex h-full flex-col gap-1 overflow-hidden rounded-[10px] px-3 py-2 text-xs shadow-sm transition-colors", card.status === "stopped" && "opacity-70")}
      style={{
        background: needs ? "color-mix(in oklab, var(--destructive) 10%, var(--card))" : "var(--card)",
        border: `1.5px solid ${needs ? "var(--destructive)" : card.status === "running" ? "color-mix(in oklab, var(--primary) 55%, var(--border))" : "var(--border)"}`,
      }}
    >
      <div className="flex items-center justify-between gap-2 text-[9px] uppercase tracking-[0.06em] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <StatusDot status={card.status} />
          crew · {card.status}
          {card.status === "stopped" ? <span data-card-status="stopped" className="sr-only">stopped</span> : null}
        </span>
        {needs ? <span className="normal-case tracking-normal text-[10px] text-[var(--destructive)]">{card.needsYou} Needs you</span> : null}
      </div>
      <button type="button" className="nodrag nopan truncate text-left text-sm font-medium text-foreground" onClick={(event) => (event.stopPropagation(), onOpen?.(card.name))}>
        {card.name}
      </button>
      <div className="truncate text-[10px] text-muted-foreground">
        {card.task ? <span className="mr-1 rounded-[4px] bg-muted px-1 font-mono text-foreground">{card.task}</span> : "no task · "}
        <span className="font-mono">⎇ {card.branch ?? "–"}</span>
        {card.behind !== null ? ` · ${card.behind} behind main` : ""}
        {card.merge ? ` · MR ${card.merge.state}` : ""}
      </div>
      {/* One line, never more: wrapping pushed the name and branch out of the fixed-height card. */}
      <div className="flex gap-x-2 overflow-hidden whitespace-nowrap text-[10px] text-muted-foreground">
        {card.members.slice(0, MEMBERS_ON_CARD).map((member) => (
          <span key={member.key} className="flex items-center gap-1" title={member.needsYou.length ? `Needs you: ${member.needsYou.join(", ")}` : member.activity}>
            <Dot tone={member.needsYou.length ? "bg-red-400" : (ACTIVITY_TONE[member.activity] ?? "bg-muted-foreground")} />
            {member.key}
          </span>
        ))}
        {card.members.length > MEMBERS_ON_CARD ? <span data-more-members>+{card.members.length - MEMBERS_ON_CARD}</span> : null}
      </div>
      {waiting && card.merge && onMerge ? (
        <div className="mt-auto flex items-center gap-1.5">
          <span className="truncate text-amber-400" title={card.merge.reason ?? ""}>
            {card.merge.id}
            {card.merge.reason ? ` · ${card.merge.reason}` : ""}
          </span>
          <span className="flex-1" />
          <Button size="sm" variant="outline" className="nodrag nopan h-6 px-2" onClick={(event) => (event.stopPropagation(), onMerge(card.merge!.id, "approve"))}>
            Merge
          </Button>
          <Button size="sm" variant="ghost" className="nodrag nopan h-6 px-2" onClick={(event) => (event.stopPropagation(), onMerge(card.merge!.id, "reject"))}>
            Reject
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Board lines: lead talk (live while a cross-crew message between the two is recent) and waitsFor. */
export function boardLines(overview: OverviewDto, messages: readonly MessageDto[], now: number): BoardLine[] {
  const talking = new Set(
    messages
      .filter((message) => message.crossCrew && now - message.createdAt <= RECENT_MS)
      .map((message) => [crewOfAddress(message.fromAddress), crewOfAddress(message.toAddress)].sort().join("|")),
  );
  return [
    ...overview.leadLinks.map((link) => ({
      kind: "lead" as const,
      from: link.from,
      to: link.to,
      label: `lead ↔ lead · ${link.count}`,
      live: talking.has([link.from, link.to].sort().join("|")),
    })),
    ...overview.dependencies
      .filter((dep) => dep.source !== null)
      .map((dep) => ({ kind: "wait" as const, from: dep.crew, to: dep.source!, label: `waits for ${dep.task} · until ${dep.until} · ${dep.state}`, live: false })),
  ];
}

export function ProjectBoard({
  overview,
  messages = [],
  onOpen,
  onMerge,
}: {
  overview: OverviewDto;
  messages?: readonly MessageDto[];
  onOpen?: (name: string) => void;
  onMerge?: (id: string, action: "approve" | "reject") => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const lines = useMemo(() => boardLines(overview, messages, now), [overview, messages, now]);
  const byName = useMemo(() => new Map(overview.crews.map((card) => [card.name, card])), [overview]);
  const names = useMemo(() => overview.crews.map((card) => card.name), [overview]);
  const renderCard = useCallback(
    (name: string) => {
      const card = byName.get(name);
      return card ? <CrewCard card={card} onOpen={onOpen} onMerge={onMerge} /> : null;
    },
    [byName, onOpen, onMerge],
  );
  return (
    <div>
      <CrewBoardCanvas names={names} lines={lines} renderCard={renderCard} onOpen={onOpen} />
      {/* The same connections as text: for screen readers, and readable without zooming. */}
      {lines.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-0.5 text-xs text-muted-foreground" aria-label="Connections">
          {lines.map((line, i) => (
            <li key={i} data-line={line.kind} data-live={line.live ? "true" : undefined} className="flex items-center gap-1.5">
              <Icon name={line.kind === "lead" ? "ArrowLeftRight" : "Hourglass"} className={cn("size-3", line.kind === "lead" ? "text-sky-400" : "text-amber-400")} />
              {line.from} → {line.to}: {line.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ProjectOverview({ projectId, crews, onOpen }: { projectId: string; crews: CrewDto[]; onOpen: (name: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [overview, setOverview] = useState<OverviewDto | null>(null);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [crewFilter, setCrewFilter] = useState("");
  const [status, setStatus] = useState("");
  const [crossOnly, setCrossOnly] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
    rpc.call("projectOverview", { projectId }).then(setOverview, fail);
    rpc
      .call("listMessages", {
        projectId,
        crossCrew: crossOnly,
        limit: 200,
        ...(crewFilter ? { crew: crewFilter } : {}),
        ...(status ? { status: status as MessageDto["status"] } : {}),
      })
      .then((r) => setMessages(r.messages), fail);
  }, [rpc, projectId, crewFilter, status, crossOnly]);
  useEffect(refetch, [refetch]);
  useRealtime(ACTIVITY_CHANNEL, refetch);
  useRealtime(CREWS_CHANNEL, refetch);
  const onMerge = async (id: string, action: "approve" | "reject") => {
    try {
      const result = await rpc.call("mergeAction", { id, action, note: "" });
      setError(result.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    refetch();
  };
  const threads = overview?.threads;
  const stoppedCount = crews.filter((entry) => entry.status === "stopped").length;
  const over = threads && threads.limit !== null && threads.members > threads.limit;
  return (
    <div className="flex flex-col gap-4" aria-label="Project overview">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <header className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="text-sm font-semibold text-foreground">Project overview</span>
        <span data-crew-count={crews.length}>
          {crews.length} crews
          {stoppedCount > 0 ? ` · ${stoppedCount} stopped` : ""}
        </span>
        {threads ? (
          <span className={cn(over && "text-amber-400")} data-thread-limit={over ? "over" : "ok"}>
            Threads {threads.running ?? "?"} running · {threads.members} members in crews ·{" "}
            {threads.limit === null ? "limit not readable" : `limit ${threads.limit}${threads.source === "plugin" ? " (plugin)" : ""}`}
          </span>
        ) : null}
      </header>
      {overview ? <ProjectBoard overview={overview} messages={messages} onOpen={onOpen} onMerge={onMerge} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
      <section className="rounded-xl border border-[#1f1f22] bg-[#0b0b0c] p-4">
        <header className="mb-2 flex flex-wrap items-center gap-3">
          {/* Between crews, through their leads; each crew's own talk lives in its crew view. */}
          <h4 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{crossOnly ? "Lead communication" : "Project feed"}</h4>
          <span className="text-[11px] text-muted-foreground">{crossOnly ? "between crews · open a crew for its own talk" : "all messages of the project"}</span>
          <span className="flex-1" />
          <select aria-label="Filter by crew" className="rounded-md border border-input bg-transparent px-2 py-1 text-xs" value={crewFilter} onChange={(e) => setCrewFilter(e.target.value)}>
            <option value="">all crews</option>
            {crews.map((crew) => (
              <option key={crew.id} value={crew.name}>
                {crew.name}
              </option>
            ))}
          </select>
          <select aria-label="Filter by status" className="rounded-md border border-input bg-transparent px-2 py-1 text-xs" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">all states</option>
            {MESSAGE_STATUSES.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <input type="checkbox" aria-label="Cross-crew only" checked={crossOnly} onChange={(e) => setCrossOnly(e.target.checked)} />
            cross-crew only
          </label>
        </header>
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No messages.</p>
        ) : (
          <ul aria-label="Project feed">
            {[...messages].reverse().map((message) => (
              <MessageItem key={message.id} message={message} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channel and work items (crew view)

export function ChannelSection({ crew }: { crew: CrewDto }) {
  const rpc = useRpc<typeof rpcContract>();
  const [posts, setPosts] = useState<ChannelDto[]>([]);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("listChannel", { projectId: crew.projectId, name: crew.name, limit: 200 }).then(
      (r) => setPosts(r.posts),
      (cause: unknown) => setError(String(cause)),
    );
  }, [rpc, crew.projectId, crew.name]);
  useEffect(refetch, [refetch]);
  useRealtime(ACTIVITY_CHANNEL, refetch);
  return (
    <section className="rounded-xl border border-[#1f1f22] bg-[#0b0b0c] p-4">
      <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Channel</h4>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {posts.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing in the channel yet.</p>
      ) : (
        <ul aria-label="Channel" className="mb-2 flex flex-col gap-1 text-sm">
          {posts.map((post) => (
            <li key={post.id}>
              <span className="text-xs text-muted-foreground">
                {time(post.createdAt)} <span className="font-mono">{post.author}</span>
                {post.topic ? <span className="ml-1 rounded bg-muted px-1 text-[10px]">{post.topic}</span> : null}
              </span>{" "}
              <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{post.body}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          aria-label="Channel post"
          className="flex-1 rounded-md border border-input bg-transparent px-2 py-1 text-sm"
          placeholder="Post as the human; @member-key wakes that member"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <Button
          size="sm"
          disabled={body.trim() === ""}
          onClick={async () => {
            const result = await rpc.call("postChannel", { projectId: crew.projectId, name: crew.name, body, topic: null });
            setError(result.error);
            if (!result.error) setBody("");
            refetch();
          }}
        >
          Post
        </Button>
      </div>
    </section>
  );
}

export function WorkSection({ crew }: { crew: CrewDto }) {
  const rpc = useRpc<typeof rpcContract>();
  const [items, setItems] = useState<WorkDto[]>([]);
  const refetch = useCallback(() => {
    rpc.call("listWork", { projectId: crew.projectId, name: crew.name, all: false }).then((r) => setItems(r.items), () => undefined);
  }, [rpc, crew.projectId, crew.name]);
  useEffect(refetch, [refetch]);
  useRealtime(ACTIVITY_CHANNEL, refetch);
  return (
    <section className="rounded-xl border border-[#1f1f22] bg-[#0b0b0c] p-4">
      <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Open work</h4>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No open work items.</p>
      ) : (
        <ul aria-label="Work items" className="flex flex-col gap-1 text-sm">
          {items.map((item) => (
            <li key={item.id} data-rung={item.rung} className={cn(item.rung >= 4 && "text-red-400")}>
              <span className="font-mono text-xs text-muted-foreground">{item.id}</span> [{item.state}] {item.tier} {item.title} ·{" "}
              <span className="font-mono text-xs">{item.owner ?? "unassigned"}</span>
              {item.rung > 0 ? <span className="ml-1 text-xs text-amber-400">follow-up {item.rung}/4</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page

type Tab = "topology" | "table" | "file";
const TABS: { id: Tab; label: string }[] = [
  { id: "topology", label: "Topology" },
  { id: "table", label: "Table & Feed" },
  { id: "file", label: "Edit crew file" },
];

/**
 * Commands (`commandPaletteAction`) run outside React and get no RPC client
 * (PluginCommandContext, bb-plugin-sdk.d.ts:18534–18549). The mounted panel,
 * header and sidebar accessory hand theirs over here, the same bridge as the
 * row-status setter.
 */
type RpcClient = ReturnType<typeof useRpc<typeof rpcContract>>;
let rpcBridge: RpcClient | null = null;
function useRpcBridge(): RpcClient {
  const rpc = useRpc<typeof rpcContract>();
  useEffect(() => {
    rpcBridge = rpc;
  }, [rpc]);
  return rpc;
}

export function TopologyTab({
  crew,
  members,
  links,
  onChanged,
}: {
  crew: CrewDto;
  members: MemberDto[];
  links: { from: string; to: string; kind: string }[];
  onChanged: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [activity, setActivity] = useState<ActivityDto[]>([]);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messageId, setMessageId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const refetch = useCallback(() => {
    rpc.call("getActivity", { projectId: crew.projectId, name: crew.name }).then((r) => setActivity(r.members), () => undefined);
    rpc
      .call("listMessages", { projectId: crew.projectId, crew: crew.name, crossCrew: false, limit: 200 })
      .then((r) => setMessages(r.messages), () => undefined);
    setNow(Date.now());
  }, [rpc, crew.projectId, crew.name]);
  useEffect(refetch, [refetch]);
  useRealtime(ACTIVITY_CHANNEL, refetch);
  // Recency fades without a new message too: re-read the clock now and then.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const known = useMemo(() => new Set(members.map((member) => member.key)), [members]);
  const flows = useMemo(() => messageFlows(messages, crew.name, known), [messages, crew.name, known]);
  const recent = useMemo(() => recentFlowIds(flows, now), [flows, now]);
  const strip = useMemo(() => timeline(messages), [messages]);
  const message = messages.find((entry) => entry.id === messageId) ?? null;
  const activeFlow = message ? flowOf(message, crew.name, known) : null;
  const openMember = (key: string) => void rpc.call("openMembers", { projectId: crew.projectId, name: crew.name, members: [key], leadOnly: false });
  // Needs you first: the card opens on the member that is waiting.
  const current =
    members.find((m) => m.key === selected) ??
    members.find((m) => activity.some((v) => v.key === m.key && v.needsYou.length > 0)) ??
    members.find((m) => m.lead) ??
    members[0] ??
    null;
  const ref = current ? { projectId: crew.projectId, name: crew.name, member: current.key } : null;
  const act = async (action: MemberAction) => {
    if (!ref) return;
    try {
      const result =
        action === "open"
          ? await rpc.call("openMembers", { projectId: crew.projectId, name: crew.name, members: [ref.member], leadOnly: false })
          : action === "handover"
            ? await rpc.call("handover", ref)
            : action === "detach"
              ? await rpc.call("detach", ref)
              : await rpc.call("reset", { ...ref, mode: action === "reset-new" ? "new" : "clear" });
      setNote(result.error ?? (action === "open" ? null : `${action} done for ${ref.member}`));
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : String(cause));
    }
    refetch();
    onChanged();
  };
  if (members.length === 0) return <p className="text-sm text-muted-foreground">No members yet. Run bb crew apply.</p>;
  return (
    <div className="flex flex-col gap-2">
      {note ? (
        <p role="status" className="text-xs text-muted-foreground">
          {note}
        </p>
      ) : null}
      {/* Canvas and card side by side on a wide panel; on a phone the card goes under the canvas, as in Graph Studio. */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <TopologyCanvas
          members={members}
          links={links}
          activity={activity}
          selected={current?.key ?? null}
          onSelect={(key) => {
            setSelected(key);
            setMessageId(null);
          }}
          onOpen={openMember}
          flows={flows}
          recent={recent}
          activeFlow={activeFlow}
        />
        {message ? (
          <MessageCard message={message} crewName={crew.name} onClose={() => setMessageId(null)} onOpenSender={openMember} />
        ) : current ? (
          <MemberCard
            member={current}
            view={activity.find((v) => v.key === current.key) ?? null}
            crewName={crew.name}
            onAction={act}
            held={messages.filter((entry) => (entry.fromAddress === current.address || entry.toAddress === current.address) && HOLDABLE.has(entry.status))}
            onMessageAction={async (id, action) => {
              const result = await rpc.call("messageAction", { id, action });
              setNote(result.error ?? `${action === "release" ? "Released" : "Discarded"} the message`);
              refetch();
            }}
            onShowMessage={setMessageId}
            onAnswer={async (body) => {
              const result = await rpc.call("sendMessage", { projectId: crew.projectId, to: current.address, body, crew: crew.name, replyTo: null });
              setNote(result.error ?? `Answer sent to ${current.address}`);
              refetch();
            }}
          />
        ) : null}
      </div>
      <TopologyLegend kinds={[...new Set(links.map((link) => link.kind))]} messages={flows.length > 0} />
      <CommsStrip messages={strip} crewName={crew.name} selectedId={messageId} onSelect={setMessageId} />
      <section className="rounded-xl border border-[#1f1f22] bg-[#0b0b0c] p-4" aria-label="Crew communication">
        <header className="mb-2 flex items-center gap-3">
          <h4 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Communication</h4>
          <span className="text-[11px] text-muted-foreground">{messages.length} messages inside {crew.name}</span>
        </header>
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No messages yet.</p>
        ) : (
          <ul aria-label="Crew log" className="max-h-80 overflow-y-auto">
            {[...messages].reverse().map((entry) => (
              <MessageItem key={entry.id} message={entry} selected={entry.id === messageId} onSelect={(id) => setMessageId(id === messageId ? null : id)} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Crew thread panel (BBP-49): `::crew{crew="…"}` and the header/palette open
// this in the thread's side panel, the pattern Graph Studio's `::graph-run`
// uses for `threadPanelAction` — TopologyTab already draws the member graph
// on top and the crew log below, so the panel is that tab, not a new layout.
// Styling here stays minimal; BBP-50 redesigns the config panels.

function crewRefFromParams(params: unknown): { crew: string; projectId: string } | null {
  if (typeof params !== "object" || params === null) return null;
  const { crew, projectId } = params as Record<string, unknown>;
  if (typeof crew !== "string" || typeof projectId !== "string" || !CREW_NAME.test(crew)) return null;
  return { crew, projectId };
}

export function CrewDetailPanel({ threadId, params }: { threadId: string; params: unknown }) {
  const rpc = useRpc<typeof rpcContract>();
  const direct = useMemo(() => crewRefFromParams(params), [params]);
  // No params (opened from the header or palette, not a directive): the panel's own thread names its crew.
  const [ref, setRef] = useState<{ crew: string; projectId: string } | null | undefined>(direct ?? undefined);
  useEffect(() => {
    if (direct) return setRef(direct);
    rpc.call("memberOfThread", { threadId }).then(
      (result) => setRef(result.member ? { crew: result.member.crew, projectId: result.member.projectId } : null),
      () => setRef(null),
    );
  }, [rpc, threadId, direct]);
  const [crew, setCrew] = useState<CrewDto | null | undefined>(undefined);
  const [members, setMembers] = useState<MemberDto[]>([]);
  const [links, setLinks] = useState<{ from: string; to: string; kind: string }[]>([]);
  const refetch = useCallback(() => {
    if (!ref) return;
    rpc.call("getCrew", { projectId: ref.projectId, name: ref.crew }).then(
      (result) => {
        setCrew(result.crew);
        setMembers(result.members);
        setLinks(result.links ?? []);
      },
      () => setCrew(null),
    );
  }, [rpc, ref?.projectId, ref?.crew]);
  useEffect(refetch, [refetch]);
  useRealtime(ACTIVITY_CHANNEL, refetch);
  useRealtime(CREWS_CHANNEL, refetch);

  if (ref === undefined) return <p className="p-3 text-xs text-muted-foreground">Loading…</p>;
  if (ref === null) return <p className="p-3 text-xs text-muted-foreground">This thread has no crew.</p>;
  if (crew === undefined) return <p className="p-3 text-xs text-muted-foreground">Crew {ref.crew}: loading…</p>;
  if (crew === null) return <p className="p-3 text-xs text-muted-foreground">There is no crew “{ref.crew}” in this project.</p>;
  return (
    <div className="p-3">
      <TopologyTab crew={crew} members={members} links={links} onChanged={refetch} />
    </div>
  );
}

/** Confirmation for `deleteCrew`: the crew must be stopped; blockers can be forced past. */
function DeleteCrewForm({ crew, onDone }: { crew: CrewDto; onDone: (text: string | null, deleted: boolean) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [threads, setThreads] = useState<"archive" | "delete" | "keep">("archive");
  const [blockers, setBlockers] = useState<string[]>([]);
  const [force, setForce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stopped = crew.status === "stopped";
  return (
    <section aria-label="Delete crew" className="mb-3 rounded-xl border border-[#5a1f1f] bg-[#0b0b0c] p-3">
      <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-[#ef6b6b]">Delete crew {crew.name} — removes all of its data</h4>
      {stopped ? (
        <label className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
          Member threads
          <select aria-label="Member threads" className="w-56 rounded-md border border-[#1f1f22] bg-transparent px-1.5 py-1 text-xs text-foreground" value={threads} onChange={(e) => setThreads(e.target.value as typeof threads)}>
            <option value="archive">archive (default)</option>
            <option value="delete">delete, sub-threads included</option>
            <option value="keep">keep, detached from the crew</option>
          </select>
        </label>
      ) : (
        <p className="text-xs text-muted-foreground">
          The crew is {crew.status}. Stop it first (⋯ → Stop, or <code>bb crew stop {crew.name}</code>).
        </p>
      )}
      {blockers.length > 0 ? (
        <>
          <ul aria-label="Delete blockers" className="mt-2 list-disc pl-4 text-xs text-[#ef6b6b]">
            {blockers.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <label className="mt-1 flex items-center gap-1.5 text-xs text-[#ef6b6b]">
            <input type="checkbox" aria-label="Delete anyway" checked={force} onChange={(e) => setForce(e.target.checked)} /> Delete anyway
          </label>
        </>
      ) : null}
      {error && blockers.length === 0 ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={!stopped || busy || (blockers.length > 0 && !force)}
          onClick={async () => {
            setBusy(true);
            try {
              const result = await rpc.call("deleteCrew", { projectId: crew.projectId, name: crew.name, threads, force });
              if (result.error) {
                setBlockers(result.blockers);
                setError(result.error);
              } else onDone(`${crew.name} deleted: ${result.threads.length} thread(s) ${threads === "keep" ? "kept" : `${threads}d`}`, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          Delete crew
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onDone(null, false)}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

function AddMemberForm({ crew, onDone }: { crew: CrewDto; onDone: (text: string | null) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [values, setValues] = useState({ group: "", id: "", role: "", permissions: "" });
  // null until the user picks: then the server copies the lead's provider and model.
  const [execution, setExecution] = useState<{ providerId: string; model: string; reasoningLevel: string; serviceTier?: string } | null>(null);
  const [confirmFull, setConfirmFull] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof values) => (event: { target: { value: string } }) => setValues({ ...values, [key]: event.target.value });
  const input = (key: keyof typeof values, label: string) => (
    <label className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
      {label}
      <input aria-label={label} className="rounded-md border border-[#1f1f22] bg-transparent px-1.5 py-1 text-xs text-foreground" value={values[key]} onChange={set(key)} />
    </label>
  );
  return (
    <section aria-label="Add member" className="mb-3 rounded-xl border border-[#1f1f22] bg-[#0b0b0c] p-3">
      <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Add member — changes the crew file, then applies</h4>
      <div className="grid grid-cols-3 gap-2">
        {input("group", "Group")}
        {input("id", "Member id")}
        {input("role", "Role")}
        <label className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
          Permissions
          <select aria-label="Permissions" className="rounded-md border border-[#1f1f22] bg-transparent px-1.5 py-1 text-xs text-foreground" value={values.permissions} onChange={set("permissions")}>
            <option value="">(inherited)</option>
            {["ask", "accept-edits", "auto", "full"].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-2 flex flex-col gap-0.5 text-[11px] text-muted-foreground" aria-label="New member execution">
        Provider and model {execution ? "" : "(the lead's until you pick)"}
        <ProviderModelPicker
          value={{
            providerId: execution?.providerId ?? "",
            model: execution?.model ?? "",
            reasoningLevel: (execution?.reasoningLevel ?? "medium") as never,
            ...(execution?.serviceTier ? { serviceTier: execution.serviceTier as never } : {}),
          }}
          onChange={(value) => setExecution({ providerId: value.providerId, model: value.model, reasoningLevel: value.reasoningLevel, ...(value.serviceTier ? { serviceTier: value.serviceTier } : {}) })}
        />
      </div>
      {values.permissions === "full" ? (
        <label className="mt-2 flex items-center gap-1.5 text-xs text-[#ef6b6b]">
          <input type="checkbox" aria-label="Confirm full permissions" checked={confirmFull} onChange={(e) => setConfirmFull(e.target.checked)} /> I confirm permissions: full
        </label>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          disabled={!values.group || !values.id}
          onClick={async () => {
            // Leave empty fields out entirely: undefined is not a JSON value.
            const optional = <K extends string>(key: K, value: string) => (value ? { [key]: value } : {}) as Partial<Record<K, string>>;
            const result = await rpc.call("addMember", {
              projectId: crew.projectId,
              name: crew.name,
              group: values.group,
              id: values.id,
              ...optional("role", values.role),
              ...(execution
                ? {
                    provider: execution.providerId,
                    model: execution.model,
                    reasoningLevel: execution.reasoningLevel as never,
                    ...(execution.serviceTier ? { serviceTier: execution.serviceTier as never } : {}),
                  }
                : {}),
              ...(optional("permissions", values.permissions) as { permissions?: "ask" | "accept-edits" | "auto" | "full" }),
              confirmFull,
            });
            if (result.error) setError(result.error);
            else onDone(result.results.map((r) => `${r.result} ${r.address}`).join(" · "));
          }}
        >
          Add and apply
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onDone(null)}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

function AttachForm({ crew, members, onDone }: { crew: CrewDto; members: MemberDto[]; onDone: (text: string | null) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [threads, setThreads] = useState<{ id: string; title: string | null; status: string; providerId: string }[] | null>(null);
  const [threadId, setThreadId] = useState("");
  const [member, setMember] = useState(members.find((m) => !m.threadId || m.thread !== "present")?.key ?? members[0]?.key ?? "");
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    rpc.call("attachCandidates", { projectId: crew.projectId }).then((r) => setThreads(r.threads), () => setThreads([]));
  }, [rpc, crew.projectId]);
  return (
    <section aria-label="Attach thread" className="mb-3 rounded-xl border border-[#1f1f22] bg-[#0b0b0c] p-3 text-xs">
      <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Attach an existing thread — no new thread, kickoff brief as a message</h4>
      {threads === null ? (
        <p className="text-muted-foreground">Loading unassigned threads…</p>
      ) : threads.length === 0 ? (
        <p className="text-muted-foreground">No unassigned threads in this project.</p>
      ) : (
        <ul aria-label="Unassigned threads" className="mb-2 flex max-h-40 flex-col gap-1 overflow-y-auto">
          {threads.map((thread) => (
            <li key={thread.id}>
              <label className="flex items-center gap-2">
                <input type="radio" name="attach-thread" aria-label={thread.title ?? thread.id} checked={threadId === thread.id} onChange={() => setThreadId(thread.id)} />
                <span className="font-mono">{thread.id}</span> {thread.title ?? "(untitled)"} <span className="text-muted-foreground">{thread.status}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        as
        <select aria-label="Attach as member" className="rounded-md border border-[#1f1f22] bg-transparent px-1.5 py-1" value={member} onChange={(e) => setMember(e.target.value)}>
          {members.map((m) => (
            <option key={m.key} value={m.key}>
              {m.address}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1">
          <input type="checkbox" aria-label="Replace the member's thread" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> replace its thread
        </label>
      </div>
      {error ? <p role="alert" className="mt-2 text-destructive">{error}</p> : null}
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          disabled={!threadId || !member}
          onClick={async () => {
            const result = await rpc.call("attach", { projectId: crew.projectId, name: crew.name, member, threadId, replace });
            if (result.error) setError(result.error);
            else onDone(`attached ${threadId} as ${member}`);
          }}
        >
          Attach
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onDone(null)}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

function CrewChips({ crews, onPick }: { crews: CrewDto[]; onPick: (id: string) => void }) {
  return (
    <ul className="flex flex-wrap items-center gap-2" aria-label="Crews">
      {crews.map((entry) => (
        <li key={entry.id}>
          <button
            type="button"
            title={entry.status}
            onClick={() => onPick(entry.id)}
            className={cn("flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted/60", entry.status === "stopped" && "opacity-70")}
          >
            <StatusDot status={entry.status} />
            {entry.name}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Projects that have crews, in first-seen order, with the name the server reported (the id when it did not). */
export function crewProjects(crews: readonly CrewDto[]): { id: string; name: string; count: number }[] {
  const projects = new Map<string, { id: string; name: string; count: number }>();
  for (const entry of crews) {
    const project = projects.get(entry.projectId);
    if (project) project.count += 1;
    else projects.set(entry.projectId, { id: entry.projectId, name: entry.projectName ?? entry.projectId, count: 1 });
  }
  return [...projects.values()];
}

/**
 * The project the panel shows: the one picked, else the project BB is in when
 * it has crews, else the first with crews. Anchoring to BB's project — not to
 * whichever crew was selected last — is what keeps the crew you work with
 * from landing under "other projects".
 */
export function shownProject(crews: readonly CrewDto[], picked: string | null, current: string | null): string | null {
  const has = (id: string | null) => id !== null && crews.some((entry) => entry.projectId === id);
  if (has(picked)) return picked;
  if (has(current)) return current;
  return crews[0]?.projectId ?? null;
}

function CrewsPage() {
  const rpc = useRpcBridge();
  const [crews, setCrews] = useState<CrewDto[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  /** The project overview is the entry; a crew opens from its card or the list. */
  const [view, setView] = useState<"overview" | "crew">("overview");
  const [tab, setTab] = useState<Tab>("topology");
  const [members, setMembers] = useState<MemberDto[]>([]);
  const [links, setLinks] = useState<{ from: string; to: string; kind: string }[]>([]);
  const [yaml, setYaml] = useState<string | null>(null);
  const [needsByCrew, setNeedsByCrew] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [form, setForm] = useState<"add" | "attach" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickedProject, setPickedProject] = useState<string | null>(null);
  const { projectId: bbProject } = useBbContext();
  const projectId = shownProject(crews ?? [], pickedProject, bbProject);
  const projectCrews = useMemo(() => (crews ?? []).filter((entry) => entry.projectId === projectId), [crews, projectId]);
  const projects = useMemo(() => crewProjects(crews ?? []), [crews]);
  const crew = projectCrews.find((entry) => entry.id === selected) ?? projectCrews[0] ?? null;
  const { byProject } = useNeedsYou();

  const refetch = useCallback(() => {
    rpc.call("listCrews", { projectId: null }).then(
      (result) => {
        setCrews(result.crews);
        setError(null);
      },
      (cause: unknown) => setError(String(cause)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(CREWS_CHANNEL, refetch);

  const loadCrew = useCallback(() => {
    if (!crew) return setMembers([]);
    rpc.call("getCrew", { projectId: crew.projectId, name: crew.name }).then(
      (result) => {
        setMembers(result.members);
        setLinks(result.links ?? []);
      },
      (cause: unknown) => setError(String(cause)),
    );
    rpc.call("getActivity", { projectId: crew.projectId, name: crew.name }).then(
      (result) => setNeedsByCrew(result.members.filter((view) => view.needsYou.length > 0).length),
      () => undefined,
    );
  }, [rpc, crew?.id, crew?.updatedAt]);
  useEffect(loadCrew, [loadCrew]);
  useRealtime(ACTIVITY_CHANNEL, loadCrew);
  useEffect(() => {
    if (!crew || tab !== "file") return;
    rpc.call("getCrewFile", { projectId: crew.projectId, name: crew.name }).then((r) => setYaml(r.yaml ?? ""), () => setYaml(""));
  }, [rpc, crew?.id, crew?.fileVersion, tab]);

  const act = async (run: () => Promise<{ error?: string | null } | unknown>, done?: (result: never) => string) => {
    setBusy(true);
    setMenu(false);
    try {
      const result = (await run()) as { error?: string | null };
      setNote(result && typeof result === "object" && result.error ? result.error : done ? done(result as never) : null);
      refetch();
      loadCrew();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      <div className="mx-auto box-border w-full max-w-6xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
        {error ? (
          <p role="alert" className="mb-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {crews === null ? (
          <p className="text-sm text-muted-foreground">Loading crews…</p>
        ) : crews.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No crews yet. Try <code>bb crew templates</code> and <code>bb crew apply trio</code>.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {view === "overview" ? (
              // One project at a time, chosen explicitly: the chips list exactly
              // the crews of the board below. Other projects are a switch away,
              // not a second row of chips that reads as "the rest".
              <div className="flex flex-wrap items-center gap-3">
                {projects.length > 1 ? (
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Icon name="FolderOpen" className="size-3.5" />
                    <select
                      aria-label="Project"
                      className="rounded-md border border-[#1f1f22] bg-transparent px-1.5 py-1 text-sm font-medium text-foreground hover:bg-[#1a1a1c]"
                      value={projectId ?? ""}
                      onChange={(event) => {
                        setPickedProject(event.target.value);
                        setSelected(null);
                      }}
                    >
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name} ({project.count}){byProject[project.id] ? ` · ${byProject[project.id]} need you` : ""}
                          {project.id === bbProject ? " · current" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <CrewChips
                  crews={projectCrews}
                  onPick={(id) => {
                    setSelected(id);
                    setView("crew");
                  }}
                />
              </div>
            ) : null}
            {view === "overview" && crew ? (
              <ProjectOverview
                projectId={crew.projectId}
                crews={projectCrews}
                onOpen={(name) => {
                  const match = crews.find((entry) => entry.projectId === crew.projectId && entry.name === name);
                  if (match) setSelected(match.id);
                  setView("crew");
                }}
              />
            ) : null}
            {view === "crew" && crew ? (
              <section>
                <header className="mb-2 flex flex-wrap items-center gap-3">
                  <Button size="sm" variant="ghost" className="h-7 px-2" aria-label="Back to the project overview" onClick={() => setView("overview")}>
                    <Icon name="ChevronLeft" className="size-4" />
                  </Button>
                  <select
                    aria-label="Crew"
                    className="rounded-md border-0 bg-transparent py-1 text-base font-semibold hover:bg-[#1a1a1c]"
                    value={crew.id}
                    onChange={(event) => setSelected(event.target.value)}
                  >
                    {/* The project's crews only; the project is switched on the overview. */}
                    {projectCrews.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                        {entry.status === "stopped" ? " (stopped)" : ""}
                      </option>
                    ))}
                  </select>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <StatusDot status={crew.status} /> {crew.status} · {members.length} members · file v{crew.fileVersion}
                  </span>
                  <NeedsYouBadge count={needsByCrew} />
                  <span className="flex-1" />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || members.length === 0}
                    onClick={() =>
                      act(
                        () => rpc.call("openMembers", { projectId: crew.projectId, name: crew.name, leadOnly: false }),
                        (r: { opened: string[] }) => `Opened ${r.opened.length} thread(s)${r.opened.length >= 4 ? " as a grid" : " side by side"}`,
                      )
                    }
                  >
                    <Icon name="LayoutGrid" className="size-4" /> Open all
                  </Button>
                  <div className="relative">
                    <Button size="sm" variant="ghost" aria-label="More crew actions" aria-expanded={menu} onClick={() => setMenu((value) => !value)}>
                      ⋯
                    </Button>
                    {menu ? (
                      <div role="menu" aria-label="Crew actions" className="absolute right-0 top-9 z-50 flex w-48 flex-col rounded-lg border border-[#1f1f22] bg-[#0b0b0c] p-1 text-sm shadow-lg">
                        <button type="button" role="menuitem" className="rounded px-2 py-1.5 text-left hover:bg-[#1a1a1c]" onClick={() => act(() => rpc.call("stop", { projectId: crew.projectId, name: crew.name, archive: false }), () => `${crew.name} stopped`)}>
                          Stop
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="rounded px-2 py-1.5 text-left hover:bg-[#1a1a1c]"
                          onClick={() =>
                            act(
                              () => rpc.call("snapshot", { projectId: crew.projectId, name: crew.name, label: null }),
                              (r: { id: string; bindings: number; work: number; messages: number }) =>
                                `Snapshot ${r.id}: ${r.bindings} bindings, ${r.work} open work items, ${r.messages} undelivered messages — bb crew restore ${r.id}`,
                            )
                          }
                        >
                          Snapshot
                        </button>
                        <button type="button" role="menuitem" className="rounded px-2 py-1.5 text-left hover:bg-[#1a1a1c]" onClick={() => (setMenu(false), setForm("add"))}>
                          Add member
                        </button>
                        <button type="button" role="menuitem" className="rounded px-2 py-1.5 text-left hover:bg-[#1a1a1c]" onClick={() => (setMenu(false), setForm("attach"))}>
                          Attach thread…
                        </button>
                        <button type="button" role="menuitem" className="rounded px-2 py-1.5 text-left text-[#ef6b6b] hover:bg-[#1a1a1c]" onClick={() => (setMenu(false), setForm("delete"))}>
                          Delete crew…
                        </button>
                      </div>
                    ) : null}
                  </div>
                </header>
                {note ? (
                  <p role="status" className="mb-2 text-xs text-muted-foreground">
                    {note}
                  </p>
                ) : null}
                {form === "add" ? (
                  <AddMemberForm
                    crew={crew}
                    onDone={(text) => {
                      setForm(null);
                      if (text) setNote(text);
                      refetch();
                      loadCrew();
                    }}
                  />
                ) : null}
                {form === "delete" ? (
                  <DeleteCrewForm
                    crew={crew}
                    onDone={(text, deleted) => {
                      setForm(null);
                      if (text) setNote(text);
                      // The crew is gone: fall back to the first remaining one, where the note shows.
                      if (deleted) setSelected(null);
                      refetch();
                    }}
                  />
                ) : null}
                {form === "attach" ? (
                  <AttachForm
                    crew={crew}
                    members={members}
                    onDone={(text) => {
                      setForm(null);
                      if (text) setNote(text);
                      loadCrew();
                    }}
                  />
                ) : null}
                <nav className="mb-4 flex gap-5 border-b border-border" aria-label="Crew views">
                  {TABS.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      aria-current={tab === entry.id ? "page" : undefined}
                      onClick={() => setTab(entry.id)}
                      className={cn("-mb-px border-b-2 py-2 text-sm", tab === entry.id ? "border-foreground" : "border-transparent text-muted-foreground")}
                    >
                      {entry.label}
                    </button>
                  ))}
                </nav>
                {tab === "topology" ? <TopologyTab crew={crew} members={members} links={links} onChanged={loadCrew} /> : null}
                {tab === "table" ? <TableAndFeed crew={crew} members={members} /> : null}
                {tab === "file" ? (
                  yaml === null ? (
                    <p className="text-sm text-muted-foreground">Loading the crew file…</p>
                  ) : (
                    <CrewFileEditor projectId={crew.projectId} initialYaml={yaml} onApplied={() => (refetch(), loadCrew())} />
                  )
                ) : null}
              </section>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

/** The crew of the thread in view, through the bridged RPC client; null when there is none. */
async function crewOfThread(threadId: string | null) {
  if (!threadId || !rpcBridge) return null;
  return (await rpcBridge.call("memberOfThread", { threadId })).member;
}

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: CREW_ICON, component: CrewTeam });
  app.slots.navPanel({
    id: "crews",
    title: "Crews",
    icon: CREW_ICON,
    path: "crews",
    component: CrewsPage,
    headerContent: HeaderContent,
    experimental_sidebarAccessory: SidebarAccessory,
  });
  app.slots.experimental_threadHeaderAction({ id: "member-badge", title: "Crew member", component: MemberBadge });
  app.slots.messageDirective({ id: "crew", component: CrewDirectiveCard });
  app.slots.threadPanelAction({
    id: "crew",
    title: "Crew",
    icon: CREW_ICON,
    layout: "flush",
    run: async ({ threadId, openPanel }) => {
      const member = await crewOfThread(threadId);
      openPanel(member ? { title: `Crew ${member.crew}`, params: { crew: member.crew, projectId: member.projectId } } : { title: "Crew" });
    },
    component: ({ threadId, params }) => <CrewDetailPanel threadId={threadId} params={params} />,
  });
  app.slots.pendingInteraction({ id: "crew-confirm", component: ConfirmInteraction });
  // Palette commands for the crew of the thread in view (§4.6).
  const needsCrew = ({ threadId }: { threadId: string | null }) => threadId !== null && rpcBridge !== null;
  app.slots.commandPaletteAction({
    id: "apply-crew",
    title: "Crew: apply the crew of this thread",
    isAvailable: needsCrew,
    run: async ({ threadId }) => {
      const member = await crewOfThread(threadId);
      if (member) await rpcBridge!.call("apply", { projectId: member.projectId, ref: member.crew, fresh: [], confirmFull: false });
    },
  });
  app.slots.commandPaletteAction({
    id: "stop-crew",
    title: "Crew: stop the crew of this thread",
    isAvailable: needsCrew,
    run: async ({ threadId }) => {
      const member = await crewOfThread(threadId);
      if (member) await rpcBridge!.call("stop", { projectId: member.projectId, name: member.crew, archive: false });
    },
  });
  app.slots.commandPaletteAction({
    id: "open-members",
    title: "Crew: open all members of this thread's crew",
    isAvailable: needsCrew,
    run: async ({ threadId }) => {
      const member = await crewOfThread(threadId);
      if (member) await rpcBridge!.call("openMembers", { projectId: member.projectId, name: member.crew, leadOnly: false });
    },
  });
  app.slots.commandPaletteAction({
    id: "open-lead",
    title: "Crew: open the lead of this thread's crew",
    isAvailable: needsCrew,
    run: async ({ threadId }) => {
      const member = await crewOfThread(threadId);
      if (member) await rpcBridge!.call("openMembers", { projectId: member.projectId, name: member.crew, leadOnly: true });
    },
  });
  app.contentScripts.register({
    id: "row-status",
    mount(context) {
      // Optional on older clients: feature-detect before use (§4.6).
      if (typeof context.experimental_setThreadRowStatus !== "function") return;
      rowSetter = context.experimental_setThreadRowStatus;
      applied.clear();
      if (pendingRows) applyRowStatuses(pendingRows);
      const sync = () =>
        void fetchRowStatuses(context.pluginId, fetch, context.signal).then((rows) => {
          if (rows && !context.signal.aborted) applyRowStatuses(rows);
        });
      sync();
      const timer = setInterval(sync, ROW_STATUS_POLL_MS);
      return () => {
        clearInterval(timer);
        rowSetter = null;
        applied.clear();
      };
    },
  });
});

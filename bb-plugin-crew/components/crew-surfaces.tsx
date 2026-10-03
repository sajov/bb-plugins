// Small surfaces outside the Crews panel (§4.6):
// - MemberBadge: `experimental_threadHeaderAction`, the member's address and
//   shift in the thread header with Reset / Handover / Detach. Renders nothing
//   on threads that are not a crew member's (the server decides, from the
//   bindings — metadata alone is untrusted).
// - CrewDirectiveCard: `::crew{crew="…"}`, a live card of the crew in chat,
//   analogous to Graph Studio's `::graph-run`.
// - ConfirmInteraction: `slots.pendingInteraction` renderer "crew-confirm"
//   for team changes that need the human (removing a member, full).
import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginMessageDirectiveProps, PluginPendingInteractionProps, PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import type { ActivityDto, CrewDto, rpcContract } from "../server";
import { activityTone } from "../lib/topology";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { CREW_ICON } from "./crew-icon";

const ACTIVITY_CHANNEL = "crew-activity";
const CREWS_CHANNEL = "crews-changed";
export const CREW_NAME = /^[A-Za-z0-9][\w-]{0,63}$/;

type BadgeMember = { key: string; address: string; crew: string; projectId: string; shift: number; lead: boolean; handover: string | null; leadThreadId: string | null };

export function MemberBadge({ threadId, isCompactViewport }: Pick<PluginThreadHeaderActionProps, "threadId" | "isCompactViewport">) {
  const rpc = useRpc<typeof rpcContract>();
  const [member, setMember] = useState<BadgeMember | null>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("memberOfThread", { threadId }).then(
      (result) => setMember(result.member),
      () => setMember(null),
    );
  }, [rpc, threadId]);
  useEffect(refetch, [refetch]);
  useRealtime(CREWS_CHANNEL, refetch);
  useRealtime(ACTIVITY_CHANNEL, refetch);
  if (!member) return null;

  const ref = { projectId: member.projectId, name: member.crew, member: member.key };
  const run = async (label: string, call: () => Promise<{ error: string | null }>) => {
    setOpen(false);
    try {
      const result = await call();
      setNote(result.error ?? `${label} started`);
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : String(cause));
    }
    refetch();
  };
  return (
    <div className="relative" data-crew-badge={member.address}>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Crew member ${member.address}, shift ${member.shift}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="h-7 gap-1.5 font-mono text-xs"
      >
        <Icon name={CREW_ICON} className="size-4" />
        {isCompactViewport ? null : (
          <span>
            {member.address} · Shift {member.shift}
            {member.handover ? " · handover" : ""}
          </span>
        )}
      </Button>
      {open ? (
        <div role="menu" aria-label="Member actions" className="absolute right-0 top-8 z-50 flex w-52 flex-col rounded-lg border border-[#1f1f22] bg-[#0b0b0c] p-1 text-xs shadow-lg">
          <button type="button" role="menuitem" className="rounded px-2 py-1.5 text-left hover:bg-[#1a1a1c]" onClick={() => run("Reset", () => rpc.call("reset", { ...ref, mode: "clear" }))}>
            Reset (clear context)
          </button>
          <button type="button" role="menuitem" className="rounded px-2 py-1.5 text-left hover:bg-[#1a1a1c]" onClick={() => run("Reset", () => rpc.call("reset", { ...ref, mode: "new" }))}>
            Reset (new thread)
          </button>
          <button type="button" role="menuitem" className="rounded px-2 py-1.5 text-left hover:bg-[#1a1a1c]" onClick={() => run("Handover", () => rpc.call("handover", ref))}>
            Handover
          </button>
          <button type="button" role="menuitem" className="rounded px-2 py-1.5 text-left text-[#ef6b6b] hover:bg-[#1a1a1c]" onClick={() => run("Detach", () => rpc.call("detach", ref))}>
            Detach from crew
          </button>
        </div>
      ) : null}
      {note ? (
        <div role="status" className="absolute right-0 top-8 z-40 w-60 rounded-md border border-[#1f1f22] bg-[#0b0b0c] p-2 text-[11px]" onClick={() => setNote(null)}>
          {note}
        </div>
      ) : null}
    </div>
  );
}

export function CrewDirectiveCard({ attributes, message }: Pick<PluginMessageDirectiveProps, "attributes" | "message">) {
  const name = CREW_NAME.test(attributes.crew ?? "") ? attributes.crew! : null;
  const projectId = message.projectId;
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [crew, setCrew] = useState<CrewDto | null | undefined>(undefined);
  const [views, setViews] = useState<ActivityDto[]>([]);
  const refetch = useCallback(() => {
    if (!name || !projectId) return;
    rpc.call("getCrew", { projectId, name }).then((result) => setCrew(result.crew), () => setCrew(null));
    rpc.call("getActivity", { projectId, name }).then((result) => setViews(result.members), () => setViews([]));
  }, [rpc, name, projectId]);
  useEffect(refetch, [refetch]);
  useRealtime(ACTIVITY_CHANNEL, refetch);
  useRealtime(CREWS_CHANNEL, refetch);

  if (!name) return <p className="text-xs text-muted-foreground">Crew: this card names no valid crew.</p>;
  if (!projectId) return <p className="text-xs text-muted-foreground">Crew {name}: no project for this message.</p>;
  if (crew === undefined) return <p className="text-xs text-muted-foreground">Crew {name}: loading…</p>;
  if (crew === null) return <p className="text-xs text-muted-foreground">There is no crew “{name}” in this project.</p>;
  const needs = views.filter((view) => view.needsYou.length > 0).length;
  return (
    <div data-crew-directive={crew.name} className="my-2 flex flex-col gap-2 rounded-xl border border-[#1f1f22] bg-[#0b0b0c] p-3 text-xs">
      <div className="flex items-center gap-2">
        <Icon name={CREW_ICON} className="size-4" />
        <span className="text-sm font-semibold">{crew.name}</span>
        <span className="text-muted-foreground">
          {crew.status} · {views.length} members · file v{crew.fileVersion}
        </span>
        {needs > 0 ? <span className="ml-auto rounded-full border border-[#3a1f22] bg-[#1c1011] px-2 text-[#ef6b6b]">{needs} Needs you</span> : null}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Members">
        {views.map((view) => (
          <li key={view.key} className="flex items-center gap-1" title={view.question ?? view.activity}>
            <span className="inline-block size-2 rounded-full" style={{ background: activityTone(view.activity, view.needsYou.length > 0) }} />
            {view.lead ? "★ " : ""}
            {view.key}
            <span className="text-muted-foreground">{view.needsYou.length > 0 ? "needs you" : view.activity}</span>
          </li>
        ))}
      </ul>
      <div>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => {
            // BBP-49: the sidebar first, as Graph Studio's ::graph-run does; a surface
            // without a thread side panel (the panel view itself) falls back to the nav panel.
            const opened = navigate.openThreadPanel({ actionId: "crew", title: `Crew ${crew.name}`, params: { crew: crew.name, projectId } });
            if (!opened) navigate.toPluginPanel("crews");
          }}
        >
          Open in Crews
        </Button>
      </div>
    </div>
  );
}

export function ConfirmInteraction({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const payload = (interaction.payload ?? {}) as { kind?: unknown; title?: unknown; detail?: unknown };
  const title = typeof payload.title === "string" ? payload.title : interaction.title;
  const detail = typeof payload.detail === "string" ? payload.detail : "";
  const danger = payload.kind === "full-permissions" || payload.kind === "remove-member";
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-[#1f1f22] bg-[#0b0b0c] p-3 text-sm" aria-label="Crew confirmation">
      <strong className={danger ? "text-[#ef6b6b]" : undefined}>{title}</strong>
      {detail ? <p className="m-0 text-xs text-muted-foreground">{detail}</p> : null}
      <div className="flex gap-2">
        <Button size="sm" variant={danger ? "destructive" : "default"} onClick={() => void submit({ confirmed: true })}>
          Confirm
        </Button>
        <Button size="sm" variant="outline" onClick={() => void submit({ confirmed: false })}>
          Decline
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void cancel()}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

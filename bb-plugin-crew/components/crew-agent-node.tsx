// BBP-83, level 3 of the Crews canvas: a member opened into its agent card,
// drawn on the canvas over the member node it grew out of — what it runs on,
// how full its context is, what waits in its queue, what it works on now.
import type { Node, NodeProps } from "@xyflow/react";
import type { ActivityDto, MemberDto, WorkDto } from "../server";
import { formatContextShare } from "../lib/format";
import { activityLabel } from "../lib/topology";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { MemberAction } from "./crew-topology";

export const AGENT_W = 300;
export const AGENT_H = 220;

export type AgentNodeData = {
  member: MemberDto;
  view: ActivityDto | null;
  /** The member's own open work item, if it has claimed one. */
  work: WorkDto | null;
  onAction: (action: MemberAction) => void;
};

/** The work item a member works on now: claimed before open, its own only. */
export function currentWork(items: readonly WorkDto[], address: string): WorkDto | null {
  const own = items.filter((item) => item.owner === address);
  return own.find((item) => item.state === "claimed") ?? own.find((item) => item.state === "open") ?? null;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-16 shrink-0 text-[10px] uppercase tracking-[0.06em] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-foreground">{children}</span>
    </div>
  );
}

export function AgentNodeView({ data }: NodeProps<Node<AgentNodeData>>) {
  const { member, view, work, onAction } = data;
  const model = member.actualModel ?? member.model;
  const provider = member.actualProvider ?? member.provider;
  // The card's own buttons must not reach the canvas: no pan, no node click.
  const act = (action: MemberAction) => (event: React.MouseEvent) => {
    event.stopPropagation();
    onAction(action);
  };
  return (
    <div
      data-agent-node={member.key}
      className="nodrag nopan flex h-full w-full cursor-default flex-col gap-2 rounded-[10px] border-2 border-primary bg-card p-3 text-xs text-card-foreground shadow-lg"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{member.key}</span>
        <span className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
          {member.lead ? "lead · " : ""}
          {activityLabel(view, member.thread)}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <Row label="Model">{model ? `${model}${provider ? ` · ${provider}` : ""}` : "default"}</Row>
        <Row label="Context">{view?.context != null ? formatContextShare(view.context) : "—"}</Row>
        <Row label="Queue">
          {view ? `${view.openWork} open · ${view.held} held` : "—"}
        </Row>
        <Row label="Work">{work ? work.title : "none"}</Row>
      </div>
      <div className="mt-auto flex items-center gap-1.5">
        <Button size="sm" variant="outline" className="h-7 px-2" onClick={act("open")}>
          <Icon name="ExternalLink" className="size-3.5" />
          Open
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={act("handover")}>
          Handover
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={act("reset-clear")}>
          Reset
        </Button>
      </div>
    </div>
  );
}

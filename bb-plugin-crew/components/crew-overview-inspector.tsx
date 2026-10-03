// Fullscreen overview diagram (BBP-71): the inspector panel for a selected
// crew node, in accordions — the shared inspector vocabulary
// (components/inspector.tsx, kept byte-identical to the sibling plugin's own
// copy by tests/inspector.test.tsx; no import between the two).
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { CrewNode } from "../lib/overview-graph";
import { InspectorFooter, InspectorHeader, InspectorRows, InspectorSection } from "./inspector";

export function OverviewInspector({ crew, onOpen, onClose }: { crew: CrewNode; onOpen: () => void; onClose: () => void }) {
  return (
    <div aria-label="Crew inspector">
      <InspectorHeader
        icon={<Icon name="Users" className="size-4" />}
        title={crew.name}
        subtitle={crew.branch ?? "no branch"}
        actions={
          <Button size="sm" variant="ghost" className="h-7 px-2" aria-label="Close inspector" onClick={onClose}>
            <Icon name="X" className="size-3.5" />
          </Button>
        }
      />
      <InspectorSection title="Status" summary={crew.needsYou > 0 ? "waits on you" : crew.status} open>
        <InspectorRows
          rows={[
            { label: "Status", value: crew.status },
            { label: "Task", value: crew.task ?? "none" },
            { label: "Needs you", value: String(crew.needsYou), className: crew.needsYou > 0 ? "text-destructive" : undefined },
          ]}
        />
      </InspectorSection>
      <InspectorSection title="Members" summary={`${crew.members.length}`}>
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs" aria-label="Members">
          {crew.members.map((member) => (
            <li key={member.key} className="flex items-center justify-between gap-2">
              <span className="truncate">
                {member.lead ? "★ " : ""}
                {member.key}
              </span>
              <span className="text-muted-foreground">{member.activity}</span>
            </li>
          ))}
        </ul>
      </InspectorSection>
      <InspectorFooter note="Double-click a crew on the canvas to open it the same way.">
        <Button size="sm" variant="outline" className="h-7" onClick={onOpen}>
          Open
        </Button>
      </InspectorFooter>
    </div>
  );
}

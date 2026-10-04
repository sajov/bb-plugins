// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import YAML from "yaml";
import { CrewEditFullscreen } from "../components/crew-edit-fullscreen";

const YAML_TEXT = `version: "1"
name: mst-factory
groups:
  - id: orch
    members:
      - id: lead
        lead: true
        role: Plans.
        provider: claude-code
        model: claude-opus-5-5
  - id: dev
    members:
      - id: impl
        role: Implements.
        provider: claude-code
        model: claude-sonnet-5-5
links:
  - from: orch-lead
    to: dev-impl
    kind: assigns_to
`;

// The SDK picker needs BB's runtime; a plain stand-in keeps the test on our own code.
const Picker = ({ value, onChange }: { value: { providerId: string; model: string }; onChange: (value: { providerId: string; model: string }) => void }) => (
  <input aria-label="Model stub" value={value.model} onChange={(event) => onChange({ providerId: value.providerId, model: event.target.value })} />
);

function setup(overrides: Partial<Parameters<typeof CrewEditFullscreen>[0]> = {}) {
  const onSave = vi.fn(async (_yaml: string) => null as string | null);
  const onClose = vi.fn();
  const onOverview = vi.fn();
  const onReload = vi.fn(async () => YAML_TEXT);
  render(
    <CrewEditFullscreen
      title="mastra — mst-factory"
      initialYaml={YAML_TEXT}
      onSave={onSave}
      onReload={onReload}
      onOverview={onOverview}
      onClose={onClose}
      ExecutionPicker={Picker}
      {...overrides}
    />,
  );
  return { onSave, onClose, onOverview, onReload, dialog: screen.getByRole("dialog") };
}

beforeAll(() => installTestPluginRuntime());
afterEach(cleanup);

describe("CrewEditFullscreen", () => {
  it("shows the header actions, validity and the member accordions", () => {
    const { dialog } = setup();
    const view = within(dialog);
    for (const name of ["Reload", "Overview", "Save", "Leave full screen", "Member", "Group", "Remove member"]) {
      expect(view.getByRole("button", { name: new RegExp(name) })).toBeTruthy();
    }
    for (const section of ["Identity", "Role", "Provider & model", "Skills", "Permissions", "Links", "Crew settings"]) {
      expect(view.getByRole("button", { name: new RegExp(`^${section.replace("&", "\\&")}`) })).toBeTruthy();
    }
    expect(view.getByText("The crew file is valid.")).toBeTruthy();
    expect(view.queryByText("Unsaved changes")).toBeNull();
    expect((view.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("edits the selected member and saves valid YAML", async () => {
    const { dialog, onSave } = setup();
    const view = within(dialog);
    fireEvent.change(view.getByLabelText("Member"), { target: { value: "dev-impl" } });
    fireEvent.click(view.getByRole("button", { name: /^Role/ }));
    fireEvent.change(view.getByLabelText("Role text"), { target: { value: "Builds it." } });
    expect(view.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = YAML.parse(onSave.mock.calls[0]![0]);
    expect(saved.groups[1].members[0].role).toBe("Builds it.");
    await waitFor(() => expect(view.queryByText("Unsaved changes")).toBeNull());
  });

  it("blocks Save while the file has errors", () => {
    const { dialog } = setup();
    const view = within(dialog);
    fireEvent.click(view.getByRole("button", { name: /^Crew settings/ }));
    fireEvent.change(view.getByLabelText("Crew instructions"), { target: { value: "x".repeat(5000) } });
    expect(view.queryByText("The crew file is valid.")).toBeNull();
    expect((view.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("adds a member and a group, and removes a non-lead member", () => {
    const { dialog } = setup();
    const view = within(dialog);
    const picker = () => view.getByLabelText("Member") as HTMLSelectElement;
    fireEvent.click(view.getByRole("button", { name: /\+ ?Member|^Member$/ }));
    expect(picker().value).toBe("orch-member");
    fireEvent.click(view.getByRole("button", { name: /Group/ }));
    expect(picker().value).toBe("group2-member");
    fireEvent.click(view.getByRole("button", { name: "Remove member" }));
    expect(Array.from(picker().options).map((option) => option.value)).not.toContain("group2-member");
  });

  it("disables Remove member for the lead", () => {
    const { dialog } = setup();
    expect((within(dialog).getByRole("button", { name: "Remove member" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows and removes links of the member", () => {
    const { dialog } = setup();
    const view = within(dialog);
    fireEvent.click(view.getByRole("button", { name: /^Links/ }));
    expect(view.getByText(/assigns_to → dev-impl/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Remove link orch-lead assigns_to dev-impl" }));
    expect(view.queryByText(/assigns_to → dev-impl/)).toBeNull();
  });

  it("reports a save error instead of clearing the dirty state", async () => {
    const { dialog } = setup({ onSave: vi.fn(async () => "disk full") });
    const view = within(dialog);
    fireEvent.click(view.getByRole("button", { name: /^Role/ }));
    fireEvent.change(view.getByLabelText("Role text"), { target: { value: "New." } });
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("disk full"));
    expect(view.getByText("Unsaved changes")).toBeTruthy();
  });

  it("wires Overview, Reload and Leave full screen", async () => {
    const { dialog, onOverview, onReload, onClose } = setup();
    const view = within(dialog);
    fireEvent.click(view.getByRole("button", { name: "Overview" }));
    fireEvent.click(view.getByRole("button", { name: "Reload" }));
    fireEvent.click(view.getByRole("button", { name: /Leave full screen/ }));
    expect(onOverview).toHaveBeenCalled();
    await waitFor(() => expect(onReload).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });
});

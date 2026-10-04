// @vitest-environment jsdom
//
// Panel wiring through the SDK's own slot harness, so the RPC calls the UI
// makes are the ones the server actually declares.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  loadPluginApp,
  renderSlot,
  type CapturedPluginApp,
} from "@get-bb/plugin-sdk/testing/app";
import { TEMPLATE_SECTIONS, TEMPLATES } from "../lib/templates";
import { toGraphFile } from "../server";

let app: CapturedPluginApp;

beforeAll(async () => {
  app = await loadPluginApp(() => import("../app"));
});
afterEach(cleanup);

const mine = { ...TEMPLATES[0]!, id: "my-graph", name: "My Graph" };
const SECTION_LABELS: string[] = Object.values(TEMPLATE_SECTIONS);

function panel(overrides: Record<string, unknown> = {}) {
  return renderSlot(
    app.threadPanelActions[0]!,
    { threadId: "thr_1", params: null },
    {
      rpc: {
        listGraphs: () => ({ graphs: [mine, ...TEMPLATES], templates: TEMPLATES }),
        listRuns: () => ({ runs: [] }),
        listSkills: () => ({
          skills: [
            {
              id: "code-review",
              name: "code-review",
              description: "Review changes",
              scope: "bb-user",
            },
          ],
          error: null,
        }),
        ...overrides,
      },
      context: { projectId: "proj_1", threadId: "thr_1" },
    },
  );
}

describe("Graph Studio panel", () => {
  it("registers the nav panel and thread panel action", () => {
    expect(app.navPanels).toHaveLength(1);
    expect(app.threadPanelActions).toHaveLength(1);
  });

  it("offers export/import from the overview, not only inside the editor", async () => {
    const slot = panel();
    expect(await slot.findByText("File: export / import")).toBeTruthy();
    expect(
      slot.getByLabelText("Paste JSON and import it as a new graph"),
    ).toBeTruthy();
  });

  it("exports the graph selected above and shows its JSON", async () => {
    const slot = panel({
      exportGraph: ({ id }: { id: string }) => ({
        filename: `${id}.graph.json`,
        json: toGraphFile(mine),
      }),
    });
    fireEvent.click(await slot.findByRole("button", { name: /as JSON/i }));
    await waitFor(() => {
      const call = slot.inspection.rpcCalls.find(
        (entry) => entry.method === "exportGraph",
      );
      expect(call).toBeTruthy();
      expect((call!.input as { id: string }).id).toBe("my-graph");
    });
    const output = (await slot.findByLabelText(
      "Exported JSON",
    )) as HTMLTextAreaElement;
    expect(output.value).toContain('"id": "my-graph"');
  });

  it("sends pasted JSON to importGraph", async () => {
    const slot = panel({
      importGraph: () => ({ graph: mine }),
    });
    const box = await slot.findByLabelText(
      "Paste JSON and import it as a new graph",
    );
    fireEvent.change(box, { target: { value: toGraphFile(mine) } });
    fireEvent.click(slot.getByRole("button", { name: "Import" }));
    await waitFor(() => {
      const call = slot.inspection.rpcCalls.find(
        (entry) => entry.method === "importGraph",
      );
      expect(call).toBeTruthy();
      expect((call!.input as { overwrite: boolean }).overwrite).toBe(false);
    });
  });

  it("surfaces an import error instead of failing silently", async () => {
    const slot = panel({
      importGraph: () => {
        throw new Error('A graph named "my-graph" already exists.');
      },
    });
    const box = await slot.findByLabelText(
      "Paste JSON and import it as a new graph",
    );
    fireEvent.change(box, { target: { value: "{}" } });
    fireEvent.click(slot.getByRole("button", { name: "Import" }));
    expect(await slot.findByRole("alert")).toBeTruthy();
  });

  it("asks the server for the thread's skills so the editor can offer them", async () => {
    const slot = panel();
    await waitFor(() => {
      const call = slot.inspection.rpcCalls.find(
        (entry) => entry.method === "listSkills",
      );
      expect(call).toBeTruthy();
      expect((call!.input as { threadId: string }).threadId).toBe("thr_1");
    });
  });
});

/**
 * Focus mode. The graph is the interface while a flow runs, so the prose
 * around it steps aside — but exactly one thing must never step aside with it.
 */
describe("Full screen", () => {
  const graph = TEMPLATES.find((entry) => entry.id === "concept-feature")!;
  const makeRun = (overrides: Record<string, unknown> = {}) => ({
    id: "run_1",
    graphId: graph.id,
    graph,
    threadId: "thr_1",
    projectId: "proj_1",
    input: "A task",
    status: "running",
    state: { input: "A task", outputs: {}, fields: {}, visits: {}, steps: 0 },
    error: null,
    createdAt: 1,
    updatedAt: 2,
    nodeRuns: [],
    pendingQuestion: null,
    ...overrides,
  });

  const openRun = async (run: Record<string, unknown>) => {
    const slot = panel({ listRuns: () => ({ runs: [run] }) });
    // The row renders the task in typographic quotes, hence the regex.
    fireEvent.click(await slot.findByText(/A task/));
    return slot;
  };

  // The layer covers the whole window, portaled to the body — the old mode
  // only filled the panel's column, which was a reset rather than a mode.
  const layer = () => screen.queryByRole("dialog", { name: /full screen/ });

  it("opens over the whole window, with the details in a sidebar", async () => {
    const slot = await openRun(makeRun());
    expect(layer()).toBeNull();

    fireEvent.click(slot.getByRole("button", { name: "Full screen" }));

    const opened = await waitFor(() => {
      const found = layer();
      expect(found).not.toBeNull();
      return found!;
    });
    expect(opened.parentElement).toBe(document.body);
    expect(
      within(opened).getByText(/Click a node to see its prompt/),
    ).toBeTruthy();
    expect(within(opened).getByRole("button", { name: /Leave full screen/ })).toBeTruthy();
    // The inline view steps aside rather than rendering a second canvas.
    expect(slot.queryByRole("button", { name: "Full screen" })).toBeNull();
  });

  // The one rule the mode lives or dies by. A waiting node looks much like a
  // working one on the canvas, so hiding the question would leave a run
  // stopped with nothing anywhere saying why — this project's recurring bug,
  // rebuilt as a feature.
  it("keeps a pending question visible in full screen", async () => {
    const slot = await openRun(
      makeRun({
        status: "waiting-human",
        pendingQuestion: {
          nodeId: "approval",
          label: "Approval",
          question: "Does the concept hold?",
        },
      }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Full screen" }));

    const opened = await waitFor(() => {
      const found = layer();
      expect(found).not.toBeNull();
      return found!;
    });
    expect(within(opened).getByText("Does the concept hold?")).toBeTruthy();
    expect(within(opened).getByLabelText("Answer to the approval")).toBeTruthy();
  });

  // The question is usually Markdown; as plain text a table is a wall of pipes.
  it("hands the question to the host Markdown renderer", async () => {
    const slot = await openRun(
      makeRun({
        status: "waiting-human",
        pendingQuestion: {
          nodeId: "approval",
          label: "Approval",
          question: "**Move these?**\n\n| Note | Target |\n| --- | --- |\n| a.md | Projects |",
        },
      }),
    );
    // The host renders Markdown; the harness stands in with a marked div, so
    // what can be checked here is that the question goes to it, whole.
    const rendered = await slot.findByTestId("bb-markdown");
    expect(rendered.textContent).toContain("| a.md | Projects |");
    expect(rendered.tagName).not.toBe("P");
  });

  it("answers the approval it showed, naming its node", async () => {
    const calls: unknown[] = [];
    const waiting = makeRun({
      status: "waiting-human",
      pendingQuestion: { nodeId: "approval", label: "Approval", question: "Go?" },
    });
    const slot = panel({
      listRuns: () => ({ runs: [waiting] }),
      answerHuman: (input: unknown) => {
        calls.push(input);
        return { run: null };
      },
    });
    fireEvent.click(await slot.findByText(/A task/));
    fireEvent.change(await slot.findByLabelText("Answer to the approval"), {
      target: { value: "yes" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ runId: "run_1", answer: "yes", nodeId: "approval" });
  });

  it("comes back with Escape", async () => {
    const slot = await openRun(makeRun());
    fireEvent.click(slot.getByRole("button", { name: "Full screen" }));
    await waitFor(() => expect(layer()).not.toBeNull());

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(layer()).toBeNull());
    expect(await slot.findByRole("button", { name: "Full screen" })).toBeTruthy();
  });
});

/**
 * The host keeps one panel component alive and swaps `threadId` underneath it.
 * Everything the panel shows therefore has to be scoped to the thread by hand
 * — without that, the studio was a shared window onto whichever conversation
 * you touched last, which is precisely what a side panel must not be.
 */
describe("kept per thread", () => {
  const graph = TEMPLATES.find((entry) => entry.id === "concept-feature")!;
  const runFor = (threadId: string, id: string, input: string) => ({
    id,
    graphId: graph.id,
    graph,
    threadId,
    projectId: "proj_1",
    input,
    status: "running",
    state: { input, outputs: {}, fields: {}, visits: {}, steps: 0 },
    error: null,
    createdAt: 1,
    updatedAt: 2,
    nodeRuns: [],
    pendingQuestion: null,
  });

  const twoThreads = () => {
    const registration = app.threadPanelActions[0]!;
    const slot = renderSlot(
      registration,
      { threadId: "thr_1", params: null },
      {
        rpc: {
          listGraphs: () => ({ graphs: TEMPLATES, templates: TEMPLATES }),
          listRuns: ({ threadId }: { threadId: string }) => ({
            runs:
              threadId === "thr_1"
                ? [runFor("thr_1", "run_1", "Task A")]
                : [runFor("thr_2", "run_2", "Task B")],
          }),
          listSkills: () => ({ skills: [], error: null }),
        },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    const Component = registration.component!;
    const show = (threadId: string) =>
      slot.lifecycle.rerender(<Component threadId={threadId} params={null} />);
    return { slot, show };
  };

  it("does not carry one thread's open run into the next", async () => {
    const { slot, show } = twoThreads();
    fireEvent.click(await slot.findByText(/Task A/));
    expect(await slot.findByText(/Click a node to see its prompt/)).toBeTruthy();

    show("thr_2");

    // Not merely "some other run": the second thread must land in its own
    // library. A run id it does not own renders as "Loading the run …"
    // forever, because `listRuns` is scoped to the thread and never returns it.
    await waitFor(() => {
      expect(slot.queryByText(/Click a node to see its prompt/)).toBeNull();
    });
    expect(slot.queryByText(/Loading the run/)).toBeNull();
    expect(await slot.findByText(/Task B/)).toBeTruthy();
  });

  it("gives a thread its view back when you return to it", async () => {
    const { slot, show } = twoThreads();
    fireEvent.click(await slot.findByText(/Task A/));
    expect(await slot.findByText(/Click a node to see its prompt/)).toBeTruthy();

    show("thr_2");
    await waitFor(() => {
      expect(slot.queryByText(/Click a node to see its prompt/)).toBeNull();
    });
    show("thr_1");

    expect(await slot.findByText(/Click a node to see its prompt/)).toBeTruthy();
  });

  it("keeps the graph armed in 'Start a run' with the thread that armed it", async () => {
    const { slot, show } = twoThreads();
    const other = TEMPLATES[3]!;
    fireEvent.click((await slot.findAllByLabelText("Graph"))[0]!);
    fireEvent.click(
      slot.getByRole("listbox").querySelector(`#gs-option-${other.id}`)!,
    );
    await waitFor(() => {
      expect(slot.getAllByLabelText("Graph")[0]!.textContent).toContain(other.name);
    });

    show("thr_2");

    await waitFor(() => {
      expect(slot.getAllByLabelText("Graph")[0]!.textContent).toContain(
        TEMPLATES[0]!.name,
      );
    });
  });
});

/**
 * The same run, as a line for the terminal. The value of the button is that
 * the clipboard gets *exactly* what the eye read — so that is what is asserted
 * here, not merely that some copy happened.
 */
describe("copying the command", () => {
  const writes: string[] = [];

  beforeAll(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          writes.push(text);
          return Promise.resolve();
        },
      },
    });
  });
  afterEach(() => {
    writes.length = 0;
  });

  it("offers the graph's own example, not a <task> placeholder", async () => {
    const slot = panel();
    const line = await slot.findByText(/^bb graph-studio run my-graph/);
    expect(line.textContent).toBe(
      `bb graph-studio run my-graph "${mine.example}"`,
    );
    expect(line.textContent).not.toContain("<task>");
  });

  it("follows the task field once something is typed", async () => {
    const slot = panel();
    await slot.findByText(/^bb graph-studio run my-graph/);
    fireEvent.change(slot.getByLabelText("Task"), {
      target: { value: "Something else entirely" },
    });
    expect(
      (await slot.findByText(/^bb graph-studio run my-graph/)).textContent,
    ).toBe('bb graph-studio run my-graph "Something else entirely"');
  });

  it("copies exactly the line that is on screen", async () => {
    const slot = panel();
    const line = await slot.findByText(/^bb graph-studio run my-graph/);
    const command = line.textContent!;
    fireEvent.click(
      slot.getByRole("button", { name: `Copy command: ${command}` }),
    );
    await waitFor(() => expect(writes).toEqual([command]));
    expect(await slot.findByText("Copied")).toBeTruthy();
  });

  // A task with a quote in it is the case that turns a helpful button into a
  // broken paste, and it is invisible until someone actually runs the line.
  it("quotes a task containing double quotes so the shell survives it", async () => {
    const slot = panel();
    await slot.findByText(/^bb graph-studio run my-graph/);
    fireEvent.change(slot.getByLabelText("Task"), {
      target: { value: 'say "hello"' },
    });
    const line = await slot.findByText(/^bb graph-studio run my-graph/);
    expect(line.textContent).toBe(
      'bb graph-studio run my-graph "say \\"hello\\""',
    );
  });
});

/**
 * The grouping was first built into the editor's dropdowns only, and the list
 * people actually use — the run picker — stayed flat. It looked done and was
 * not. These tests assert against the rendered picker, so the next time it
 * only half lands, something says so.
 *
 * Since the picker became a searchable list, the headings are the fine ones
 * from `TEMPLATE_SECTIONS`: the curriculum the order of `TEMPLATES` encodes
 * used to live in the comments between the entries, where no reader saw it.
 */
describe("library grouping in the run picker", () => {
  /** Open the picker and hand back the slot. */
  const open = async () => {
    const slot = panel();
    fireEvent.click(await slot.findByLabelText("Graph"));
    return slot;
  };

  const headings = (slot: Awaited<ReturnType<typeof open>>) =>
    [...slot.getByRole("listbox").parentElement!.querySelectorAll("p")]
      .map((node) => node.textContent ?? "")
      .filter((text) => SECTION_LABELS.includes(text) || text === "Your graphs");

  const optionIds = (slot: Awaited<ReturnType<typeof open>>) =>
    [...slot.getByRole("listbox").querySelectorAll('[role="option"]')].map(
      (node) => node.id.replace("gs-option-", ""),
    );

  it("groups the run picker instead of listing everything flat", async () => {
    const slot = await open();
    expect(headings(slot)).toEqual([
      "Your graphs",
      "Patterns — one step after another",
      "Patterns — one branch chosen",
      "Patterns — several branches at once",
      "Patterns — state and cycles",
      "Patterns — one flow delegating to another",
      "Patterns — reliability, where it is a shape",
      "Work — before there is a task",
      "Work — writing the concept",
      "Work — building",
      "Work — both ends",
    ]);
  });

  it("puts a saved graph first, under its own heading, not among the patterns", async () => {
    const slot = await open();
    expect(headings(slot)[0]).toBe("Your graphs");
    expect(optionIds(slot)[0]).toBe("my-graph");
  });

  it("sorts a pattern and a work template onto different shelves", async () => {
    const slot = await open();
    const headingOf = (id: string) => {
      const option = slot.getByRole("listbox").querySelector(`#gs-option-${id}`)!;
      return option.parentElement!.querySelector("p")!.textContent;
    };
    expect(headingOf("ensemble-vote")).toBe("Patterns — several branches at once");
    expect(headingOf("dev-tdd")).toBe("Work — building");
  });

  it("offers every graph exactly once across the groups", async () => {
    const slot = await open();
    const ids = optionIds(slot);
    expect(ids).toHaveLength(TEMPLATES.length + 1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The point of the search is the pattern vocabulary, not the matching:
   * somebody after "voting" will not guess `ensemble-vote`. Asserted here and
   * not only in `canon.test.ts` because the wiring is its own failure — a
   * field that filters nothing looks exactly like a library with one entry.
   */
  it("narrows the list to what was searched for, by pattern name", async () => {
    const slot = await open();
    fireEvent.change(slot.getByLabelText("Search the library"), {
      target: { value: "voting" },
    });
    await waitFor(() => {
      expect(optionIds(slot)).toEqual(["ensemble-vote"]);
    });
    // And the heading of the one shelf left over, so a narrowed list still
    // says where the hit sits in the catalogue.
    expect(headings(slot)).toEqual(["Patterns — several branches at once"]);
  });

  it("says so when nothing matches, instead of showing an empty list", async () => {
    const slot = await open();
    fireEvent.change(slot.getByLabelText("Search the library"), {
      target: { value: "kubernetes" },
    });
    expect(await slot.findByText(/Nothing matches/)).toBeTruthy();
    expect(optionIds(slot)).toEqual([]);
  });

  it("shows the whole library again for an emptied search field", async () => {
    const slot = await open();
    const field = slot.getByLabelText("Search the library");
    fireEvent.change(field, { target: { value: "voting" } });
    await waitFor(() => expect(optionIds(slot)).toHaveLength(1));
    fireEvent.change(field, { target: { value: "" } });
    await waitFor(() => {
      expect(optionIds(slot)).toHaveLength(TEMPLATES.length + 1);
    });
  });

  /**
   * A row carries three columns plus a subtitle — that is the whole reason the
   * `<select>` had to go, since an `<option>` can hold none of it. A test that
   * only counted rows would stay green with every one of them blank.
   */
  it("shows name, pattern, size and purpose on a row", async () => {
    const slot = await open();
    const row = slot.getByRole("listbox").querySelector("#gs-option-ensemble-vote")!;
    const vote = TEMPLATES.find((graph) => graph.id === "ensemble-vote")!;
    expect(row.textContent).toContain(vote.name);
    expect(row.textContent).toContain("Parallelization — voting");
    expect(row.textContent).toContain(`${vote.nodes.length} nodes`);
    expect(row.textContent).toContain(vote.description);
  });

  it("marks the armed graph as the selected option, and only that one", async () => {
    const slot = await open();
    const selected = [
      ...slot.getByRole("listbox").querySelectorAll('[aria-selected="true"]'),
    ].map((node) => node.id);
    expect(selected).toEqual(["gs-option-my-graph"]);
  });

  it("closes on Escape without changing the armed graph", async () => {
    const slot = await open();
    fireEvent.keyDown(slot.getByRole("listbox"), { key: "Escape" });
    await waitFor(() => expect(slot.queryByRole("listbox")).toBeNull());
    expect(slot.getByLabelText("Graph").textContent).toContain("My Graph");
  });

  it("arms the graph the keyboard walked to when Enter is pressed", async () => {
    const slot = await open();
    const field = slot.getByLabelText("Search the library");
    // From `my-graph`, which is where an opening picker puts the cursor.
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => {
      expect(slot.getByLabelText("Graph").textContent).toContain(TEMPLATES[0]!.name);
    });
  });
});

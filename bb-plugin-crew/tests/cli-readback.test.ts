// `bb crew list|show|ps|work list --json`: what an agent or a script reads back
// without scraping the text. Before, `--json` was taken for an unknown boolean
// flag and the text came back, so a parse failed on "No crews in this project."
import { describe, expect, it } from "vitest";
import { OUTPUT_LIMIT, runCli, type CliResult } from "../lib/cli";
import { PROJECT, running, setup } from "./helpers";

const ctx = { projectId: PROJECT };
/** Resolves like the server: an id or name BB knows, else nothing; no ref means the calling thread's project. */
const known = async (ref: string | null, c: { projectId?: string }) => (ref ? (ref === PROJECT ? ref : null) : (c.projectId ?? null));
const json = (result: CliResult) => JSON.parse(result.stdout ?? "");

describe("bb crew … --json", () => {
  it("list: a parseable array with the counts the text shows, an empty array for no crews, and no crew file text", async () => {
    const empty = setup();
    const none = await runCli(empty.service, ["list", "--project", PROJECT, "--json"], ctx, known);
    expect(none.exitCode).toBe(0);
    expect(json(none)).toEqual([]);

    const { service, port } = setup();
    const { crew } = await running(service, port);
    const listed = await runCli(service, ["list", "--json"], ctx, known);
    expect(listed.exitCode).toBe(0);
    expect(json(listed)).toEqual([{ name: "trio", status: crew.status, fileVersion: crew.fileVersion, members: 3 }]);
    // Projected by name: nothing of the crew file (kickoff, roles) or the row travels along.
    expect(listed.stdout).not.toContain("Reply with OK");
    expect(listed.stdout).not.toContain("Builds.");

    // The text mode is as it was.
    const text = await runCli(service, ["list"], ctx, known);
    expect(text.stdout).toContain("trio");
    expect(() => json(text)).toThrow();
  });

  it("show is an object and ps an array; drift is reported per member; a missing crew is a JSON refusal", async () => {
    const { service, port } = setup();
    const { threads } = await running(service, port);

    const shown = json(await runCli(service, ["show", "trio", "--json"], ctx, known));
    expect(Array.isArray(shown)).toBe(false);
    expect(shown).toMatchObject({ name: "trio", drift: null });
    expect(shown.members.map((member: { address: string }) => member.address).sort()).toEqual(["dev-impl@trio", "dev-review@trio", "orch-lead@trio"]);
    const impl = shown.members.find((member: { key: string }) => member.key === "dev-impl");
    expect(impl).toMatchObject({ threadId: threads["dev-impl"], thread: "present", drift: false, actualProvider: "claude-code" });

    port.threads.get(threads["orch-lead"]!)!.model = "other";
    const drifted = json(await runCli(service, ["ps", "--json"], ctx, known));
    expect(Array.isArray(drifted)).toBe(true);
    const byKey = Object.fromEntries(drifted[0].members.map((member: { key: string }) => [member.key, member]));
    expect(byKey["orch-lead"]).toMatchObject({ drift: true, actualModel: "other" });
    expect(byKey["dev-impl"]).toMatchObject({ drift: false });

    const missing = await runCli(service, ["show", "nosuch", "--json"], ctx, known);
    expect(missing.exitCode).toBe(1);
    expect(json(missing)).toMatchObject({ ok: false, error: { code: "crew_not_found" } });
    expect(missing.stderr).toContain('No crew "nosuch"');
    // Without --json the refusal is stderr only, as before.
    const plain = await runCli(service, ["show", "nosuch"], ctx, known);
    expect(plain.exitCode).toBe(1);
    expect(plain.stdout).toBeUndefined();
  });

  it("work list: items with their owner address, no body; empty is []; --json on a mutating command changes nothing", async () => {
    const { service, port } = setup();
    await running(service, port);
    const before = await runCli(service, ["work", "list", "--crew", "trio", "--json"], ctx, known);
    expect(before.exitCode).toBe(0);
    expect(json(before)).toEqual([]);

    // `work create` is a mutation: --json must not turn its text into JSON, or hide it behind a refusal.
    const created = await runCli(service, ["work", "create", "Build it", "--owner", "dev-impl", "--tier", "p1", "--body", "SECRET BODY", "--crew", "trio", "--json"], ctx, known);
    expect(created.exitCode).toBe(0);
    expect(() => json(created)).toThrow();

    const listed = await runCli(service, ["work", "list", "--crew", "trio", "--json"], ctx, known);
    const items = json(listed);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ crew: "trio", title: "Build it", tier: "p1", owner: "dev-impl@trio", taskKey: null, dueAt: null });
    expect(listed.stdout).not.toContain("SECRET BODY");
    // The same item, as the text prints it.
    const text = await runCli(service, ["work", "list", "--crew", "trio"], ctx, known);
    expect(text.stdout).toContain(`${items[0].id} [${items[0].state}] p1 "Build it" owner dev-impl@trio`);
  });

  it("project: an unknown --project is refused by name, in JSON and in text, and never falls back to the calling thread's project", async () => {
    const { service, port } = setup();
    await running(service, port);

    const unknown = await runCli(service, ["list", "--project", "proj_personal", "--json"], ctx, known);
    expect(unknown.exitCode).toBe(1);
    expect(json(unknown)).toMatchObject({ ok: false, error: { code: "project_not_found" } });
    expect(unknown.stdout).toContain("proj_personal");
    expect(unknown.stdout).not.toContain("trio");
    expect(unknown.stderr).toContain('No project "proj_personal"');

    const text = await runCli(service, ["list", "--project", "proj_personal"], ctx, known);
    expect(text.exitCode).toBe(1);
    expect(text.stdout).toBeUndefined();
    expect(text.stderr).toContain('No project "proj_personal"');

    // The same invocation with a project BB knows reads back.
    const valid = await runCli(service, ["list", "--project", PROJECT, "--json"], {}, known);
    expect(valid.exitCode).toBe(0);
    expect(json(valid)).toHaveLength(1);

    // No project at all keeps its own message and code.
    const nothing = await runCli(service, ["list", "--json"], {}, known);
    expect(nothing.exitCode).toBe(1);
    expect(json(nothing)).toMatchObject({ ok: false, error: { code: "no_project" } });
    expect(nothing.stderr).toContain("--project");
  });
  it("ps returns an empty JSON array while a missing named crew and show without a name are refusals", async () => {
    const { service } = setup();
    const empty = await runCli(service, ["ps", "--json"], ctx, known);
    expect(empty.exitCode).toBe(0);
    expect(json(empty)).toEqual([]);
    const missing = await runCli(service, ["ps", "missing", "--json"], ctx, known);
    expect(missing.exitCode).toBe(1);
    expect(json(missing).error.code).toBe("crew_not_found");
    const usage = await runCli(service, ["show", "--json"], ctx, known);
    expect(usage.exitCode).toBe(1);
    expect(json(usage).error.code).toBe("usage");
  });

  it("refuses oversized JSON without truncation, then returns valid JSON when the result fits", async () => {
    const { service, port, db } = setup();
    const { crew } = await running(service, port);
    const item = service.queue.create(crew, { kind: "human" }, { title: "Large result" });
    db.prepare("UPDATE work_items SET closure_note = ? WHERE id = ?").run("x".repeat(OUTPUT_LIMIT), item.id);
    const refused = await runCli(service, ["work", "list", "--crew", "trio", "--json"], ctx, known);
    expect(refused.exitCode).toBe(1);
    expect(json(refused).error.code).toBe("output_too_large");
    expect(refused.stdout!.length).toBeLessThan(OUTPUT_LIMIT);
    db.prepare("UPDATE work_items SET closure_note = NULL WHERE id = ?").run(item.id);
    const accepted = await runCli(service, ["work", "list", "--crew", "trio", "--json"], ctx, known);
    expect(accepted.exitCode).toBe(0);
    expect(json(accepted)[0].id).toBe(item.id);
  });

});

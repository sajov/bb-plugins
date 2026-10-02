# Crew

A persistent agent team for BB. A harness wraps a model; a crew wraps
harnesses.

A crew is described in a `crew.yaml`: groups of members, each with a fixed
address (`dev-owner@my-crew`), its own provider and model, a role and
permissions. `bb crew apply` reconciles the file against BB threads — the
lead's thread is the parent, every member is a child thread — and keeps doing
so as the file changes. Members message each other, share a channel and a work
queue, and several crews in one project coordinate through their leads, BB
Tasks and `main`. You see who works, who waits and who needs you.

Graph Studio describes a flow that ends; a crew is a team that stays. Both
combine: a Graph Studio `member` node runs a step on a crew member instead of
a fresh thread.

![Project overview: all crews of a project with branch, members and the cross-crew feed](../docs/screenshots/crew-overview.png)

![Topology of one crew: groups, members, links and the member card](../docs/screenshots/crew-details.png)

Inspired by [OpenRig](https://github.com/mvschwarz/openrig) for
[herdr](https://github.com/herdrdev/herdr).

## Install

```sh
bb plugin install git:https://github.com/sajov/bb-plugins.git \
  --subdirectory bb-plugin-crew
```

Requires BB with plugin SDK 0.5.29 or newer.

## A crew file

```yaml
version: "1"
name: pair
summary: Owner builds, checker verifies the exact candidate.
instructions: Every handoff names the exact commit or file set.
baseBranch: main
groups:
  - id: dev
    members:
      - id: owner
        lead: true
        provider: claude-code
        model: claude-sonnet-5
        role: Implements exactly one bounded change at a time.
      - id: check
        provider: claude-code
        model: claude-sonnet-5
        permissions: ask
        role: Checks exactly the candidate named in the handoff.
links:
  - { from: dev-owner, to: dev-check, kind: works_with }
  - { from: dev-check, to: dev-owner, kind: escalates_to }
```

Provider and model always sit on the member itself. Writing members get their
own worktree; readers share the crew's.

`skills:` and `graphs:` are optional on crew, group and member, and inherit
the same way `instructions` does (crew → group → member, each name kept
once). `skills:` names skills to prefer, resolved against `~/.bb/skills`,
`~/.bb/skills-generated` and the project's own `.bb/skills`; an unknown name
only warns. `graphs:` names Graph Studio graphs the member may run with
`crew_graph_run`; an unknown graph id only warns too — nothing is installed
or validated beyond the name.

## Running a Graph Studio graph from a member

A member whose `graphs:` list is non-empty gets `crew_graph_run(graph, input)`:
it starts the named graph on Graph Studio, blocks until the run is done,
failed, stopped, or times out, and returns the result with the run id. The
member's address, key and role go into the run's input explicitly; the graph
never sees the member's thread.

Every run is linked back to the member and crew that started it (durably, so
it survives a restart): the Topology tab shows it as a sub-row under the
member with its live status, and **Needs you** gets an entry with reason
`graph-approval` and the waiting human node's question while a run sits on one
— gone again once the run continues or ends. `bb crew stop` cancels a crew's
open runs; `bb crew delete --threads delete` also deletes their worker
threads, since Graph Studio's own threads are not BB children of the
member's thread.

## Usage

```sh
bb crew templates                              # pair, trio, research
bb crew plan trio                              # read-only: one action per member
bb crew apply crew.yaml [--fresh <member>…] [--confirm-full]
bb crew ps                                     # members, thread state, shift, provider/model
bb crew needs                                  # who waits for you, with the question
bb crew send dev-impl@trio "Start with step 1" --subject TASK-1
bb crew log --crew trio [--chain <id>] [--cross-crew]
bb crew merges | approve <mr> | reject <mr> "reason"
bb crew snapshot trio && bb crew restore <snapshot>
bb crew handover dev-impl@trio
bb crew stop trio [--archive]
bb crew delete trio [--threads archive|delete|keep]
```

In the app, **Crews** in the sidebar opens a project overview of all crews.
Each crew has the tabs Topology, Table & Feed and Edit crew file (YAML and
form, BB's provider/model picker, a preview identical to `bb crew plan`, one
Apply button). Member threads carry a header badge, and `::crew{crew="…"}`
renders a live card in chat.

The full command and agent-tool reference is the skill:
[skills/crew/SKILL.md](skills/crew/SKILL.md).

## Crews talking to each other

Several crews in one project — say `api` and `web`, each on its own feature —
can talk across their boundary.

- **Who may talk:** `crossCrew: leads` (default) lets only the leads message
  another crew; other members go through their lead. `open` allows everyone,
  `none` isolates the crew. Between two crews the stricter setting wins. The
  human is reachable from every crew as `human`: `kind: "info"` for status
  reports (no Needs you, nobody waits), `kind: "question"` (default) when an
  answer is needed.
- **How:** a lead calls `crew_send(to: "web-lead@web", …)`; `crew_directory`
  lists all crews of the project with task, status, branch and lead.
- **Waiting on another crew:** `waitsFor: [{ task: TASK-1, until: merged }]` in
  the crew file. When the other crew's work is merged into `baseBranch`, the
  waiting lead is woken exactly once and rebases.
- **Safety:** a reply chain keeps counting steps across crews and stops at
  `maxSteps` (default 6), so two crews cannot ping-pong forever.

Where you see it:

- **Project overview → Project feed** with "cross-crew only": every message
  between crews, including rejected and held ones. Lines between the crew
  cards show lead-to-lead traffic and `waitsFor`.
- **A crew's Table & Feed tab:** messages to and from other crews are marked;
  clicking one shows the whole chain.
- **CLI:** `bb crew log --cross-crew`, `bb crew directory`, `bb crew deps`.

```sh
bb crew send api-lead@api "Is the header schema stable?" --subject TASK-1
bb crew log --cross-crew
bb crew directory
bb crew deps --crew web
```

## Limits

- BB has no read-only permission mode, so `permissions: ask` runs as
  `accept-edits`; a checker stays read-only by its role.
- BB names worktree branches itself (`bb/<title>-<thread>`).
- Merge, rebase and checks run git in the BB server process: the repository
  must be on the machine BB runs on. Worktrees on other hosts are refused with
  a clear reason.
- A member session started before a plugin reload keeps its old tool set until
  it restarts (`bb crew apply --fresh <member>`).
- Sidebar row icons use an experimental SDK API.

## Development

```sh
npm install --include=dev --cache "$TMPDIR/npm-cache"
npx tsc --noEmit
npx vitest run
bb plugin build && bb plugin reload crew
```

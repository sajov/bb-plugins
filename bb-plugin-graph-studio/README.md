# Graph Studio

Build agent graphs that may contain **cycles**, run them against real BB
threads, and watch them execute on a live canvas.

![Graph Studio editor](../docs/screenshots/graph-studio-create.png)

![Graph Studio run in the chat](../docs/screenshots/graph-studio-chat.png)

```sh
bb graph-studio graphs [search]
bb graph-studio show harness-arc
bb graph-studio run evaluator-optimizer "Write the onboarding text for new colleagues"
bb graph-studio status <run-id>
```

## Where it sits

| | BB `workflows` (built-in) | Harness | **Graph Studio** |
|---|---|---|---|
| Authored as | JS script | fixed 5 phases | data, edited in the UI |
| Cycles | no | one hidden rewind | **yes, first-class** |
| Conditional routing | in script code | verdict only | **declarative edges** |
| Parallel fan-out | **yes** | no | yes, static and dynamic |
| Human in the loop | no | per step | **interrupt node** |
| Visualisation | phase list | phase strip | **graph canvas** |
| Durable across reload | yes | run state | **LangGraph checkpoints** |

Graph Studio is the answer to "I want a workflow, but the critic has to be able
to send work back".

## Division of labour

**LangGraph owns** state, edges, cycles, and checkpointing.
**BB owns** execution — threads, worktrees, providers, permissions.

A node is never a model call. It is *spawn a BB thread, wait for it to go idle,
put its last message into the state*. Workers therefore appear in the sidebar,
inherit the parent thread's environment, and run on your existing provider
subscriptions — no separate API keys.

## The graph model

A graph is JSON, not code:

- **Nodes** — `agent` (spawns a thread), `dialog` (spawns a thread that may
  ask back), `member` (hands the step to a persistent [Crew](../bb-plugin-crew)
  member), `human` (pauses for you), `subgraph` (embeds another graph),
  `note`. Each has a prompt with `{{input}}`, `{{node_id}}`,
  `{{node_id.field}}` and `{{item}}` placeholders, plus a `maxVisits` cycle
  guard.
- **Edges** — `from → to`, optionally with a condition. Conditions are a small,
  inspectable language (`always`, `contains`, `notContains`, `equals`,
  `matches`, `visitsBelow`), never arbitrary code, so an edge can be drawn and
  checked before it runs.
- **Routing** — several unconditional edges from one node run **in parallel**.
  Among conditional edges the node's `routing` decides: `first` (the default)
  takes the first match, `every` takes every edge whose condition holds. An
  unconditional edge acts as the fallback. That single rule covers routers,
  loops and fan-outs.
- **Guards** — `maxVisits` per node, `maxAttempts` per visit, `maxSteps` per
  graph and `maxFanOut` per fan-out, so a cycle always terminates.

Every graph also carries an `example`: a real task it is meant for, in plain
words. The name says what a graph does and the description says how — neither
answers "what do I type into it". The example fills the placeholder in the task
field and builds the ready-made `bb graph-studio run <id> "<task>"` line that
sits next to a copy button in the library and the editor.

## Shipped templates

32 of them, read-only; clone one under a new id to edit it. They come in two
groups, because they are two different things.

### Patterns — established flows

A shape you build on. Between them they cover the usual orchestration
catalogue, and the library search matches the catalogue's own vocabulary
(`orchestrator–worker` finds `map-reduce`, `voting` finds `ensemble-vote`).

| Id | What it is |
| --- | --- |
| `prompt-chaining` | One step feeds the next, with a gate that can stop the chain. |
| `routing` | A classifier sends the task to the specialist that fits. |
| `simple-merge` | The same exclusive choice, but the branches converge again. |
| `multi-choice` | Inclusive or: every area named is worked on, in parallel. |
| `deferred-choice` | The graph prepares the ground, a human picks the branch. |
| `parallel-sectioning` | Three independent views, then a merge. |
| `ensemble-vote` | Three attempts at the same question, then a tally. |
| `map-reduce` | One node works out the units, each gets its own thread. |
| `plan-and-execute` | A planner produces steps; the run decides how many. |
| `debate` | Positions answer the question, then each other, round by round, until a moderator calls it. |
| `milestone` | A later step waits on evidence gathered further back. |
| `state-machine` | A field holds the state, the edges are the transitions. |
| `evaluator-optimizer` | Draft → critique → revise until it holds. |
| `react-loop` | Reason → act → observe, every round its own thread. |
| `harness-arc` | Explore → Plan → Build → Review → Hand over, with a back edge. |
| `supervisor` | A lead delegates, gets control back, decides again. |
| `hierarchical` | One step is a whole flow of its own, as a subgraph. |
| `swarm` | Specialists pass the task among themselves; no lead in the middle. |
| `guardrail` | A check that may refuse, before the irreversible step. |
| `circuit-breaker` | Retry a fixed number of rounds, then hand over to a person. |
| `saga-compensation` | Apply, verify, and undo if the verification fails. |
| `fallback-chain` | The direct route, and a different one when it gives up. |

### Work — flows for this repo

These carry assumptions about how we work here. Their steps run on
[Matt Pocock's skills](https://github.com/mattpocock/skills) (`grilling`,
`tdd`, `code-review`, `codebase-design`, `zoom-out` and others), so install
them first — see [Install](#install).

- **Idea → concept** (`idea-to-concept`) — an interview before there is a task
  at all, then draft and distill. No repo needed.
- **Concept — in waves** (`concept-waves`) — holds one Markdown version while
  you dictate, and is explicitly forbidden from inventing anything.
- **Concept — feature in this repo** (`concept-feature`) — Explore → Draft
  (`codebase-design`) → Grill (`grilling`) → Distill → approval.
- **Concept — architecture & interface** (`concept-architecture`) — Frame
  (`domain-modeling`) → Options (`design-an-interface`) → Decide → Grill →
  Distill.
- **Concept — domain** (`concept-domain`) — Research (`research`) → Draft →
  Grill → Distill. No code involved.
- **Development — concept → plan → build → test** (`dev-tdd`) — the full arc,
  TDD in the worker (`tdd`), `code-review` on the result.
- **Development — bug** (`dev-bugfix`) — Diagnose (`diagnosing-bugs`) → a
  failing reproduction test → fix → test run.
- **Development — refactor in small steps** (`dev-refactor`) — plan
  (`request-refactor-plan`), then step → test → next step, cycling on
  *progress* rather than on failure.
- **Project — concept and build** (`project-end-to-end`) — embeds
  `idea-to-concept` as a subgraph and builds its result.
- **Owner–check loop** (`owner-check-loop`) — runs on a crew instead of fresh
  threads: `dev-owner` builds, `dev-check` checks, a fail goes back, at most
  three laps. Needs the Crew plugin; clone it and replace `my-crew`.

In the development templates the test run is its own node with a declared
`status` field, and `RED` routes back into the work. A worker that judges its
own output talks a red run away; a node that may only answer with the field
cannot.

The concept templates end in the same fixed Markdown skeleton with a 350-word
ceiling. The reason the *writing* is its own node: the node that worked
something out also writes its derivation down. A separate node sees only the
result and the skeleton, so the concept stays the length it was supposed to be.
The critic routes back on `REWORK`, but only for substance — wording is the
distill node's job anyway.

Verdicts use one vocabulary throughout — `APPROVE` / `REWORK` / `BLOCK` for
judgements, `GREEN` / `RED` for test runs. The tokens are deliberately ASCII:
`equals` compares case-insensitively but **not** diacritic-insensitively, so a
token with an umlaut would let a back edge quietly run into nothing as soon as
a model spelled it without.

### Result fields instead of text search

An agent node can declare fields. Its worker then appends a JSON object to its
answer, and edges compare values:

```json
{ "id": "critic", "fields": [
    { "name": "verdict", "type": "enum", "options": ["APPROVE","REWORK","BLOCK"] }
] }
```
```json
{ "from": "critic", "to": "worker",
  "when": { "source": "field", "key": "critic.verdict", "op": "equals", "value": "REWORK" } }
```

Why it matters: a `contains "ENOUGH"` once ended a real run early because the
critic wrote "not good *enough*". A field comparison cannot do that. An edge
reading a field that was never declared is a validation error — so the same
trap is caught before the run starts.

If the worker breaks the contract (no JSON, a missing field, an invalid enum
value), the attempt counts as failed and `maxAttempts` applies.

### Dynamic fan-out

Static fan-out — several unconditional edges — fixes the number of branches
before anything runs. The interesting tasks only learn their width at run time:
"review every changed file" is 7 today and 2 tomorrow.

An edge can therefore fan out over a `list` field:

```json
{ "id": "plan", "fields": [{ "name": "files", "type": "list" }] }
```
```json
{ "from": "plan", "to": "review", "fanOutOver": "plan.files" }
```

The target runs once per entry, in parallel, each instance seeing its entry as
`{{item}}`. The following node reads all results, numbered, through
`{{review}}`.

Why this needed declared fields first: without them there would be no reliable
source for the list — you would have to parse prose and would be back in the
"not good *enough*" trap.

The limits are deliberately tight, because every entry is its own BB thread:

- `maxFanOut` (default 12) caps the branches; what is dropped goes into the log.
- An empty list is not a broken contract but a legitimate "nothing to do" — the
  run ends there and says so.
- A fanning-out node has exactly one outgoing edge, and it carries no condition.
- Approval, dialogue and subgraph nodes cannot be the target: they hold the
  graph up, and n simultaneous questions to one person are not a sensible thing.
- The branches share no field value, so an edge cannot read a field of a
  fanned-out node. All of this is checked before the run starts.

### Joins that actually wait

LangGraph starts a node as soon as **one** incoming edge delivers. With one
edge per branch, a merge node behind two unequal branches ran twice — and its
first run happened before the longer branch had written anything, so the
placeholder for it was empty. Measured against the fake host in
`tests/runtime.test.ts`:

```
before:  split, long1, short, join, long2, join   → join twice
after:   split, long1, short, long2, join         → join once
```

The remedy is LangGraph's join edge, `addEdge(["b1","b2"], "c")`. It cannot be
used for every node with several inputs: in `harness-arc` the build node is
entered from the plan *or* from the critic's back edge, never both, and a join
edge there would wait for a branch that never comes — the run would not fail,
it would hang. `joinSources` (`lib/graph.ts`) therefore decides conservatively
and recognises only the structured case: all incoming edges unconditional, all
branches tracing back through unique single steps to the *same* fan-out, no
branch of that fan-out ending elsewhere, and none of it inside a cycle. Where
it declines but two branches of one fan-out still meet, the validator warns.

### Retry per node

`maxAttempts` (default 2) are attempts for *one* visit — distinct from
`maxVisits`, which counts how often the graph legitimately comes back to a
node. A provider hiccup no longer ends the whole run. Approval nodes are never
retried: `interrupt()` throws on purpose.

### Resume from a step

A finished or failed run can be continued at any point where work was still
outstanding. Completed nodes do not run again — their results come from the
checkpoint. Changes to the graph take effect immediately.

```sh
bb graph-studio checkpoints <run-id>
bb graph-studio rerun <run-id> <checkpoint-id>
```

In the panel: "Resume from a step", under the graph.

### Letting a worker choose the next node

An edge normally names its target. It can instead read it from a declared
field, under "Target from a field" on the edge: the worker that just finished
says who takes over. That is the one thing a swarm has that a supervisor does
not, and `swarm` is the template for it.

Two forms, and they promise different things.

A **choice** field whose options are node ids is the recommended one. The
possible successors are declared, so the canvas draws them as dotted arrows
and the check for unreachable nodes still works. A worker that answers with
anything outside the options fails its contract and is retried, which is a
better failure than a bad route.

A **text** field is the open swarm: any node, decided at run time. The canvas
cannot draw where it goes, the unreachable-node check goes blind for that node,
and validation warns about exactly that. Use it when the successors genuinely
cannot be written down in advance.

Either way the edge's own target stays as the fallback, for when the field
names nothing known. The run log always says where a handoff went, because it
is the one routing decision the drawing cannot show.

### When a step gives up

A node that uses up its attempts ends the run. That is the default and usually
right: without its result there is nothing sensible to do next.

A node can be set to **carry on** instead, under "When the attempts are used
up". Its failure is then recorded rather than thrown, and an edge with the
`failed` condition decides where the run goes — the fallback branch of a
behaviour tree. The fallback node can read why with `{{node.error}}`, so the
second route knows what the first one ran into. `fallback-chain` is that shape
as a template.

Nothing is written to the failed node's result, so `{{node}}` downstream is
empty rather than invented. Two mistakes are refused outright: a `failed` edge
on a node that ends the run can never be taken, and a node behind a dynamic
fan-out has no single outcome to route on.

### When a run ends early

A run that fails or is stopped tells the workers it leaves behind — a branch
still at work, a dialogue thread waiting for an answer nobody will give. They
are not killed: each gets one message saying the run is over, asking it to
write down what it found and stop. The thread stays readable, and so does the
work.

### Dialogue nodes: skills that ask back

An `agent` node is one shot. It waits for the worker to go **idle** — and a
worker waiting for an answer *is* idle, so its question gets recorded as the
result and the run carries on with nobody having replied. A skill built around
an interview (`grilling`: "ask the questions one at a time, waiting for
feedback on each") silently degrades into a monologue.

A `dialog` node keeps one thread open and takes turns:

```
worker asks  →  interrupt()  →  your answer goes into the same thread  →  …
```

Every message the worker sends carries a control block, in the same spirit as
the result fields:

```json
{ "done": false, "question": "exactly one question" }
```

`done: true` ends the interview, and the closing message is the node's result —
carrying the declared fields, so an edge can route on it as usual. `maxTurns`
(default 12) asks for a summary rather than letting an interview run all
evening.

One subtlety worth knowing, because it decides the implementation: LangGraph
re-runs a node from the top after an `interrupt()` and replays the earlier
interrupts from the checkpoint. Everything the node did *before* them happens
again — so a naive dialogue node spawns a fresh thread per question. The open
conversation is therefore recorded in a `dialogs` table and recognised on
replay, and answers already delivered are not sent twice.

### Subgraphs

A `subgraph` node embeds another graph. Its nodes run as part of this run, in
the same LangGraph, on the same state — so a later node reads a result from
*inside* the child with the usual `{{node_id}}` placeholder. That sharing is
the whole point, and the reason node ids have to be unique across the boundary:
two nodes with the same id write the same slot, and the second wins. Each graph
on its own is perfectly valid; only the combination is wrong, so the validator
checks ids across the boundary.

The child is mounted as a **compiled** graph rather than called from a
function. A nested `invoke()` does not throw on `interrupt()` — it returns
`__interrupt__` in its result, and a parent node would have read an unanswered
question as the child's answer: the dialogue-node bug, one level up. Mounted
this way, LangGraph propagates the interrupt into the parent's tasks and
`Command({ resume })` reaches across the boundary.

The rules, all of them against silent failure: no graph embedding itself; no
two graphs embedding each other in a circle; no unknown graph; no child that is
not runnable on its own; no duplicate node ids across the boundary; no subgraph
as the target of a fan-out; and no edge or placeholder pointing at the subgraph
node *itself* — it writes nothing under its own id, its children do.

One deliberate limit: the child is resolved **live** at compile time, not
frozen into the run. `runs.graph_json` holds only the parent. Change an
embedded graph while a run is in flight and the run continues with the new
version from its next step.

### Combining with Crew

Graph Studio describes a flow that ends; [Crew](../bb-plugin-crew) is a team
that stays. They work in both directions:

- **A graph step on a crew member.** A `member` node names `member@crew` and
  delivers its prompt to that member's existing thread instead of spawning a
  worker. The member keeps its context, worktree, provider and model from the
  crew file, so a member node carries no model of its own. Before a run starts,
  every member address is checked against Crew; a missing plugin, an unknown
  member or a member without a thread stops the run with a reason rather than
  silently falling back to a fresh thread. `owner-check-loop` is the ready-made
  example.
- **A crew member running a graph.** A member whose crew file lists
  `graphs:` gets the tool `crew_graph_run`: it starts the graph, waits for the
  result, and the run shows up on the member card. A run waiting on a `human`
  node appears in Crew's **Needs you**.

### Model per node

An `agent` or `dialog` node may say which provider, model, reasoning level and
service tier its worker runs on; left unset it inherits from the parent thread
as before. The point is concrete: in the development templates the plan node
wants a strong model and the test-run node does not need one.

The four fields are **one** decision, not four — BB only honours a model
together with the provider it belongs to. `nodeExecution()` is the single place
that judges what counts as a complete selection, and the validator rejects a
half-filled node instead of letting it look routed and quietly run on the
inherited model.

Two checks, because they answer two different questions. The validator checks
the *shape*, live in the editor. At run start, `unknownModels` checks
*existence* against the model catalogue of the environment the run inherits. An
imported graph can name a model this machine does not have, and BB would fall
back to the inherited one — a silent downgrade where cost and capability differ
and nothing says so. The run aborts instead. Deliberately asymmetric:
fail-closed on a real mismatch, fail-open when the catalogue itself cannot be
read.

The selection is visible in three places, because an invisible assignment
explains nothing later: a badge in the editor's node header, the short name on
the node in the canvas, and `model: provider/model` in `bb graph-studio show`.

### Duration and token use per node

What makes the model choice decidable in the first place. Usage is read in
`onNodeFinish` from BB's `thread/tokenUsage/updated` event — newest first,
limit 1, because those events carry the *running total* and summing them would
give a multiple. Deliberately not live: polling a running thread every superstep
buys a number nobody can act on yet.

**Zero is not zero tokens.** The columns are nullable, and `describeCost` says
nothing about a node without a measurement rather than writing "0 tokens" — a
missing measurement is indistinguishable from a real zero after the fact. The
run total therefore also says how many node runs went into it *without* a
measurement. `describeCost` and `runTotal` live in `lib/describe.ts` and are
shared by CLI and panel: two renderings of the same number drift.

### What a node is doing, while it does it

A node spends its minutes inside `awaitThread`, waiting for a BB worker to go
idle. LangGraph has nothing to say in that time — it emits one event per node,
and that event is "finished" — so the signs of life come from the worker
thread instead:

- **The worker is named as soon as it exists.** `onNodeThread(nodeRunId,
  threadId)` writes the id while the node runs, so "Open child thread" is
  there during the wait rather than after it. On a dialogue node it fires on
  the interrupt replay too, where the conversation is loaded rather than
  spawned.
- **A clock**, from `startedAt`, in the node's bottom-right corner. It takes
  that corner from `max n×` while the node runs and gives it back afterwards.
- **An activity line** under the node: `threads.events.list` with
  `item/started`, newest first, limit 1, polled every 3 s for running nodes
  only. `lib/activity.ts` turns the event into one line — BB's own
  `presentation.label` plus its `title`, so the canvas and the thread describe
  the same moment the same way. Items BB marks `suppress` are skipped, and the
  types that arrive with no presentation at all (`agentMessage`,
  `commandExecution`) get their own wording. The shapes are measured from
  `bb thread log --json`, not inferred from the SDK types: the types put the
  specific part of a line in `detail` and do not list those two types for
  `item/started` at all.

The activity is **in memory, never a column**: it is true for seconds, it is
re-readable from the thread at any time, and a stored copy would come back
after a reload as a claim about the present that nobody is checking. It is
published only when it changes — a node that sits two minutes in one tool call
must not redraw the canvas forty times to say so. When an event says nothing
usable, `describeActivity` returns `null` and the previous line stands; a
placeholder would have overwritten a line that meant something with one that
does not.

## Skills instead of hand-written rules

An agent node can name **BB skills** instead of (or alongside) its prompt:

```json
{ "id": "critic", "label": "Review", "skills": ["code-review"], "prompt": "…" }
```

On spawn the runtime prepends a directive ("First apply the skill
`code-review` …"), and the worker loads the skill itself — progressive
disclosure, so no context ballast. The editor offers the skills available in
the project.

**Limit:** the SDK only lets a plugin configure its *own* manifest skills via
`bb.agents.configure`. Foreign skills therefore cannot be attached hard — they
are named and loaded by the worker. Same effect in practice, but it is an
instruction, not a guarantee.

## Tools for the calling agent

An agent in a BB thread can drive Graph Studio directly:
`graph_studio_graphs` (list the library), `graph_studio_describe` (one graph
with its nodes, edges and the validator's findings), `graph_studio_run` and
`graph_studio_status`. The run takes the parent thread and project from the
call's own context.

Worth knowing when calling `graph_studio_run`: `input` is the **only** context
the run gets. Its workers are fresh threads with no sight of the calling
conversation, and every node after the first reads only what the first one
produced.

## Stored centrally, shareable as a file

Graphs live in `~/.bb/plugins/graph-studio/data.db`, **without** a project
reference: built once, available everywhere. Only *runs* carry `project_id`
and `thread_id`.

To get a graph into a repo, versioned and shareable:

```sh
bb graph-studio export my-graph > .bb/graphs/my-graph.graph.json
bb graph-studio import .bb/graphs/my-graph.graph.json [--overwrite]
bb graph-studio delete my-graph
```

The file format is a versioned envelope (`{ version, graph }`) without
timestamps — those belong to the database row, not to the document. A
hand-written bare graph object is accepted too; schema defaults fill the rest.
Shipped template ids are reserved, and an existing graph is only replaced with
`--overwrite`.

Templates that were renamed keep working: `resolveGraph` looks an unknown id up
in `RENAMED_TEMPLATES` and resolves it, with a line in the log, instead of
quietly finding nothing. That matters for subgraph references, which store a
`graphId` and resolve it at run time.

## Durability

Runs are checkpointed into the plugin's own SQLite database
(`lib/checkpointer.ts`, a `BaseCheckpointSaver` over `bb.storage.database()` —
no native module in the bundle). A plugin reload resumes `running` rows from
their last checkpoint instead of re-running finished nodes.

## Install

```sh
bb plugin install git:https://github.com/sajov/bb-plugins.git \
  --subdirectory bb-plugin-graph-studio
```

The Work templates need Matt Pocock's skills. Without them a worker is told to
apply a skill it cannot find and falls back to the prompt alone:

```sh
npx skills add mattpocock/skills
```

Skills that publish to an issue tracker, commit, or write ADRs and glossaries
(`to-spec`, `to-issues`, `implement`, `grill-with-docs`) are deliberately not
used by a shipped template; nothing leaves the working tree without a human
step.

## Development

```sh
npm install --include=dev --cache "$TMPDIR/npm-cache"
npm run typecheck
npm test
npm run build
bb plugin install . --yes     # first time; afterwards: bb plugin reload graph-studio
```

Requires BB >= 0.42 and Plugin SDK >= 0.4.47.

## License

MIT

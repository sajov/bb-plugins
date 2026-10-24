---
name: crew
description: Build, reconcile and stop a persistent agent team (crew) from a crew.yaml with the `bb crew` CLI, and work inside one as a member (crew_send, crew_peers, …). Use when the user asks for a crew, a fixed team of agents, to message crew members, or to apply/stop/inspect one.
---

# Crew

A crew is a persistent team of agent threads in one BB project. Each member
has a fixed address `{group}-{member}@{crew}` and at most one current thread.
Exactly one member is the lead; every other member's thread nests under the
lead's thread. The crew file (`crew.yaml`) is the declaration; `apply`
reconciles the threads with it.

## Commands

All commands take `--project <id|name>`; inside a BB thread the thread's
project is the default.

```
bb crew templates                         # bundled crew files: pair, trio, research
bb crew plan <crew|template|file.yaml>    # read-only: one action per member
bb crew apply <crew|template|file.yaml> [--fresh <member>…] [--confirm-full]
bb crew list                              # crews of the project with status
bb crew show <crew>                       # members, provider/model, thread, shift
bb crew show <crew> --against <file|template>  # plus one "Drift from file" line (plan prints it too)
bb crew ps [<crew>]                       # same, for all crews when none is named
bb crew stop <crew> [--archive]           # stop running turns; --archive archives
bb crew delete <crew> [--threads archive|delete|keep] [--force]   # remove a stopped crew for good
bb crew export <crew> > crew.yaml         # the stored crew file
bb crew send <member@crew> <text…> [--subject s] [--urgent] [--reply-to msg]   # as the human
bb crew broadcast <crew> [--group g] <text…>                                  # as the human
bb crew log [--crew c] [--chain id] [--cross-crew] [--status s] [--limit n] [--full]
bb crew needs                             # members that need you now, with the question
bb crew whoami                            # inside a member thread: which member this is
bb crew release <msg> | discard <msg>     # deliver or drop a held / loop-stopped message
bb crew stop-chain <chain>                # nothing more on this chain is delivered
```

`<crew|template|file.yaml>`: anything ending in `.yaml`/`.yml` or containing
a `/` is read as a file (relative to the current directory); otherwise a
stored crew of the project, otherwise a template. To customise a template:
`bb crew export` it after one apply, or write the file from scratch.

## Plan actions and apply results

| plan | meaning |
| --- | --- |
| `reuse` | thread bound, exists, not archived, matches |
| `unarchive` | thread bound but archived |
| `spawn` | no thread bound, the bound one is gone, or `--fresh` |
| `update` | title, parent or model differ (provider changes need `--fresh`) |
| `remove` | member no longer in the file; its thread is archived, never deleted |

Apply reports one honest result per member: `reused`, `unarchived`,
`spawned`, `updated`, `removed` or `failed (reason)`. A second apply without
changes reports `reused` for every member and creates no thread. Crew status
is `running`, `degraded` (some member failed), `starting` or `stopped`.

## Crew file

```yaml
version: "1"
name: first-project          # no "." "@" or spaces in any id
summary: Owner builds, checker verifies.
instructions: Every handoff names the exact commit.   # inherited crew → group → member
permissions: accept-edits    # ask | accept-edits | auto | full
environment: auto            # auto | reuse | worktree | host:<id>
groups:
  - id: orch
    members:
      - { id: lead, lead: true, provider: claude-code, model: claude-opus-5-5, role: Plans and assigns. }
  - id: dev
    members:
      - { id: owner, provider: claude-code, model: claude-sonnet-5, role: Implements one change at a time. }
      - { id: check, provider: claude-code, model: claude-sonnet-5, permissions: ask, role: Checks the candidate. }
      # optional per member: reasoningLevel (none|low|medium|high|xhigh|max|ultra|ultracode), serviceTier (default|fast)
links:
  - { from: orch-lead, to: dev-owner, kind: assigns_to }   # assigns_to | works_with | escalates_to | can_read
```

Validation (errors block apply): unique ids, forbidden characters, exactly one
lead (a single member is its own lead), link ends exist, no `assigns_to`
cycle, provider and model set on every member itself (a crew- or
group-level provider/model is an error; stored files are rewritten once on
plugin load, and `add-member` copies missing values from the lead), `full` only with
`--confirm-full`, role + inherited instructions within 4096 characters.
Warnings: provider or model not in this machine's catalogue, several writing
members sharing one environment.

## Environments

`auto` (default): the lead's thread creates the crew environment (a managed
worktree); writing members (`accept-edits`, `auto`, `full`) get their own
managed worktree; reading members (`ask`) reuse the lead's environment.
`reuse` puts everyone in the lead's environment, `worktree` gives every member
its own. BB chooses the worktree branch names itself — the `crew/<crew>`
branch names from the concept cannot be requested with SDK 0.5.29.

## Messaging

Addresses: `dev-impl` (own crew), `dev-impl@crew`, `@group:dev`, `@crew`
(suffix `@<crew>` for another crew), `human`. Every message is stored in the
plugin DB first — refused ones too — and `bb crew log` shows all of them.

Inside a member thread the messaging tools are `crew_whoami`, `crew_peers`,
`crew_send(to, subject?, body, priority?, reply_to?)`, `crew_broadcast` and
`crew_inbox`. They are enabled only for threads whose metadata matches the
member binding in the plugin DB. Incoming messages look like:

```
[crew] From: orch-lead@trio → To: dev-impl@trio
Sent: 2026-09-30T09:12Z · msg msg_… · chain ch_… (step 2/6)
Subject: …
---
<body>
---
Reply with crew_send(to: "orch-lead", reply_to: "msg_…", …)
```

Delivery by recipient state: idle → a new turn; busy → queued behind the
running turn (`queued` counts as delivered and is never resent); open
approval/question → `on_hold` until it is answered, then delivered once; crew
stopped → `on_hold` until the next apply; thread archived or gone → `failed`
with the reason. `urgent` steers a running turn and is allowed only from the
lead and the human. Plugin notices never start a turn.

Rules: a reply inherits the chain and adds one step; the message that would
reach `maxSteps` (default 6) or exceed `maxMessagesPerChainPerHour` (default
20) is `stopped_loop` and its sender shows as Needs you. `messaging: links`
allows only linked pairs (either direction) plus the lead. Across crews the
stricter `crossCrew` of the two crews applies: `leads` (default) lets only
lead talk to lead, `open` anyone, `none` nobody. The human may always write,
and anyone may write to `human`. `crew_send(to: "human", kind: …)`:
`kind: "info"` for status reports — shown in the feed and `bb crew log` as
info, no Needs you, nobody waits, not appended to a question; `kind:
"question"` (default) only when you need an answer — one open question per
member, further ones are appended; the human's answer (`bb crew send`) starts
a new chain. `kind: "info"` to a member is refused.

Needs you (a state of the member, not a list): open approval/question, open
question to the human, stopped loop, thread in error. The panel shows it on
top of the Table & Feed tab and counts it; sidebar rows get an icon (error =
Needs you, running = working, success = unread result).

## Work queue, channel, several crews (E3)

```sh
bb crew work list|create|claim|unclaim|handoff|done|fail … --crew <crew>
bb crew channel <crew> [post <text…>] [--topic <t>] [--since <iso>]
bb crew merges [--all] | approve <mr> | reject <mr> [note…]
bb crew directory | deps [--crew <crew>]
bb crew thread-limit [<n>|off]      # plugin-side limit; BB's own limit is never changed
bb crew tick                        # run follow-ups and the dependency poll now
```

Agent tools: every member has `crew_channel_post/read`, `crew_work_create/
claim/handoff/done/fail/list` and `crew_rebase`; the lead has `crew_deliver`
and `crew_directory` (all members under `crossCrew: open`); a member marked
`integrator: true` (at most one per crew; the role text grants nothing) has
`crew_merges` and `crew_merge`. Live
sessions keep the tool set they started with; new tools arrive with the next
session start (`bb crew apply --fresh <member>`).

- Work items are the record of work. Unclaimed (or claimed and overdue)
  items get follow-ups every minute, rung n after n tier periods (`followUps:
  {p0: 15, p1: 60, p2: 240, p3: 1440}` minutes by default): 1 and 2 remind the
  owner (the lead for unassigned items), 3 escalates along `escalates_to`
  (else the lead, else the human), 4 puts the owner on Needs you
  (`follow-up`) and messages the lead. Each rung is logged once.
- Channel posts wake nobody; `@member-key` becomes a message.
- Integration: `crew_deliver` asks to merge the lead's worktree branch (the
  branch BB picked, `bb/…`) into `baseBranch` (default `main`). Without an
  integrator the lead is on Needs you (`merge-request`) until the human runs
  `bb crew approve|reject`. An integrator merges only when the crew file's
  `checks` command exits 0 in the crew worktree; red checks, a missing
  `checks` or a conflict return the request to the human. Every merge sends a
  non-waking "main moved" note to all running leads. `crew_rebase` aborts on
  conflict and puts the member on Needs you (`merge-conflict`).
- `waitsFor: [{task, until: merged|done|comment:<kw>}]`: polled every minute;
  on fulfilment the waiting lead gets exactly one waking message (for
  `merged`: with the rebase order). The waiting crew's own `task` gets the
  label `wartet-auf:<KEY>` in BB Tasks (created if missing; skipped with a
  stored reason if that fails).
- Lead relief: context from 60 % (members 80 %) shows "Handover suggested",
  a lead at 80 % is on Needs you (`context`). With `deputy:` a cross-crew
  message to a lead busy for longer than `leadBusyTimeout` (10 min) goes to
  the deputy.
- Thread limit: a delivery that would start a turn while the limit is
  reached is `throttled`, leads and human messages go first. The limit is
  read via `bb concurrency-limit status --json` (the SDK has no API for it).

## Lifecycle (E4)

```sh
bb crew snapshot <crew> [--label <text>]    # bindings, open work, undelivered messages, channel cursor
bb crew snapshots <crew>
bb crew restore <snapshot>                  # same bindings, work and messages again, then apply
bb crew reset <member@crew> [--mode clear|new]
bb crew handover <member@crew> [--brief <text>] [--cancel]
bb crew add-member <group>-<id> --crew <crew> [--role r] [--provider p] [--model m] [--permissions p] [--kickoff k] [--confirm-full]
bb crew remove-member <member@crew>
bb crew attach                              # unassigned threads of the project
bb crew attach <threadId> --as <member@crew> [--replace]
bb crew detach <member@crew>
bb crew export <crew> > crew.yaml
bb crew import crew.yaml                    # stores the file, prints the plan, applies nothing
```

- Every new thread for an address is a new **shift** (`shift` in `whoami`).
  A thread that stops being the member's keeps its transcript: it is
  archived (or, after `detach`, left alone) with `retired: true` in its crew
  metadata. Nothing is ever deleted — except by `bb crew delete`.
- `reset --mode clear`: same thread, context cleared, no turn started; the
  kickoff brief rides on the first message the new shift receives. `--mode new`: a fresh thread, the old
  one archived. A lead's new thread takes the members under it.
- `handover`: the member is asked to write a brief and pass it with
  `crew_handover_note(brief)`. Messages to the member are held (`on_hold`,
  reason "handing over") until the new shift starts; the brief becomes a
  work item for the new thread, then the held messages go to the new thread,
  once. `--brief` (the human's brief) completes at once. A member may also
  call `crew_handover_note` on its own, e.g. at "Handover suggested".
- `attach` binds an existing thread of the same project to a member without
  a new thread or restart: it sets the metadata, the title and the parent
  (the lead). Its role instruction applies from the next session start, so
  the kickoff brief arrives as a normal crew message (BB runs it as the
  thread's next turn; the SDK cannot append without dispatching). Refused:
  a thread of another project, one already bound, an archived one, and a
  member that still has a live thread unless `--replace`.
- `add-member`/`remove-member` edit the stored crew file (comments kept)
  and apply it; removing archives the thread. The lead cannot be removed.
- `delete` removes a crew and every row of it (file versions, members,
  bindings, journal, messages, channel, work, escalations, dependencies,
  merge requests, snapshots, handovers) in one transaction. Refused unless the
  crew is `stopped` (run `bb crew stop <crew>` first), and while another crew
  has an open `waitsFor` on this crew's task or the crew has an `open` or
  `returned` merge request — the refusal names them, `--force` deletes anyway
  and prints each as a warning. `--threads archive` (default) archives every
  current and retired member thread; `delete` deletes them, sub-threads first
  (BB does not delete them with the parent), the lead last; `keep` leaves them
  as they are and only removes the crew keys from their plugin metadata.
  Threads that are already gone are reported as `missing`, not as errors. If a
  thread operation fails, no row is removed and the delete can be rerun. A
  cross-crew message stays for the other crew, with the deleted side shown as
  `deleted:<crewId>`; one still waiting for the deleted crew is `rejected`.
  The leads of the other running crews get a directory note. Panel: ⋯ →
  Delete crew… (thread mode, and "Delete anyway" when something blocks).
- `restore` never sends a message twice: one delivered after the snapshot is
  reported as "already delivered".

Lead-only tools: `crew_add_member`, `crew_remove_member`, `crew_reset`,
`crew_status`. Other members do not get them, and a call from an older
session is refused. Removing a member and adding one with `full` ask the
human in the lead's thread first (a Confirm / Decline form). `crew_add_member`
takes provider and model from the crew file (the group's first member, else the
lead), never from the caller.

In chat, `::crew{crew="<name>"}` renders a live card of the crew. The thread
header of a member thread shows `address · Shift n` with Reset, Handover and
Detach.

## For other plugins (RPC contract, `contractVersion: 1`)

`bb.sdk.plugins.callRpc({ pluginId: "crew", method, input })`:

- `resolveMember({projectId, address})` → `{member: {memberId, address, crew, key, lead, role, threadId, shift, activity} | null, error}`
- `sendToMember({projectId, address, body, from, subject?, correlationId})` →
  `{messageId, status, duplicate, error}`. Idempotent: the same
  `correlationId` returns the first message and sends nothing.
- `listMembers({projectId, crew?})` → `{members: […]}`
- `memberReply({messageId})` → `{status: pending|held|running|completed|failed|refused, text, eventCursor, threadId}`:
  the first completed assistant answer after delivery, from whichever shift received it.

## Limits to know

- `ask` maps to BB's `accept-edits` mode: BB has no read-only permission mode.
- Stopping a crew does not archive unless `--archive` is given; a later apply
  unarchives and reports `unarchived`.
- Never delete member threads by hand; remove the member from the file and
  apply, which archives it.

Work items can wait for other items in the same crew: `work create ... --waits-for wi_a,wi_b` (agent: `waits_for`). The human or lead can auditably update them with `work wait <id> --on wi_a,wi_b` or `--clear`. All prerequisites must be done; blocked claims are allowed with a warning. Readiness is announced once per declaration, so restoring an item from a snapshot does not announce it again; dependencies already done at creation do not send a readiness notice.

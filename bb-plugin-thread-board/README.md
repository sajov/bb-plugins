# Thread Board

Every thread on a full-page kanban board, sorted by what it needs next — and a
one-line purpose in every thread header, so sessions left lying around can be
picked up or put away.

## What it shows

- **Board** (sidebar → *Thread Board*): columns *In progress*, *Waiting for you*,
  *Stale* and *Done*. A card is a short headline, project and thread title,
  progress and last activity — a pulsing dot while an agent runs.
- **Detail popup** on click: purpose, the open step and up to four next actions
  the model proposes — on stale threads too — each sent to the thread with its
  number key `1`–`4`. More keys: `↵` open thread, `D` mark done / reopen,
  `R` re-evaluate, `A` archive (done threads, press twice).
- **Purpose bar** in the thread header: progress ring, headline and state; a
  click opens the details with a refresh button and the same next actions on
  `1`–`4`.

## How a column is chosen

Live state first: a running agent is *In progress*, a pending approval is
*Waiting for you*. A manual *done* wins over everything but a running agent.
Then the model: *Done*, or *In progress* for an idle thread with work left but
no question. An unevaluated idle thread has handed the turn back, so it is
*Waiting for you*. Anything not touched for *Stale after (days)* and not done is
*Stale*. *Evaluate N threads* assesses every thread without a headline yet.

## How the purpose is written

When a thread goes idle with new messages, a hidden worker thread reads its
transcript (the first message plus as many recent ones as fit) and replies with
purpose, progress, state and next step. The worker is archived and stopped
straight after. One evaluation runs at a time.

## Settings

| Setting | Default | |
| --- | --- | --- |
| Evaluation model | `claude-opus-5-5` | BB model id of the worker; empty uses the project default |
| Evaluation provider | `claude-code` | provider owning that model |
| Evaluate automatically | on | off: only the refresh button evaluates |
| Minimum minutes between evaluations | 10 | per thread |
| Stale after (days) | 7 | |

## CLI

```sh
bb thread-board purpose [<thread-id>] [--json]
bb thread-board refresh [<thread-id>]
```

## Develop

```sh
npm install --include=dev --cache "$TMPDIR/npm-cache"
npx tsc --noEmit && npx vitest run
bb plugin build && bb plugin reload thread-board
```

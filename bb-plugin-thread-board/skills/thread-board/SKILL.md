---
name: thread-board
description: Read or refresh the model-written purpose, progress and state of a BB thread with `bb thread-board`. Use when asked what a thread is for, where it stands, or which threads wait on the user.
---

# Thread Board

The Thread Board plugin keeps one assessment per thread: a one- or two-sentence
purpose, progress 0–100, a state (`working`, `waiting`, `done`) and, when the
thread waits on the user, the next step they owe.

```sh
bb thread-board purpose [<thread-id>] [--json]   # stored assessment; defaults to the current thread
bb thread-board refresh [<thread-id>]            # queue a fresh evaluation now
```

- An evaluation runs in a hidden worker thread on the model set in the plugin's
  settings (default `claude-opus-5-5` on `claude-code`). It takes as long as one
  agent turn; `refresh` returns at once and the result lands later.
- Evaluations also run on their own when a thread goes idle with new messages,
  at most once per thread per configured interval.
- `purpose` fails with exit code 1 when a thread has never been evaluated.

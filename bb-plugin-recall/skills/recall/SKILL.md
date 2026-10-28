---
name: recall
description: Search earlier BB threads and tasks by meaning with the Recall plugin (recall_search, recall_get, `bb recall`). Use before starting work to find past discussions, decisions and tickets on the same topic.
---

# Recall

Recall mirrors every thread (user and assistant messages, no tool output) and
every BB task, plus any Markdown folders configured in the plugin settings
(e.g. an Obsidian vault), into a local qmd index and fuses it with BB's keyword search.

## Agent tools

- `recall_search({ query, kinds?, mode?, limit? })` — ranked hits with a
  snippet. `kinds` is any of `"thread"`, `"task"`, `"file"`. `mode: "fast"` uses
  keywords only; `"smart"` (default) adds meaning and reranking.
- `recall_get({ kind, id })` — the indexed text of one hit (for files the id
  is the absolute path), capped at 20,000 characters.

Reference threads from a hit as `@thread:<id>`.

## CLI

```sh
bb recall search "how do we publish a plugin" [--kind thread|task] [--mode fast|smart] [--limit 10] [--json]
bb recall status [--json]
bb recall reindex
```

## Constraints

- Needs `qmd` on the server's PATH (`npm i -g @tobilu/qmd`). Without it, only
  BB's keyword search answers and results say "keyword search only".
- The index refreshes every minute. The first full pass embeds every thread
  once and takes minutes; the first smart query after a server start loads
  the models and can take over a minute.
- Recall uses its own qmd index (`--index recall`); the user's default qmd
  index and collections are never touched.


Recall starts inactive until a source is explicitly selected in plugin settings.
For Tasks only, set sourceTasks=true, sourceThreads=false, sourceArchived=false
and leave folders empty. Saved explicit choices are retained; unset sources now
default to false. Status phase inactive means choose sources, not missing qmd.
Timers and reindex cannot enable a source. Disabling sources hides their cached
results; with all sources off existing disk data is retained, not securely erased.

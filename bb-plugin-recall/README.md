# Recall

Find earlier threads and tasks by meaning, not only by exact words.

## What you get

- **Recall: search everything** in the command palette (Mod+S). It opens
  a search window styled like the palette, with Fast (keywords) and Smart
  (meaning, reranked) modes, filters for threads and tasks, and keyboard
  navigation. Enter opens a thread. Mod+Enter continues the search in the
  side panel.
- A **Recall** tab in a thread's right panel with results and a preview of the
  indexed text.
- `recall_search` and `recall_get` tools for agents, and a `bb recall` command
  (`search`, `status`, `reindex`).

## How it works

Recall starts inactive, with all sources off. Select sources in the plugin
settings before it reads or mirrors any corpus. Once selected, every minute
Recall writes changed threads (user and assistant messages, no tool output)
and BB tasks from those sources as Markdown into its own data folder.
It then has [qmd](https://github.com/tobi/qmd) index those files. A search
combines BB's built-in keyword search with qmd's results through reciprocal
rank fusion, so a hit found by both rises to the top. Recall keeps its own qmd
index and never touches your default qmd index or its collections.
Everything runs locally.

## Requirements

`qmd` on the server's PATH (`npm i -g @tobilu/qmd`). Without it, Recall falls
back to BB's keyword search and says so in the results.

## Settings

Settings → Plugins → Recall, or `bb plugin config recall set <key> <value>`:

| Key | Default | Meaning |
| --- | --- | --- |
| `sourceThreads` | false | Index thread messages (never tool output) |
| `sourceArchived` | false | Include archived threads |
| `sourceTasks` | false | Index BB tasks |
| `folders` | empty | Extra Markdown folders, one absolute path per line (e.g. an Obsidian vault) |
| `defaultMode` | smart | Mode used until you switch it in the search window |
| `intervalSeconds` | 60 | How often changes are picked up (minimum 30) |

For Tasks only, explicitly set `sourceTasks=true`, `sourceThreads=false`,
`sourceArchived=false`, and leave `folders` empty. Adding a folder explicitly
selects that folder; archived threads are included only with `sourceThreads`.
No selected source means no mirror, folder scan or qmd probe, even on the
first load, a timer tick, or a reindex request. Status reports `phase: inactive`.
`bb recall reindex` exits with a source-selection message while inactive; the
reindex RPC returns `started: false`.

**Upgrading:** explicitly saved source choices keep their values. Unset fields
now default to false instead of implicitly opting into threads, archived
threads and Tasks. Check the source settings after upgrading if you previously
relied on those defaults. Source changes wake the existing service loop.

Disabled sources are hidden from search and retrieval. While another source
remains active, the next pass removes disabled mirror documents as before.
With all sources off Recall performs no corpus/index I/O; existing mirror and
qmd data remain on disk but are not served. This is not automatic secure erasure
or retroactive cancellation of an already-running pass.

## Measured on one machine (343 threads, 5.9 MB of text, 09.10.2026)

| Step | Time |
| --- | --- |
| First full embedding | about 4 min, once |
| One changed thread, update + embed | 1.6 s |
| Fast search | 0.2 s |
| Smart search through the CLI | about 8 s (qmd loads its models on every call) |

## Development

```sh
npm install --include=dev --cache "$TMPDIR/npm-cache"
npx tsc --noEmit
npx vitest run
bb plugin build && bb plugin reload recall
```

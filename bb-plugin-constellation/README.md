# bb-plugin-constellation

A **Canvas** nav entry for BB: every thread BB lists — chat threads included —
as one navigable tree under Agents → project → thread. Runs on its own; Crew
and Graph Studio are not required.

## Using it

Two areas: the canvas and a resizable panel on its right.

- **Overview** (nothing selected): search and filters, view options, a live
  status board and the legend, each a section that opens and closes.
- **A card's view** (click a card): what it is, its fields, its thread's turns
  and tool calls, and a chat that sends to that thread.
- Over the canvas: the zoom (bottom left) and the tool-call terminal, a
  window you can drag anywhere.

Keys: `/` search · `J` next running work · `T` tool-call terminal · `]` hide
or show the panel · `Esc` back to the overview · `⌘↵` send a chat message.

The canvas itself (layout, cards, sidebar) is the shared `bb-canvas` source,
vendored into `vendor/bb-canvas/` by `bash bb-canvas/scripts/sync.sh`;
`tests/vendor-drift.test.ts` fails when the copy and the source differ.

`lib/notify.ts` holds the `canvas.notify` prototype (SDK >= 0.6.15) for
extensions that push their own layers later.

```bash
npm install
npm test
npm run typecheck
```

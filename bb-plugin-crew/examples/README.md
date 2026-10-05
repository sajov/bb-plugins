# Examples

Two topologies for the same kind of work, to show that crew is a runtime, not
a fixed team shape.

- `pipeline.yaml` — an isolated pipeline (grill → spec → tickets → implement →
  review). Members never message each other; the lead assigns and collects
  artifacts, and `messaging: links` means only the declared `assigns_to` /
  `escalates_to` links may carry messages at all. This is the shape to pick
  for agentic coding, where a fresh context per step and a reviewer blind to
  the implementation matter more than a shared channel.
- `team.yaml` — a communicating team. `dev-impl` and `dev-review` message each
  other directly (`works_with` both ways) while the lead still plans and
  merges. Use this when the work genuinely needs a shared channel between two
  members, not as the default.

Try either with:

```sh
bb crew apply bb-plugin-crew/examples/pipeline.yaml
bb crew apply bb-plugin-crew/examples/team.yaml
```

`tests/examples.test.ts` loads both files through the real parser and
validator (`parseCrewYaml` / `validateCrew`) and asserts they come back
without problems.

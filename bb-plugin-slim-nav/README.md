# Slim Nav

A BB plugin that turns the main sidebar navigation into icon-only buttons, so
the thread list gets more vertical room.

- Icon-only buttons in three densities: 28px (compact), 34px (cozy), 40px
  (roomy). Touch devices always use 40px.
- Renders BB's own navigation component, so saved order, hidden items, routing,
  keyboard shortcuts and split gestures keep working unchanged.
- Labels stay in the accessibility tree and are mirrored into hover tooltips.
- Optional removal of the divider below the navigation.

## Install

```sh
bb plugin install git:https://github.com/sajov/bb-plugins.git \
  --subdirectory bb-plugin-slim-nav
```

Then select **Settings → Appearance → Navigation → Slim Nav**.

## Settings

Under the plugin's settings section:

| Setting | Default | Effect |
| --- | --- | --- |
| Icon density | `compact` | Button size: `compact` 28px, `cozy` 34px, `roomy` 40px. |
| Hide the divider below navigation | on | Removes the separator above the thread list. |

## Customize the items

**More (…) → Customize sidebar** reorders items and toggles visibility, exactly
as with the built-in navigation — the customize-mode editor is deliberately left
unstyled so it keeps its full labels and controls.

Choose **bb (built-in)** under the Navigation setting, or disable the plugin, to
restore the original navigation.

## Development

```sh
npm install --include=dev
npm run typecheck
npm run build
bb plugin install . --yes
```

Requires BB >= 0.42 and Plugin SDK >= 0.4.47.

The stylesheet targets host DOM attributes (`data-testid`,
`data-sidebar-navigation-*`). Those are not a stable contract, so a BB UI change
can require an update here.

## Credit

The idea and the DOM-styling approach follow
[Compact Nav](https://github.com/SawyerHood/sawyer-plugins/tree/main/plugins/compact-nav)
by Sawyer Hood (MIT).

## License

MIT

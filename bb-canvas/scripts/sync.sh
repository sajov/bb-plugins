#!/usr/bin/env bash
# Copies bb-canvas's source into <plugin>/vendor/bb-canvas/ of every plugin
# that uses it: the Canvas plugin gets lib/ and components/; crew and Graph
# Studio only build layers for it, so they get lib/ alone (BBP-193). The copy is checked in: a plugin is built and
# installed on its own (path: or marketplace source), so it must never import
# from outside its folder. Each plugin's vendor-drift test fails when the copy
# and this source differ — run this script after every change here.
#
#   bash bb-canvas/scripts/sync.sh            # all plugins below
#   bash bb-canvas/scripts/sync.sh bb-plugin-crew
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
plugins=("$@")
[ ${#plugins[@]} -eq 0 ] && plugins=(bb-plugin-graph-studio bb-plugin-crew bb-plugin-constellation)

for plugin in "${plugins[@]}"; do
  target="$root/$plugin/vendor/bb-canvas"
  rm -rf "$target"
  mkdir -p "$target"
  dirs=(lib)
  [ "$plugin" = bb-plugin-constellation ] && dirs=(lib components)
  for dir in "${dirs[@]}"; do
    cp -R "$root/bb-canvas/$dir" "$target/$dir"
  done
  echo "synced bb-canvas -> $plugin/vendor/bb-canvas"
done

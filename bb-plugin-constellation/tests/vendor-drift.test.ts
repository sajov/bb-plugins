// vendor/bb-canvas/ is a checked-in copy of the repo's bb-canvas/ source
// (bb-canvas/scripts/sync.sh). A hand edit to the copy, or a source change
// nobody synced, turns this red instead of shipping two diverging canvases.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const plugin = fileURLToPath(new URL("..", import.meta.url));
const source = join(plugin, "..", "bb-canvas");
const copy = join(plugin, "vendor", "bb-canvas");

function files(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(relative(dir, path), readFileSync(path, "utf8"));
    }
  };
  for (const sub of ["lib", "components"]) walk(join(dir, sub));
  return out;
}

describe("vendor/bb-canvas", () => {
  it("matches bb-canvas/ byte for byte (run bash bb-canvas/scripts/sync.sh)", () => {
    const want = files(source);
    const have = files(copy);
    expect([...have.keys()].sort()).toEqual([...want.keys()].sort());
    for (const [path, text] of want) expect(have.get(path), path).toBe(text);
  });
});

// BBP-83: the human saw dark fragments in the light theme — surfaces with a
// hard-coded dark hex. Every colour in the plugin's UI comes from the BB theme.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const sources = ["app.tsx", ...readdirSync(join(root, "components")).filter((name) => name.endsWith(".tsx")).map((name) => `components/${name}`)];
const HEX_CLASS = /\b(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke|outline)-\[#[0-9a-fA-F]{3,8}\]/g;

describe("theme tokens only (BBP-83)", () => {
  it("no UI source uses a hard-coded hex colour class", () => {
    const offenders = sources.flatMap((file) => (readFileSync(join(root, file), "utf8").match(HEX_CLASS) ?? []).map((hit) => `${file}: ${hit}`));
    expect(offenders).toEqual([]);
  });

  it("the check itself catches a hex class (positive case)", () => {
    expect('className="border border-[#1f1f22] hover:bg-[#1a1a1c]"'.match(HEX_CLASS)).toEqual(["border-[#1f1f22]", "hover:bg-[#1a1a1c]"]);
  });
});

describe("activity dots follow the theme (BBP-83)", () => {
  it("every activity tone is a theme variable; needs you reads as destructive", async () => {
    const { activityTone } = await import("../lib/topology");
    for (const activity of ["working", "idle", "error", "unknown"]) expect(activityTone(activity, false)).toMatch(/^var\(--/);
    expect(activityTone("idle", true)).toBe("var(--destructive)");
    // negative: idle without Needs you is not destructive
    expect(activityTone("idle", false)).not.toBe("var(--destructive)");
  });
});

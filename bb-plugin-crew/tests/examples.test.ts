import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasErrors, parseCrewYaml, validateCrew } from "../lib/spec";

const examplesDir = join(__dirname, "..", "examples");

describe.each(["pipeline.yaml", "team.yaml"])("examples/%s", (file) => {
  it("parses and validates without errors", () => {
    const text = readFileSync(join(examplesDir, file), "utf8");
    const { value, problems: parseProblems } = parseCrewYaml(text);
    expect(parseProblems).toEqual([]);
    const { problems } = validateCrew(value, { skills: null, graphs: null, catalog: null });
    expect(hasErrors(problems)).toBe(false);
  });
});

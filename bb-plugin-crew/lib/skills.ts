// Skill name resolution for crew.yaml's `skills: [...]` field (BBP-29).
//
// Names are matched against SKILL.md frontmatter under three roots: the two
// global directories in ~/.bb (`skills`, `skills-generated`) and the
// project's own `.bb/skills`. Filesystem access is injected so this stays
// testable without touching disk.
import { readdir as nodeReaddir, readFile as nodeReadFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import type { SkillsCatalog } from "./spec";

export type SkillsFs = {
  readdir: (path: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
};

export const nodeSkillsFs: SkillsFs = {
  readdir: (path) => nodeReaddir(path),
  readFile: (path) => nodeReadFile(path, "utf8"),
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

/** The `name:` frontmatter field of `<dir>/SKILL.md`, the directory name when absent, or null when there is no SKILL.md there. */
async function skillName(fs: SkillsFs, dir: string, fallback: string): Promise<string | null> {
  let content: string;
  try {
    content = await fs.readFile(join(dir, "SKILL.md"));
  } catch {
    return null;
  }
  const match = FRONTMATTER.exec(content);
  if (match) {
    const front = YAML.parse(match[1]!) as { name?: unknown } | null;
    if (front && typeof front.name === "string" && front.name.trim() !== "") return front.name.trim();
  }
  return fallback;
}

/** One root's immediate subdirectories that hold a SKILL.md, by their resolved name. */
async function scanRoot(fs: SkillsFs, root: string): Promise<string[]> {
  const entries = await fs.readdir(root).catch(() => []);
  const names: string[] = [];
  for (const entry of entries) {
    const name = await skillName(fs, join(root, entry), entry);
    if (name) names.push(name);
  }
  return names;
}

export type SkillsRoots = {
  /** The user's home directory; global roots are `<homeDir>/.bb/skills` and `<homeDir>/.bb/skills-generated`. */
  homeDir: string;
  /** The project's local checkout path; its root is `<projectPath>/.bb/skills`. Null skips it. */
  projectPath: string | null;
};

/** All skill names known here: global (~/.bb/skills, ~/.bb/skills-generated) and project (<projectPath>/.bb/skills). */
export async function resolveSkillsCatalog(roots: SkillsRoots, fs: SkillsFs = nodeSkillsFs): Promise<SkillsCatalog> {
  const dirs = [join(roots.homeDir, ".bb", "skills"), join(roots.homeDir, ".bb", "skills-generated")];
  if (roots.projectPath) dirs.push(join(roots.projectPath, ".bb", "skills"));
  const names = new Set<string>();
  for (const dir of dirs) {
    for (const name of await scanRoot(fs, dir)) names.add(name);
  }
  return { names };
}

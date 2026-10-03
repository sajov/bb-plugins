import { describe, expect, it } from "vitest";
import { resolveSkillsCatalog, type SkillsFs } from "../lib/skills";

function fakeFs(files: Record<string, string>): SkillsFs {
  return {
    readdir: async (path) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const seen = new Set<string>();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const entry = rest.split("/")[0];
        if (entry) seen.add(entry);
      }
      if (seen.size === 0) throw new Error(`ENOENT: ${path}`);
      return [...seen];
    },
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  };
}

const frontmatter = (name: string) => `---\nname: ${name}\ndescription: test\n---\n\nBody.`;

describe("resolveSkillsCatalog", () => {
  it("positive: finds skills under both global roots and the project root, by frontmatter name", async () => {
    const fs = fakeFs({
      "/home/.bb/skills/memory/SKILL.md": frontmatter("memory"),
      "/home/.bb/skills-generated/plugin-commands/SKILL.md": frontmatter("plugin-commands"),
      "/repo/.bb/skills/local-thing/SKILL.md": frontmatter("local-thing"),
    });
    const catalog = await resolveSkillsCatalog({ homeDir: "/home", projectPath: "/repo" }, fs);
    expect([...catalog.names].sort()).toEqual(["local-thing", "memory", "plugin-commands"]);
  });

  it("positive: a missing frontmatter name falls back to the directory name", async () => {
    const fs = fakeFs({ "/home/.bb/skills/gitlab/SKILL.md": "# Gitlab\n\nNo frontmatter here." });
    const catalog = await resolveSkillsCatalog({ homeDir: "/home", projectPath: null }, fs);
    expect(catalog.names.has("gitlab")).toBe(true);
  });

  it("positive: finds Claude Code skills globally and in the project", async () => {
    const fs = fakeFs({
      "/home/.claude/skills/tdd/SKILL.md": frontmatter("tdd"),
      "/repo/.claude/skills/repo-only/SKILL.md": frontmatter("repo-only"),
    });
    const catalog = await resolveSkillsCatalog({ homeDir: "/home", projectPath: "/repo" }, fs);
    expect([...catalog.names].sort()).toEqual(["repo-only", "tdd"]);
  });

  it("negative: projectPath null skips the project's .claude/skills too", async () => {
    const fs = fakeFs({ "/repo/.claude/skills/repo-only/SKILL.md": frontmatter("repo-only") });
    const catalog = await resolveSkillsCatalog({ homeDir: "/home", projectPath: null }, fs);
    expect(catalog.names.size).toBe(0);
  });

  it("negative: an entry without a SKILL.md is not a skill", async () => {
    const fs = fakeFs({ "/home/.bb/skills/not-a-skill/README.md": "nope" });
    const catalog = await resolveSkillsCatalog({ homeDir: "/home", projectPath: null }, fs);
    expect(catalog.names.size).toBe(0);
  });

  it("negative: a missing root is skipped, not an error", async () => {
    const fs = fakeFs({});
    const catalog = await resolveSkillsCatalog({ homeDir: "/home", projectPath: "/repo" }, fs);
    expect(catalog.names.size).toBe(0);
  });

  it("negative: projectPath null skips the project root entirely", async () => {
    const fs = fakeFs({ "/repo/.bb/skills/local-thing/SKILL.md": frontmatter("local-thing") });
    const catalog = await resolveSkillsCatalog({ homeDir: "/home", projectPath: null }, fs);
    expect(catalog.names.size).toBe(0);
  });
});

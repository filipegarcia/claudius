import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "./agents";
import { assertWithin } from "./safe-path";

/**
 * Skills surface.
 *
 * On disk a skill is a directory containing a `SKILL.md` file with YAML
 * frontmatter (`name`, `description`, sometimes `allowed-tools`) and a
 * markdown body. The SDK loads them per-cwd and per-user; we expose them
 * so the user can browse, edit, create, and delete skills from the web
 * UI — same shape as agents.
 *
 *   user scope    → ~/.claude/skills/<name>/SKILL.md
 *   project scope → <cwd>/.claude/skills/<name>/SKILL.md
 *
 * The web UI exposes the SKILL.md body as a single textarea. Skills with
 * ancillary files (scripts, data) can still be authored via the editor,
 * but creating those side files is a CLI/editor task — this module
 * intentionally only owns SKILL.md.
 */

export type SkillScope = "user" | "project";

export type SkillFile = {
  scope: SkillScope;
  /** Directory name (also used as the skill's identity). */
  name: string;
  /** Absolute path to SKILL.md. */
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
};

export function skillsDir(scope: SkillScope, projectCwd: string): string {
  if (scope === "user") return join(homedir(), ".claude", "skills");
  return join(projectCwd, ".claude", "skills");
}

export function skillPath(scope: SkillScope, projectCwd: string, name: string): string {
  if (!/^[\w.\-]+$/.test(name)) throw new Error("invalid skill name");
  // assertWithin is the path-injection barrier — guarantees the resolved
  // path stays inside the scoped skills directory even if `name` somehow
  // got past the regex (defence-in-depth) and gives CodeQL a recognized
  // sanitizer on the projectCwd → fs.* flow.
  return assertWithin(skillsDir(scope, projectCwd), join(name, "SKILL.md"));
}

export async function listSkills(scope: SkillScope, projectCwd: string): Promise<SkillFile[]> {
  const dir = skillsDir(scope, projectCwd);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return [];
    throw err;
  }
  const out: SkillFile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filename = entry.name;
    if (!/^[\w.\-]+$/.test(filename)) continue; // skip dotfiles, weird names
    const skillFile = join(dir, filename, "SKILL.md");
    try {
      const raw = await fs.readFile(skillFile, "utf8");
      const parsed = parseFrontmatter(raw);
      out.push({
        scope,
        name: filename,
        path: skillFile,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        raw,
      });
    } catch {
      // No SKILL.md — directory isn't actually a skill, skip silently.
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function readSkill(
  scope: SkillScope,
  projectCwd: string,
  name: string,
): Promise<SkillFile | null> {
  const p = skillPath(scope, projectCwd, name);
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = parseFrontmatter(raw);
    return { scope, name, path: p, frontmatter: parsed.frontmatter, body: parsed.body, raw };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeSkill(
  scope: SkillScope,
  projectCwd: string,
  name: string,
  raw: string,
): Promise<void> {
  const p = skillPath(scope, projectCwd, name); // also validates name
  await fs.mkdir(dirname(p), { recursive: true });
  await fs.writeFile(p, raw, "utf8");
}

/**
 * Removes the entire skill directory, including any ancillary files. The
 * directory IS the skill identity, so half-deleting (just SKILL.md) would
 * leave litter that can't be re-created with the same name.
 */
export async function deleteSkill(
  scope: SkillScope,
  projectCwd: string,
  name: string,
): Promise<boolean> {
  if (!/^[\w.\-]+$/.test(name)) throw new Error("invalid skill name");
  const dir = join(skillsDir(scope, projectCwd), name);
  try {
    await fs.rm(dir, { recursive: true, force: false });
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return false;
    throw err;
  }
}

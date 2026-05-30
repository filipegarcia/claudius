import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertWithin, assertAbsoluteUserPath, PathInjectionError } from "./safe-path";

/**
 * Lean plain-text CRUD for Claude Code rule files under `.claude/rules/*.md`.
 *
 * Deliberately simpler than `auto-memory.ts`: a rule file's content is exactly
 * the raw markdown the user typed — NO frontmatter injection, NO type field,
 * NO MEMORY.md index. We list/create/edit/delete the files; the Claude Code CLI
 * is what consumes them at runtime (the bundled SDK does not auto-load them).
 */

export type RuleScope = "user" | "project";

const FILENAME_RE = /^[\w.\-]+\.md$/;

/** Strict whitelist: a bare `*.md` filename with no path components. */
export function isValidRuleFilename(name: string): boolean {
  return FILENAME_RE.test(name);
}

/**
 * Resolve the rules directory for a scope.
 *  - "user"    → ~/.claude/rules
 *  - "project" → <projectCwd>/.claude/rules (cwd must be an absolute path).
 *
 * `assertAbsoluteUserPath` rejects relative paths / null bytes and throws
 * `PathInjectionError` (which the route maps to 400). For project scope a
 * missing cwd is therefore an error, never a silent default.
 */
export function rulesDir(scope: RuleScope, projectCwd?: string | null): string {
  if (scope === "user") {
    return join(homedir(), ".claude", "rules");
  }
  if (!projectCwd) {
    throw new PathInjectionError("project scope requires an absolute cwd");
  }
  return join(assertAbsoluteUserPath(projectCwd), ".claude", "rules");
}

export type RuleFile = {
  name: string;
  path: string;
  size: number;
  modifiedMs: number;
};

export async function listRules(scope: RuleScope, projectCwd?: string | null): Promise<RuleFile[]> {
  const dir = rulesDir(scope, projectCwd);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return [];
    throw err;
  }
  const out: RuleFile[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const p = join(dir, name);
    try {
      const s = await fs.stat(p);
      out.push({ name, path: p, size: s.size, modifiedMs: s.mtimeMs });
    } catch {
      // skip
    }
  }
  out.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return out;
}

export async function readRule(
  scope: RuleScope,
  name: string,
  projectCwd?: string | null,
): Promise<string | null> {
  if (!isValidRuleFilename(name)) return null;
  // assertWithin is the CodeQL `js/path-injection` sanitizer on the
  // homedir/cwd → fs.* flow; FILENAME_RE above is defence-in-depth.
  const target = assertWithin(rulesDir(scope, projectCwd), name);
  try {
    return await fs.readFile(target, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw err;
  }
}

export type WriteRuleResult =
  | { ok: true; name: string; path: string }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

/**
 * Write a rule file with the raw body verbatim. With `overwrite` false (the
 * default) this is a create: O_EXCL means an existing file returns 409. With
 * `overwrite` true this is an edit of an existing file — it requires the file
 * to already exist (404 otherwise) so PATCH never silently creates.
 */
export async function writeRule(
  scope: RuleScope,
  name: string,
  body: string,
  projectCwd?: string | null,
  overwrite = false,
): Promise<WriteRuleResult> {
  if (!isValidRuleFilename(name)) {
    return { ok: false, status: 400, error: "invalid filename" };
  }
  const dir = rulesDir(scope, projectCwd);
  await fs.mkdir(dir, { recursive: true });
  // assertWithin is the path-injection barrier on the homedir/cwd → fs.*
  // flow; `name` already passed isValidRuleFilename, so this is
  // defence-in-depth that also gives CodeQL a recognized sanitizer.
  const target = assertWithin(dir, name);
  if (overwrite) {
    // Edit semantics: the file must already exist or this is a 404. (A plain
    // overwrite write would otherwise create the file silently.)
    try {
      await fs.access(target);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return { ok: false, status: 404, error: "not found" };
      return { ok: false, status: 500, error: e.message };
    }
    try {
      await fs.writeFile(target, body, { encoding: "utf8" });
    } catch (err) {
      return { ok: false, status: 500, error: (err as Error).message };
    }
    return { ok: true, name, path: target };
  }
  try {
    // O_EXCL — if the file exists, fs returns EEXIST; we map that to 409.
    await fs.writeFile(target, body, { flag: "wx", encoding: "utf8" });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") return { ok: false, status: 409, error: "file already exists" };
    return { ok: false, status: 500, error: e.message };
  }
  return { ok: true, name, path: target };
}

export type DeleteRuleResult =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 500; error: string };

export async function deleteRule(
  scope: RuleScope,
  name: string,
  projectCwd?: string | null,
): Promise<DeleteRuleResult> {
  if (!isValidRuleFilename(name)) {
    return { ok: false, status: 400, error: "invalid filename" };
  }
  const target = assertWithin(rulesDir(scope, projectCwd), name);
  try {
    await fs.unlink(target);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ok: false, status: 404, error: "not found" };
    return { ok: false, status: 500, error: e.message };
  }
  return { ok: true };
}

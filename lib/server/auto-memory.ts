import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { assertWithin } from "./safe-path";

/**
 * Mirrors Claude Code's encoding of project paths into the
 * ~/.claude/projects/<encoded>/ directory: every non-alphanumeric character
 * becomes "-" (with no consolidation of runs).
 */
export function encodeProjectDir(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, "-");
}

export function autoMemoryDir(projectCwd: string): string {
  return join(homedir(), ".claude", "projects", encodeProjectDir(projectCwd), "memory");
}

export type MemoryFile = {
  name: string;
  path: string;
  size: number;
  modifiedMs: number;
};

export async function listAutoMemory(projectCwd: string): Promise<MemoryFile[]> {
  const dir = autoMemoryDir(projectCwd);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return [];
    throw err;
  }
  const out: MemoryFile[] = [];
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

export async function readMemoryFile(projectCwd: string, name: string): Promise<string | null> {
  // Strict whitelist on `name` — must be a *.md filename, no path components.
  if (!/^[\w.\-]+\.md$/.test(name)) return null;
  const p = join(autoMemoryDir(projectCwd), name);
  try {
    return await fs.readFile(p, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw err;
  }
}

const FILENAME_RE = /^[\w.\-]+\.md$/;

export function isValidMemoryFilename(name: string): boolean {
  return FILENAME_RE.test(name);
}

export type MemoryType = "user" | "feedback" | "project" | "reference";

export type WriteMemoryInput = {
  filename: string;
  type: MemoryType;
  name: string;
  description: string;
  body: string;
};

export type WriteMemoryResult =
  | { ok: true; name: string; path: string }
  | { ok: false; status: 400 | 409 | 413 | 500; error: string };

/**
 * Writes a new auto-memory file with the canonical frontmatter shape and
 * appends a one-line index entry to MEMORY.md (creating it if missing). Uses
 * O_EXCL on write so attempts to overwrite an existing file return 409.
 */
export async function writeMemoryFile(
  projectCwd: string,
  input: WriteMemoryInput,
): Promise<WriteMemoryResult> {
  if (!isValidMemoryFilename(input.filename)) {
    return { ok: false, status: 400, error: "invalid filename" };
  }
  if (!input.name.trim() || !input.description.trim()) {
    return { ok: false, status: 400, error: "name and description required" };
  }
  if (!["user", "feedback", "project", "reference"].includes(input.type)) {
    return { ok: false, status: 400, error: "invalid type" };
  }
  const dir = autoMemoryDir(projectCwd);
  await fs.mkdir(dir, { recursive: true });
  // assertWithin is the path-injection barrier on the projectCwd → fs.*
  // flow. `input.filename` already passed `isValidMemoryFilename` above,
  // so this is defence-in-depth that also gives CodeQL a recognized
  // sanitizer.
  const target = assertWithin(dir, input.filename);
  const content =
    `---\n` +
    `name: ${input.name}\n` +
    `description: ${input.description}\n` +
    `type: ${input.type}\n` +
    `---\n\n` +
    input.body;
  try {
    // O_EXCL — if the file exists, fs returns EEXIST; we map that to 409.
    await fs.writeFile(target, content, { flag: "wx", encoding: "utf8" });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") return { ok: false, status: 409, error: "file already exists" };
    return { ok: false, status: 500, error: e.message };
  }
  const indexed = await appendMemoryIndex(projectCwd, input.filename, input.name, input.description);
  if (!indexed.ok) {
    // Roll back the memory file we just wrote so a rejected index entry
    // never leaves an unindexed file behind — the write as a whole fails,
    // matching upstream's "explicit error instead of silent truncation"
    // (the index isn't silently left inconsistent with what's on disk).
    // Inline path-injection barrier: CodeQL's js/path-injection sanitizer
    // doesn't propagate through the await + branch above, so re-derive and
    // re-assert right at the fs.unlink call site (mirrors writeAgent in
    // agents.ts — see CLAUDE.md path-safety notes).
    const safeDir = resolve(dir);
    const rollbackTarget = resolve(safeDir, input.filename);
    if (rollbackTarget.startsWith(safeDir + sep)) {
      await fs.unlink(rollbackTarget).catch(() => {});
    }
    return indexed;
  }
  return { ok: true, name: input.filename, path: target };
}

export type ParsedMemory = {
  name: string;
  description: string;
  type: MemoryType | string;
  body: string;
};

/**
 * Loose frontmatter parse — pulls `name`/`description`/`type` from the first
 * `--- … ---` block. Tolerates extra keys; values may be quoted but quotes are
 * preserved verbatim (the writer doesn't quote, so a roundtrip is identity).
 */
export function parseMemoryFrontmatter(raw: string): ParsedMemory | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = m[1];
  const body = m[2];
  const get = (key: string): string | null => {
    const re = new RegExp(`^${key}:\\s*(.*)$`, "m");
    const r = fm.match(re);
    return r ? r[1].trim() : null;
  };
  const name = get("name") ?? "";
  const description = get("description") ?? "";
  const type = get("type") ?? "user";
  if (!name) return null;
  return { name, description, type, body };
}

export type PatchMemoryInput = {
  filename: string;
  description?: string;
  type?: MemoryType;
  body?: string;
};

export type PatchMemoryResult =
  | { ok: true; path: string; parsed: ParsedMemory }
  | { ok: false; status: 400 | 404 | 500; error: string };

/**
 * Rewrite an existing memory file in place. `name` is identity and is
 * preserved from the existing frontmatter; everything else falls back to the
 * existing value when the patch omits it. Also patches the matching
 * `MEMORY.md` index line in place when description changes.
 */
export async function patchMemoryFile(
  projectCwd: string,
  input: PatchMemoryInput,
): Promise<PatchMemoryResult> {
  if (!isValidMemoryFilename(input.filename)) {
    return { ok: false, status: 400, error: "invalid filename" };
  }
  if (input.type && !["user", "feedback", "project", "reference"].includes(input.type)) {
    return { ok: false, status: 400, error: "invalid type" };
  }
  const target = join(autoMemoryDir(projectCwd), input.filename);
  let raw: string;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ok: false, status: 404, error: "not found" };
    return { ok: false, status: 500, error: e.message };
  }
  const parsed = parseMemoryFrontmatter(raw);
  if (!parsed) {
    return { ok: false, status: 400, error: "unparseable frontmatter" };
  }
  const next: ParsedMemory = {
    name: parsed.name, // identity — never patch
    description: input.description ?? parsed.description,
    type: input.type ?? parsed.type,
    body: input.body ?? parsed.body,
  };
  const content =
    `---\n` +
    `name: ${next.name}\n` +
    `description: ${next.description}\n` +
    `type: ${next.type}\n` +
    `---\n\n` +
    next.body;
  try {
    await fs.writeFile(target, content, { encoding: "utf8" });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { ok: false, status: 500, error: e.message };
  }
  if (input.description !== undefined && input.description !== parsed.description) {
    await replaceMemoryIndexLine(projectCwd, input.filename, next.name, next.description);
  }
  return { ok: true, path: target, parsed: next };
}

export type DeleteMemoryResult =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 500; error: string };

/**
 * Removes the memory file and its matching `(<filename>)` line in MEMORY.md
 * (other index lines untouched). Returns 404 if the file is already absent.
 */
export async function deleteMemoryFile(
  projectCwd: string,
  filename: string,
): Promise<DeleteMemoryResult> {
  if (!isValidMemoryFilename(filename)) {
    return { ok: false, status: 400, error: "invalid filename" };
  }
  const target = join(autoMemoryDir(projectCwd), filename);
  try {
    await fs.unlink(target);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ok: false, status: 404, error: "not found" };
    return { ok: false, status: 500, error: e.message };
  }
  await removeMemoryIndexLine(projectCwd, filename);
  return { ok: true };
}

async function replaceMemoryIndexLine(
  projectCwd: string,
  filename: string,
  name: string,
  description: string,
): Promise<void> {
  const indexPath = join(autoMemoryDir(projectCwd), "MEMORY.md");
  let existing = "";
  try {
    existing = await fs.readFile(indexPath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return;
    throw err;
  }
  const marker = `(${filename})`;
  const lines = existing.split("\n");
  let touched = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(marker)) {
      lines[i] = `- [${name}](${filename}) — ${description}`;
      touched = true;
      break;
    }
  }
  if (!touched) return;
  await fs.writeFile(indexPath, lines.join("\n"), "utf8");
}

async function removeMemoryIndexLine(projectCwd: string, filename: string): Promise<void> {
  const indexPath = join(autoMemoryDir(projectCwd), "MEMORY.md");
  let existing: string;
  try {
    existing = await fs.readFile(indexPath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return;
    throw err;
  }
  const marker = `(${filename})`;
  const lines = existing.split("\n");
  const filtered = lines.filter((l) => !l.includes(marker));
  if (filtered.length === lines.length) return;
  await fs.writeFile(indexPath, filtered.join("\n"), "utf8");
}

/**
 * CC 2.1.210 parity: "Memory writes that leave a MEMORY.md index over its
 * read limit now produce an explicit error instead of silent truncation."
 * MEMORY.md is meant to stay a lightweight one-line-per-entry pointer index
 * (the actual content lives in the individual memory files); this is a
 * conservative cap chosen to catch genuinely degenerate growth (hundreds of
 * entries) without flagging normal usage — there is no upstream-documented
 * exact byte limit to mirror, so this is deliberately generous.
 */
export const MEMORY_INDEX_READ_LIMIT_BYTES = 20_000;

/**
 * CC 2.1.211 parity: "Improved the memory index over-limit warning to
 * measure only loaded content, excluding frontmatter and HTML comments."
 * MEMORY.md is generated as a plain pointer index with no frontmatter of
 * its own (see the doc comment above), but nothing stops a user from
 * hand-editing it to prepend a `--- … ---` block or drop in `<!-- -->`
 * annotations (e.g. "don't edit below this line"). Those bytes are never
 * loaded as index *content* — they'd just be noise counted against the
 * limit — so they're stripped before measuring, matching upstream's fix.
 */
export function measureMemoryIndexLoadedBytes(text: string): number {
  const withoutFrontmatter = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const withoutComments = withoutFrontmatter.replace(/<!--[\s\S]*?-->/g, "");
  return Buffer.byteLength(withoutComments, "utf8");
}

export type AppendMemoryIndexResult =
  | { ok: true }
  | { ok: false; status: 413; error: string };

/**
 * Idempotent: if any line in MEMORY.md already references `(<filename>)`, do
 * nothing. Otherwise append `- [<name>](<filename>) — <description>`. Creates
 * MEMORY.md if missing.
 *
 * Refuses (rather than silently truncating) when the append would push
 * MEMORY.md over `MEMORY_INDEX_READ_LIMIT_BYTES` — the caller's memory file
 * itself has already been written to disk by this point, so this only
 * blocks the index entry, never the underlying memory content.
 */
export async function appendMemoryIndex(
  projectCwd: string,
  filename: string,
  name: string,
  description: string,
): Promise<AppendMemoryIndexResult> {
  const dir = autoMemoryDir(projectCwd);
  const indexPath = join(dir, "MEMORY.md");
  let existing = "";
  try {
    existing = await fs.readFile(indexPath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw err;
  }
  // Idempotency check: look for `(<filename>)` substring (markdown link target).
  const marker = `(${filename})`;
  if (existing.includes(marker)) return { ok: true };
  const line = `- [${name}](${filename}) — ${description}\n`;
  // Ensure separation from prior content.
  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const next = existing + sep + line;
  if (measureMemoryIndexLoadedBytes(next) > MEMORY_INDEX_READ_LIMIT_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `MEMORY.md index would exceed its ${MEMORY_INDEX_READ_LIMIT_BYTES}-byte read limit — trim older entries before adding more`,
    };
  }
  await fs.writeFile(indexPath, next, "utf8");
  return { ok: true };
}

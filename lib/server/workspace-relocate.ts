import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { encodeProjectDir } from "./auto-memory";
import { closeDb, openDb, type DB } from "./db";
import { PathInjectionError } from "./safe-path";

/**
 * Moving a workspace's root folder (Workspace settings → Root folder).
 *
 * Everything Claudius knows about a workspace's sessions is keyed by the
 * root path, encoded into `~/.claude/projects/<encoded-root>/`:
 *
 *   - `<sessionId>.jsonl`  — the SDK transcript (source of truth)
 *   - `<sessionId>/`       — per-session sidecars (subagent transcripts,
 *                            spilled tool results)
 *   - `assets/`            — content-addressed chat images (asset-store.ts)
 *   - `.claudius.db`       — our per-workspace SQLite (titles, tasks, usage,
 *                            goals, queued messages, open tabs, …)
 *
 * Re-pointing the workspace at a new root therefore makes every session
 * "disappear" — the list is read from a different, empty directory. This
 * module carries them across.
 *
 * Transcript relocation mirrors what the Claude Code CLI itself does when a
 * session `cd`s into another project (`relocateSessionTranscript`): move the
 * JSONL and its sidecar dir into the new project dir, then append a
 * `{"type":"relocated","sessionId","relocatedCwd"}` entry. The SDK reads that
 * entry from the transcript tail in `getSessionInfo` / `listSessions` (it
 * wins over the `cwd` recorded on the original lines), so a later resume
 * spawns the agent in the NEW root instead of the old one, and the CLI
 * carries the stamp forward in its re-appended session metadata.
 *
 * The DB is merged rather than renamed so moving into a folder that already
 * has Claudius history keeps both sides (rows already present in the
 * destination win on key conflicts).
 */

const SESSION_JSONL_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const DB_FILE = ".claudius.db";

export type RelocateResult = {
  /** Session transcripts moved into the new project dir. */
  moved: number;
  /** Per-session failures — those transcripts stay in the old folder. */
  failed: { sessionId: string; error: string }[];
  /** Set when moving chat assets or merging the Claudius DB failed (transcripts may still have moved). */
  dataError?: string;
};

function projectsBase(): string {
  return resolve(homedir(), ".claude", "projects");
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/**
 * Session ids recorded for `root`: every transcript on disk plus DB-only rows
 * (a session renamed before its first turn flushed has a DB row but no JSONL —
 * `/api/sessions/all` surfaces those too, so they count).
 */
export async function listWorkspaceSessionIds(root: string): Promise<string[]> {
  const base = projectsBase();
  const dir = resolve(base, encodeProjectDir(root));
  if (!dir.startsWith(base + sep)) throw new PathInjectionError("project dir escapes base");
  const ids = new Set<string>();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  for (const name of names) {
    const m = SESSION_JSONL_RE.exec(name);
    if (m) ids.add(m[1]);
  }
  if (names.includes(DB_FILE)) {
    const db = await openDb(root, "readonly").catch(() => null);
    if (db) {
      try {
        const rows = db.prepare("SELECT id FROM sessions WHERE cwd = ?").all(root) as { id: string }[];
        for (const r of rows) ids.add(r.id);
      } catch {
        // pre-v2 DB without a sessions table — transcripts are the full set
      }
    }
  }
  return [...ids];
}

/**
 * Move a directory, merging into the destination when it already exists
 * (existing destination files win — sidecars and assets are keyed by session
 * id / content hash, so a same-named file is the same data).
 */
async function moveDirMerging(src: string, dst: string): Promise<void> {
  const base = projectsBase();
  if (!dst.startsWith(base + sep)) throw new PathInjectionError("destination escapes base");
  if (!(await pathExists(dst))) {
    await fs.rename(src, dst);
    return;
  }
  await fs.cp(src, dst, { recursive: true, force: false, errorOnExist: false });
  await fs.rm(src, { recursive: true, force: true });
}

/** Append the SDK's `relocated` stamp, making sure it starts on its own line. */
async function appendRelocatedStamp(file: string, sessionId: string, toRoot: string): Promise<void> {
  const base = projectsBase();
  if (!file.startsWith(base + sep)) throw new PathInjectionError("transcript escapes base");
  let prefix = "";
  const fh = await fs.open(file, "r");
  try {
    const { size } = await fh.stat();
    if (size > 0) {
      const last = Buffer.alloc(1);
      await fh.read(last, 0, 1, size - 1);
      if (last[0] !== 0x0a) prefix = "\n";
    }
  } finally {
    await fh.close();
  }
  const line = JSON.stringify({ type: "relocated", sessionId, relocatedCwd: toRoot });
  await fs.appendFile(file, `${prefix}${line}\n`, "utf8");
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Re-key every `cwd` column (sessions, commit_drafts, feedback, and any
 * future table that grows one) from the old root to the new one. `OR IGNORE`
 * + the follow-up DELETE resolve key conflicts (commit_drafts is keyed by
 * cwd) in favour of the row already recorded for the destination.
 */
function rekeyCwdColumns(db: DB, fromRoot: string, toRoot: string): void {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all() as { name: string }[];
  for (const { name } of tables) {
    const hasCwd = db
      .prepare("SELECT 1 FROM pragma_table_info(?, 'main') WHERE name = 'cwd'")
      .get(name);
    if (!hasCwd) continue;
    const t = quoteIdent(name);
    db.prepare(`UPDATE OR IGNORE ${t} SET cwd = ? WHERE cwd = ?`).run(toRoot, fromRoot);
    db.prepare(`DELETE FROM ${t} WHERE cwd = ?`).run(fromRoot);
  }
}

type ColumnInfo = { name: string; type: string; pk: number };

/**
 * Copy every row of the old workspace DB into the new one, then delete the
 * old file. Both sides are migrated to the current schema first so their
 * column sets line up; the column intersection is still used so a DB written
 * by a newer build doesn't break the copy.
 */
async function mergeDb(fromRoot: string, toRoot: string, fromDbFile: string): Promise<void> {
  // Bring the source schema up to date, then release it — the cached
  // handles must not outlive the file we're about to delete.
  closeDb(fromRoot);
  await openDb(fromRoot);
  closeDb(fromRoot);

  const dst = await openDb(toRoot);
  dst.prepare("ATTACH DATABASE ? AS reloc_src").run(fromDbFile);
  try {
    dst.transaction(() => {
      // asset_uses → assets is a real FK; defer checks to COMMIT so table
      // order doesn't matter.
      dst.pragma("defer_foreign_keys = ON");
      const tables = dst
        .prepare(
          `SELECT name FROM reloc_src.sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_meta'`,
        )
        .all() as { name: string }[];
      for (const { name } of tables) {
        const dstCols = dst
          .prepare("SELECT name, type, pk FROM pragma_table_info(?, 'main')")
          .all(name) as ColumnInfo[];
        if (dstCols.length === 0) continue; // unknown to this build's schema
        const srcCols = new Set(
          (
            dst.prepare("SELECT name FROM pragma_table_info(?, 'reloc_src')").all(name) as {
              name: string;
            }[]
          ).map((c) => c.name),
        );
        // A lone INTEGER PRIMARY KEY is a rowid alias (loop_ticks.id) — let
        // the destination assign fresh ids instead of colliding with its own.
        const pk = dstCols.filter((c) => c.pk > 0);
        const rowidAlias =
          pk.length === 1 && pk[0].type.toUpperCase() === "INTEGER" ? pk[0].name : null;
        const cols = dstCols
          .filter((c) => c.name !== rowidAlias && srcCols.has(c.name))
          .map((c) => quoteIdent(c.name));
        if (cols.length === 0) continue;
        const list = cols.join(", ");
        const t = quoteIdent(name);
        dst.exec(`INSERT OR IGNORE INTO main.${t} (${list}) SELECT ${list} FROM reloc_src.${t}`);
      }
      rekeyCwdColumns(dst, fromRoot, toRoot);
    })();
  } finally {
    dst.exec("DETACH DATABASE reloc_src");
  }

  for (const suffix of ["", "-wal", "-shm"]) {
    await fs.unlink(fromDbFile + suffix).catch((err: unknown) => {
      if (!isNotFound(err)) throw err;
    });
  }
}

/**
 * Move every session recorded under `fromRoot` so it belongs to `toRoot`.
 *
 * Callers must stop live sessions bound to `fromRoot` first — a running
 * Claude Code process appends to its transcript by path and would recreate
 * the old file mid-move.
 *
 * Per-session and DB failures are collected into the result rather than
 * thrown, so a partial move still reports exactly what landed where.
 */
export async function relocateWorkspaceSessions(
  fromRoot: string,
  toRoot: string,
): Promise<RelocateResult> {
  const result: RelocateResult = { moved: 0, failed: [] };
  if (fromRoot === toRoot) return result;

  const base = projectsBase();
  const fromDir = resolve(base, encodeProjectDir(fromRoot));
  const toDir = resolve(base, encodeProjectDir(toRoot));
  if (!fromDir.startsWith(base + sep) || !toDir.startsWith(base + sep)) {
    throw new PathInjectionError("project dir escapes base");
  }
  // Two roots can encode to the same dir (`/a/b-c` vs `/a/b/c`). Nothing to
  // move on disk then — only the relocated stamps and the DB re-key apply.
  const sameDir = fromDir === toDir;

  let names: string[];
  try {
    names = await fs.readdir(fromDir);
  } catch (err) {
    if (isNotFound(err)) return result;
    throw err;
  }
  if (!sameDir) await fs.mkdir(toDir, { recursive: true });

  for (const name of names) {
    const m = SESSION_JSONL_RE.exec(name);
    if (!m) continue;
    const sessionId = m[1];
    const src = resolve(fromDir, name);
    const dst = resolve(toDir, name);
    if (!dst.startsWith(base + sep)) continue;
    try {
      if (!sameDir) {
        if (await pathExists(dst)) {
          throw new Error("a transcript with this id already exists in the new folder");
        }
        await fs.rename(src, dst);
        const srcSidecar = resolve(fromDir, sessionId);
        if (await pathExists(srcSidecar)) {
          await moveDirMerging(srcSidecar, resolve(toDir, sessionId));
        }
      }
      await appendRelocatedStamp(dst, sessionId, toRoot);
      result.moved++;
    } catch (err) {
      result.failed.push({ sessionId, error: errMessage(err) });
    }
  }

  if (!sameDir && names.includes("assets")) {
    try {
      await moveDirMerging(resolve(fromDir, "assets"), resolve(toDir, "assets"));
    } catch (err) {
      // Chat images referenced by moved sessions stay behind; the sessions
      // themselves are fine. Surface it alongside any DB error.
      result.dataError = `assets: ${errMessage(err)}`;
    }
  }

  if (names.includes(DB_FILE)) {
    try {
      if (sameDir) {
        const db = await openDb(toRoot);
        db.transaction(() => rekeyCwdColumns(db, fromRoot, toRoot))();
      } else {
        await mergeDb(fromRoot, toRoot, resolve(fromDir, DB_FILE));
      }
    } catch (err) {
      result.dataError = result.dataError
        ? `${result.dataError}; database: ${errMessage(err)}`
        : `database: ${errMessage(err)}`;
    }
  }

  // Tidy up an emptied project dir. Anything left (auto-memory, failed
  // transcripts) keeps it alive — rmdir refuses non-empty dirs.
  if (!sameDir) await fs.rmdir(fromDir).catch(() => {});

  return result;
}

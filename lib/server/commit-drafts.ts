import { openDb } from "./db";

/**
 * Per-workspace commit-message draft store.
 *
 * The "Generate" button in `components/git/CommitBox.tsx` produces a
 * commit message via `/api/workspaces/:id/git/commit-message`. Without
 * persistence, leaving the /git page (or hitting refresh) loses that
 * message and the user has to regenerate. This module backs the draft
 * by SQLite so the message survives until either:
 *   - the user commits (we clear), or
 *   - the user regenerates (we overwrite).
 *
 * One row per cwd (one workspace = one active draft). Manual edits aren't
 * persisted yet — only generate fills the row. Adding manual-edit
 * persistence later just means calling `setCommitDraft` on the textarea's
 * onChange (debounced).
 */

export async function getCommitDraft(cwd: string): Promise<string | null> {
  const db = await openDb(cwd, "readonly").catch(() => null);
  if (!db) return null;
  const row = db
    .prepare<[string], { message: string } | undefined>(
      "SELECT message FROM commit_drafts WHERE cwd = ?",
    )
    .get(cwd);
  return row?.message ?? null;
}

export async function setCommitDraft(cwd: string, message: string): Promise<void> {
  const db = await openDb(cwd);
  const trimmed = message.trim();
  if (!trimmed) {
    db.prepare("DELETE FROM commit_drafts WHERE cwd = ?").run(cwd);
    return;
  }
  db.prepare(
    `INSERT INTO commit_drafts(cwd, message, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(cwd) DO UPDATE SET
       message    = excluded.message,
       updated_at = excluded.updated_at`,
  ).run(cwd, trimmed, Date.now());
}

export async function clearCommitDraft(cwd: string): Promise<void> {
  const db = await openDb(cwd);
  db.prepare("DELETE FROM commit_drafts WHERE cwd = ?").run(cwd);
}

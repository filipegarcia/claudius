import { openDb } from "./db";

/**
 * Local record of user feedback (the CLI-style session-quality survey).
 *
 * Submissions are forwarded to Anthropic via the SDK's undocumented
 * `query.submitFeedback` AND persisted here, so a row survives even when the
 * unsupported forward call fails or the method is dropped by an SDK bump.
 * See `lib/server/db-migrations/008_feedback.sql`. Scoped to the per-cwd
 * `.claudius.db`, so workspace isolation is implicit.
 */

export type FeedbackRating = "up" | "down";

export type FeedbackRecord = {
  id: string;
  sessionId?: string | null;
  rating?: FeedbackRating | null;
  comment: string;
  surface?: string | null;
  /** Whether the SDK accepted the forward to Anthropic. */
  forwarded: boolean;
  createdAt: number;
};

type RawRow = {
  id: string;
  session_id: string | null;
  rating: string | null;
  comment: string | null;
  surface: string | null;
  forwarded: number;
  created_at: number;
};

function rowToRecord(row: RawRow): FeedbackRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    rating: (row.rating as FeedbackRating | null) ?? null,
    comment: row.comment ?? "",
    surface: row.surface,
    forwarded: row.forwarded === 1,
    createdAt: row.created_at,
  };
}

export async function insertFeedback(
  cwd: string,
  record: FeedbackRecord,
): Promise<void> {
  const db = await openDb(cwd).catch(() => null);
  if (!db) return;
  db.prepare(
    `INSERT INTO feedback(id, session_id, cwd, rating, comment, surface, forwarded, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.sessionId ?? null,
    cwd,
    record.rating ?? null,
    record.comment,
    record.surface ?? null,
    record.forwarded ? 1 : 0,
    record.createdAt,
  );
}

export async function listFeedback(
  cwd: string,
  limit = 100,
): Promise<FeedbackRecord[]> {
  const db = await openDb(cwd, "readonly").catch(() => null);
  if (!db) return [];
  const rows = db
    .prepare<[number], RawRow>(
      `SELECT id, session_id, rating, comment, surface, forwarded, created_at
         FROM feedback
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(limit);
  return rows.map(rowToRecord);
}

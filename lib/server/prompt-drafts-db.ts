import { openDb } from "./db";

/**
 * Per-session prompt-composer draft store.
 *
 * The composer in `components/chat/PromptInput.tsx` persists its in-progress
 * text + attached images here so that:
 *   - refreshing the page restores what the user was typing,
 *   - switching to another session and back keeps that session's draft
 *     intact (drafts are keyed by session_id, NOT shared globally),
 *   - leaving Claudius and coming back later finds the draft still there.
 *
 * Submitting a prompt clears the row; clearing the textarea to empty also
 * clears the row (so the steady state is "no row" rather than "row with
 * empty text"). Drafts are scoped to the per-workspace `.claudius.db` and
 * naturally inherit workspace isolation.
 */

export type PromptDraftImage = {
  id: string;
  ordinal: number;
  data: string;
  mediaType: string;
};

export type PromptDraft = {
  text: string;
  images: PromptDraftImage[];
  updatedAt: number;
};

type RawRow = {
  text: string;
  images: string;
  updated_at: number;
};

function parseImages(raw: string): PromptDraftImage[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Defensive: drop anything that doesn't look like an AttachedImage.
    return parsed.filter(
      (x): x is PromptDraftImage =>
        x != null &&
        typeof x === "object" &&
        typeof (x as PromptDraftImage).id === "string" &&
        typeof (x as PromptDraftImage).ordinal === "number" &&
        typeof (x as PromptDraftImage).data === "string" &&
        typeof (x as PromptDraftImage).mediaType === "string",
    );
  } catch {
    return [];
  }
}

export async function getPromptDraft(
  cwd: string,
  sessionId: string,
): Promise<PromptDraft | null> {
  const db = await openDb(cwd, "readonly").catch(() => null);
  if (!db) return null;
  const row = db
    .prepare<[string], RawRow | undefined>(
      "SELECT text, images, updated_at FROM prompt_drafts WHERE session_id = ?",
    )
    .get(sessionId);
  if (!row) return null;
  return {
    text: row.text,
    images: parseImages(row.images),
    updatedAt: row.updated_at,
  };
}

export async function setPromptDraft(
  cwd: string,
  sessionId: string,
  text: string,
  images: PromptDraftImage[],
): Promise<void> {
  // Collapse empty drafts to a DELETE — the absence-of-row IS the "no draft"
  // signal, and skipping the write keeps the SQLite file lean when the user
  // clears the textarea.
  if (!text && images.length === 0) {
    return clearPromptDraft(cwd, sessionId);
  }
  const db = await openDb(cwd);
  db.prepare(
    `INSERT INTO prompt_drafts(session_id, text, images, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       text       = excluded.text,
       images     = excluded.images,
       updated_at = excluded.updated_at`,
  ).run(sessionId, text, JSON.stringify(images), Date.now());
}

export async function clearPromptDraft(cwd: string, sessionId: string): Promise<void> {
  const db = await openDb(cwd).catch(() => null);
  if (!db) return;
  db.prepare("DELETE FROM prompt_drafts WHERE session_id = ?").run(sessionId);
}

import { openDb } from "./db";

/**
 * Per-session record of user messages that originated from a clicked
 * "Suggested follow-up" chip (see `components/chat/PromptSuggestions.tsx`).
 *
 * The chat sends a clicked suggestion verbatim as a normal user message; we
 * persist its (session_id, message_uuid) here so the bubble can render an
 * "auto-suggested" badge that survives a reload. On reload the message is
 * replayed from the SDK JSONL with no in-memory provenance, so the client
 * fetches the set of suggested uuids for the session and overlays the badge by
 * uuid match. Scoped to the per-workspace `.claudius.db`.
 */

export async function recordSuggestedMessage(
  cwd: string,
  input: { sessionId: string; messageUuid: string; text: string },
): Promise<void> {
  const { sessionId, messageUuid, text } = input;
  if (!sessionId || !messageUuid) return;
  const db = await openDb(cwd);
  db.prepare(
    `INSERT INTO suggested_messages(session_id, message_uuid, suggestion_text, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, message_uuid) DO UPDATE SET
       suggestion_text = excluded.suggestion_text`,
  ).run(sessionId, messageUuid, text ?? "", Date.now());
}

export async function listSuggestedMessageUuids(
  cwd: string,
  sessionId: string,
): Promise<string[]> {
  const db = await openDb(cwd, "readonly").catch(() => null);
  if (!db) return [];
  const rows = db
    .prepare<[string], { message_uuid: string }>(
      "SELECT message_uuid FROM suggested_messages WHERE session_id = ?",
    )
    .all(sessionId);
  return rows.map((r) => r.message_uuid);
}

import { openDb } from "./db";

/**
 * Per-session record of user messages that were sent as a session goal (see
 * `components/chat/GoalBanner.tsx` and the `/goal` command).
 *
 * Submitting the goal input sends the text as a normal user prompt AND records
 * it as the tracked goal — the agent starts working on it. We persist its
 * (session_id, message_uuid) here so the bubble can render a "Goal" badge that
 * survives a reload. On reload the message is replayed from the SDK JSONL with
 * no in-memory provenance, so the client fetches the set of goal uuids for the
 * session and overlays the badge by uuid match. Scoped to the per-workspace
 * `.claudius.db`. Mirrors `suggested-messages-db.ts`.
 */

export async function recordGoalMessage(
  cwd: string,
  input: { sessionId: string; messageUuid: string; text: string },
): Promise<void> {
  const { sessionId, messageUuid, text } = input;
  if (!sessionId || !messageUuid) return;
  const db = await openDb(cwd);
  db.prepare(
    `INSERT INTO goal_messages(session_id, message_uuid, goal_text, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, message_uuid) DO UPDATE SET
       goal_text = excluded.goal_text`,
  ).run(sessionId, messageUuid, text ?? "", Date.now());
}

export async function listGoalMessageUuids(
  cwd: string,
  sessionId: string,
): Promise<string[]> {
  const db = await openDb(cwd, "readonly").catch(() => null);
  if (!db) return [];
  const rows = db
    .prepare<[string], { message_uuid: string }>(
      "SELECT message_uuid FROM goal_messages WHERE session_id = ?",
    )
    .all(sessionId);
  return rows.map((r) => r.message_uuid);
}

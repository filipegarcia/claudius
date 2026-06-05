import { openDb } from "./db";

/**
 * Per-session FIFO queue of pending user messages. Backs the chat's
 * "queued · sends after current response" strip.
 *
 * The Session object (one in-memory instance per session) is the single writer
 * — all mutations go through `Session.enqueueMessage` / `removeQueued` etc.,
 * which call into these helpers and broadcast `queue:updated` to subscribers.
 * That single-writer invariant means we don't need cross-process locking; a
 * single SQL statement per operation is enough.
 *
 * Positions are monotonic but NOT compacted on remove. "Pop head" = lowest
 * `position`, not literally 0. Reorder = swap positions between two rows.
 * Skipping the renumber-on-delete keeps each operation a single statement.
 *
 * The DB file is per-cwd, so workspace scoping is implicit.
 */

export type QueuedMessageRow = {
  uuid: string;
  sessionId: string;
  position: number;
  text: string;
  images: Array<{ data: string; mediaType: string; ordinal?: number }> | null;
  slash: boolean;
  fromSuggestion: boolean;
  fromGoal: boolean;
  createdAtMs: number;
};

type DbRow = {
  uuid: string;
  session_id: string;
  position: number;
  text: string;
  images_json: string | null;
  slash: number;
  from_suggestion: number;
  from_goal: number;
  created_at_ms: number;
};

function toRow(r: DbRow): QueuedMessageRow {
  let images: QueuedMessageRow["images"] = null;
  if (r.images_json) {
    try {
      const parsed = JSON.parse(r.images_json);
      if (Array.isArray(parsed)) images = parsed as QueuedMessageRow["images"];
    } catch {
      images = null;
    }
  }
  return {
    uuid: r.uuid,
    sessionId: r.session_id,
    position: r.position,
    text: r.text,
    images,
    slash: r.slash === 1,
    fromSuggestion: r.from_suggestion === 1,
    fromGoal: r.from_goal === 1,
    createdAtMs: r.created_at_ms,
  };
}

export async function listQueue(
  cwd: string,
  sessionId: string,
): Promise<QueuedMessageRow[]> {
  const db = await openDb(cwd, "readonly").catch(() => null);
  if (!db) return [];
  const rows = db
    .prepare<[string], DbRow>(
      `SELECT uuid, session_id, position, text, images_json, slash,
              from_suggestion, from_goal, created_at_ms
       FROM queued_messages
       WHERE session_id = ?
       ORDER BY position ASC`,
    )
    .all(sessionId);
  return rows.map(toRow);
}

export async function enqueueTail(
  cwd: string,
  input: {
    sessionId: string;
    uuid: string;
    text: string;
    images?: Array<{ data: string; mediaType: string; ordinal?: number }>;
    slash?: boolean;
    fromSuggestion?: boolean;
    fromGoal?: boolean;
  },
): Promise<QueuedMessageRow> {
  const db = await openDb(cwd);
  const imagesJson =
    input.images && input.images.length > 0 ? JSON.stringify(input.images) : null;
  // Compute next position from MAX(position)+1, or 0 for an empty queue.
  // Wrapped in a transaction so a concurrent enqueueTail can't collide on
  // position (single-writer Session in practice, but transactions are cheap
  // insurance and let us return the final row in one round-trip).
  const tx = db.transaction((): DbRow => {
    const row = db
      .prepare<[string], { next: number }>(
        `SELECT COALESCE(MAX(position) + 1, 0) AS next
         FROM queued_messages WHERE session_id = ?`,
      )
      .get(input.sessionId);
    const position = row?.next ?? 0;
    const createdAtMs = Date.now();
    db.prepare(
      `INSERT INTO queued_messages
         (uuid, session_id, position, text, images_json, slash,
          from_suggestion, from_goal, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.uuid,
      input.sessionId,
      position,
      input.text ?? "",
      imagesJson,
      input.slash ? 1 : 0,
      input.fromSuggestion ? 1 : 0,
      input.fromGoal ? 1 : 0,
      createdAtMs,
    );
    return {
      uuid: input.uuid,
      session_id: input.sessionId,
      position,
      text: input.text ?? "",
      images_json: imagesJson,
      slash: input.slash ? 1 : 0,
      from_suggestion: input.fromSuggestion ? 1 : 0,
      from_goal: input.fromGoal ? 1 : 0,
      created_at_ms: createdAtMs,
    };
  });
  return toRow(tx());
}

/**
 * Atomically read-and-remove the head item (lowest position) for this session.
 * Returns null if the queue is empty. Used by `flushQueueIfIdle()` on the
 * Session to drain one message per turn.
 */
export async function popHead(
  cwd: string,
  sessionId: string,
): Promise<QueuedMessageRow | null> {
  const db = await openDb(cwd);
  const tx = db.transaction((): DbRow | null => {
    const row = db
      .prepare<[string], DbRow>(
        `SELECT uuid, session_id, position, text, images_json, slash,
                from_suggestion, from_goal, created_at_ms
         FROM queued_messages
         WHERE session_id = ?
         ORDER BY position ASC
         LIMIT 1`,
      )
      .get(sessionId);
    if (!row) return null;
    db.prepare(`DELETE FROM queued_messages WHERE uuid = ?`).run(row.uuid);
    return row;
  });
  const popped = tx();
  return popped ? toRow(popped) : null;
}

/**
 * Atomically read-and-remove a specific queued message by uuid. Returns the
 * full row when it was present, null otherwise. Used by `Session.sendQueuedNow`
 * (the "Send now" override on the QueueIndicator strip): we need the original
 * text/images/flags so we can push them into `sendInput()`, AND we need the
 * dequeue to be atomic so a second "Send now" click — or a concurrent drain
 * via `flushQueueIfIdle` — can't re-send the same message.
 */
export async function popByUuid(
  cwd: string,
  sessionId: string,
  uuid: string,
): Promise<QueuedMessageRow | null> {
  const db = await openDb(cwd);
  const tx = db.transaction((): DbRow | null => {
    const row = db
      .prepare<[string, string], DbRow>(
        `SELECT uuid, session_id, position, text, images_json, slash,
                from_suggestion, from_goal, created_at_ms
         FROM queued_messages
         WHERE session_id = ? AND uuid = ?`,
      )
      .get(sessionId, uuid);
    if (!row) return null;
    db.prepare(`DELETE FROM queued_messages WHERE uuid = ?`).run(row.uuid);
    return row;
  });
  const popped = tx();
  return popped ? toRow(popped) : null;
}

export async function removeByUuid(
  cwd: string,
  sessionId: string,
  uuid: string,
): Promise<boolean> {
  const db = await openDb(cwd);
  const res = db
    .prepare(`DELETE FROM queued_messages WHERE session_id = ? AND uuid = ?`)
    .run(sessionId, uuid);
  return res.changes > 0;
}

export async function updateByUuid(
  cwd: string,
  sessionId: string,
  uuid: string,
  patch: {
    text?: string;
    images?: Array<{ data: string; mediaType: string; ordinal?: number }> | null;
  },
): Promise<boolean> {
  const db = await openDb(cwd);
  const sets: string[] = [];
  const args: unknown[] = [];
  if (typeof patch.text === "string") {
    sets.push("text = ?");
    args.push(patch.text);
  }
  if (patch.images !== undefined) {
    sets.push("images_json = ?");
    args.push(
      patch.images && patch.images.length > 0 ? JSON.stringify(patch.images) : null,
    );
  }
  if (sets.length === 0) return false;
  args.push(sessionId, uuid);
  const res = db
    .prepare(
      `UPDATE queued_messages SET ${sets.join(", ")}
       WHERE session_id = ? AND uuid = ?`,
    )
    .run(...args);
  return res.changes > 0;
}

/**
 * Swap this item's position with its neighbor in the requested direction.
 * No-op (returns false) when already at the boundary. Atomic — both rows
 * update inside one transaction so a concurrent reader can't see a
 * duplicate-position window.
 */
export async function moveByUuid(
  cwd: string,
  sessionId: string,
  uuid: string,
  direction: "up" | "down",
): Promise<boolean> {
  const db = await openDb(cwd);
  const tx = db.transaction((): boolean => {
    const self = db
      .prepare<[string, string], { uuid: string; position: number }>(
        `SELECT uuid, position FROM queued_messages
         WHERE session_id = ? AND uuid = ?`,
      )
      .get(sessionId, uuid);
    if (!self) return false;
    const neighborSql =
      direction === "up"
        ? `SELECT uuid, position FROM queued_messages
           WHERE session_id = ? AND position < ?
           ORDER BY position DESC LIMIT 1`
        : `SELECT uuid, position FROM queued_messages
           WHERE session_id = ? AND position > ?
           ORDER BY position ASC LIMIT 1`;
    const neighbor = db
      .prepare<[string, number], { uuid: string; position: number }>(neighborSql)
      .get(sessionId, self.position);
    if (!neighbor) return false;
    // Two-step swap with a sentinel position (-1) to dodge the UNIQUE-ish
    // (session_id, position) collision window. There's no explicit UNIQUE
    // constraint on (session_id, position) today, but the index expects
    // distinct values for ORDER BY determinism, so play it safe.
    db.prepare(`UPDATE queued_messages SET position = -1 WHERE uuid = ?`).run(
      self.uuid,
    );
    db.prepare(`UPDATE queued_messages SET position = ? WHERE uuid = ?`).run(
      self.position,
      neighbor.uuid,
    );
    db.prepare(`UPDATE queued_messages SET position = ? WHERE uuid = ?`).run(
      neighbor.position,
      self.uuid,
    );
    return true;
  });
  return tx();
}

export async function clearAll(cwd: string, sessionId: string): Promise<void> {
  const db = await openDb(cwd);
  db.prepare(`DELETE FROM queued_messages WHERE session_id = ?`).run(sessionId);
}

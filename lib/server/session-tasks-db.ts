import { openDb } from "./db";
import type { TaskSnapshotEntry } from "@/lib/shared/events";

/**
 * Per-session subagent (Task) record store.
 *
 * Subagent metadata (token/tool counts, duration, status, summary) and the
 * subagent's inner conversation are streamed live as transient SSE-only
 * events (`task_progress` / `task_notification`) and `parent_tool_use_id`-
 * tagged messages. None of that is written to the SDK's on-disk JSONL, so
 * once a session is idle-reaped or the server restarts and the session is
 * rebuilt from disk, a Task block loses its counters and its expanded
 * transcript. We persist that derived state here and replay it via the
 * `task_snapshot` SSE event so it survives a refresh.
 *
 * Rows are upserted atomically once per task (on completion); see
 * `lib/server/db-migrations/007_session_tasks.sql`. Scoped to the per-cwd
 * `.claudius.db`, so workspace isolation is implicit.
 */

type RawRow = {
  task_id: string;
  tool_use_id: string | null;
  subagent_type: string | null;
  description: string | null;
  task_type: string | null;
  workflow_name: string | null;
  status: string | null;
  total_tokens: number | null;
  tool_uses: number | null;
  duration_ms: number | null;
  summary: string | null;
  error: string | null;
  inner_messages: string;
};

function parseInnerMessages(raw: string): TaskSnapshotEntry["innerMessages"] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Defensive: keep only `{ message, at? }`-shaped rows.
    return parsed.filter(
      (x): x is { at?: number; message: unknown } =>
        x != null && typeof x === "object" && "message" in (x as object),
    );
  } catch {
    return [];
  }
}

function rowToEntry(row: RawRow): TaskSnapshotEntry {
  return {
    taskId: row.task_id,
    toolUseId: row.tool_use_id ?? undefined,
    subagentType: row.subagent_type ?? undefined,
    description: row.description ?? undefined,
    taskType: row.task_type ?? undefined,
    workflowName: row.workflow_name ?? undefined,
    status: row.status ?? "completed",
    totalTokens: row.total_tokens ?? undefined,
    toolUses: row.tool_uses ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    summary: row.summary ?? undefined,
    error: row.error ?? undefined,
    innerMessages: parseInnerMessages(row.inner_messages),
  };
}

export async function saveSessionTask(
  cwd: string,
  sessionId: string,
  task: TaskSnapshotEntry,
): Promise<void> {
  const db = await openDb(cwd).catch(() => null);
  if (!db) return;
  db.prepare(
    `INSERT INTO session_tasks(
       session_id, task_id, tool_use_id, subagent_type, description,
       task_type, workflow_name, status, total_tokens, tool_uses,
       duration_ms, summary, error, inner_messages, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, task_id) DO UPDATE SET
       tool_use_id    = excluded.tool_use_id,
       subagent_type  = excluded.subagent_type,
       description    = excluded.description,
       task_type      = excluded.task_type,
       workflow_name  = excluded.workflow_name,
       status         = excluded.status,
       total_tokens   = excluded.total_tokens,
       tool_uses      = excluded.tool_uses,
       duration_ms    = excluded.duration_ms,
       summary        = excluded.summary,
       error          = excluded.error,
       inner_messages = excluded.inner_messages,
       updated_at     = excluded.updated_at`,
  ).run(
    sessionId,
    task.taskId,
    task.toolUseId ?? null,
    task.subagentType ?? null,
    task.description ?? null,
    task.taskType ?? null,
    task.workflowName ?? null,
    task.status ?? null,
    task.totalTokens ?? null,
    task.toolUses ?? null,
    task.durationMs ?? null,
    task.summary ?? null,
    task.error ?? null,
    JSON.stringify(task.innerMessages ?? []),
    Date.now(),
  );
}

export async function listSessionTasks(
  cwd: string,
  sessionId: string,
): Promise<TaskSnapshotEntry[]> {
  const db = await openDb(cwd, "readonly").catch(() => null);
  if (!db) return [];
  const rows = db
    .prepare<[string], RawRow>(
      `SELECT task_id, tool_use_id, subagent_type, description, task_type,
              workflow_name, status, total_tokens, tool_uses, duration_ms,
              summary, error, inner_messages
         FROM session_tasks
        WHERE session_id = ?
        ORDER BY updated_at ASC`,
    )
    .all(sessionId);
  return rows.map(rowToEntry);
}

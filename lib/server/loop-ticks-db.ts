import { openDb } from "./db";

/**
 * Persisted history of dynamic-`/loop` (`ScheduleWakeup`) ticks — backs the
 * "Loops" section on the Cost page (Claude Code 2.1.243 parity: "Added a
 * Loops breakdown to /usage"). See `lib/server/db-migrations/017_loop_ticks.sql`
 * for why this table exists (the live `Session.scheduledLoops` map has no
 * history — each tick replaces the last) and for the session-level grouping
 * rationale. Scoped to the per-cwd `.claudius.db`, so workspace isolation is
 * implicit — mirrors `session-tasks-db.ts`.
 */

export type LoopTick = {
  sessionId: string;
  sessionTitle: string | null;
  toolUseId: string;
  prompt: string;
  firedAt: number;
  noop: boolean;
};

export async function recordLoopTick(cwd: string, tick: LoopTick): Promise<void> {
  const db = await openDb(cwd).catch(() => null);
  if (!db) return;
  db.prepare(
    `INSERT INTO loop_ticks(session_id, session_title, tool_use_id, prompt, fired_at, noop, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tool_use_id) DO NOTHING`,
  ).run(
    tick.sessionId,
    tick.sessionTitle,
    tick.toolUseId,
    tick.prompt,
    tick.firedAt,
    tick.noop ? 1 : 0,
    Date.now(),
  );
}

/**
 * Attach the main-loop token usage of the turn that produced this tick, once
 * its `result` message lands. No-op if the tick was never recorded (e.g. the
 * DB write above failed) or already has tokens attached.
 */
export async function attachLoopTickTokens(
  cwd: string,
  toolUseId: string,
  tokens: number,
): Promise<void> {
  const db = await openDb(cwd).catch(() => null);
  if (!db) return;
  db.prepare(
    `UPDATE loop_ticks SET tokens = ? WHERE tool_use_id = ? AND tokens IS NULL`,
  ).run(Math.max(0, Math.round(tokens)), toolUseId);
}

export type LoopBreakdownRow = {
  sessionId: string;
  sessionTitle: string | null;
  runCount: number;
  totalTokens: number;
  tokensPerRun: number;
  lastRun: number;
  lastPrompt: string;
};

type RawBreakdownRow = {
  session_id: string;
  session_title: string | null;
  run_count: number;
  total_tokens: number | null;
  last_run: number;
};

export async function listLoopBreakdown(cwd: string): Promise<LoopBreakdownRow[]> {
  const db = await openDb(cwd, "readonly").catch(() => null);
  if (!db) return [];
  const rows = db
    .prepare(
      `SELECT session_id, MAX(session_title) AS session_title, COUNT(*) AS run_count,
              SUM(COALESCE(tokens, 0)) AS total_tokens, MAX(fired_at) AS last_run
         FROM loop_ticks
        GROUP BY session_id
        ORDER BY last_run DESC`,
    )
    .all() as RawBreakdownRow[];
  // Last-fired prompt per session, for the row's context label. A second
  // query rather than a window function — better-sqlite3's SQLite build
  // supports them, but keeping this simple avoids a fragile ORDER-BY-inside-
  // GROUP_CONCAT trick for a handful of rows on a rarely-heavy table.
  const lastPromptStmt = db.prepare<[string], { prompt: string }>(
    `SELECT prompt FROM loop_ticks WHERE session_id = ? ORDER BY fired_at DESC LIMIT 1`,
  );
  return rows.map((r) => {
    const runCount = r.run_count;
    const totalTokens = r.total_tokens ?? 0;
    return {
      sessionId: r.session_id,
      sessionTitle: r.session_title,
      runCount,
      totalTokens,
      tokensPerRun: runCount > 0 ? Math.round(totalTokens / runCount) : 0,
      lastRun: r.last_run,
      lastPrompt: lastPromptStmt.get(r.session_id)?.prompt ?? "",
    };
  });
}

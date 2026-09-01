import { openDb } from "./db";
import type { SessionUsageTotals } from "@/lib/shared/events";

/**
 * Durable per-session cost/usage accumulator — see
 * `lib/server/db-migrations/019_session_usage.sql` for why this exists
 * (SDK `result` messages never reach the JSONL, and the SDK's own running
 * totals reset on every resume, so without this row the /cost dialog
 * resets whenever a session is rebuilt from disk).
 *
 * Scoped to the per-cwd `.claudius.db`, so workspace isolation is implicit —
 * mirrors `session-tasks-db.ts` / `loop-ticks-db.ts`.
 */

type RawRow = {
  total_cost_usd: number;
  num_turns: number;
  duration_ms: number;
  duration_api_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  model_usage_json: string | null;
};

export async function getSessionUsage(
  cwd: string,
  sessionId: string,
): Promise<SessionUsageTotals | null> {
  const db = await openDb(cwd, "readonly").catch(() => null);
  if (!db) return null;
  const row = db
    .prepare(
      `SELECT total_cost_usd, num_turns, duration_ms, duration_api_ms,
              input_tokens, output_tokens, cache_read_input_tokens,
              cache_creation_input_tokens, model_usage_json
         FROM session_usage WHERE session_id = ?`,
    )
    .get(sessionId) as RawRow | undefined;
  if (!row) return null;
  let modelUsage: Record<string, unknown> | undefined;
  if (row.model_usage_json) {
    try {
      const parsed = JSON.parse(row.model_usage_json);
      if (parsed && typeof parsed === "object") modelUsage = parsed;
    } catch {
      // Corrupt JSON — drop the breakdown, keep the scalar totals.
    }
  }
  return {
    totalCostUsd: row.total_cost_usd,
    numTurns: row.num_turns,
    durationMs: row.duration_ms,
    durationApiMs: row.duration_api_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadInputTokens: row.cache_read_input_tokens,
    cacheCreationInputTokens: row.cache_creation_input_tokens,
    ...(modelUsage ? { modelUsage } : {}),
  };
}

export async function saveSessionUsage(
  cwd: string,
  sessionId: string,
  usage: SessionUsageTotals,
): Promise<void> {
  const db = await openDb(cwd).catch(() => null);
  if (!db) return;
  db.prepare(
    `INSERT INTO session_usage(session_id, total_cost_usd, num_turns, duration_ms,
       duration_api_ms, input_tokens, output_tokens, cache_read_input_tokens,
       cache_creation_input_tokens, model_usage_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       total_cost_usd = excluded.total_cost_usd,
       num_turns = excluded.num_turns,
       duration_ms = excluded.duration_ms,
       duration_api_ms = excluded.duration_api_ms,
       input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens,
       cache_read_input_tokens = excluded.cache_read_input_tokens,
       cache_creation_input_tokens = excluded.cache_creation_input_tokens,
       model_usage_json = excluded.model_usage_json,
       updated_at = excluded.updated_at`,
  ).run(
    sessionId,
    usage.totalCostUsd,
    Math.round(usage.numTurns),
    Math.round(usage.durationMs),
    Math.round(usage.durationApiMs),
    Math.round(usage.inputTokens),
    Math.round(usage.outputTokens),
    Math.round(usage.cacheReadInputTokens),
    Math.round(usage.cacheCreationInputTokens),
    usage.modelUsage ? JSON.stringify(usage.modelUsage) : null,
    Date.now(),
  );
}

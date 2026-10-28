import { promises as fs, createReadStream } from "node:fs";
import { resolve, sep } from "node:path";
import { projectRoot } from "./db";
import { jsonlLines } from "./jsonl-lines";

/**
 * The SDK's process-cumulative usage counters (`total_cost_usd`,
 * `duration_api_ms`, `modelUsage`) as last observed for one CLI process — or,
 * before that process's first `result`, the values it restored from the
 * transcript's `cost-state` checkpoint (see `lastRecordedCostState`).
 */
export type SdkCumulativeUsage = {
  totalCostUsd: number;
  durationApiMs: number;
  /** Per-model `ModelUsage` (SDK shape) — cumulative token/cost counters. */
  modelUsage?: Record<string, unknown>;
};

const MODEL_USAGE_NUMERIC_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "webSearchRequests",
  "costUSD",
] as const;

function isCount(v: unknown, max = 1e15): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max;
}

/**
 * Mirror of the CLI's own `cost-state` schema check — an entry it rejects is
 * not restored, so it mustn't become our baseline either.
 */
function parseCostState(entry: Record<string, unknown>): SdkCumulativeUsage | null {
  if (!isCount(entry.totalCostUSD, 1e9) || !isCount(entry.totalAPIDuration)) return null;
  const rawModels = entry.modelUsage;
  if (!rawModels || typeof rawModels !== "object" || Array.isArray(rawModels)) return null;
  const modelUsage: Record<string, unknown> = {};
  for (const [model, raw] of Object.entries(rawModels as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") return null;
    const m = raw as Record<string, unknown>;
    if (!MODEL_USAGE_NUMERIC_FIELDS.every((f) => isCount(m[f]))) return null;
    if (m.thinkingTokens !== undefined && !isCount(m.thinkingTokens)) return null;
    modelUsage[model] = { ...m };
  }
  return {
    totalCostUsd: entry.totalCostUSD,
    durationApiMs: entry.totalAPIDuration,
    ...(Object.keys(modelUsage).length > 0 ? { modelUsage } : {}),
  };
}

/**
 * The usage checkpoint a CLI resuming session `id` will restore: the LAST
 * valid `{"type":"cost-state"}` record for that session in its transcript
 * (the CLI treats the record as last-wins per session id). The engine writes
 * one when a CLI process exits gracefully, so after a reap / kill / crash the
 * checkpoint lags the real spend — and a short-lived side process (e.g. a
 * second front end resuming the same conversation) can leave a $0 one.
 * Either way, it's exactly what the next CLI re-reports as the starting
 * point of its "cumulative" `total_cost_usd` / `modelUsage`, which is why the
 * usage fold needs it.
 *
 * Null when there's no checkpoint or the file can't be read.
 */
export async function lastRecordedCostState(
  id: string,
  cwd: string,
): Promise<SdkCumulativeUsage | null> {
  if (!/^[\w-]+$/.test(id)) return null;
  const dir = projectRoot(cwd);
  const file = resolve(dir, `${id}.jsonl`);
  if (!file.startsWith(dir + sep)) return null;
  try {
    await fs.access(file);
  } catch {
    return null;
  }
  let last: SdkCumulativeUsage | null = null;
  try {
    for await (const line of jsonlLines(createReadStream(file, "utf8"))) {
      if (!line.includes('"cost-state"')) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // torn trailing line mid-write
      }
      if (entry.type !== "cost-state" || entry.sessionId !== id) continue;
      const parsed = parseCostState(entry);
      if (parsed) last = parsed;
    }
  } catch {
    return null;
  }
  return last;
}

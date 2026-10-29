import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { encodeProjectDir } from "./auto-memory";
import {
  costFromUsage,
  getPricingTable,
  priceForModel,
  type PricingTable,
} from "./litellm-pricing";
import {
  applyModelPricing,
  hasModelPricingOverride,
  resolveManagedModelPricing,
} from "./model-pricing-override";
import { getSessionTitlesByCwd } from "./sessions-db";
import { costFromTokens, inferenceGeoMultiplier } from "@/lib/shared/cost-pricing";
import { lookupSessionAccount, resolveSessionAccounts } from "./session-accounts";
import { readSettings, type ModelPricingSettings } from "./settings";
import type { SessionUsageTotals } from "@/lib/shared/events";

export type ByDay = {
  date: string; // YYYY-MM-DD (server local tz)
  usd: number;
  inputTokens: number;
  outputTokens: number;
};

export type BySession = {
  sessionId: string;
  firstSeenMs: number;
  lastSeenMs: number;
  numTurns: number;
  totalUsd: number;
  model?: string;
  /** User-assigned Claudius title (from `.claudius.db`), when the session has one. */
  title?: string;
  /** Account profile this session is pinned to, when it has a pin. */
  accountId?: string;
  /** Display label for `accountId` (`Removed account` if since deleted). */
  accountLabel?: string;
};

export type ByModel = {
  model: string;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type CostReport = {
  totalUsd: number;
  todayUsd: number;
  weekUsd: number; // rolling 7d
  monthUsd: number; // rolling 30d
  byDay: ByDay[];
  bySession: BySession[];
  byModel: ByModel[];
  /**
   * True when the `modelPricing` setting (Claude Code 2.1.243) has a
   * discount multiplier or per-model rate configured, so the Cost page can
   * show "using org pricing" instead of implying pure list-price figures.
   */
  pricingOverrideActive: boolean;
  /**
   * How many account profiles are configured system-wide. The Cost page
   * only breaks spend out by account when this is > 1 — with a single
   * account every row would carry the same badge.
   */
  accountsConfigured: number;
  /** Note shown to the user on the page. */
  note: string;
};

/**
 * One assistant turn, distilled to what cost aggregation needs. Pricing is
 * deliberately *not* baked in here — it's applied at aggregate time from the
 * live LiteLLM table, so a pricing refresh doesn't require re-parsing JSONL.
 */
export type Row = {
  /** Dedup key `message.id:requestId`, or null when either is absent. */
  k: string | null;
  m: string; // model
  d: string; // day key (YYYY-MM-DD)
  i: number; // input tokens
  o: number; // output tokens
  cr: number; // cache read tokens
  cw: number; // cache creation tokens (5m + 1h)
  /**
   * CC 2.1.300 — the 1-hour slice of `cw` (`cache_creation.ephemeral_1h_input_tokens`,
   * clamped to `cw`). Billed at 2x input instead of the 5m 1.25x. Optional so
   * hand-built rows / older shapes read as 0.
   */
  cw1h?: number;
  /** Authoritative per-turn cost from the JSONL, when present (else null). */
  u: number | null;
  /** CC 2.1.239 — `usage.inference_geo`; `"us"` carries a 1.1× data-residency premium. */
  geo?: string | null;
};

export type FileSummary = {
  path: string;
  mtimeMs: number;
  size: number;
  firstSeenMs: number;
  lastSeenMs: number;
  rows: Row[];
};

type CacheShape = {
  // v2: stores per-turn token rows (not precomputed USD) so cross-file dedup
  // and pricing refreshes work. v3 (CC 2.1.300): rows carry `cw1h` so 1-hour
  // cache writes price at their own rate. Bumping this invalidates older caches.
  version: 3;
  files: Record<string, FileSummary>;
};

const CACHE_FILE = ".claudius-cost-cache.json";
const CACHE_VERSION = 3;

function projectDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", encodeProjectDir(cwd));
}

export function dayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isSyntheticModel(model: string): boolean {
  // Claude Code emits `<synthetic>` / `<synthetic>-fast` for locally-generated
  // assistant turns (e.g. "Prompt is too long"). These never hit the API and
  // have no cost — ccusage drops them, so do we.
  return model.startsWith("<synthetic>");
}

/** Session id a transcript belongs to: `<id>.jsonl`, or anything under `<id>/`. */
export function sessionIdForTranscript(dir: string, path: string): string {
  return (relative(dir, path).split(sep)[0] ?? "").replace(/\.jsonl$/, "");
}

/** Workflow agents nest at `subagents/workflows/wf_<id>/agent-*.jsonl`. */
const SUBAGENT_MAX_DEPTH = 4;

/**
 * Task-subagent and Workflow-agent transcripts of one session
 * (every `*.jsonl` under `<dir>/<id>/subagents/`). Their API calls are real spend on
 * the session but never appear in the main `<id>.jsonl` — skipping them
 * under-reported a subagent-heavy session by more than half.
 */
async function subagentTranscripts(dir: string, sessionId: string): Promise<string[]> {
  if (!/^[\w-]+$/.test(sessionId)) return [];
  const root = resolve(dir, sessionId, "subagents");
  const out: string[] = [];
  const stack: Array<[string, number]> = [[root, 0]];
  while (stack.length > 0) {
    const [at, depth] = stack.pop()!;
    const target = resolve(root, at);
    if (!target.startsWith(dir + sep)) continue;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(target, { withFileTypes: true });
    } catch {
      continue; // no subagents dir (the common case) or unreadable
    }
    for (const e of entries) {
      const child = resolve(target, e.name);
      if (e.isDirectory()) {
        if (depth < SUBAGENT_MAX_DEPTH) stack.push([child, depth + 1]);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        out.push(child);
      }
    }
  }
  return out.sort();
}

async function readCache(dir: string): Promise<CacheShape> {
  const path = join(dir, CACHE_FILE);
  try {
    const buf = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(buf) as CacheShape;
    if (parsed.version === CACHE_VERSION && parsed.files) return parsed;
  } catch {
    // ignore
  }
  return { version: CACHE_VERSION, files: {} };
}

async function writeCache(dir: string, cache: CacheShape): Promise<void> {
  const path = join(dir, CACHE_FILE);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(cache), "utf8");
}

async function summarizeFile(path: string, mtimeMs: number, size: number): Promise<FileSummary> {
  const summary: FileSummary = {
    path,
    mtimeMs,
    size,
    firstSeenMs: Infinity,
    lastSeenMs: 0,
    rows: [],
  };
  let buf: string;
  try {
    buf = await fs.readFile(path, "utf8");
  } catch {
    summary.firstSeenMs = 0;
    return summary;
  }
  for (const line of buf.split("\n")) {
    if (!line || line[0] !== "{") continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (r.type !== "assistant") continue;
    const message = r.message as
      | { id?: string; model?: string; usage?: Record<string, unknown> }
      | undefined;
    if (!message?.usage) continue;
    const ts = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
    if (Number.isNaN(ts)) continue;

    const model = message.model ?? "(unknown)";
    if (isSyntheticModel(model)) continue;

    const u = message.usage;
    const cacheCreation = u.cache_creation as Record<string, unknown> | undefined;
    // Total cache-creation tokens: the top-level field when present, else the
    // sum of the ephemeral 5m/1h buckets. The 1h slice is kept separately and
    // clamped to the total, mirroring the engine's split pricer (CC 2.1.300):
    //   h = min(cache_creation.ephemeral_1h_input_tokens, cache_creation_input_tokens)
    //   cost = h × promptCacheWrite1hTokens + (total − h) × promptCacheWriteTokens
    const cacheWrite =
      Number(u.cache_creation_input_tokens ?? 0) ||
      Number(cacheCreation?.ephemeral_5m_input_tokens ?? 0) +
        Number(cacheCreation?.ephemeral_1h_input_tokens ?? 0);
    const cacheWrite1h = Math.min(
      Number(cacheCreation?.ephemeral_1h_input_tokens ?? 0) || 0,
      cacheWrite,
    );

    const msgId = typeof message.id === "string" ? message.id : null;
    const reqId = typeof r.requestId === "string" ? r.requestId : null;
    const costUsd = typeof r.costUSD === "number" ? r.costUSD : null;

    summary.rows.push({
      k: msgId && reqId ? `${msgId}:${reqId}` : null,
      m: model,
      d: dayKey(ts),
      i: Number(u.input_tokens ?? 0),
      o: Number(u.output_tokens ?? 0),
      cr: Number(u.cache_read_input_tokens ?? 0),
      cw: cacheWrite,
      cw1h: cacheWrite1h,
      u: costUsd,
      geo: typeof u.inference_geo === "string" ? u.inference_geo : null,
    });

    if (ts < summary.firstSeenMs) summary.firstSeenMs = ts;
    if (ts > summary.lastSeenMs) summary.lastSeenMs = ts;
  }
  if (summary.firstSeenMs === Infinity) summary.firstSeenMs = 0;
  return summary;
}

export function rowUsd(
  row: Row,
  table: PricingTable,
  pricing: ModelPricingSettings | undefined,
): number {
  const base =
    row.u != null // authoritative cost from the JSONL (already includes any geo premium)
      ? row.u
      : // CC 2.1.239 — the token-computed fallback must add the 1.1× US-only
        // data-residency premium itself (`inference_geo === "us"`).
        costFromUsage(priceForModel(row.m, table), {
          input: row.i,
          output: row.o,
          cacheRead: row.cr,
          cacheCreation: row.cw,
          cacheCreation1h: row.cw1h ?? 0,
        }) * inferenceGeoMultiplier(row.geo);
  if (!pricing) return base;
  return applyModelPricing(
    base,
    row.m,
    {
      input: row.i,
      output: row.o,
      cacheRead: row.cr,
      cacheWrite: row.cw,
      cacheWrite1h: row.cw1h ?? 0,
    },
    pricing,
  );
}

/**
 * CC 2.1.271 — the engine honors modelPricing only from managed sources, so
 * prefer the managed/policy tier (via resolveSettings) over Claudius's own
 * user-scope setting; fall back to user scope when no managed value is set.
 */
export async function resolvePricing(cwd: string): Promise<ModelPricingSettings | undefined> {
  const userPricing = await readSettings("user", cwd)
    .then((s) => s.modelPricing)
    .catch(() => undefined);
  const managedPricing = await resolveManagedModelPricing(cwd);
  return managedPricing ?? userPricing;
}

/**
 * Every transcript in one project dir — each `<id>.jsonl` plus its subagent
 * transcripts — summarized into per-turn rows, through the dir's
 * `.claudius-cost-cache.json` (a file is re-parsed only when its mtime or
 * size changed). Null when the dir doesn't exist.
 */
export async function summarizeProjectDir(dir: string): Promise<FileSummary[] | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    throw err;
  }

  const cache = await readCache(dir);
  const seen = new Set<string>();
  let dirty = false;

  const transcripts: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    transcripts.push(join(dir, name));
    transcripts.push(...(await subagentTranscripts(dir, name.replace(/\.jsonl$/, ""))));
  }

  for (const path of transcripts) {
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(path);
    } catch {
      continue;
    }
    seen.add(path);
    const cached = cache.files[path];
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue;
    cache.files[path] = await summarizeFile(path, stat.mtimeMs, stat.size);
    dirty = true;
  }

  for (const path of Object.keys(cache.files)) {
    if (!seen.has(path)) {
      delete cache.files[path];
      dirty = true;
    }
  }

  if (dirty) await writeCache(dir, cache).catch(() => {});
  return Object.values(cache.files);
}

export async function aggregate(cwd: string): Promise<CostReport> {
  const dir = projectDir(cwd);
  const summaries = await summarizeProjectDir(dir);
  if (!summaries) return emptyReport();

  const table = await getPricingTable();
  const pricing = await resolvePricing(cwd);

  // Dedup is global across files: when a session is resumed or forked, the new
  // JSONL replays prior turns verbatim (same message.id + requestId). We count
  // each unique turn once, attributing it to the first file that contains it.
  // A deterministic order (oldest-first, then path) makes attribution stable;
  // grand totals are order-independent regardless.
  const files = summaries
    .filter((f) => f.rows.length > 0)
    .sort((a, b) => a.firstSeenMs - b.firstSeenMs || a.path.localeCompare(b.path));

  const dedup = new Set<string>();
  const byDayMap = new Map<string, ByDay>();
  const byModelMap = new Map<string, ByModel>();
  // A session's main transcript and its subagent transcripts fold into one row.
  const sessionAcc = new Map<
    string,
    { firstSeenMs: number; lastSeenMs: number; usd: number; turns: number; modelHist: Record<string, number> }
  >();
  let totalUsd = 0;

  for (const file of files) {
    let sessionUsd = 0;
    let sessionTurns = 0;
    const modelHist: Record<string, number> = {};

    for (const row of file.rows) {
      if (row.k) {
        if (dedup.has(row.k)) continue;
        dedup.add(row.k);
      }
      const usd = rowUsd(row, table, pricing);
      totalUsd += usd;

      const day = byDayMap.get(row.d) ?? { date: row.d, usd: 0, inputTokens: 0, outputTokens: 0 };
      day.usd += usd;
      day.inputTokens += row.i;
      day.outputTokens += row.o;
      byDayMap.set(row.d, day);

      const mb =
        byModelMap.get(row.m) ??
        ({
          model: row.m,
          usd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        } as ByModel);
      mb.usd += usd;
      mb.inputTokens += row.i;
      mb.outputTokens += row.o;
      mb.cacheReadTokens += row.cr;
      mb.cacheWriteTokens += row.cw;
      byModelMap.set(row.m, mb);

      sessionUsd += usd;
      sessionTurns += 1;
      modelHist[row.m] = (modelHist[row.m] ?? 0) + 1;
    }

    if (sessionTurns === 0) continue; // fully duplicated elsewhere

    const sessionId = sessionIdForTranscript(dir, file.path);
    const acc = sessionAcc.get(sessionId);
    if (!acc) {
      sessionAcc.set(sessionId, {
        firstSeenMs: file.firstSeenMs,
        lastSeenMs: file.lastSeenMs,
        usd: sessionUsd,
        turns: sessionTurns,
        modelHist,
      });
      continue;
    }
    acc.firstSeenMs = Math.min(acc.firstSeenMs, file.firstSeenMs);
    acc.lastSeenMs = Math.max(acc.lastSeenMs, file.lastSeenMs);
    acc.usd += sessionUsd;
    acc.turns += sessionTurns;
    for (const [m, n] of Object.entries(modelHist)) acc.modelHist[m] = (acc.modelHist[m] ?? 0) + n;
  }

  const sessions: BySession[] = [];
  for (const [sessionId, acc] of sessionAcc) {
    let best: string | undefined;
    let bestN = 0;
    for (const [m, n] of Object.entries(acc.modelHist)) {
      if (n > bestN) {
        best = m;
        bestN = n;
      }
    }
    sessions.push({
      sessionId,
      firstSeenMs: acc.firstSeenMs,
      lastSeenMs: acc.lastSeenMs,
      numTurns: acc.turns,
      totalUsd: acc.usd,
      model: best,
    });
  }

  const byDay = [...byDayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const byModel = [...byModelMap.values()].sort((a, b) => b.usd - a.usd);
  const bySession = sessions.sort((a, b) => b.lastSeenMs - a.lastSeenMs);

  // Attach user-assigned titles from the project's `.claudius.db`. The report
  // is scoped to `cwd`, so that's the title-store key; the `*:id` fallback
  // covers sessions whose JSONL header dropped the cwd. A title miss just
  // leaves `title` undefined and the table falls back to the short id.
  try {
    const titles = await getSessionTitlesByCwd(
      bySession.map((s) => ({ cwd, id: s.sessionId })),
    );
    for (const s of bySession) {
      const title = titles.get(`${cwd}:${s.sessionId}`) ?? titles.get(`*:${s.sessionId}`);
      if (title) s.title = title;
    }
  } catch {
    // Title lookup is best-effort — never fail the cost report over it.
  }

  // Attach the account each session ran under, so spend on this page can be
  // read per identity. Same best-effort contract as titles: the report is
  // scoped to one cwd, a miss just leaves the row unbadged.
  const { byKey, accountsConfigured } = await resolveSessionAccounts(
    bySession.map((s) => ({ cwd, id: s.sessionId })),
  );
  for (const s of bySession) {
    const acct = lookupSessionAccount(byKey, cwd, s.sessionId);
    if (acct) {
      s.accountId = acct.accountId;
      s.accountLabel = acct.accountLabel;
    }
  }

  const today = dayKey(Date.now());
  const weekDays = new Set<string>();
  const monthDays = new Set<string>();
  for (let i = 0; i < 7; i++) weekDays.add(dayKey(Date.now() - i * 86_400_000));
  for (let i = 0; i < 30; i++) monthDays.add(dayKey(Date.now() - i * 86_400_000));

  let todayUsd = 0;
  let weekUsd = 0;
  let monthUsd = 0;
  for (const d of byDay) {
    if (d.date === today) todayUsd += d.usd;
    if (weekDays.has(d.date)) weekUsd += d.usd;
    if (monthDays.has(d.date)) monthUsd += d.usd;
  }

  return {
    totalUsd,
    todayUsd,
    weekUsd,
    monthUsd,
    byDay,
    bySession,
    byModel,
    pricingOverrideActive: hasModelPricingOverride(pricing),
    accountsConfigured,
    note: hasModelPricingOverride(pricing)
      ? "Cost uses your org's contracted modelPricing rates (settings.json) instead of list price where a rate matches; deduplicated by message+request id so resumed/forked sessions aren't double-counted."
      : "Cost uses on-disk token counts priced with LiteLLM public list prices (1-hour cache writes at 2× input, as Claude Code bills them), deduplicated by message+request id so resumed/forked sessions aren't double-counted.",
  };
}

/** One deduplicable API call read off a transcript line, for the seed estimate. */
type TranscriptApiCall = {
  /** `message.id:requestId`; null (never deduped) without a string message id. */
  key: string | null;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  /** All cache-creation tokens; `cacheWrite1h` of them at the 1-hour rate. */
  cacheWrite: number;
  cacheWrite1h: number;
  usd: number;
};

/**
 * Parse one transcript line into an API call, or null. Token fields count
 * only when they're finite numbers. Cost is the record's own `costUSD` when
 * present, else the static list prices (`costFromTokens`, the 1-hour share
 * of cache writes at its own rate) times the US data-residency premium.
 */
function transcriptApiCall(line: string): TranscriptApiCall | null {
  if (!line.startsWith("{")) return null;
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!r || typeof r !== "object" || r.type !== "assistant") return null;
  const message = r.message as Record<string, unknown> | null | undefined;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const u = message.usage as Record<string, unknown> | null | undefined;
  if (!u || typeof u !== "object" || Array.isArray(u)) return null;
  const model = typeof message.model === "string" ? message.model : "(unknown)";
  if (isSyntheticModel(model)) return null;
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const cc = u.cache_creation;
  const buckets =
    cc && typeof cc === "object" && !Array.isArray(cc) ? (cc as Record<string, unknown>) : null;
  const input = n(u.input_tokens);
  const output = n(u.output_tokens);
  const cacheRead = n(u.cache_read_input_tokens);
  const cacheWrite =
    n(u.cache_creation_input_tokens) ||
    n(buckets?.ephemeral_5m_input_tokens) + n(buckets?.ephemeral_1h_input_tokens);
  const cacheWrite1h = Math.min(Math.max(n(buckets?.ephemeral_1h_input_tokens), 0), Math.max(cacheWrite, 0));
  const id = typeof message.id === "string" ? message.id : null;
  const req = typeof r.requestId === "string" ? r.requestId : "";
  const usd =
    typeof r.costUSD === "number" && Number.isFinite(r.costUSD)
      ? r.costUSD
      : costFromTokens(model, {
          input,
          output,
          cacheRead,
          cacheWrite5m: cacheWrite - cacheWrite1h,
          cacheWrite1h,
        }) * inferenceGeoMultiplier(typeof u.inference_geo === "string" ? u.inference_geo : null);
  return { key: id === null ? null : `${id}:${req}`, model, input, output, cacheRead, cacheWrite, cacheWrite1h, usd };
}

/**
 * All-time usage of one session estimated from its transcripts — the main
 * `<id>.jsonl` plus every subagent / workflow-agent transcript (sorted) —
 * deduplicated by `message.id:requestId` across them. Priced with the static
 * list prices the seed has always used (`lib/shared/cost-pricing.ts`, the
 * same table the Rust port mirrors), not the Cost page's LiteLLM table.
 * Seeds the `session_usage` row for a session that has none
 * (`Session.seedUsageBaseline`). `numTurns` counts main-thread API calls
 * (what the SDK's per-turn `num_turns` adds up to); durations aren't in the
 * JSONL and stay 0. Null when no API call is found.
 */
export async function estimateSessionUsageFromTranscripts(
  cwd: string,
  sessionId: string,
): Promise<SessionUsageTotals | null> {
  if (!/^[\w-]+$/.test(sessionId)) return null;
  const dir = projectDir(cwd);
  const main = resolve(dir, `${sessionId}.jsonl`);
  if (!main.startsWith(dir + sep)) return null;
  const files = [main, ...(await subagentTranscripts(dir, sessionId))];

  const totals: SessionUsageTotals = {
    totalCostUsd: 0,
    numTurns: 0,
    durationMs: 0,
    durationApiMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  // A Map, not an object literal: a model id like `__proto__` must be a key.
  const modelUsage = new Map<string, Record<string, number>>();
  const seen = new Set<string>();
  let calls = 0;
  for (const path of files) {
    let text: string;
    try {
      text = await fs.readFile(path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const call = transcriptApiCall(line);
      if (!call) continue;
      if (call.key !== null) {
        if (seen.has(call.key)) continue;
        seen.add(call.key);
      }
      calls += 1;
      if (path === main) totals.numTurns += 1;
      totals.totalCostUsd += call.usd;
      totals.inputTokens += call.input;
      totals.outputTokens += call.output;
      totals.cacheReadInputTokens += call.cacheRead;
      totals.cacheCreationInputTokens += call.cacheWrite;
      let m = modelUsage.get(call.model);
      if (!m) {
        m = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0,
        };
        modelUsage.set(call.model, m);
      }
      m.inputTokens += call.input;
      m.outputTokens += call.output;
      m.cacheReadInputTokens += call.cacheRead;
      m.cacheCreationInputTokens += call.cacheWrite;
      m.costUSD += call.usd;
    }
  }
  if (calls === 0) return null;
  return { ...totals, modelUsage: Object.fromEntries(modelUsage) };
}

function emptyReport(): CostReport {
  return {
    totalUsd: 0,
    todayUsd: 0,
    weekUsd: 0,
    monthUsd: 0,
    byDay: [],
    bySession: [],
    byModel: [],
    pricingOverrideActive: false,
    accountsConfigured: 0,
    note: "No sessions recorded yet for this project.",
  };
}

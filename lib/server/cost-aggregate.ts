import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { encodeProjectDir } from "./auto-memory";
import {
  costFromUsage,
  getPricingTable,
  priceForModel,
  type PricingTable,
} from "./litellm-pricing";
import { getSessionTitlesByCwd } from "./sessions-db";

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
  /** Note shown to the user on the page. */
  note: string;
};

/**
 * One assistant turn, distilled to what cost aggregation needs. Pricing is
 * deliberately *not* baked in here — it's applied at aggregate time from the
 * live LiteLLM table, so a pricing refresh doesn't require re-parsing JSONL.
 */
type Row = {
  /** Dedup key `message.id:requestId`, or null when either is absent. */
  k: string | null;
  m: string; // model
  d: string; // day key (YYYY-MM-DD)
  i: number; // input tokens
  o: number; // output tokens
  cr: number; // cache read tokens
  cw: number; // cache creation tokens
  /** Authoritative per-turn cost from the JSONL, when present (else null). */
  u: number | null;
};

type FileSummary = {
  path: string;
  mtimeMs: number;
  size: number;
  firstSeenMs: number;
  lastSeenMs: number;
  rows: Row[];
};

type CacheShape = {
  // v2: stores per-turn token rows (not precomputed USD) so cross-file dedup
  // and pricing refreshes work. Bumping this invalidates older v1 caches.
  version: 2;
  files: Record<string, FileSummary>;
};

const CACHE_FILE = ".claudius-cost-cache.json";
const CACHE_VERSION = 2;

function projectDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", encodeProjectDir(cwd));
}

function dayKey(ms: number): string {
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

async function readCache(cwd: string): Promise<CacheShape> {
  const path = join(projectDir(cwd), CACHE_FILE);
  try {
    const buf = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(buf) as CacheShape;
    if (parsed.version === CACHE_VERSION && parsed.files) return parsed;
  } catch {
    // ignore
  }
  return { version: CACHE_VERSION, files: {} };
}

async function writeCache(cwd: string, cache: CacheShape): Promise<void> {
  const path = join(projectDir(cwd), CACHE_FILE);
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
    // LiteLLM/ccusage price cache creation with a single rate against the total
    // creation tokens — so we sum the ephemeral 5m/1h buckets (preferring the
    // top-level field when present) rather than splitting them.
    const cacheWrite =
      Number(u.cache_creation_input_tokens ?? 0) ||
      Number(cacheCreation?.ephemeral_5m_input_tokens ?? 0) +
        Number(cacheCreation?.ephemeral_1h_input_tokens ?? 0);

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
      u: costUsd,
    });

    if (ts < summary.firstSeenMs) summary.firstSeenMs = ts;
    if (ts > summary.lastSeenMs) summary.lastSeenMs = ts;
  }
  if (summary.firstSeenMs === Infinity) summary.firstSeenMs = 0;
  return summary;
}

function rowUsd(row: Row, table: PricingTable): number {
  if (row.u != null) return row.u; // authoritative cost from the JSONL
  return costFromUsage(priceForModel(row.m, table), {
    input: row.i,
    output: row.o,
    cacheRead: row.cr,
    cacheCreation: row.cw,
  });
}

export async function aggregate(cwd: string): Promise<CostReport> {
  const dir = projectDir(cwd);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return emptyReport();
    throw err;
  }

  const cache = await readCache(cwd);
  const seen = new Set<string>();
  let dirty = false;

  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
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

  if (dirty) await writeCache(cwd, cache).catch(() => {});

  const table = await getPricingTable();

  // Dedup is global across files: when a session is resumed or forked, the new
  // JSONL replays prior turns verbatim (same message.id + requestId). We count
  // each unique turn once, attributing it to the first file that contains it.
  // A deterministic order (oldest-first, then path) makes attribution stable;
  // grand totals are order-independent regardless.
  const files = Object.values(cache.files)
    .filter((f) => f.rows.length > 0)
    .sort((a, b) => a.firstSeenMs - b.firstSeenMs || a.path.localeCompare(b.path));

  const dedup = new Set<string>();
  const byDayMap = new Map<string, ByDay>();
  const byModelMap = new Map<string, ByModel>();
  const sessions: BySession[] = [];
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
      const usd = rowUsd(row, table);
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

    let best: string | undefined;
    let bestN = 0;
    for (const [m, n] of Object.entries(modelHist)) {
      if (n > bestN) {
        best = m;
        bestN = n;
      }
    }

    const sessionId = file.path
      .split("/")
      .pop()!
      .replace(/\.jsonl$/, "");
    sessions.push({
      sessionId,
      firstSeenMs: file.firstSeenMs,
      lastSeenMs: file.lastSeenMs,
      numTurns: sessionTurns,
      totalUsd: sessionUsd,
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
    note: "Cost uses ccusage-compatible methodology: on-disk token counts priced with LiteLLM public list prices, deduplicated by message+request id so resumed/forked sessions aren't double-counted.",
  };
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
    note: "No sessions recorded yet for this project.",
  };
}

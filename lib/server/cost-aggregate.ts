import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { encodeProjectDir } from "./auto-memory";
import { costFromTokens, type TokenBreakdown } from "./cost-pricing";

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

type FileSummary = {
  path: string;
  mtimeMs: number;
  size: number;
  totalUsd: number;
  numTurns: number;
  firstSeenMs: number;
  lastSeenMs: number;
  model: string | undefined;
  byDay: Record<string, { usd: number; inputTokens: number; outputTokens: number }>;
  byModel: Record<string, ByModel>;
};

type CacheShape = {
  version: 1;
  files: Record<string, FileSummary>;
};

const CACHE_FILE = ".claudius-cost-cache.json";

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

async function readCache(cwd: string): Promise<CacheShape> {
  const path = join(projectDir(cwd), CACHE_FILE);
  try {
    const buf = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(buf) as CacheShape;
    if (parsed.version === 1 && parsed.files) return parsed;
  } catch {
    // ignore
  }
  return { version: 1, files: {} };
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
    totalUsd: 0,
    numTurns: 0,
    firstSeenMs: Infinity,
    lastSeenMs: 0,
    model: undefined,
    byDay: {},
    byModel: {},
  };
  let buf: string;
  try {
    buf = await fs.readFile(path, "utf8");
  } catch {
    return summary;
  }
  const modelHistogram: Record<string, number> = {};
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
      | { model?: string; usage?: Record<string, unknown> }
      | undefined;
    if (!message?.usage) continue;
    const ts = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
    if (Number.isNaN(ts)) continue;

    const u = message.usage;
    const cacheCreation = u.cache_creation as Record<string, unknown> | undefined;
    const tokens: TokenBreakdown = {
      input: Number(u.input_tokens ?? 0),
      output: Number(u.output_tokens ?? 0),
      cacheRead: Number(u.cache_read_input_tokens ?? 0),
      cacheWrite5m: Number(cacheCreation?.ephemeral_5m_input_tokens ?? 0),
      cacheWrite1h: Number(cacheCreation?.ephemeral_1h_input_tokens ?? 0),
    };
    const model = message.model ?? "(unknown)";
    const usd = costFromTokens(model, tokens);
    summary.totalUsd += usd;
    summary.numTurns += 1;
    if (ts < summary.firstSeenMs) summary.firstSeenMs = ts;
    if (ts > summary.lastSeenMs) summary.lastSeenMs = ts;
    modelHistogram[model] = (modelHistogram[model] ?? 0) + 1;

    const dk = dayKey(ts);
    const dayEntry = (summary.byDay[dk] ??= { usd: 0, inputTokens: 0, outputTokens: 0 });
    dayEntry.usd += usd;
    dayEntry.inputTokens += tokens.input;
    dayEntry.outputTokens += tokens.output;

    const mb = (summary.byModel[model] ??= {
      model,
      usd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    mb.usd += usd;
    mb.inputTokens += tokens.input;
    mb.outputTokens += tokens.output;
    mb.cacheReadTokens += tokens.cacheRead;
    mb.cacheWriteTokens += tokens.cacheWrite5m + tokens.cacheWrite1h;
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [m, n] of Object.entries(modelHistogram)) {
    if (n > bestN) {
      best = m;
      bestN = n;
    }
  }
  summary.model = best;
  if (summary.firstSeenMs === Infinity) summary.firstSeenMs = 0;
  return summary;
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

  const byDayMap = new Map<string, ByDay>();
  const byModelMap = new Map<string, ByModel>();
  const sessions: BySession[] = [];
  let totalUsd = 0;

  for (const file of Object.values(cache.files)) {
    if (file.numTurns === 0) continue;
    totalUsd += file.totalUsd;

    const sessionId = file.path
      .split("/")
      .pop()!
      .replace(/\.jsonl$/, "");
    sessions.push({
      sessionId,
      firstSeenMs: file.firstSeenMs,
      lastSeenMs: file.lastSeenMs,
      numTurns: file.numTurns,
      totalUsd: file.totalUsd,
      model: file.model,
    });

    for (const [date, agg] of Object.entries(file.byDay)) {
      const cur = byDayMap.get(date) ?? { date, usd: 0, inputTokens: 0, outputTokens: 0 };
      cur.usd += agg.usd;
      cur.inputTokens += agg.inputTokens;
      cur.outputTokens += agg.outputTokens;
      byDayMap.set(date, cur);
    }

    for (const [model, agg] of Object.entries(file.byModel)) {
      const cur =
        byModelMap.get(model) ??
        ({
          model,
          usd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        } as ByModel);
      cur.usd += agg.usd;
      cur.inputTokens += agg.inputTokens;
      cur.outputTokens += agg.outputTokens;
      cur.cacheReadTokens += agg.cacheReadTokens;
      cur.cacheWriteTokens += agg.cacheWriteTokens;
      byModelMap.set(model, cur);
    }
  }

  const byDay = [...byDayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const byModel = [...byModelMap.values()].sort((a, b) => b.usd - a.usd);
  const bySession = sessions.sort((a, b) => b.lastSeenMs - a.lastSeenMs);

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
    note: "Cost is computed from on-disk token counts × public Claude API list pricing (estimate). For the authoritative account-wide total, see your Anthropic usage dashboard.",
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

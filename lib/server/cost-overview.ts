import { promises as fs, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { accountsDir, readAccountsRaw } from "./accounts-store";
import { encodeProjectDir } from "./auto-memory";
import {
  dayKey,
  resolvePricing,
  rowUsd,
  sessionIdForTranscript,
  summarizeProjectDir,
  type FileSummary,
} from "./cost-aggregate";
import { getPricingTable } from "./litellm-pricing";
import { hasModelPricingOverride } from "./model-pricing-override";
import type { ModelPricingSettings } from "./settings";
import { getSessionAccountsByCwd } from "./sessions-db";
import { listWorkspaces } from "./workspaces-store";
import {
  UNPINNED_ACCOUNT_KEY,
  type CostOverview,
  type OverviewAccount,
  type OverviewDay,
  type OverviewProject,
} from "@/lib/shared/cost-overview";

/**
 * Spend across every project and every account on this machine — the
 * Account page's overview. The per-workspace Cost page (`aggregate`) only
 * sees one project; this walks every `~/.claude/projects/<dir>`, including
 * projects that were never opened as a Claudius workspace (sessions run from
 * a plain `claude` CLI elsewhere still cost money).
 *
 * Same rows, cache and pricing as `aggregate`, so a workspace's numbers here
 * match its Cost page. The one difference: dedup by `message.id:requestId`
 * is global across all projects, so a call replayed into another project's
 * transcript (a fork into a different cwd) counts once, for the earliest
 * file, instead of once per project.
 *
 * Accounts come from each session's pin (`sessions.state.accountProfileId`
 * in the project's `.claudius.db`, read-only — this never creates or
 * migrates a project DB). Sessions without a pin (run outside Claudius, or
 * before profiles existed) land in the `UNPINNED_ACCOUNT_KEY` bucket — except
 * in a profile's own `projects` dir (see `listProjectSources`), whose
 * sessions only that profile can have run.
 */

type Source = { dir: string; profileId: string | null };

/**
 * Project dirs by name. Normally just `~/.claude/projects/*`. A profile's
 * config dir mirrors that via a `projects` symlink; one holding a real dir
 * instead (the CLI wrote there before the mirror existed) is a second source,
 * merged by dir name.
 */
async function listProjectSources(): Promise<Map<string, Source[]>> {
  const out = new Map<string, Source[]>();
  const addRoot = async (root: string, profileId: string | null) => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue; // a symlinked project dir isn't followed
      const list = out.get(e.name) ?? [];
      list.push({ dir: join(root, e.name), profileId });
      out.set(e.name, list);
    }
  };

  const main = join(homedir(), ".claude", "projects");
  await addRoot(main, null);

  const mainReal = await fs.realpath(main).catch(() => main);
  const profilesRoot = join(accountsDir(), "profiles");
  let profiles: Dirent[] = [];
  try {
    profiles = await fs.readdir(profilesRoot, { withFileTypes: true });
  } catch {
    // no profiles configured
  }
  for (const p of profiles) {
    if (!p.isDirectory()) continue;
    const root = join(profilesRoot, p.name, "projects");
    const st = await fs.lstat(root).catch(() => null);
    if (!st?.isDirectory()) continue; // missing, or the usual symlink
    if ((await fs.realpath(root).catch(() => root)) === mainReal) continue;
    await addRoot(root, p.name);
  }
  return out;
}

/** The first `max` bytes of a file as UTF-8 (a torn last line is fine). */
async function readHead(path: string, max: number): Promise<string> {
  const fh = await fs.open(path, "r");
  try {
    const buf = Buffer.alloc(max);
    const { bytesRead } = await fh.read(buf, 0, max, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/** A project dir's cwd never changes; remember it once found. */
const cwdMemo = new Map<string, string>();

/**
 * The project root a non-workspace dir belongs to, from the `cwd` field the
 * CLI writes on its transcript records. The dir name itself can't be decoded
 * (`encodeProjectDir` maps every non-alphanumeric to `-`).
 */
async function transcriptCwd(key: string, dirs: string[]): Promise<string | null> {
  const memo = cwdMemo.get(key);
  if (memo) return memo;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = (await fs.readdir(dir)).filter((n) => n.endsWith(".jsonl")).slice(0, 8);
    } catch {
      continue;
    }
    for (const name of names) {
      let head: string;
      try {
        head = await readHead(join(dir, name), 64 * 1024);
      } catch {
        continue;
      }
      for (const line of head.split("\n")) {
        if (!line.includes('"cwd"')) continue;
        try {
          const r = JSON.parse(line) as { cwd?: unknown };
          if (typeof r.cwd === "string" && r.cwd) {
            cwdMemo.set(key, r.cwd);
            return r.cwd;
          }
        } catch {
          // torn last line of the head, or not JSON
        }
      }
    }
  }
  return null;
}

function displayPath(cwd: string): string {
  const home = homedir();
  if (cwd === home) return "~";
  return cwd.startsWith(home + sep) ? `~${cwd.slice(home.length)}` : cwd;
}

type Acc = { usd: number; sessions: Set<string>; lastSeenMs: number };
const newAcc = (): Acc => ({ usd: 0, sessions: new Set(), lastSeenMs: 0 });

type TaggedFile = {
  file: FileSummary;
  project: string;
  account: string;
  sessionKey: string;
  pricing: ModelPricingSettings | undefined;
};

export async function aggregateOverview(): Promise<CostOverview> {
  const [sources, workspaces, accountsState, table] = await Promise.all([
    listProjectSources(),
    listWorkspaces().catch(() => []),
    readAccountsRaw().catch(() => null),
    getPricingTable(),
  ]);
  const profiles = accountsState?.profiles ?? [];
  const labels = new Map(profiles.map((p) => [p.id, p.label]));
  const wsByDir = new Map(
    workspaces.filter((w) => w.rootPath).map((w) => [encodeProjectDir(w.rootPath), w]),
  );

  const projectMeta = new Map<string, Omit<OverviewProject, "usd" | "sessions" | "lastSeenMs">>();
  const tagged: TaggedFile[] = [];
  let pricingOverrideActive = false;

  for (const [key, srcs] of sources) {
    const found: Array<{ src: Source; files: FileSummary[] }> = [];
    for (const src of srcs) {
      const files = (await summarizeProjectDir(src.dir))?.filter((f) => f.rows.length > 0) ?? [];
      if (files.length > 0) found.push({ src, files });
    }
    if (found.length === 0) continue; // no spend: skip the cwd lookup and the DB

    const ws = wsByDir.get(key);
    const cwd = ws?.rootPath ?? (await transcriptCwd(key, srcs.map((s) => s.dir)));
    projectMeta.set(key, {
      key,
      label: ws?.name ?? (cwd ? displayPath(cwd) : key),
      cwd,
      workspaceId: ws?.id ?? null,
    });

    // The pins live in the project's `.claudius.db`, which sits at
    // `projectRoot(cwd)` — only usable when the cwd maps back to this dir,
    // and only probed when that dir exists in `~/.claude/projects` (a
    // profile-only project has no DB, and the read-only open would still
    // create the parent dir).
    let pins = new Map<string, string>();
    if (cwd && encodeProjectDir(cwd) === key && srcs.some((s) => s.profileId === null)) {
      const ids = new Set<string>();
      for (const { src, files } of found) {
        for (const f of files) ids.add(sessionIdForTranscript(src.dir, f.path));
      }
      pins = await getSessionAccountsByCwd([...ids].map((id) => ({ cwd, id }))).catch(
        () => new Map<string, string>(),
      );
    }
    const pricing = await resolvePricing(cwd ?? homedir()).catch(() => undefined);
    if (hasModelPricingOverride(pricing)) pricingOverrideActive = true;

    for (const { src, files } of found) {
      for (const file of files) {
        const sessionId = sessionIdForTranscript(src.dir, file.path);
        const account = pins.get(`${cwd}:${sessionId}`) ?? src.profileId ?? UNPINNED_ACCOUNT_KEY;
        tagged.push({ file, project: key, account, sessionKey: `${key}:${sessionId}`, pricing });
      }
    }
  }

  // Oldest file first (then path), like `aggregate`: a replayed call is
  // attributed to the file it first appeared in, deterministically.
  tagged.sort(
    (a, b) => a.file.firstSeenMs - b.file.firstSeenMs || a.file.path.localeCompare(b.file.path),
  );

  const dedup = new Set<string>();
  const days = new Map<string, { usd: number; byProject: Map<string, number>; byAccount: Map<string, number> }>();
  const byProject = new Map<string, Acc>();
  const byAccount = new Map<string, Acc>();
  let totalUsd = 0;

  for (const t of tagged) {
    let fileUsd = 0;
    for (const row of t.file.rows) {
      if (row.k) {
        if (dedup.has(row.k)) continue;
        dedup.add(row.k);
      }
      const usd = rowUsd(row, table, t.pricing);
      totalUsd += usd;
      fileUsd += usd;
      let day = days.get(row.d);
      if (!day) {
        day = { usd: 0, byProject: new Map(), byAccount: new Map() };
        days.set(row.d, day);
      }
      day.usd += usd;
      day.byProject.set(t.project, (day.byProject.get(t.project) ?? 0) + usd);
      day.byAccount.set(t.account, (day.byAccount.get(t.account) ?? 0) + usd);
    }
    if (fileUsd === 0) continue; // fully duplicated elsewhere (or free)
    for (const [map, key] of [
      [byProject, t.project],
      [byAccount, t.account],
    ] as const) {
      let acc = map.get(key);
      if (!acc) {
        acc = newAcc();
        map.set(key, acc);
      }
      acc.usd += fileUsd;
      acc.sessions.add(t.sessionKey);
      acc.lastSeenMs = Math.max(acc.lastSeenMs, t.file.lastSeenMs);
    }
  }

  const dayList: OverviewDay[] = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({
      date,
      usd: d.usd,
      byProject: Object.fromEntries(d.byProject),
      byAccount: Object.fromEntries(d.byAccount),
    }));

  const projects: OverviewProject[] = [...byProject.entries()]
    .map(([key, acc]) => ({
      ...(projectMeta.get(key) ?? { key, label: key, cwd: null, workspaceId: null }),
      usd: acc.usd,
      sessions: acc.sessions.size,
      lastSeenMs: acc.lastSeenMs,
    }))
    .sort((a, b) => b.usd - a.usd);

  const accounts: OverviewAccount[] = [...byAccount.entries()]
    .map(([key, acc]) => {
      const unpinned = key === UNPINNED_ACCOUNT_KEY;
      const label = unpinned ? "No profile" : labels.get(key);
      return {
        key,
        label: label ?? `Removed account (${key.slice(0, 12)})`,
        accountId: unpinned ? null : key,
        removed: !unpinned && label === undefined,
        usd: acc.usd,
        sessions: acc.sessions.size,
        lastSeenMs: acc.lastSeenMs,
      };
    })
    .sort((a, b) => b.usd - a.usd);

  const now = Date.now();
  const today = dayKey(now);
  const weekDays = new Set<string>();
  const monthDays = new Set<string>();
  for (let i = 0; i < 7; i++) weekDays.add(dayKey(now - i * 86_400_000));
  for (let i = 0; i < 30; i++) monthDays.add(dayKey(now - i * 86_400_000));
  let todayUsd = 0;
  let weekUsd = 0;
  let monthUsd = 0;
  for (const d of dayList) {
    if (d.date === today) todayUsd += d.usd;
    if (weekDays.has(d.date)) weekUsd += d.usd;
    if (monthDays.has(d.date)) monthUsd += d.usd;
  }

  return {
    generatedAt: now,
    totalUsd,
    todayUsd,
    weekUsd,
    monthUsd,
    days: dayList,
    projects,
    accounts,
    accountsConfigured: profiles.length,
    pricingOverrideActive,
  };
}

let inflight: Promise<CostOverview> | null = null;

/**
 * `aggregateOverview`, shared by concurrent callers: the first run on a
 * machine parses every transcript once (later runs hit the per-project
 * caches), so a second request mid-scan joins it instead of starting over.
 */
export function getCostOverview(): Promise<CostOverview> {
  inflight ??= aggregateOverview().finally(() => {
    inflight = null;
  });
  return inflight;
}

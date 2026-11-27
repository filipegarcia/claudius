#!/usr/bin/env node
// Golden fixture for the native Sessions browser (U11): the pure rules the
// React page (app/[workspaceId]/sessions/page.tsx) ranks, pages and labels
// its rows with.
//
//   node rust/scripts/sessions-page-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with HOME in a temp
// dir, `TZ=UTC`, `LANG=en_US.UTF-8` and `Date.now()` fixed (`now`), twice;
// both recordings must agree byte for byte. What it records:
// - `parse`: lib/shared/session-search.ts `parseSessionQuery(raw)`.
// - `score`: `scoreSession(fields, q, namesOnly)` with `q` lowered as the
//   page lowers it (`text.toLowerCase()`).
// - `rank`: the page's `filtered` for a query over a session list (no branch,
//   unread or transcript filter): parse, lower, score, stable sort by score
//   descending. This composition is the page's, copied here (page.tsx is a
//   React module); the parts it calls are the real ones.
// - `lower`: `String.prototype.toLowerCase`, which the scoring runs on both
//   sides.
// - `older` / `ceiling` / `hasMore`: lib/shared/session-search-older.ts
//   `olderSearchState`, `nextOlderSearchCeiling` and
//   lib/shared/session-pagination.ts `hasMoreSessions`, with the constants.
// - `relative` / `bytes`: the page's own `fmtRelative` and `fmtBytes`, taken
//   from page.tsx's source text (they aren't exported) into a temp module.
// - `localeString` / `localeDate` / `localeNumber`: `toLocaleString()`,
//   `toLocaleDateString()` and a number's `toLocaleString()` in en-US, UTC:
//   the one-session page's meta line and the compaction divider's tokens.
//
// Written to rust/app/crates/claudius-app/tests/fixtures/sessions_page_golden.json
// and replayed by rust/app/crates/claudius-app/tests/sessions_golden.rs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "app/crates/claudius-app/tests/fixtures/sessions_page_golden.json");
const NOW = 1795723200000;

if (!process.env.SESSIONS_PAGE_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sessions-page-golden-")));
    try {
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            TZ: "UTC",
            LANG: "en_US.UTF-8",
            SESSIONS_PAGE_GOLDEN_CHILD: root,
          },
        },
      );
      if (r.status !== 0) {
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      return readFileSync(join(root, "out.json"), "utf8");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) throw new Error("the two recordings differ");
  writeFileSync(out, runs[0]);
  const fixture = JSON.parse(runs[0]);
  const counts = Object.entries(fixture.sections).map(([k, v]) => `${k} ${v.length}`);
  const total = Object.values(fixture.sections).reduce((n, v) => n + v.length, 0);
  console.log(`wrote ${out.slice(repo.length + 1)}: ${total} cases (stable)\n  ${counts.join(", ")}`);
  process.exit(0);
}

const ROOT_DIR = process.env.SESSIONS_PAGE_GOLDEN_CHILD;

const hook = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
export async function resolve(spec, ctx, next) {
  if ((spec.startsWith(".") || spec.startsWith("file:")) && ctx.parentURL) {
    const p = fileURLToPath(new URL(spec, ctx.parentURL));
    if (!existsSync(p) && existsSync(p + ".ts")) return next(pathToFileURL(p + ".ts").href, ctx);
  }
  return next(spec, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

Date.now = () => NOW;

// The page's two local helpers, cut out of its source.
const pageSrc = readFileSync(join(repo, "app/[workspaceId]/sessions/page.tsx"), "utf8");
function extract(name) {
  const start = pageSrc.indexOf(`\nfunction ${name}(`);
  if (start < 0 || pageSrc.indexOf(`\nfunction ${name}(`, start + 1) >= 0) {
    throw new Error(`page.tsx no longer declares \`function ${name}(\` exactly once: update the recorder`);
  }
  const end = pageSrc.indexOf("\n}\n", start);
  if (end < 0) throw new Error(`can't find the end of ${name}`);
  return pageSrc.slice(start + 1, end + 2);
}
const helpersPath = join(ROOT_DIR, "page-helpers.ts");
writeFileSync(helpersPath, `export ${extract("fmtRelative")}\nexport ${extract("fmtBytes")}\n`);
const { fmtRelative, fmtBytes } = await import(pathToFileURL(helpersPath).href);
const { parseSessionQuery, scoreSession } = await import(
  pathToFileURL(join(repo, "lib/shared/session-search.ts")).href
);
const older = await import(pathToFileURL(join(repo, "lib/shared/session-search-older.ts")).href);
const pagination = await import(pathToFileURL(join(repo, "lib/shared/session-pagination.ts")).href);

// --------------------------------- cases ---------------------------------

const RAW = [
  "",
  "   ",
  "foo",
  "  Foo Bar  ",
  "n:",
  "n:foo",
  "N:foo",
  "n: foo",
  "n:   foo bar ",
  " n:x",
  "xn:foo",
  "n :foo",
  "nn:foo",
  "n:n:foo",
  "\tn:\tfoo\t",
  "\u00a0n:\u00a0foo\u00a0",
  "\ufeffn:x\ufeff",
  "\u2028n:\u2029x",
  "\u0085n:x\u0085",
  "\u180en:x",
  "\u3000n:\u3000x",
  "\u200bn:x",
  "n:\u000bx",
  "n:\u000cx",
  "\r\nn:x\r\n",
  "n:\u2000\u200ax",
  "n:\u202f\u205fx",
  "N: Caf\u00e9",
  "\u1680n:x",
];

const parse = RAW.map((raw) => ({ raw, out: parseSessionQuery(raw) }));

const FIELDS = [
  {
    customTitle: "Fix the login bug",
    claudiusTitle: null,
    firstPrompt: "please fix the login flow",
    sessionId: "3e9a7c41-0b2d-4e8f-8c6a-1d2e3f405162",
  },
  {
    customTitle: "Other title",
    claudiusTitle: "Release notes",
    firstPrompt: "draft the release notes",
    sessionId: "8c1f0b2e-5d4a-4f7e-9a61-2b3c4d5e6f70",
  },
  { customTitle: null, claudiusTitle: null, firstPrompt: null, sessionId: "51c0e8a3-9f7b-4d2c-a1e6-0b9c8d7e6f5a" },
  { customTitle: "", claudiusTitle: "", firstPrompt: "", sessionId: "ABCDEF00-0000-4000-8000-000000000000" },
  { customTitle: "\u00dcn\u00efc\u00f6d\u00e9 Stra\u00dfe", firstPrompt: "Gr\u00fc\u00dfe", sessionId: "u1" },
  { claudiusTitle: "\u039f\u0394\u03a5\u03a3\u03a3\u0395\u03a5\u03a3", sessionId: "u2" },
  { customTitle: "\u0130stanbul trip", sessionId: "u3" },
  { customTitle: "\u65e5\u672c\u8a9e\u306e\u30bf\u30a4\u30c8\u30eb", firstPrompt: "\ud83d\ude80 launch", sessionId: "u4" },
  { customTitle: "login", claudiusTitle: "Login page", sessionId: "login-1" },
  { customTitle: "KELVIN \u212a", sessionId: "u5" },
];
const QUERIES = [
  "fix",
  "Fix the login bug",
  "login",
  "LOGIN",
  "please",
  "3e9a",
  "zzz",
  "release",
  "notes",
  "8C1F",
  "stra\u00dfe",
  "STRASSE",
  "gr\u00fc",
  "\u03bf\u03b4\u03c5\u03c3\u03c3\u03b5\u03c5\u03c2",
  "\u03a3",
  "\u0130stanbul",
  "i\u0307stanbul",
  "istanbul",
  "\u65e5\u672c",
  "\ud83d\ude80",
  "kelvin k",
  "\u212a",
  "-0000-",
  "ABCDEF",
];
const score = [];
for (const fields of FIELDS) {
  for (const raw of QUERIES) {
    const q = raw.toLowerCase();
    for (const namesOnly of [false, true]) {
      const s = scoreSession(fields, q, namesOnly);
      score.push({ fields, q, namesOnly, out: s });
    }
  }
}

const lower = [...new Set([...QUERIES, ...FIELDS.flatMap((f) => [f.customTitle, f.claudiusTitle, f.firstPrompt].filter(Boolean))])].map(
  (raw) => ({ raw, out: raw.toLowerCase() }),
);

// The page's ranking (its `filtered` memo with no branch / unread / content
// filter), over every field set as one list.
function rankIds(sessions, filter) {
  const { text, namesOnly } = parseSessionQuery(filter);
  const q = text.toLowerCase();
  if (!q) return sessions.map((s) => s.sessionId);
  const scored = [];
  for (const s of sessions) {
    const sc = scoreSession(
      { customTitle: s.customTitle, claudiusTitle: s.claudiusTitle, firstPrompt: s.firstPrompt, sessionId: s.sessionId },
      q,
      namesOnly,
    );
    if (sc != null) scored.push({ s, score: sc });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.s.sessionId);
}
const RANK_FILTERS = [
  "",
  "  ",
  "login",
  "n:login",
  "n: 3e9a",
  "3e9a",
  "e",
  "n:e",
  "N:  LOGIN PAGE",
  "Login",
  "release notes",
  "s",
  "-",
  "\u00a0login\u00a0",
];
const rank = RANK_FILTERS.map((filter) => ({ sessions: FIELDS, filter, out: rankIds(FIELDS, filter) }));

const olderCases = [];
for (const query of ["", " ", "x"]) {
  for (const matchCount of [0, 2]) {
    for (const loadedCount of [0, 5, 1000, 1200]) {
      for (const hasMore of [true, false]) {
        for (const loading of [true, false]) {
          for (const failed of [undefined, false, true]) {
            for (const ceiling of [1000, 2000]) {
              const input = { query, matchCount, loadedCount, hasMore, loading, ceiling };
              if (failed !== undefined) input.failed = failed;
              olderCases.push({ input, out: older.olderSearchState(input) });
            }
          }
        }
      }
    }
  }
}
const ceiling = [
  [1000, 0],
  [1000, 1000],
  [1000, 1450],
  [2000, 1000],
  [0, 0],
].map(([c, loaded]) => ({ ceiling: c, loaded, out: older.nextOlderSearchCeiling(c, loaded) }));
const hasMore = [
  [0, 200],
  [199, 200],
  [200, 200],
  [201, 200],
  [0, 0],
  [5, 0],
  [5, -1],
  [400, 400],
].map(([returned, limit]) => ({ returned, limit, out: pagination.hasMoreSessions(returned, limit) }));
const constants = [
  { name: "SESSION_PAGE_SIZE", out: pagination.SESSION_PAGE_SIZE },
  { name: "OLDER_SEARCH_STEP", out: older.OLDER_SEARCH_STEP },
];

const DAY = 86_400_000;
const relative = [
  NOW,
  NOW - 1,
  NOW - 59_999,
  NOW - 60_000,
  NOW - 61_000,
  NOW - 3_599_999,
  NOW - 3_600_000,
  NOW - 7_260_000,
  NOW - (DAY - 1),
  NOW - DAY,
  NOW - DAY - 1,
  NOW - 2 * DAY,
  NOW - 400 * DAY,
  NOW + 5_000,
  0,
  1_700_000_000_000,
].map((ms) => ({ ms, out: fmtRelative(ms) }));
const bytes = [
  null,
  0,
  1,
  1023,
  1024,
  1075,
  1280,
  1331,
  1536,
  10239,
  10240,
  1048575,
  1048576,
  1310720,
  5 * 1048576 + 262144,
  1073741824,
  123456789,
  0.5,
  1024.5,
].map((n) => ({ n, out: fmtBytes(n ?? undefined) }));

const STAMPS = [NOW, 0, 1_700_000_000_000, NOW + 12 * 3_600_000 + 5_000, NOW - 13 * 3_600_000];
const localeString = STAMPS.map((ms) => ({ ms, out: new Date(ms).toLocaleString() }));
const localeDate = STAMPS.map((ms) => ({ ms, out: new Date(ms).toLocaleDateString() }));
const localeNumber = [0, 7, 999, 1000, 12345, 1234567, 98765432].map((n) => ({ n, out: n.toLocaleString() }));

const sections = {
  parse,
  score,
  rank,
  lower,
  older: olderCases,
  ceiling,
  hasMore,
  constants,
  relative,
  bytes,
  localeString,
  localeDate,
  localeNumber,
};

// ASCII-only JSON (every non-ASCII unit `\u`-escaped), so the fixture reads
// the same in any tool.
const text = JSON.stringify({ now: NOW, sections }, null, 1).replace(
  /[\u007f-\uffff]/g,
  (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
);
writeFileSync(join(ROOT_DIR, "out.json"), text + "\n");

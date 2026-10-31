#!/usr/bin/env node
// Golden fixture for `GET /api/docker/containers` (D23), recorded from the
// real route handler (app/api/docker/containers/route.ts) with a fake
// `docker` alone on PATH:
//
//   node rust/scripts/docker-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with the repo as its
// cwd, HOME and CLAUDE_CONFIG_DIR at a temp dir, a resolve hook for
// `next/server`, PATH at a temp bin dir and `Date.now` pinned (`sampledAt`).
//
// The fake (`fake`, a /bin/sh script) writes its argv, NUL-separated, to
// $FAKE_DOCKER_DIR/<verb>.argv and then sources <verb>.sh from there; that
// snippet can call `out` / `err` to print <verb>.out / <verb>.err, sleep,
// trap, kill itself or generate output. The real docker is never on PATH.
// Each case sets the bin dir's `docker` (`bin`: the fake, missing, not
// executable, a directory, a missing interpreter, or no shebang), writes
// each verb's files, calls GET() and records the status, content type and
// body text (a body over 64 KiB as its sha256 and byte length) and the argv
// each verb ran with (null: never ran). `minMs` / `maxMs` bound how long the
// handler took (checked here and in the replay). A case with `as` is a
// listed difference: it is also recorded with `as` merged over it (`gotAs`),
// which is what the Rust port answers.
//
// Written to rust/crates/claudius-server/tests/fixtures/docker_golden.json
// (ASCII only); replayed by crates/claudius-server/tests/docker.rs against
// the real binary with the same fake.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-server/tests/fixtures/docker_golden.json");

if (!process.env.DOCKER_GOLDEN_CHILD) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "docker-golden-")));
  try {
    const r = spawnSync(
      process.execPath,
      ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
      {
        cwd: repo,
        stdio: "inherit",
        env: {
          PATH: process.env.PATH,
          HOME: join(root, "home"),
          CLAUDE_CONFIG_DIR: join(root, "config"),
          DOCKER_GOLDEN_CHILD: "1",
          DOCKER_GOLDEN_ROOT: root,
        },
      },
    );
    process.exit(r.status ?? 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const hook = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = ${JSON.stringify(pathToFileURL(repo + "/").href)};
export async function resolve(spec, ctx, next) {
  const s = spec.startsWith("@/") ? new URL(spec.slice(2), ROOT).href : spec;
  if ((s.startsWith(".") || s.startsWith("file:")) && ctx.parentURL) {
    const p = fileURLToPath(new URL(s, ctx.parentURL));
    if (!existsSync(p)) {
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        if (existsSync(p + ext)) return next(pathToFileURL(p + ext).href, ctx);
      }
    }
  }
  try {
    return await next(s, ctx);
  } catch (e) {
    // A bare CJS subpath without an exports map (\`next/server\`).
    if (e?.code === "ERR_MODULE_NOT_FOUND" && !s.includes(":") && !s.startsWith(".")) return next(s + ".js", ctx);
    throw e;
  }
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const SAMPLED_AT = 1_700_000_000_000;
Date.now = () => SAMPLED_AT;

const ROOT = process.env.DOCKER_GOLDEN_ROOT;
const BIN = join(ROOT, "bin");
const DATA = join(ROOT, "data");
mkdirSync(BIN, { recursive: true });
process.env.PATH = BIN;
process.env.FAKE_DOCKER_DIR = DATA;

const route = await import(join(repo, "app/api/docker/containers/route.ts"));

// ------------------------------- the fake -------------------------------

const FAKE_BODY = [
  "# Fake `docker` (D23 golden): argv to <verb>.argv, then <verb>.sh.",
  'd="$FAKE_DOCKER_DIR"',
  'v="$1"',
  "printf '%s\\000' \"$@\" > \"$d/$v.argv\"",
  'out() { /bin/cat "$d/$v.out"; }',
  'err() { /bin/cat "$d/$v.err" >&2; }',
  'if [ -f "$d/$v.sh" ]; then . "$d/$v.sh"; fi',
  "printf 'fake docker: no script for %s\\n' \"$v\" >&2",
  "exit 97",
  "",
].join("\n");
const FAKE = `#!/bin/sh\n${FAKE_BODY}`;

/** Put `docker` in the bin dir as `kind` says. */
function installBin(kind) {
  const p = join(BIN, "docker");
  rmSync(p, { recursive: true, force: true });
  if (kind === "missing") return;
  if (kind === "dir") return mkdirSync(p);
  const text = { fake: FAKE, noexec: FAKE, badinterp: `#!/nonexistent-claudius-d23/sh\n${FAKE_BODY}`, noshebang: FAKE_BODY }[kind];
  if (text === undefined) throw new Error(`bin ${kind}`);
  writeFileSync(p, text);
  chmodSync(p, kind === "noexec" ? 0o644 : 0o755);
}

// ------------------------------- helpers -------------------------------

/** Number literals JSON.stringify can't write: `INF` is 1e400, `NINF` -1e400, `NEG0` -0. */
const INF = "@@1e400@@";
const NINF = "@@-1e400@@";
const NEG0 = "@@-0@@";
const j = (v) => JSON.stringify(v).replace(/"@@(-?1e400|-0)@@"/g, "$1");
/** NDJSON text: strings as they are, anything else through `j`. */
const nd = (...rows) => rows.map((r) => (typeof r === "string" ? r : j(r))).join("\n") + "\n";
/** Go's encoder escapes <, > and & inside strings. */
const go = (v) => j(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
/** A verb that prints `stdout` (and `stderr`) and exits `code`. */
const V = (stdout = "", stderr = "", code = 0) => ({ sh: `out; err; exit ${code}`, out: stdout, err: stderr });
const OK_EMPTY = V();
const DAEMON = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n";
/** A 12-hex short id and its 64-hex full form. */
const sid = (n) => n.toString(16).padStart(12, "0");
const fid = (n) => sid(n) + "deadbeef".repeat(6) + "0123";
const deep = (n, leaf) => {
  let v = leaf;
  for (let i = 0; i < n; i++) v = [v];
  return v;
};

// ------------------------------- cases -------------------------------

const CASES = [];
const add = (group, name, c) => CASES.push({ group, name, ...c });

// ---- the fleet
const PS_REAL = [
  {
    Command: '"docker-entrypoint.s\u2026"',
    CreatedAt: "2026-10-27 09:12:44 +0000 UTC",
    ID: sid(1),
    Image: "postgres:16",
    Labels: "com.docker.compose.project=app,com.docker.compose.service=db",
    LocalVolumes: "1",
    Mounts: "app_pgdata",
    Names: "app-db-1",
    Networks: "app_default",
    Ports: "0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp",
    RunningFor: "2 hours ago",
    Size: "63B (virtual 432MB)",
    State: "running",
    Status: "Up 2 hours (healthy)",
  },
  { ID: sid(2), Image: "redis:7-alpine", Names: "app-cache-1", Ports: "6379/tcp", RunningFor: "5 minutes ago", State: "running", Status: "Up 5 minutes (health: starting)" },
  { ID: sid(3), Image: "nginx:latest", Names: "web", Ports: "0.0.0.0:8080->80/tcp", RunningFor: "3 days ago", State: "running", Status: "Up 3 days (unhealthy)" },
  { ID: sid(4), Image: "alpine", Names: "job", Ports: "", RunningFor: "3 hours ago", State: "exited", Status: "Exited (0) 3 hours ago" },
  { ID: sid(5), Image: "busybox", Names: "fresh", Ports: "", RunningFor: "1 second ago", State: "created", Status: "Created" },
  { ID: sid(6), Image: "node:22", Names: "paused", Ports: "3000/tcp", RunningFor: "2 hours ago", State: "paused", Status: "Up 2 hours (Paused)" },
  { ID: sid(7), Image: "app/worker:dev", Names: "worker", Ports: "", RunningFor: "10 seconds ago", State: "restarting", Status: "Restarting (1) 5 seconds ago" },
];
const STATS_REAL = [
  { BlockIO: "1.2MB / 3.4MB", CPUPerc: "0.05%", Container: sid(1), ID: sid(1), MemPerc: "1.23%", MemUsage: "23.4MiB / 1.95GiB", Name: "app-db-1", NetIO: "1.2kB / 3.4kB", PIDs: "7" },
  { BlockIO: "0B / 0B", CPUPerc: "12.50%", Container: sid(2), ID: sid(2), MemPerc: "0.40%", MemUsage: "8.105MiB / 1.953GiB", Name: "app-cache-1", NetIO: "726B / 0B", PIDs: "5" },
  { BlockIO: "25.1MB / 0B", CPUPerc: "150.03%", Container: sid(3), ID: sid(3), MemPerc: "0.00%", MemUsage: "0B / 0B", Name: "web", NetIO: "1.5GB / 22.3MB", PIDs: "13" },
  { BlockIO: "-- / --", CPUPerc: "--", Container: sid(6), ID: sid(6), MemPerc: "--", MemUsage: "-- / --", Name: "paused", NetIO: "-- / --", PIDs: "--" },
  { BlockIO: "4.1kB / 0B", CPUPerc: "0.00%", Container: "worker", ID: fid(7), MemPerc: "0.01%", MemUsage: "128KiB / 7.66GiB", Name: "worker", NetIO: "0B / 0B", PIDs: "0" },
];
add("fleet", "realistic docker output (Go escapes, all states)", { ps: V(PS_REAL.map(go).join("\n") + "\n"), stats: V(STATS_REAL.map(go).join("\n") + "\n") });
add("fleet", "no containers", { ps: OK_EMPTY, stats: OK_EMPTY });
add("fleet", "no trailing newline, CRLF", { ps: V(PS_REAL.slice(0, 3).map(go).join("\r\n")), stats: V(STATS_REAL.slice(0, 3).map(go).join("\r\n")) });
add("fleet", "stats rows in another order, one missing", { ps: V(nd(...PS_REAL.slice(0, 4))), stats: V(nd(STATS_REAL[2], STATS_REAL[0])) });
add("fleet", "stats empty", { ps: V(nd(...PS_REAL.slice(0, 2))), stats: OK_EMPTY });
add("fleet", "exit 0 with stderr chatter", { ps: V(nd(PS_REAL[0]), DAEMON), stats: V(nd(STATS_REAL[0]), "WARNING: x\n") });
{
  // Over 64 KiB each way: multi-byte characters across the pipe reads.
  const ps = [];
  const stats = [];
  for (let i = 0; i < 250; i++) {
    ps.push({ ID: fid(1000 + i), Names: `n${i}-\u00e9\u{1F600}\u65e5${"\u00e9".repeat(i % 7)}`, Image: "img\u2603".repeat(40), Status: i % 3 ? "Up (healthy)" : "Up", State: "running", Ports: "p".repeat(i % 50) });
    stats.push({ ID: sid(1000 + i), CPUPerc: `${i / 100}%`, MemPerc: `${i % 97}.5%`, MemUsage: `${i}KiB / ${i + 1}MiB`, BlockIO: `${i}kB / ${i}MB`, NetIO: `${i}B / ${i}GB`, Name: "\u00e9\u{1F600}".repeat(60) });
  }
  add("fleet", "250 containers, multi-byte across reads", { ps: V(nd(...ps)), stats: V(nd(...stats.reverse())) });
}

// ---- line shapes
add("lines", "blank, odd and malformed lines", {
  ps: V(
    [
      "",
      "   ",
      "\t",
      "\r",
      j({ ID: "crlf" }) + "\r",
      "\ufeff" + j({ ID: "bom" }),
      "\u00a0\u2028" + j({ ID: "nbsp-ls" }) + "\u2029\u3000",
      "\u0085" + j({ ID: "nel" }),
      j({ ID: "nel-after" }) + "\u0085",
      "{",
      '{"ID":}',
      "not json",
      '{"ID":"a",}',
      "{'ID':'x'}",
      '{"ID":"x"} trailing',
      '{"ID":"y"}{"ID":"z"}',
      j({ ID: "cr-joined" }) + "\r" + j({ ID: "second" }),
      "null",
      " null ",
      "false",
      "true",
      "0",
      "-0",
      "1e400",
      '"str"',
      "[]",
      "[1,2]",
      "{}",
      '{ "ID" : "ws" ,\t"Names" : [ 1 , { "a" : [ ] , "b" : { } } , [ ] , -2.5e-3 ] , "Image":{ } , "Status" : null }',
      '{"ID":"cr"\r,"Names":\r1}',
      '{"I\\u0044":"escaped-key","\\u004eames":"n"}',
      '{"ID":"ls\u2028in-string"}',
      '{"ID":"tab\tin-string"}',
      '{"ID":"ok-last"}',
    ].join("\n"),
  ),
  stats: V(nd({ ID: "crlf", CPUPerc: "1%" }, { ID: "bom", CPUPerc: "2%" }, { ID: "nbsp-ls", CPUPerc: "3%" }, { ID: "ok-last", CPUPerc: "4%" })),
});
add("lines", "field values of every type", {
  ps: V(
    [
      '{"ID":"n1","Names":1.0,"Image":1e2,"Status":-0,"State":1e400,"Ports":-1e400,"RunningFor":1e21,"Labels":[1E+2,1e-2]}',
      '{"ID":"n1b","Names":1E+2,"Image":-1.5E-7,"Status":0.000001,"State":1e-7,"Ports":12345678901234567890,"RunningFor":1.7976931348623157e308}',
      '{"ID":"n2","Names":0.1,"Image":5e-324,"Status":true,"State":false,"Ports":null,"RunningFor":123456789012345678901234567890}',
      '{"ID":"n3","Names":[],"Image":[1,"a",null,[2,[3]],{}],"Status":{},"State":{"b":1,"a":2,"10":3,"2":4,"-1":5,"01":6,"4294967294":7,"4294967295":8,"1.5":9},"Ports":{"__proto__":1,"constructor":2},"RunningFor":[null]}',
      '{"ID":"n4","Names":"first","Names":"second","Image":{"a":1,"b":2,"a":3},"Status":"Up","State":"running","Ports":"","RunningFor":""}',
      '{"ID":"n5","Names":"\\u0000\\u0001\\u001f\\u007f\\u0080\\u009f\\b\\f\\n\\r\\t\\"\\\\\\/","Image":"\\u2028\\u2029\\ufeff\\ufffe","Status":"\\ud800","State":"x\\udc00y","Ports":"\\ud83d\\ude00","RunningFor":"\\\\ud800"}',
      j({ ID: "n6", Names: "\u{1F600} \u65e5\u672c \u00e9 e\u0301 \u202eRTL\u202c \uFFFD", Image: "\u{10FFFF}\u{1F1F5}\u{1F1F9}", Status: "Up 1 minute", State: "running", Ports: "0.0.0.0:80->80/tcp", RunningFor: "x".repeat(10000) }),
      '{"ID":"n7"}',
      '{"Names":"no id"}',
      '{"ID":null,"Names":"null id"}',
      '{"id":"lower","ID":"upper","iD":"mixed"}',
    ].join("\n"),
  ),
  stats: OK_EMPTY,
});
add("lines", "a field nested 999 levels (1000 with the row)", { ps: V(nd({ ID: "deep", Names: deep(999, "x"), Status: deep(998, "(healthy)") })), stats: OK_EMPTY });
add("lines", "a line nested 1001 levels in an unused field", {
  ps: V(nd({ ID: "keep" }, { ID: "deep", Labels: deep(1000, 1) }, { ID: "after" })),
  stats: OK_EMPTY,
  as: { ps: V(nd({ ID: "keep" }, { ID: "after" })) },
  why: "a line nested past 1000 levels is skipped",
});

// ---- ids and the join
add("ids", "ID shapes and the 12-unit join", {
  ps: V(
    nd(
      { ID: fid(1), Names: "full id" },
      { ID: "short", Names: "short id" },
      { ID: "", Names: "empty id" },
      { ID: null, Names: "null id" },
      { Names: "no id" },
      { ID: "abcdefghijklmnop", Names: "16 chars" },
      { ID: "a".repeat(11) + "\u{1F600}tail", Names: "astral cut at 12" },
      { ID: "b".repeat(10) + "\u{1F600}tail", Names: "astral kept at 12" },
      { ID: "\u65e5\u672c\u8a9e\u306e\u9577\u3044\u30b3\u30f3\u30c6\u30caID\u3067\u3059", Names: "BMP cut" },
      { ID: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], Names: "array id" },
      { ID: [], Names: "empty array id" },
      { ID: [[sid(2)]], Names: "nested array id" },
      { ID: sid(2), Names: "dup stats" },
      { ID: sid(3), Names: "stats by full id" },
      { ID: "zz", Names: "no stats" },
    ),
  ),
  stats: V(
    nd(
      { ID: sid(1), CPUPerc: "1%" },
      { ID: "short", CPUPerc: "2%" },
      { ID: "", CPUPerc: "99%" },
      { ID: 0, CPUPerc: "98%" },
      { ID: false, CPUPerc: "97%" },
      { ID: null, CPUPerc: "96%" },
      { ID: [], CPUPerc: "95%" },
      { ID: [sid(2)], CPUPerc: "94%" },
      5,
      "str",
      [1],
      true,
      { ID: "abcdefghijklXXXX", CPUPerc: "3%" },
      { ID: "a".repeat(11) + "\u{1F600}zzz", CPUPerc: "4%" },
      { ID: "b".repeat(10) + "\u{1F600}", CPUPerc: "5%" },
      { ID: "\u65e5\u672c\u8a9e\u306e\u9577\u3044\u30b3\u30f3\u30c6\u30ca", CPUPerc: "6%" },
      { ID: sid(2), CPUPerc: "7%" },
      { ID: sid(2), CPUPerc: "8%" },
      { ID: fid(3), CPUPerc: "9%" },
    ),
  ),
});
add("ids", "a lone-surrogate ID escape joins", {
  ps: V('{"ID":"aaaaaaaaaaa\\ud83d","Names":"escape"}\n{"ID":"x\\udc00","Names":"low"}\n'),
  stats: V('{"ID":"aaaaaaaaaaa\\ud83d\\ude00","CPUPerc":"1%"}\n{"ID":"x\\udc00","CPUPerc":"2%"}\n'),
});

// ---- health (Status)
{
  const statuses = [
    "Up 2 hours (healthy)",
    "Up (unhealthy)",
    "Up (health: starting)",
    "(HEALTHY)",
    "(UnHealthy)",
    "(Health: Starting)",
    "(healthy",
    "healthy)",
    "unhealthy)",
    "Up unhealthy) (healthy)",
    "( healthy)",
    "(healthy )",
    "(health:starting)",
    "(health:  starting)",
    "(health: starting )",
    "(healthy)(unhealthy)",
    "(unhealthy) (healthy)",
    "((healthy))",
    "(health: starting)(healthy)",
    "(\u212Aealthy)",
    "(healt\u0127y)",
    "(\uff48ealthy)",
    "\uff08healthy\uff09",
    "(he\u0000althy)",
    "",
    "Up 3 days",
  ];
  const odd = [5, 0, true, false, null, ["(healthy)"], [["x", "(unhealthy)"]], [null, "(health: starting)"], ["(", "healthy)"], {}, { valueOf: 1 }, INF, NEG0];
  add("parse", "health from Status", {
    ps: V(nd(...[...statuses, ...odd].map((Status, i) => ({ ID: `h${i}`, Status })))),
    stats: OK_EMPTY,
  });
}

// ---- percent (CPUPerc, MemPerc)
{
  const pct = [
    "1.23%",
    "0%",
    "0.00%",
    "-1.5%",
    "--",
    "",
    "abc",
    "1,5%",
    "1.2.3%",
    ".5%",
    "5.%",
    "a-5",
    "--5",
    "-",
    "-.5",
    "1e3%",
    "  7 %",
    "\u00a07",
    "\u0661\u0662",
    "\uff15",
    "9".repeat(400) + "%",
    "1" + "0".repeat(308) + "%",
    "-0%",
    "0x1F%",
    "Infinity%",
    "100.000000000000000000001%",
    "0.1e2",
    5,
    0,
    NEG0,
    0.5,
    1e21,
    1e-7,
    INF,
    NINF,
    true,
    false,
    [12],
    [],
    ["1", "2"],
    [[3], 4],
    [null, 6],
    {},
    { valueOf: 2 },
    null,
  ];
  const ps = pct.map((_, i) => ({ ID: `p${i}` }));
  const stats = pct.map((v, i) => ({ ID: `p${i}`, CPUPerc: v, MemPerc: pct[(i + 7) % pct.length] }));
  add("parse", "percentages", { ps: V(nd(...ps)), stats: V(nd(...stats)) });
}

// ---- sizes (MemUsage, BlockIO, NetIO)
{
  const sizes = [
    "23.4MiB / 1.95GiB",
    "0B / 0B",
    "1.2kB / 3.4kB",
    "1KiB / 1TiB",
    "1TB / 1GB",
    "5PB / 1EiB",
    "1.5 MB / 2 mb",
    "12MiBfoo / x",
    "/",
    "--",
    "-- / --",
    "1/2/3",
    "1/2/3/4MB",
    "1e3MB / 1E3kb",
    "-5MB / 3MB",
    "1.MB",
    "1. MB / 2 .MB",
    ".5MB",
    "\u00a012 MB",
    "12\u00a0MB",
    "12\u3000GiB",
    "12\u2028kB",
    "12\ufeffkB",
    "12\u0085MB",
    "12\tKIB",
    "12 \u00e9MB",
    "12\u212AB",
    "12\u014DB", // U+014D's low byte is "M"
    "9".repeat(320) + "B",
    "1" + "0".repeat(300) + "TB",
    "1" + "0".repeat(300) + "TB / -" + "1" + "0".repeat(300) + "TB",
    "-0B / -0B",
    "1.5",
    "0.1KB / 0.2KB",
    "123456789.123456789GiB",
    "abc / def",
    " 7 / 8 ",
    "  /  ",
    "1B/",
    "/1B",
    "1 / 2 / ",
    "12MB3",
    "1KiB2 / 3GB4",
  ];
  const falsy = [0, NEG0, "", null, false];
  const ps = [];
  const stats = [];
  sizes.forEach((v, i) => {
    ps.push({ ID: `s${i}` });
    stats.push({ ID: `s${i}`, MemUsage: v, BlockIO: sizes[(i + 5) % sizes.length], NetIO: sizes[(i + 11) % sizes.length] });
  });
  falsy.forEach((v, i) => {
    ps.push({ ID: `f${i}` });
    stats.push({ ID: `f${i}`, MemUsage: v, BlockIO: v, NetIO: v });
  });
  // A stats row nobody joins can hold anything.
  stats.push({ ID: "nobody", MemUsage: 5, BlockIO: [1], NetIO: {} });
  add("parse", "sizes", { ps: V(nd(...ps)), stats: V(nd(...stats)) });
}

// ---- TypeErrors in the try block
{
  const one = (name, psRows, statsRows) =>
    add("throws", name, { ps: V(nd(...psRows)), stats: statsRows === null ? V("", "", 1) : V(nd(...statsRows)) });
  for (const id of [5, 0, NEG0, -1, false, true, {}, { slice: 1 }, INF]) one(`ps ID ${j(id)}`, [{ ID: "ok" }, { ID: id }], []);
  for (const id of [7, -1, true, {}, { slice: "x" }, INF, NINF]) one(`stats ID ${j(id)}`, [{ ID: "ok" }], [{ ID: "ok" }, { ID: id }]);
  one("stats ID -0 is falsy", [{ ID: "ok" }], [{ ID: NEG0 }]);
  one("stats ID 5 with no ps rows", [], [{ ID: 5 }]);
  for (const v of [5, true, [1], {}, INF, { split: 1 }]) one(`MemUsage ${j(v)}`, [{ ID: "m" }], [{ ID: "m", MemUsage: v }]);
  one("MemUsage -0 is falsy", [{ ID: "m" }], [{ ID: "m", MemUsage: NEG0, BlockIO: NEG0, NetIO: NEG0 }]);
  one("BlockIO [1]", [{ ID: "b" }], [{ ID: "b", BlockIO: [1] }]);
  one("NetIO true", [{ ID: "n" }], [{ ID: "n", NetIO: true }]);
  one("NetIO -1", [{ ID: "n" }], [{ ID: "n", NetIO: -1 }]);
  for (const v of [{ toString: "x" }, [{ toString: 1 }], [[1, { toString: null }]], { toString: "x", valueOf: 1 }])
    one(`Status ${j(v)}`, [{ ID: "s", Status: v }], []);
  one("CPUPerc with own toString", [{ ID: "c" }], [{ ID: "c", CPUPerc: { toString: 0 } }]);
  one("MemPerc nested own toString", [{ ID: "c" }], [{ ID: "c", MemPerc: [[{ toString: [] }]] }]);
  one("MemUsage throws before Status", [{ ID: "o", Status: { toString: 1 } }], [{ ID: "o", MemUsage: 5 }]);
  one("Status throws before BlockIO", [{ ID: "o", Status: { toString: 1 } }], [{ ID: "o", BlockIO: 5 }]);
  one("CPUPerc throws before NetIO", [{ ID: "o" }], [{ ID: "o", CPUPerc: { toString: 1 }, NetIO: 5 }]);
  one("CPUPerc throws before BlockIO", [{ ID: "o" }], [{ ID: "o", CPUPerc: { toString: 1 }, BlockIO: 5 }]);
  one("BlockIO throws before NetIO", [{ ID: "o" }], [{ ID: "o", BlockIO: { toString: 1 }, NetIO: 5 }]);
  one("the first row's error wins", [{ ID: "a", Status: [{ toString: 1 }] }, { ID: 5 }], []);
  one("stats ID throws before ps rows", [{ ID: 5 }], [{ ID: 5 }]);
  one("stats failed: its rows are never read", [{ ID: "ok" }], null);
  add("throws", "ps failed: stats rows are never read", { ps: V("", "boom\n", 1), stats: V(nd({ ID: 5 })) });
}

// ---- spawn
add("spawn", "docker not on PATH", { bin: "missing" });
add("spawn", "docker not executable", { bin: "noexec", ps: OK_EMPTY, stats: OK_EMPTY });
add("spawn", "docker is a directory", { bin: "dir" });
add("spawn", "missing interpreter", { bin: "badinterp", ps: OK_EMPTY, stats: OK_EMPTY });
add("spawn", "no shebang", {
  bin: "noshebang",
  ps: V(nd({ ID: "sh", Names: "ran by /bin/sh" })),
  stats: V(nd({ ID: "sh", CPUPerc: "1%" })),
  as: { bin: "fake" },
  why: "std runs an executable without a shebang through /bin/sh; Node reports spawn ENOEXEC",
});

// ---- the daemon
const daemon = (name, stderr, code = 1) => add("daemon", name, { ps: V("", stderr, code), stats: V("", stderr, code) });
daemon("cannot connect", DAEMON);
daemon("desktop socket", "Cannot connect to the Docker daemon at unix:///Users/me/.docker/run/docker.sock. Is the docker daemon running?\n");
daemon("connect: no such file or directory", 'error during connect: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/containers/json": dial unix /var/run/docker.sock: connect: no such file or directory\n');
daemon("connection refused, upper case", "Get http://localhost:2375/v1.47/containers/json: dial tcp 127.0.0.1:2375: CONNECTION REFUSED\n");
daemon("match on the second line", "WARNING: config file not found\nCannot connect to the Docker daemon at tcp://x:2375.\n");
daemon("empty first line", "\nconnection refused\n");
daemon("CRLF first line", "Cannot connect to the Docker daemon\r\nmore\r\n");
daemon("no newline", "  connection refused  ");
daemon("Kelvin K does not fold", "Cannot connect to the Doc\u212Aer daemon\n");
daemon("long s does not fold", "connection refu\u017Fed\n");
daemon("connect: no such file (no match)", "dial unix /var/run/docker.sock: connect: no such file\n");
daemon("windows pipe (no match)", 'error during connect: this error may indicate that the docker daemon is not running: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/containers/json": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.\n');
daemon("permission denied (no match)", "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get \"http://%2Fvar%2Frun%2Fdocker.sock/v1.47/containers/json\": dial unix /var/run/docker.sock: connect: permission denied\n");
daemon("daemon text on exit 0", DAEMON, 0);
add("daemon", "stats down, ps up", { ps: V(nd(...PS_REAL.slice(0, 2))), stats: V("", DAEMON, 1) });
add("daemon", "ps down, stats up", { ps: V("", DAEMON, 1), stats: V(nd(...STATS_REAL)) });

// ---- other failures
add("exit", "exit 1 with stderr", { ps: V("", "boom\n", 1), stats: OK_EMPTY });
add("exit", "exit 2, no stderr", { ps: V("", "", 2), stats: OK_EMPTY });
add("exit", "whitespace-only stderr", { ps: V("", "  \n\t \u00a0", 1), stats: OK_EMPTY });
add("exit", "JS-trimmed stderr", { ps: V("", "\ufeff\u00a0 \u00e9chec \u2028 x\u0085\n\u3000", 125), stats: OK_EMPTY });
add("exit", "rows on stdout, exit 1", { ps: V(nd(PS_REAL[0]), "", 1), stats: V(nd(STATS_REAL[0])) });
add("exit", "rows and stderr, exit 3", { ps: V(nd(PS_REAL[0]), "partial failure\nsecond line\n", 3), stats: OK_EMPTY });
add("exit", "killed by SIGKILL", { ps: { sh: "kill -KILL $$" }, stats: OK_EMPTY });
add("exit", "killed by SIGTERM after stderr", { ps: { sh: "printf 'dying\\n' >&2; kill -TERM $$" }, stats: OK_EMPTY });
add("exit", "killed by SIGINT after stdout", { ps: { sh: "out; kill -INT $$", out: nd(PS_REAL[0]) }, stats: OK_EMPTY });
add("exit", "stats exits 1", { ps: V(nd(...PS_REAL.slice(0, 3))), stats: V(nd(...STATS_REAL), "stats failed\n", 1) });
add("exit", "stats killed", { ps: V(nd(...PS_REAL.slice(0, 3))), stats: { sh: "out; kill -KILL $$", out: nd(...STATS_REAL) } });
add("exit", "no script for either verb", {});
add("exit", "invalid UTF-8 in stderr", { ps: V("", Buffer.from([0x62, 0x61, 0x64, 0xff, 0x20, 0xc3, 0x28, 0x20, 0xed, 0xa0, 0x80, 0x20, 0xe2, 0x82, 0x0a]), 1), stats: OK_EMPTY });
add("exit", "invalid UTF-8 in stdout", {
  ps: V(Buffer.concat([Buffer.from('{"ID":"u","Names":"a'), Buffer.from([0xff, 0x62, 0xe2, 0x82, 0x63, 0xf0, 0x9f, 0x98]), Buffer.from('"}\n'), Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"ID":"bom-bytes"}\n')])),
  stats: OK_EMPTY,
});

// ---- the timeouts (ps 2 s, stats 3.5 s). `maxMs` is tight only where it
// tells something: killed at its own timeout, both waited for at once, a
// pipe a grandchild holds not waited for.
const HANG = "exec /bin/sleep 30";
const tp = (name, c) => add("timing-ps", name, c);
const ts = (name, c) => add("timing-stats", name, c);
tp("ps hangs", { ps: { sh: HANG }, stats: OK_EMPTY, minMs: 2000, maxMs: 3400 });
tp("ps hangs after stderr", { ps: { sh: `err; ${HANG}`, err: "partial\n" }, stats: OK_EMPTY, minMs: 2000, maxMs: 3400 });
tp("ps hangs after rows", { ps: { sh: `out; ${HANG}`, out: nd(PS_REAL[0]) }, stats: V(nd(STATS_REAL[0])), minMs: 2000, maxMs: 3400 });
tp("ps answers at 2.6 s", { ps: { sh: "/bin/sleep 2.6; out; exit 0", out: nd(PS_REAL[0]) }, stats: OK_EMPTY, minMs: 2000, maxMs: 3400 });
tp("ps answers at 1 s", { ps: { sh: "/bin/sleep 1; out; exit 0", out: nd(PS_REAL[0]) }, stats: V(nd(STATS_REAL[0])), minMs: 1000, maxMs: 6000 });
tp("ps exited, a grandchild holds stdout", { ps: { sh: "out; (/bin/sleep 6 &); exit 0", out: nd(PS_REAL[0]) }, stats: OK_EMPTY, minMs: 2000, maxMs: 3400 });
tp("ps ignores SIGTERM, exits 0 at 3 s", { ps: { sh: "trap '' TERM; out; /bin/sleep 3; exit 0", out: nd(PS_REAL[0]) }, stats: V(nd(STATS_REAL[0])), minMs: 3000, maxMs: 6000 });
tp("ps ignores SIGTERM, exits 3 at 3 s", { ps: { sh: "trap '' TERM; err; /bin/sleep 3; exit 3", err: "late\n" }, stats: OK_EMPTY, minMs: 3000, maxMs: 6000 });
ts("stats hangs", { ps: V(nd(...PS_REAL.slice(0, 2))), stats: { sh: HANG }, minMs: 3500, maxMs: 6000 });
ts("stats answers at 2.5 s", { ps: V(nd(...PS_REAL.slice(0, 2))), stats: { sh: "/bin/sleep 2.5; out; exit 0", out: nd(...STATS_REAL) }, minMs: 2500, maxMs: 6000 });
ts("stats answers at 5.5 s", { ps: V(nd(...PS_REAL.slice(0, 2))), stats: { sh: "/bin/sleep 5.5; out; exit 0", out: nd(...STATS_REAL) }, minMs: 3500, maxMs: 5000 });
ts("both hang", { ps: { sh: HANG }, stats: { sh: HANG }, minMs: 3500, maxMs: 4900 });
ts("ps fails fast, stats hangs", { ps: V("", "boom\n", 1), stats: { sh: HANG }, minMs: 3500, maxMs: 6000 });

// ---- maxBuffer (4 MiB a stream)
const MIB4 = 4 * 1024 * 1024;
const fill = (bytes, ch, toErr = false) => `/usr/bin/head -c ${bytes} /dev/zero | /usr/bin/tr '\\000' '${ch}'${toErr ? " >&2" : ""}`;
add("buffer", "ps stdout past 4 MiB", { ps: { sh: `${fill(MIB4 + 1, "a")}; exit 0` }, stats: OK_EMPTY });
add("buffer", "ps stdout exactly 4 MiB", { ps: { sh: `out; ${fill(MIB4 - 21, " ")}; exit 0`, out: '{"ID":"exact4mib"}\n\n' }, stats: OK_EMPTY });
add("buffer", "ps stdout past 4 MiB with stderr", { ps: { sh: `err; ${fill(MIB4 + 100, "a")}; exit 0`, err: "warn\n" }, stats: OK_EMPTY });
add("buffer", "ps stderr past 4 MiB, spaces", { ps: { sh: `${fill(MIB4 + 1000, " ", true)}; exit 1` }, stats: OK_EMPTY });
add("buffer", "ps stderr past 4 MiB, text", { ps: { sh: "/usr/bin/yes 'stderr line' | /usr/bin/head -c 5000000 >&2; exit 1" }, stats: OK_EMPTY });
add("buffer", "ps stderr past 4 MiB, daemon first", { ps: { sh: `err; ${fill(MIB4 + 1000, "x", true)}; exit 1`, err: DAEMON }, stats: OK_EMPTY });
add("buffer", "stats stdout past 4 MiB", { ps: V(nd(...PS_REAL.slice(0, 2))), stats: { sh: `out; ${fill(MIB4 + 1, "z")}; exit 0`, out: nd(...STATS_REAL) } });

// ------------------------------- record -------------------------------

const BIG = 64 * 1024;
const sha = (s) => createHash("sha256").update(s).digest("hex");
/** A verb's files as the fixture stores them. */
function verbSpec(v) {
  if (!v) return null;
  const spec = { sh: v.sh };
  for (const k of ["out", "err"]) {
    if (v[k] == null) continue;
    const buf = Buffer.isBuffer(v[k]) ? v[k] : Buffer.from(v[k], "utf8");
    if (Buffer.from(buf.toString("utf8"), "utf8").equals(buf)) spec[k] = buf.toString("utf8");
    else spec[`${k}Bytes`] = [...buf];
  }
  return spec;
}

async function record(c) {
  installBin(c.bin ?? "fake");
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA);
  for (const verb of ["ps", "stats"]) {
    const v = c[verb];
    if (!v) continue;
    writeFileSync(join(DATA, `${verb}.sh`), v.sh);
    for (const k of ["out", "err"]) if (v[k] != null) writeFileSync(join(DATA, `${verb}.${k}`), v[k]);
  }
  const t0 = performance.now();
  const res = await route.GET();
  const text = await res.text();
  const ms = performance.now() - t0;
  if (c.minMs != null && ms < c.minMs) throw new Error(`${c.name}: ${ms} ms < ${c.minMs}`);
  if (c.maxMs != null && ms > c.maxMs) throw new Error(`${c.name}: ${ms} ms > ${c.maxMs}`);
  const argv = {};
  for (const verb of ["ps", "stats"]) {
    const p = join(DATA, `${verb}.argv`);
    argv[verb] = existsSync(p) ? readFileSync(p, "utf8").split("\0").slice(0, -1) : null;
  }
  const got = { status: res.status, type: res.headers.get("content-type") };
  if (text.length > BIG) Object.assign(got, { bodySha256: sha(text), bodyBytes: Buffer.byteLength(text) });
  else got.body = text;
  got.argv = argv;
  return got;
}

const cases = [];
for (const c of CASES) {
  const entry = { group: c.group, name: c.name, bin: c.bin ?? "fake", ps: verbSpec(c.ps), stats: verbSpec(c.stats) };
  if (c.minMs != null) Object.assign(entry, { minMs: c.minMs, maxMs: c.maxMs });
  entry.got = await record(c);
  if (c.as) {
    const alt = { ...c, ...c.as };
    entry.why = c.why;
    entry.as = { bin: alt.bin ?? "fake", ps: verbSpec(alt.ps), stats: verbSpec(alt.stats) };
    entry.gotAs = await record(alt);
    if (j(entry.gotAs) === j(entry.got)) throw new Error(`${c.name}: no difference`);
  }
  cases.push(entry);
}
installBin("missing");

const fixture = {
  sampledAt: SAMPLED_AT,
  fake: FAKE,
  bins: { badinterp: `#!/nonexistent-claudius-d23/sh\n${FAKE_BODY}`, noshebang: FAKE_BODY },
  cases,
};
// ASCII only: everything past 0x7e as \u escapes (JSON.stringify already
// escaped the lone surrogates).
const text = `${JSON.stringify(fixture, null, 1)}\n`.replace(
  /[\u007f-\uffff]/g,
  (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, text);
const groups = {};
for (const c of cases) groups[c.group] = (groups[c.group] ?? 0) + 1;
console.log(`wrote ${out.slice(repo.length + 1)}: ${cases.length} cases (${Object.entries(groups).map(([g, n]) => `${g} ${n}`).join(", ")})`);
process.exit(0);

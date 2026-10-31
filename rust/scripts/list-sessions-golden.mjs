#!/usr/bin/env node
// Golden fixture for `listSessions` (S33): what the REAL Agent SDK returns,
// and what `lib/server/sessions-store.ts` `list()` (its wrapper: `limit ?? 200`,
// `includeWorktrees ?? true`) returns, over synthetic config dirs.
//
//   node rust/scripts/list-sessions-golden.mjs      (node@22, git, python3)
//
// Re-runs itself under `--experimental-transform-types` (for the .ts wrapper)
// with a temp HOME, twice; both recordings must agree byte for byte. Each case
// builds a fresh root of a fixed length ($ROOT, so file sizes and the 200-char
// project-dir cut land the same on replay) holding `config/` (the case's
// CLAUDE_CONFIG_DIR) and work dirs, from a list of ops the fixture keeps:
// `mkdir`, `write` (text with $ROOT, base64 bytes, or a repeated chunk),
// `symlink`, `fifo`, `git` (repos and real `git worktree add`), `rm`, and
// `chmod`. Paths are root-relative, or name a project dir by the cwd it
// encodes (`proj`), a literal name (`projName`), or the 200-char prefix of a
// long one with another hash suffix (`projPrefix`). Every written file gets
// an exact mtime in ns (python's `os.utime`), applied after the other ops and
// before the chmods. Forks come from the SDK's own `forkSession`; their
// random ids and times are normalized and kept as plain `write`s.
//
// Then it records each call's `JSON.stringify` result with the root as
// $ROOT: `sdk` is `listSessions(opts)`, `ts` is the wrapper. Options keep
// JS numbers as JSON, or as the strings "NaN" / "Infinity" / "-Infinity".
// Cases tagged `os` only replay there (macOS NFC and case folding).
//
// It also evaluates the SDK's private path predicates (sliced out of
// sdk.mjs by name): `xc` (a path it won't examine) and the lexical half of
// `nP` (`Da || Oc || go || is`), and records `Date.parse` on timestamp forms
// (`dates`; the ones only V8's legacy parser reads are `legacyDates`).
//
// Written to rust/crates/claudius-core/tests/fixtures/list_sessions_golden.json
// and replayed by crates/claudius-core/tests/list_sessions_golden.rs.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/list_sessions_golden.json");
const sdkPath = join(repo, "node_modules/@anthropic-ai/claude-agent-sdk");
const ROOT_LEN = 100;

if (!process.env.LIST_SESSIONS_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "lsg-rec-")));
    try {
      mkdirSync(join(tmp, "home"));
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: join(tmp, "home"),
            TZ: "UTC",
            LIST_SESSIONS_GOLDEN_CHILD: join(tmp, "out.json"),
          },
        },
      );
      if (r.status !== 0) {
        process.stderr.write(r.stdout + r.stderr);
        process.exit(r.status ?? 1);
      }
      return readFileSync(join(tmp, "out.json"), "utf8");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) {
    writeFileSync(join(tmpdir(), "lsg-run0.json"), runs[0]);
    writeFileSync(join(tmpdir(), "lsg-run1.json"), runs[1]);
    throw new Error(`the two recordings differ (see ${tmpdir()}/lsg-run{0,1}.json)`);
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const calls = fixture.cases.reduce((n, c) => n + c.calls.length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.cases.length} cases, ${calls} calls, ` +
      `${fixture.predicates.length} predicates, ${fixture.dates.length} dates (stable)`,
  );
  process.exit(0);
}

// ---- child ------------------------------------------------------------------

const sdkVersion = JSON.parse(readFileSync(join(sdkPath, "package.json"), "utf8")).version;
const { listSessions, forkSession } = await import(join(sdkPath, "sdk.mjs"));
const { list: tsList } = await import(join(repo, "lib/server/sessions-store.ts"));

// The SDK's private path predicates, sliced out of the bundle by name.
function predicates() {
  const bundle = readFileSync(join(sdkPath, "sdk.mjs"), "utf8");
  const fn = (name) => {
    const at = bundle.indexOf(`function ${name}(`);
    if (at < 0 || bundle.indexOf(`function ${name}(`, at + 1) >= 0) {
      throw new Error(`function ${name} moved in sdk.mjs: update the names`);
    }
    let i = bundle.indexOf("{", at);
    let depth = 0;
    let prev = "{";
    for (; i < bundle.length; i++) {
      const c = bundle[i];
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) break;
      else if (c === '"' || c === "'" || c === "`") {
        for (i++; bundle[i] !== c; i++) if (bundle[i] === "\\") i++;
      } else if (c === "/" && ("(,=:[!&|?{};".includes(prev) || /return$/.test(bundle.slice(at, i)))) {
        // a regex literal: skip to its closing slash and flags
        for (i++; bundle[i] !== "/"; i++) {
          if (bundle[i] === "\\") i++;
          else if (bundle[i] === "[") for (i++; bundle[i] !== "]"; i++) if (bundle[i] === "\\") i++;
        }
        while (/[a-z]/.test(bundle[i + 1])) i++;
      }
      if (!/\s/.test(bundle[i])) prev = bundle[i];
    }
    return bundle.slice(at, i + 1);
  };
  const names = ["vn", "Da", "mo", "ss", "MX", "pk", "Ly", "go", "wc", "tk", "is", "ho", "nk"];
  const src = [
    ...names.map(fn),
    ...["tf", "ZX", "mr", "Oc", "xc", "$X"].map(fn),
    "var lk=/^[\\\\/]\\?\\?[\\\\/]/;",
    "var gk=1024,hk=4096,qp=new Map,Zp=new Map;",
  ].join("\n");
  if (!bundle.includes("var lk=/^[\\\\/]\\?\\?[\\\\/]/;") || !bundle.includes("gk=1024,hk=4096,qp=new Map,Zp=new Map")) {
    throw new Error("lk / gk / hk moved in sdk.mjs: update the anchors");
  }
  return new Function("Fy", `${src}\nreturn { xc, lexical: (e) => Da(e) || Oc(e) || go(e) || is(e) };`)(nodePath);
}

const PATHS = [
  "/Users/me/project",
  "/Users/me/../project",
  "/a/..b/c",
  "/a/b..",
  "..",
  "a/..",
  "\\\\server\\share",
  "//server/share/x",
  "//wsl$/Ubuntu/home",
  "//wsl.localhost/Debian",
  "//WSL$/../x",
  "//wsl$/ ./x",
  "//?/C:/x",
  "//./pipe/x",
  "\\\\?\\UNC\\host\\share",
  "/??/C:/x",
  "/./??/x",
  "/a/../??/",
  "/??",
  "/a/??/x",
  "/net",
  "/net/",
  "/net/host",
  "/NET/host/share",
  "/x/../net/host",
  "/ne\u200ct/host",
  "/Network",
  "/network/x",
  "/Network/Servers/h/x",
  "/Network/\u017fervers/h",
  "/a/Network",
  "/Volumes/net/host",
  "/.vol/1/2",
  "/.VOL",
  "/x/.vol/1",
  "/.resolve/1/2",
  "/.nofollow/x",
  "/.file/id",
  "/GLOBAL??/x",
  "\\Device\\HarddiskVolume1",
  "/DosDevices/C:",
  "/GLOBALROOT",
  "relative/path",
  "",
  "/",
  "/private/var/folders/x/T/lsg-abc/w/a-b",
];

const DATES = [
  "2026-01-01T00:00:00.000Z",
  "2026-01-01T00:00:00Z",
  "2026-01-01T00:00Z",
  "2026-01-01T10:20:30.5Z",
  "2026-01-01T10:20:30.1234Z",
  "2026-01-01T10:20:30.000123456789123Z",
  "2026-01-01t10:20:30z",
  "2026-03-01T10:00:00+05:30",
  "2026-03-01T10:00:00-0130",
  "2026-03-01T10:00:00+23:59",
  "2026-03-01T10:00:00+24:00",
  "2026-03-01T10:00:00+2400",
  "2026-03-01T10:00:00+01",
  "2026",
  "2026-07",
  "2026-02-30",
  "2026-02-29",
  "2024-02-29T12:00:00.5Z",
  "2026-01-01T24:00Z",
  "2026-01-01T24:00:00.000Z",
  "2026-01-01T24:00:01Z",
  "2026-01-01T24:01Z",
  "2026-01-01T24:00:00.001Z",
  "2026-01-01T23:59:60Z",
  "2026-13-01",
  "2026-00-01",
  "2026-01-32",
  "2026-01-00",
  "+002026-06-01T00:00:00.5Z",
  "-000001-01-01T00:00:00Z",
  "-000000-01-01T00:00:00Z",
  "+275760-09-13T00:00:00.000Z",
  "+275760-09-13T00:00:00.001Z",
  "-271821-04-20T00:00:00Z",
  "-271821-04-19T23:59:59.999Z",
  "0000-01-01T00:00:00Z",
  "2026T10:00Z",
  "2026-01T10:00Z",
  "2026-01-01T1:00:00Z",
  "2026-01-01T00Z",
  "2026-01-01T00:00:00.Z",
  "2026-01-01T00:00:00,5Z",
  "2026-01-01T00:00:00ZZ",
  "2026-01-01T00:00:00Z ",
  " 2026-01-01T00:00:00Z",
  "2026-01-01Tx",
  "2026-01-01T00:00:00.000Zjunk",
  "garbage",
  "",
];
// Read only by V8's legacy fallback, which the port doesn't have.
const LEGACY_DATES = ["2026-01-01 00:00:00Z", "2026-1-01", "Jan 1 2026 10:00 GMT", "275760-09-13"];

// ---- transcripts --------------------------------------------------------------

const sid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const mid = (s, n) => `${s.slice(0, 24)}${(0xa00000000000 + n).toString(16)}`;
const iso = (n) => new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
const T = 1767225600; // 2026-01-01T00:00:00Z
const ns = (sec, nsec = 0) => (BigInt(Math.floor(sec)) * 1000000000n + BigInt(nsec)).toString();

const userLine = (s, n, cwd, content, extra = {}) => ({
  parentUuid: n > 1 ? mid(s, n - 1) : null,
  isSidechain: false,
  userType: "external",
  cwd,
  sessionId: s,
  version: "2.1.299",
  gitBranch: "main",
  type: "user",
  message: { role: "user", content },
  uuid: mid(s, n),
  timestamp: iso(n),
  ...extra,
});
const asstLine = (s, n, cwd, text, extra = {}) => ({
  parentUuid: mid(s, n - 1),
  isSidechain: false,
  userType: "external",
  cwd,
  sessionId: s,
  version: "2.1.299",
  gitBranch: "main",
  message: {
    id: `msg_${n}`,
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
  },
  type: "assistant",
  uuid: mid(s, n),
  timestamp: iso(n),
  ...extra,
});
/** A plain conversation: one prompt and a reply per entry of `prompts`. */
const convo = (s, cwd, prompts = ["hello there"], { head = [], tail = [], user = {} } = {}) => {
  const lines = [...head];
  prompts.forEach((p, i) => {
    lines.push(userLine(s, 2 * i + 1, cwd, p, user));
    lines.push(asstLine(s, 2 * i + 2, cwd, `reply ${i}`));
  });
  lines.push(...tail);
  return lines;
};
const jsonl = (lines) => lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";

// ---- ops ----------------------------------------------------------------------

const proj = (cwd, sub) => ({ proj: cwd, ...(sub && { sub }) });
const projName = (name, sub) => ({ projName: name, ...(sub && { sub }) });
const write = (path, text, mtime, extra = {}) => ({ op: "write", path, parts: [{ text }], mtime, ...extra });
const session = (cwdRel, s, lines, mtime, dir = proj(cwdRel, `${s}.jsonl`)) =>
  write(dir, jsonl(lines), mtime);
const mkdir = (path) => ({ op: "mkdir", path });
const git = (cwd, ...args) => ({ op: "git", cwd, args });
const C = (rel) => `$ROOT/${rel}`; // a cwd inside the root

const ja = (s) => s.replace(/[^a-zA-Z0-9]/g, "-");
function eE(e) {
  let t = 0;
  for (let n = 0; n < e.length; n++) t = ((t << 5) - t + e.charCodeAt(n)) | 0;
  return t;
}
const qc = (s) => {
  const t = ja(s);
  return t.length <= 200 ? t : `${t.slice(0, 200)}-${Math.abs(eE(s)).toString(36)}`;
};

function resolvePath(root, spec) {
  const sub = (s) => s.replaceAll("$ROOT", root);
  if (typeof spec === "string") return join(root, sub(spec));
  const projects = join(root, "config", "projects");
  let dir;
  if (spec.proj !== undefined) {
    dir = join(projects, qc(join(root, sub(spec.proj))));
  } else if (spec.projName !== undefined) dir = join(projects, spec.projName);
  else dir = join(projects, ja(join(root, sub(spec.projPrefix))).slice(0, 200) + spec.suffix);
  return spec.sub === undefined ? dir : join(dir, sub(spec.sub));
}

function bytesOf(root, parts) {
  return Buffer.concat(
    parts.map((p) => {
      if (p.text !== undefined) return Buffer.from(p.text.replaceAll("$ROOT", root), "utf8");
      if (p.b64 !== undefined) return Buffer.from(p.b64, "base64");
      return Buffer.from(p.repeat.repeat(p.count), "utf8");
    }),
  );
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

/** Run the ops; `fork` ops run the SDK's `forkSession` and come back as writes. */
async function build(root, ops) {
  const recorded = [];
  const times = [];
  const chmods = [];
  for (const op of ops) {
    const at = op.path === undefined ? undefined : resolvePath(root, op.path);
    switch (op.op) {
      case "mkdir":
        mkdirSync(at, { recursive: true });
        break;
      case "write":
        mkdirSync(dirname(at), { recursive: true });
        writeFileSync(at, bytesOf(root, op.parts));
        times.push([at, op.mtime]);
        break;
      case "symlink":
        mkdirSync(dirname(at), { recursive: true });
        symlinkSync(op.target.replaceAll("$ROOT", root), at);
        break;
      case "fifo": {
        mkdirSync(dirname(at), { recursive: true });
        const r = spawnSync("mkfifo", [at]);
        if (r.status !== 0) throw new Error(`mkfifo ${at}`);
        break;
      }
      case "rm":
        rmSync(at, { recursive: true, force: true });
        break;
      case "chmod":
        chmods.push([at, op.mode]);
        break;
      case "git": {
        const cwd = join(root, op.cwd);
        mkdirSync(cwd, { recursive: true });
        const r = spawnSync("git", op.args.map((a) => a.replaceAll("$ROOT", root)), { cwd, env: GIT_ENV, encoding: "utf8" });
        if (r.status !== 0) throw new Error(`git ${op.args.join(" ")}: ${r.stderr}`);
        break;
      }
      case "fork": {
        // The real SDK's fork, normalized: its id becomes `op.as`, the other
        // new uuids `ffffffff-...-<n>`, its new timestamps a fixed instant.
        const src = resolvePath(root, op.from);
        const source = readFileSync(src, "utf8");
        const before = new Set(readdirSync(dirname(src)));
        const res = await forkSession(op.sessionId, {
          dir: join(root, op.dir),
          ...(op.title !== undefined && { title: op.title }),
          ...(op.upToMessageId !== undefined && { upToMessageId: op.upToMessageId }),
        });
        const made = readdirSync(dirname(src)).filter((n) => !before.has(n));
        if (made.length !== 1 || made[0] !== `${res.sessionId}.jsonl`) throw new Error(`fork wrote ${made}`);
        const file = join(dirname(src), made[0]);
        let text = readFileSync(file, "utf8").replaceAll(res.sessionId, op.as);
        unlinkSync(file);
        const seen = new Map();
        text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (u) => {
          if (u === op.as || source.includes(u)) return u;
          if (!seen.has(u)) seen.set(u, `ffffffff-0000-4000-8000-${(seen.size + 1).toString(16).padStart(12, "0")}`);
          return seen.get(u);
        });
        text = text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, (t) =>
          source.includes(t) ? t : "2026-06-01T00:00:00.000Z",
        );
        const w = write({ ...op.from, sub: `${op.as}.jsonl` }, text.replaceAll(root, "$ROOT"), op.mtime);
        writeFileSync(resolvePath(root, w.path), bytesOf(root, w.parts));
        times.push([resolvePath(root, w.path), w.mtime]);
        recorded.push(w);
        continue;
      }
      default:
        throw new Error(`unknown op ${op.op}`);
    }
    recorded.push(op);
  }
  if (times.length > 0) {
    const r = spawnSync(
      "python3",
      ["-c", "import json,os,sys\nfor p,m in json.load(sys.stdin): os.utime(p, ns=(int(m), int(m)))"],
      { input: JSON.stringify(times), encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`os.utime: ${r.stderr}`);
  }
  for (const [p, mode] of chmods) chmodSync(p, mode);
  return recorded;
}

// ---- cases --------------------------------------------------------------------

const num = (v) => (typeof v === "string" ? Number(v) : v);
const callOpts = (root, o) => {
  const r = { ...o };
  if (typeof r.dir === "string") r.dir = r.dir.replaceAll("$ROOT", root);
  if ("limit" in r) r.limit = num(r.limit);
  if ("offset" in r) r.offset = num(r.offset);
  return r;
};
const sdk = (opts = {}) => ({ fn: "sdk", opts });
const ts = (opts = {}) => ({ fn: "ts", opts });

const marker = (s, next, extra = {}) => ({ type: "continued-in", continuedInSessionId: next, sessionId: s, ...extra });
const big = (n) => ({ repeat: '{"type":"filler","pad":"' + "x".repeat(1000) + '"}\n', count: n });

const cases = [];
const add = (name, ops, calls, extra = {}) => cases.push({ name, ...extra, ops, calls });

// 1. One project dir: limits, offsets, names that aren't transcripts.
add(
  "basic_dir",
  [
    session("w/app", sid(1), convo(sid(1), C("w/app"), ["first"]), ns(T + 10)),
    session("w/app", sid(2), convo(sid(2), C("w/app"), ["second"]), ns(T + 20)),
    session("w/app", sid(3), convo(sid(3), C("w/app"), ["third"]), ns(T + 30)),
    write(proj("w/app", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA.jsonl"), jsonl(convo("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", C("w/app"), ["upper"])), ns(T + 15)),
    write(proj("w/app", "notes.txt"), "x\n", ns(T + 40)),
    write(proj("w/app", "abc.jsonl"), jsonl(convo(sid(4), C("w/app"))), ns(T + 40)),
    write(proj("w/app", `${sid(5)}.jsonl.bak`), jsonl(convo(sid(5), C("w/app"))), ns(T + 40)),
    mkdir(proj("w/app", `${sid(6)}.jsonl`)),
    mkdir(proj("w/app", sid(1))),
    mkdir("w/app"),
  ],
  [
    sdk({ dir: C("w/app") }),
    sdk({ dir: C("w/app"), limit: 2 }),
    sdk({ dir: C("w/app"), limit: 1, offset: 1 }),
    sdk({ dir: C("w/app"), offset: 2 }),
    sdk({ dir: C("w/app"), offset: 9 }),
    sdk({}),
    sdk({ limit: 2 }),
    sdk({ dir: "" }),
    ts({ dir: C("w/app") }),
    ts({ dir: C("w/app"), limit: 1 }),
    ts({}),
  ],
);

// 2. Ties on mtime: id descending, in both orders; sub-millisecond mtimes.
add(
  "ties",
  [
    ...[1, 2, 3, 4].map((n) => session("w/t", sid(n), convo(sid(n), C("w/t"), [`tie ${n}`]), ns(T + 5))),
    session("w/t", sid(5), convo(sid(5), C("w/t"), ["sub a"]), ns(T + 7, 100)),
    session("w/t", sid(6), convo(sid(6), C("w/t"), ["sub b"]), ns(T + 7, 200)),
    session("w/t", sid(7), convo(sid(7), C("w/t"), ["later"]), ns(T + 9)),
  ],
  [sdk({ dir: C("w/t") }), sdk({ dir: C("w/t"), limit: 3 }), sdk({ dir: C("w/t"), limit: 10 }), sdk({ limit: 4, offset: 1 })],
);

// 3. One id under several project dirs.
add(
  "dupes_across_projects",
  [
    session("w/a", sid(1), convo(sid(1), C("w/a"), ["a copy"]), ns(T + 10)),
    session("w/b", sid(1), convo(sid(1), C("w/b"), ["b copy"]), ns(T + 20)),
    session("w/b", sid(2), convo(sid(2), C("w/b"), ["only b"]), ns(T + 25)),
    write(projName("-alpha", `${sid(1)}.jsonl`), jsonl(convo(sid(1), "/alpha", ["alpha copy"])), ns(T + 20)),
    write(projName("-zeta", `${sid(3)}.jsonl`), jsonl(convo(sid(3), "/zeta", ["zeta"])), ns(T + 5)),
    // The newest copy is a sidechain: the older one counts.
    write(projName("-alpha", `${sid(4)}.jsonl`), jsonl(convo(sid(4), "/alpha", ["side"], { user: { isSidechain: true } })), ns(T + 50)),
    session("w/a", sid(4), convo(sid(4), C("w/a"), ["main copy"]), ns(T + 40)),
    // The newest copy is a symlink (never read): the older one counts.
    { op: "symlink", path: projName("-zeta", `${sid(5)}.jsonl`), target: `$ROOT/config/projects/-alpha/${sid(1)}.jsonl` },
    write(projName("-zeta", `${sid(9)}.jsonl`), "", ns(T + 1)),
    session("w/a", sid(5), convo(sid(5), C("w/a"), ["real five"]), ns(T + 1)),
    write(projName("-alpha", "stray.jsonl"), "{}\n", ns(T)),
    write("config/projects/not-a-dir", "x", ns(T)),
  ],
  [sdk({}), sdk({ limit: 10 }), sdk({ limit: 1 }), sdk({ limit: 2, offset: 1 }), sdk({ dir: C("w/b") })],
);

// 4. Files the SDK can't or won't read.
add(
  "file_kinds",
  [
    session("w/k", sid(1), convo(sid(1), C("w/k"), ["readable"]), ns(T + 10)),
    session("w/other", sid(2), convo(sid(2), C("w/other"), ["target of a link"]), ns(T + 11)),
    { op: "symlink", path: proj("w/k", `${sid(3)}.jsonl`), target: "$ROOT/w/real3.jsonl" },
    write("w/real3.jsonl", jsonl(convo(sid(3), C("w/k"), ["through a link"])), ns(T + 12)),
    { op: "symlink", path: proj("w/k", `${sid(4)}.jsonl`), target: "$ROOT/w/missing.jsonl" },
    { op: "fifo", path: proj("w/k", `${sid(5)}.jsonl`) },
    write(proj("w/k", `${sid(6)}.jsonl`), jsonl(convo(sid(6), C("w/k"), ["locked"])), ns(T + 13)),
    { op: "chmod", path: proj("w/k", `${sid(6)}.jsonl`), mode: 0 },
    write(proj("w/k", `${sid(7)}.jsonl`), "", ns(T + 14)),
    write(proj("w/k", `${sid(8)}.jsonl`), "\n\n\n", ns(T + 15)),
    write(proj("w/k", `${sid(9)}.jsonl`), jsonl(convo(sid(9), C("w/k"), ["torn tail"])) + '{"type":"user","message":{"content":"cut', ns(T + 16)),
    {
      op: "write",
      path: proj("w/k", `${sid(10)}.jsonl`),
      parts: [{ text: `{"type":"user","sessionId":"${sid(10)}","cwd":"$ROOT/w/k","message":{"content":"bad ` }, { b64: "/v8=" }, { text: ' bytes"}}\n' }],
      mtime: ns(T + 17),
    },
    write(
      proj("w/k", `${sid(11)}.jsonl`),
      jsonl([userLine(sid(11), 1, C("w/k"), [{ type: "tool_result", tool_use_id: "t", content: "x" }]), asstLine(sid(11), 2, C("w/k"), "only a reply")]),
      ns(T + 18),
    ),
    write(proj("w/k", `${sid(12)}.jsonl`), jsonl([{ type: "summary", summary: "From a summary", leafUuid: "x" }]), ns(T + 19)),
    mkdir("w/k"),
  ],
  [sdk({ dir: C("w/k") }), sdk({ dir: C("w/k"), limit: 20 }), sdk({})],
);

// 5. Sidechains (the first line decides).
add(
  "sidechains",
  [
    session("w/s", sid(1), convo(sid(1), C("w/s"), ["side"], { user: { isSidechain: true } }), ns(T + 1)),
    write(proj("w/s", `${sid(2)}.jsonl`), `{"isSidechain": true, "type":"user","message":{"content":"spaced"}}\n`, ns(T + 2)),
    write(proj("w/s", `${sid(3)}.jsonl`), jsonl([userLine(sid(3), 1, C("w/s"), "main first"), { ...userLine(sid(3), 2, C("w/s"), "side later"), isSidechain: true }]), ns(T + 3)),
  ],
  [sdk({ dir: C("w/s") })],
);

// 6. `continued-in`: hidden once the continuation exists with messages.
{
  const cwd = C("w/c");
  const s = (n, lines, sec) => session("w/c", sid(n), lines, ns(T + sec));
  const tailWith = (n, ...extra) => convo(sid(n), cwd, [`session ${n}`], { tail: extra });
  const straddleHead = '{"type":"summary","summary":"straddles a read","leafUuid":"x"}\n';
  const bigFile = (n, parts, sec) => ({ op: "write", path: proj("w/c", `${sid(n)}.jsonl`), parts, mtime: ns(T + sec) });
  add(
    "continued_in",
    [
      s(2, convo(sid(2), cwd, ["the continuation"]), 2),
      s(1, tailWith(1, marker(sid(1), sid(2))), 1),
      s(3, tailWith(3, marker(sid(3), sid(99))), 3),
      s(4, tailWith(4, marker(sid(4), sid(5))), 4),
      write(proj("w/c", `${sid(5)}.jsonl`), "", ns(T + 5)),
      s(6, tailWith(6, marker(sid(6), sid(7))), 6),
      write(proj("w/c", `${sid(7)}.jsonl`), jsonl([{ type: "summary", summary: "no messages", leafUuid: "x" }]), ns(T + 7)),
      s(8, tailWith(8, marker(sid(8), sid(2)), userLine(sid(8), 9, cwd, "came back")), 8),
      s(9, tailWith(9, marker(sid(9), sid(2)), asstLine(sid(9), 9, cwd, "finished")), 9),
      s(10, tailWith(10, marker(sid(10), sid(2)), { ...asstLine(sid(10), 9, cwd, "open"), message: { role: "assistant", content: [], stop_reason: null } }), 10),
      s(11, tailWith(11, marker(sid(11), sid(2)), { ...asstLine(sid(11), 9, cwd, "api error"), isApiErrorMessage: true }), 11),
      s(12, tailWith(12, marker(sid(12), sid(2)), marker(sid(12), "not-a-uuid")), 12),
      write(proj("w/c", `${sid(13)}.jsonl`), jsonl(tailWith(13)) + `{"type": "continued-in", "continuedInSessionId": "${sid(2)}"}\n`, ns(T + 13)),
      s(14, tailWith(14, marker(sid(14), sid(2)), marker(sid(14), 5)), 14),
      s(15, tailWith(15, marker(sid(15), sid(16))), 15),
      { op: "symlink", path: proj("w/c", `${sid(16)}.jsonl`), target: `${sid(2)}.jsonl` },
      s(17, tailWith(17, marker(sid(17), sid(17))), 17),
      s(18, tailWith(18, marker(sid(18), sid(19))), 18),
      bigFile(19, [{ text: '{"type":"summary","summary":"big with a message","leafUuid":"x"}\n' }, big(80), { text: `{"parentUuid":null,"type":"system","sessionId":"${sid(19)}"}\n` }, big(80)], 19),
      s(20, tailWith(20, marker(sid(20), sid(21))), 20),
      bigFile(21, [{ text: '{"type":"summary","summary":"big without","leafUuid":"x"}\n' }, big(200)], 21),
      s(22, tailWith(22, marker(sid(22), sid(23))), 22),
      bigFile(23, [{ text: '{"type":"summary","summary":"huge without","leafUuid":"x"}\n' }, big(17000)], 23),
      s(24, tailWith(24, marker(sid(24), sid(2)), { ...asstLine(sid(24), 9, cwd, "x"), message: null }), 24),
      s(25, tailWith(25, marker(sid(25), sid(2)), userLine(sid(25), 9, cwd, "<command-name>/clear</command-name>")), 25),
      s(26, tailWith(26, marker(sid(26), sid(2)), userLine(sid(26), 9, cwd, [{ type: "tool_result", tool_use_id: "t", content: "r" }])), 26),
      bigFile(27, [{ text: jsonl(tailWith(27, marker(sid(27), sid(2)))) }, big(140), { text: jsonl([{ type: "last-prompt", lastPrompt: "after the filler", sessionId: sid(27) }]) }], 27),
      s(28, tailWith(28, marker(sid(28), sid(2)), "{not json", { type: "user", message: { content: "x" }, isMeta: true }), 28),
      s(29, tailWith(29, marker(sid(29), sid(2), { type: "continued-in" }), { type: "continued-in", continuedInSessionId: sid(2), note: '"type":"user"' }), 29),
      s(32, tailWith(32, marker(sid(32), "plain-name")), 32),
      write(proj("w/c", "plain-name.jsonl"), jsonl(convo(sid(33), cwd, ["not a uuid name"])), ns(T + 33)),
      // `"parentUuid":` straddles the first 1 MiB read.
      s(30, tailWith(30, marker(sid(30), sid(31))), 30),
      bigFile(31, [{ text: straddleHead }, { repeat: "y", count: (1 << 20) - 6 - 1 - straddleHead.length }, { text: `{"parentUuid":null,"type":"system","sessionId":"${sid(31)}"}\n` }, big(100)], 31),
    ],
    [sdk({ dir: cwd }), sdk({ dir: cwd, limit: 50 }), sdk({})],
  );
}

// 7. A cwd that encodes to the listed dir's name but is another directory.
{
  const P0 = "w/a-b";
  const s = (n, cwdAbs, sec, extra = {}) => session(P0, sid(n), convo(sid(n), cwdAbs, [`session ${n}`], extra), ns(T + sec));
  const relocated = (n, to) => ({ type: "relocated", sessionId: sid(n), relocatedCwd: to });
  add(
    "relocated_and_colliding_cwds",
    [
      mkdir("w/a-b"),
      mkdir("w/a/b"),
      mkdir("w/a_b"),
      mkdir("w/q-..-r"),
      mkdir("w/q"),
      mkdir("w/r"),
      { op: "symlink", path: "w/a+b", target: "a-b" },
      s(1, C("w/a-b"), 1),
      s(2, C("w/a/b"), 2),
      s(3, C("w/a/c"), 3),
      s(4, C("w/a.b"), 4),
      s(5, C("w/a_b"), 5),
      s(6, C("w/A-B"), 6),
      s(7, C("w/a+b"), 7),
      s(8, C("w/a/b"), 8, { tail: [relocated(8, C("w/a-b"))] }),
      s(9, C("w/a-b"), 9, { tail: [relocated(9, C("w/a/b"))] }),
      s(10, C("w/a/b"), 10, { tail: [relocated(10, C("w/a-b")), { type: "relocated", relocatedCwd: 5 }] }),
      s(11, C("w/a/b"), 11, { tail: [{ type: "relocated", relocatedCwd: C("w/a-b"), x: 1 }, `{"type":"relocated","relocatedCwd":"${C("w/a/b")}"`] }),
      write(
        proj(P0, `${sid(12)}.jsonl`),
        `{"type":"user","cwd":"${C("w/a/b")}","message":{"content":"torn head line"}\n${JSON.stringify({ type: "summary", summary: "s12" })}\n`,
        ns(T + 12),
      ),
      write(
        proj(P0, `${sid(13)}.jsonl`),
        `${JSON.stringify({ type: "x", cwd: 5 })}\n${jsonl(convo(sid(13), C("w/a/b"), ["number cwd first"]))}`,
        ns(T + 13),
      ),
      s(14, "", 14),
      s(15, C("w/q/../r"), 15, {}),
      session("w/q-..-r", sid(15), convo(sid(15), C("w/q/../r"), ["dot dot"]), ns(T + 15)),
      session("w/q-..-r", sid(16), convo(sid(16), C("w/q/.-/r"), ["dot dash"]), ns(T + 16)),
      mkdir("w/q/.-/r"),
      // `w/d/../e` resolves through the link to `w/d.._/e`, which also
      // encodes like `w/d-..-e`: kept only because the cwd has a `..`.
      mkdir("w/d-..-e"),
      mkdir("w/d.._/t"),
      mkdir("w/d.._/e"),
      { op: "symlink", path: "w/d", target: "d.._/t" },
      session("w/d-..-e", sid(30), convo(sid(30), C("w/d/../e"), ["dot dot through a link"]), ns(T + 30)),
      session("w/d-..-e", sid(31), convo(sid(31), C("w/d.._/e"), ["the place it resolves to"]), ns(T + 31)),
    ],
    [
      sdk({ dir: C("w/d-..-e") }),
      sdk({ dir: C("w/a-b") }),
      sdk({ dir: C("w/a-b"), limit: 50 }),
      sdk({ dir: C("w/a/b") }),
      sdk({ dir: C("w/a_b"), limit: 3 }),
      sdk({ dir: C("w/q-..-r") }),
      sdk({}),
      ts({ dir: C("w/a-b") }),
    ],
  );
}

// 8. Worktrees: real `git worktree add`.
{
  const s = (dir, n, cwdRel, sec) => session(dir, sid(n), convo(sid(n), C(cwdRel), [`in ${cwdRel}`]), ns(T + sec));
  add(
    "worktrees",
    [
      git("w/repo", "init", "-q", "-b", "main"),
      git("w/repo", "-c", "user.name=g", "-c", "user.email=g@example.com", "commit", "-q", "--allow-empty", "-m", "init"),
      git("w/repo", "worktree", "add", "-q", "$ROOT/w/repo-wt1", "-b", "b1"),
      git("w/repo", "worktree", "add", "-q", "$ROOT/w/wt2", "-b", "b2"),
      git("w/repo", "worktree", "add", "-q", "$ROOT/w/gone", "-b", "b3"),
      { op: "rm", path: "w/gone" },
      mkdir("w/repo/sub"),
      mkdir("w/repo/wt1"),
      s("w/repo", 1, "w/repo", 1),
      s("w/repo-wt1", 2, "w/repo-wt1", 2),
      s("w/wt2", 3, "w/wt2", 3),
      s("w/gone", 4, "w/gone", 4),
      s("w/other", 5, "w/other", 5),
      s("w/repo", 6, "w/repo/sub", 6),
      s("w/repo-wt1", 7, "w/repo/wt1", 7),
      s("w/repo/sub", 8, "w/repo/sub", 8),
      git("w/solo", "init", "-q", "-b", "main"),
      git("w/solo", "-c", "user.name=g", "-c", "user.email=g@example.com", "commit", "-q", "--allow-empty", "-m", "init"),
      s("w/solo", 9, "w/solo", 9),
      mkdir("w/solo/sub"),
      s("w/solo/sub", 10, "w/solo/sub", 10),
      mkdir("w/other"),
    ],
    [
      sdk({ dir: C("w/repo") }),
      sdk({ dir: C("w/repo"), includeWorktrees: false }),
      sdk({ dir: C("w/repo"), limit: 3 }),
      sdk({ dir: C("w/repo-wt1") }),
      sdk({ dir: C("w/repo-wt1"), includeWorktrees: false }),
      sdk({ dir: C("w/repo/sub") }),
      sdk({ dir: C("w/solo") }),
      sdk({ dir: C("w/solo/sub") }),
      ts({ dir: C("w/repo") }),
      ts({ dir: C("w/repo"), includeWorktrees: false }),
    ],
  );
}

// 8b. Worktrees past 200 encoded chars: a same-prefix project dir goes to
// the worktree whose path its transcripts record.
{
  const W1 = `w/${"W".repeat(130)}`;
  const W2 = `w/${"W".repeat(129)}V`;
  // Encodes to exactly 200 chars: not hashed, so no prefix siblings.
  const W3 = `w/${"U".repeat(200 - ROOT_LEN - 3)}`;
  add(
    "long_worktrees",
    [
      git("w/r2", "init", "-q", "-b", "main"),
      git("w/r2", "-c", "user.name=g", "-c", "user.email=g@example.com", "commit", "-q", "--allow-empty", "-m", "init"),
      git("w/r2", "worktree", "add", "-q", `$ROOT/${W1}`, "-b", "l1"),
      git("w/r2", "worktree", "add", "-q", `$ROOT/${W2}`, "-b", "l2"),
      git("w/r2", "worktree", "add", "-q", `$ROOT/${W3}`, "-b", "l3"),
      session("w/r2", sid(1), convo(sid(1), C("w/r2"), ["main"]), ns(T + 1)),
      session(W1, sid(2), convo(sid(2), C(W1), ["exact w1"]), ns(T + 2)),
      write({ projPrefix: W1, suffix: "-bun", sub: `${sid(3)}.jsonl` }, jsonl(convo(sid(3), C(W2), ["w2 under another hash"])), ns(T + 3)),
      write({ projPrefix: W1, suffix: "-elsewhere", sub: `${sid(4)}.jsonl` }, jsonl(convo(sid(4), "/elsewhere", ["no worktree"])), ns(T + 4)),
      session(W3, sid(5), convo(sid(5), C(W3), ["exactly 200"]), ns(T + 5)),
      write({ projPrefix: W3, suffix: "-x", sub: `${sid(6)}.jsonl` }, jsonl(convo(sid(6), C(W3), ["beside a 200-char name"])), ns(T + 6)),
    ],
    [
      sdk({ dir: C("w/r2") }),
      sdk({ dir: C("w/r2"), limit: 10 }),
      sdk({ dir: C(W2) }),
      sdk({ dir: C(W1), includeWorktrees: false }),
      sdk({ dir: C(W3), includeWorktrees: false }),
    ],
  );
}

// 9. The dir is resolved: only the realpath's project dir is read.
add(
  "dir_through_symlink",
  [
    mkdir("w/real"),
    { op: "symlink", path: "w/link", target: "$ROOT/w/real" },
    session("w/real", sid(1), convo(sid(1), C("w/real"), ["real"]), ns(T + 1)),
    session("w/link", sid(2), convo(sid(2), C("w/link"), ["raw link path"]), ns(T + 2)),
    session("w/missing", sid(3), convo(sid(3), C("w/missing"), ["missing dir"]), ns(T + 3)),
  ],
  [
    sdk({ dir: C("w/link") }),
    sdk({ dir: C("w/real") }),
    sdk({ dir: C("w/real/") }),
    sdk({ dir: C("w/real/../real") }),
    sdk({ dir: C("w/missing") }),
    ts({ dir: C("w/link") }),
  ],
);

// 10. Paths past 200 encoded chars: the hashed name, and same-prefix dirs
// whose transcripts record the same cwd.
{
  const LONG = `w/${"L".repeat(130)}`;
  const LONG2 = `w/${"L".repeat(129)}M`;
  add(
    "long_paths",
    [
      mkdir(LONG),
      session(LONG, sid(1), convo(sid(1), C(LONG), ["exact hashed dir"]), ns(T + 1)),
      write({ projPrefix: LONG, suffix: "-bunhash", sub: `${sid(2)}.jsonl` }, jsonl(convo(sid(2), C(LONG), ["other hash, same cwd"])), ns(T + 2)),
      write({ projPrefix: LONG, suffix: "-other", sub: `${sid(3)}.jsonl` }, jsonl(convo(sid(3), C(LONG2), ["other cwd"])), ns(T + 3)),
      write(
        { projPrefix: LONG, suffix: "-moved", sub: `${sid(4)}.jsonl` },
        jsonl(convo(sid(4), "/old/place", ["relocated here"], { tail: [{ type: "relocated", sessionId: sid(4), relocatedCwd: C(LONG) }] })),
        ns(T + 4),
      ),
      write({ projPrefix: LONG, suffix: "-file" }, "not a dir", ns(T + 5)),
      write({ projPrefix: LONG, suffix: "x", sub: `${sid(6)}.jsonl` }, jsonl(convo(sid(6), C(LONG), ["no dash"])), ns(T + 6)),
    ],
    [sdk({ dir: C(LONG) }), sdk({ dir: C(LONG), limit: 2 }), sdk({ dir: C(LONG2) }), sdk({})],
  );
}

// 11. `CLAUDE_CODE_PROJECT_DIR_NAME` (with CLAUDE_CONFIG_DIR set).
const LONG_O = `w/${"O".repeat(130)}`;
for (const [name, value] of [
  ["dir_name_override", "custom_dir"],
  ["dir_name_override_refused", "COM1"],
]) {
  add(
    name,
    [
      write(projName(value, `${sid(1)}.jsonl`), jsonl(convo(sid(1), C("w/app"), ["in the override dir"])), ns(T + 1)),
      session("w/app", sid(2), convo(sid(2), C("w/app"), ["in the natural dir"]), ns(T + 2)),
      mkdir("w/app"),
      // An override skips the long-name prefix scan.
      session(LONG_O, sid(3), convo(sid(3), C(LONG_O), ["long, natural dir"]), ns(T + 3)),
      write({ projPrefix: LONG_O, suffix: "-sib", sub: `${sid(4)}.jsonl` }, jsonl(convo(sid(4), C(LONG_O), ["long, prefix sibling"])), ns(T + 4)),
    ],
    [sdk({ dir: C("w/app") }), sdk({ dir: C("w/app"), limit: 1 }), sdk({}), sdk({ dir: C(LONG_O) })],
    { env: { CLAUDE_CODE_PROJECT_DIR_NAME: value } },
  );
}

// 12. `includeProgrammatic: false`.
add(
  "programmatic",
  [
    session("w/p", sid(1), convo(sid(1), C("w/p"), ["sdk-ts"], { user: { entrypoint: "sdk-ts" } }), ns(T + 1)),
    session("w/p", sid(2), convo(sid(2), C("w/p"), ["cli"], { user: { entrypoint: "cli" } }), ns(T + 2)),
    session("w/p", sid(3), convo(sid(3), C("w/p"), ["daemon"], { head: [{ type: "summary", summary: "x", sessionKind: "user" }], user: { sessionKind: "daemon" } }), ns(T + 3)),
    session("w/p", sid(4), convo(sid(4), C("w/p"), ["tail entry"], { tail: [{ type: "x", entrypoint: "sdk-py" }] }), ns(T + 4)),
    session("w/p", sid(5), convo(sid(5), C("w/p"), ["empty entry"], { head: [{ type: "x", entrypoint: "" }], tail: [{ type: "x", entrypoint: "sdk-cli" }] }), ns(T + 5)),
    session("w/p", sid(6), convo(sid(6), C("w/p"), ["worker"], { user: { sessionKind: "daemon-worker" } }), ns(T + 6)),
    session("w/p", sid(7), convo(sid(7), C("w/p"), ["sdk-go"], { user: { entrypoint: "sdk-go" } }), ns(T + 7)),
  ],
  [
    sdk({ dir: C("w/p") }),
    sdk({ dir: C("w/p"), includeProgrammatic: false }),
    sdk({ includeProgrammatic: false }),
    sdk({ dir: C("w/p"), includeProgrammatic: false, limit: 2 }),
  ],
);

// 13. Field derivation (`sl`).
{
  const cwd = C("w/f");
  let n = 0;
  const ops = [];
  const add13 = (lines, { sidecar, sidecarRaw } = {}) => {
    n++;
    ops.push(session("w/f", sid(n), lines, ns(T + n)));
    if (sidecar !== undefined) ops.push(write(proj("w/f", `${sid(n)}/custom-title.json`), JSON.stringify({ customTitle: sidecar }), ns(T)));
    if (sidecarRaw !== undefined) ops.push({ op: "write", path: proj("w/f", `${sid(n)}/custom-title.json`), parts: sidecarRaw, mtime: ns(T) });
  };
  const c = (prompts, o) => convo(sid(n + 1), cwd, prompts, o);
  add13(c(["x"], { head: [{ type: "ai-title", aiTitle: "AI head" }], tail: [{ type: "custom-title", customTitle: "" }] }));
  add13(c(["x"]), { sidecar: "  \u00a0Side\u200b\u200bcar\u00adtitle\u2028x\u0007y\ufeff " });
  add13(c(["x"]), { sidecar: `${"\u00e9".repeat(150)}${"\ud83d\ude00".repeat(60)}` });
  add13(c(["x"]), { sidecar: 5 });
  add13(c(["x"]), { sidecarRaw: [{ text: "not json" }] });
  add13(c(["x"]), { sidecarRaw: [{ text: '{"customTitle":"bad ' }, { b64: "/w==" }, { text: ' byte"}' }] });
  add13(c(["x"], { tail: [{ type: "custom-title", customTitle: "Tail wins" }] }), { sidecar: "ignored" });
  add13(c(["x"], { tail: [{ type: "custom-title", customTitle: "" }], head: [{ type: "custom-title", customTitle: "Head title" }] }), { sidecar: "not read" });
  add13(c(["x"], { tail: [{ type: "x", gitBranch: "" }] }));
  add13(c(["x"], { tail: [{ type: "relocated", relocatedCwd: "" }] }));
  add13(convo(sid(n + 1), "", ["empty cwd"]));
  add13(c(["x"], { tail: [{ type: "last-prompt", lastPrompt: "the last prompt" }, { type: "summary", summary: "a summary" }] }));
  add13(c(["x"], { tail: [{ type: "last-prompt", lastPrompt: "" }, { type: "summary", summary: "summary wins" }] }));
  add13(c([`${"a".repeat(195)}\ud83d\ude00\ud83d\ude00\ud83d\ude00 tail`]));
  add13(c([`${"b".repeat(199)}\ud83d\ude00 tail`]));
  add13(c([`${"c".repeat(100)}${"\u00e9".repeat(150)}`]));
  add13(c(["\u0085\ufeff  edges  \ufeff\u0085"]));
  add13(c(["<command-name>/clear</command-name>"]));
  add13(c(["<command-name>a\rb</command-name>"]));
  add13(c(["<b\u00e9>not a tag"]));
  add13(c(["<bash-input>\u0085 ls -la \u0085</bash-input>"]));
  add13(c([[{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }]]));
  add13(c([[{ type: "document", source: { type: "text", data: "x" } }]]));
  add13(c(["[Request interrupted by user]", "<local-command-stdout>x</local-command-stdout>", "real one"]));
  add13(c(["x"], { tail: [{ type: "tag", tag: "release" }] }));
  add13(c(["x"], { tail: [{ type: "tag", tag: "" }] }));
  add13(c(["x"], { tail: [{ type: "custom-title", customTitle: "Caf\u00e9 \\\"quoted\\\"" }] }));
  add13([...c(["x"]), '{"type":"custom-title","customTitle":"caf\\u00e9 \\ud83d\\ude00 \\"esc\\""}']);
  for (const t of ["2026-03-01T10:00:00+05:30", "2026-02-30", "2026", "garbage", "", "2026-01-01T24:00:00Z", "+002026-06-01T00:00:00.5Z"]) {
    add13([{ type: "summary", summary: `timestamp ${JSON.stringify(t)}`, timestamp: t }]);
  }
  add13([{ type: "user", timestamp: "2026-05-05T05:05:05.555Z", message: { content: "only a timestamp" } }]);
  // Only JSON.parse reads a number past f64.
  add13([JSON.stringify(userLine(sid(n + 1), 1, cwd, "beside a huge number")).replace(/}$/, ',"n":1e400}')]);
  add13(c(["<abc\ufeffx", "after a tag ended by a BOM"]));
  add13(c(["\ud83d\ude00".repeat(150)]));
  add13(c(["x"]), { sidecar: `${" ".repeat(10)}${"a".repeat(195)}${"Z".repeat(10)}` });
  add("fields", ops, [sdk({ dir: cwd })]);
}

// 14. Odd mtimes.
add(
  "mtimes",
  [
    session("w/m", sid(1), convo(sid(1), C("w/m"), ["epoch"]), ns(0)),
    session("w/m", sid(2), convo(sid(2), C("w/m"), ["before 1970"]), (-1500000000123456789n).toString()),
    // Node's double `sec * 1e3 + nsec / 1e6` rounds 0.499999 ms up to the
    // half, and Math.round then goes up; 0.499877 ms stays under it.
    session("w/m", sid(3), convo(sid(3), C("w/m"), ["just under half a ms"]), ns(T + 3, 499999)),
    session("w/m", sid(4), convo(sid(4), C("w/m"), ["a bit more under"]), ns(T + 4, 499877)),
    session("w/m", sid(8), convo(sid(8), C("w/m"), ["just under a whole second"]), ns(T + 8, 999999999)),
    session("w/m", sid(5), convo(sid(5), C("w/m"), ["exactly half"]), ns(T + 5, 500000)),
    session("w/m", sid(6), convo(sid(6), C("w/m"), ["year 2100"]), ns(4102444800, 999999999)),
    session("w/m", sid(7), convo(sid(7), C("w/m"), ["under a second"]), ns(T + 7, 999999999)),
  ],
  [sdk({ dir: C("w/m") }), sdk({ dir: C("w/m"), limit: 10 }), sdk({ dir: C("w/m"), limit: 2, offset: 1 })],
);

// 15. Limit and offset as JS numbers, and the TS wrapper's defaults.
add(
  "limits",
  [1, 2, 3, 4, 5].map((k) => session("w/l", sid(k), convo(sid(k), C("w/l"), [`n ${k}`]), ns(T + k))),
  [
    sdk({ dir: C("w/l"), limit: 0 }),
    sdk({ dir: C("w/l"), limit: -1 }),
    sdk({ dir: C("w/l"), limit: 1.5 }),
    sdk({ dir: C("w/l"), limit: "NaN" }),
    sdk({ dir: C("w/l"), limit: "Infinity" }),
    sdk({ dir: C("w/l"), limit: 100 }),
    sdk({ dir: C("w/l"), offset: 1.5 }),
    sdk({ dir: C("w/l"), offset: -1 }),
    sdk({ dir: C("w/l"), offset: "NaN", limit: 2 }),
    sdk({ dir: C("w/l"), offset: 4, limit: 3 }),
    sdk({ dir: C("w/l"), offset: 1, limit: 0 }),
    sdk({ dir: C("w/l"), offset: "Infinity" }),
    ts({ dir: C("w/l"), limit: 2 }),
    ts({ dir: C("w/l"), limit: 0 }),
    ts({ dir: C("w/l"), limit: -5 }),
    ts({ dir: C("w/l"), limit: 2.5 }),
    ts({ dir: C("w/l"), includeWorktrees: false }),
  ],
);

// 16. Directory listing order decides between equal copies.
add(
  "listing_order",
  ["-a_", "-aZ", "-a1", "-a2", "-a-", "-ab"].flatMap((d, i) => [
    write(projName(d, `${sid(1)}.jsonl`), jsonl(convo(sid(1), `/${d}`, [`copy in ${d}`])), ns(T + 1)),
    write(projName(d, `${sid(10 + i)}.jsonl`), jsonl(convo(sid(10 + i), `/${d}`, [`own ${d}`])), ns(T + 2)),
  ]),
  [sdk({}), sdk({ limit: 1 }), sdk({ limit: 3, offset: 1 })],
);

// 17. Forks from the SDK's `forkSession` are listed like any session.
add(
  "forks",
  [
    session("w/fk", sid(1), convo(sid(1), C("w/fk"), ["fork me", "second turn"]), ns(T + 1)),
    { op: "fork", from: proj("w/fk", `${sid(1)}.jsonl`), dir: "w/fk", sessionId: sid(1), as: sid(50), mtime: ns(T + 5) },
    { op: "fork", from: proj("w/fk", `${sid(1)}.jsonl`), dir: "w/fk", sessionId: sid(1), as: sid(51), title: "Named fork", upToMessageId: mid(sid(1), 2), mtime: ns(T + 6) },
    mkdir("w/fk"),
  ],
  [sdk({ dir: C("w/fk") }), sdk({ dir: C("w/fk"), limit: 2 })],
);

// 18. macOS: paths are NFC'd after realpath.
add(
  "nfc_paths",
  [
    mkdir("w/cafe\u0301"),
    session("w/caf\u00e9", sid(1), convo(sid(1), C("w/caf\u00e9"), ["nfc dir"]), ns(T + 1)),
    session("w/cafe\u0301", sid(2), convo(sid(2), C("w/cafe\u0301"), ["nfd dir"]), ns(T + 2)),
    session("w/caf\u00e9", sid(3), convo(sid(3), C("w/cafe\u0301"), ["nfd cwd"]), ns(T + 3)),
  ],
  [sdk({ dir: C("w/cafe\u0301") }), sdk({ dir: C("w/caf\u00e9") })],
  { os: "darwin" },
);

// 18b. macOS: a colliding cwd inside one of the listed worktrees (compared
// case-insensitively, on a case-insensitive volume) is kept.
add(
  "worktree_collisions",
  [
    git("w/g-h", "init", "-q", "-b", "main"),
    git("w/g-h", "-c", "user.name=g", "-c", "user.email=g@example.com", "commit", "-q", "--allow-empty", "-m", "init"),
    git("w/g-h", "worktree", "add", "-q", "$ROOT/w/g/h", "-b", "c1"),
    mkdir("w/g.h"),
    session("w/g-h", sid(1), convo(sid(1), C("w/g-h"), ["the repo"]), ns(T + 1)),
    session("w/g-h", sid(2), convo(sid(2), C("w/g/h"), ["the worktree itself"]), ns(T + 2)),
    session("w/g-h", sid(3), convo(sid(3), C("w/G/H"), ["the worktree in other case"]), ns(T + 3)),
    session("w/g-h", sid(4), convo(sid(4), C("w/g.h"), ["not a worktree"]), ns(T + 4)),
  ],
  [sdk({ dir: C("w/g-h") }), sdk({ dir: C("w/g-h"), includeWorktrees: false })],
  { os: "darwin" },
);

// 19. Colliding cwds behind links onto network paths are never resolved.
add(
  "network_links",
  [
    mkdir("w/ab-q"),
    { op: "symlink", path: "w/ab", target: "/net/claudius-golden-host/share" },
    { op: "symlink", path: "w/cd", target: "hop" },
    { op: "symlink", path: "w/hop", target: "/Network/claudius-golden" },
    mkdir("w/cd-q"),
    session("w/ab-q", sid(1), convo(sid(1), C("w/ab/q"), ["via /net"]), ns(T + 1)),
    session("w/cd-q", sid(2), convo(sid(2), C("w/cd/q"), ["via /Network"]), ns(T + 2)),
  ],
  [sdk({ dir: C("w/ab-q") }), sdk({ dir: C("w/cd-q") })],
);

// ---- record -------------------------------------------------------------------

const results = [];
for (const c of cases) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "lsg-")));
  const pad = ROOT_LEN - base.length - 1;
  if (pad < 1) throw new Error(`temp dir ${base} is too long for ROOT_LEN ${ROOT_LEN}`);
  const root = join(base, "p".repeat(pad));
  mkdirSync(join(root, "config", "projects"), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = join(root, "config");
  if (c.env?.CLAUDE_CODE_PROJECT_DIR_NAME !== undefined) process.env.CLAUDE_CODE_PROJECT_DIR_NAME = c.env.CLAUDE_CODE_PROJECT_DIR_NAME;
  else delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
  try {
    const ops = await build(root, c.ops);
    const calls = [];
    for (const call of c.calls) {
      const opts = callOpts(root, call.opts);
      let result;
      try {
        const got = call.fn === "sdk" ? await listSessions(opts) : await tsList(opts);
        result = JSON.stringify(got).replaceAll(root, "$ROOT");
      } catch (err) {
        result = JSON.stringify({ throws: String(err?.message ?? err) });
      }
      calls.push({ ...call, result });
    }
    // Same key order as the case: ops and calls replace theirs in place.
    results.push({ ...c, ops, calls });
  } finally {
    spawnSync("chmod", ["-R", "u+rwX", base]);
    rmSync(base, { recursive: true, force: true });
  }
}

const preds = predicates();
const fixture = {
  sdkVersion,
  rootLen: ROOT_LEN,
  cases: results,
  predicates: PATHS.map((path) => ({ path, xc: preds.xc(path), lexical: preds.lexical(path) })),
  dates: DATES.map((s) => [s, Number.isNaN(Date.parse(s)) ? null : Date.parse(s)]),
  legacyDates: LEGACY_DATES.map((s) => [s, Number.isNaN(Date.parse(s)) ? null : Date.parse(s)]),
};
writeFileSync(process.env.LIST_SESSIONS_GOLDEN_CHILD, JSON.stringify(fixture));

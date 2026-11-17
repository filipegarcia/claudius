#!/usr/bin/env node
// Golden fixture for the compaction row's transcript path (R04, CC 2.1.301),
// recorded from the TS sources:
//
//   node rust/scripts/resumed-transcript-golden.mjs   (node@22: session.ts
//                                                      needs better-sqlite3,
//                                                      which bun can't load)
//
// Re-runs itself under `--experimental-transform-types` with HOME and
// CLAUDE_CONFIG_DIR in a temp dir and a resolve hook for the extensionless /
// `@/` imports, twice (two temp roots); both recordings must agree byte for
// byte. Records:
//
// - `finds`: the real `findResumedTranscriptPath(id, cwd, projectsBase)` over
//   a seeded tree. Each case lists the tree it needs (`files`: `write`,
//   `mkdir`, `symlink`, paths relative to the base unless they hold `$ROOT`)
//   and the calls to make on it: `id`, `cwd`, and `base` \u2014 absent for the
//   seeded base, `"$DEFAULT"` for the two-argument call (TS's own default,
//   `homedir()/.claude/projects`), else that path. The answer is the absolute
//   path or null, with `$ROOT` for the temp root, `$HOME` for the home and
//   `$BASE` for the seeded base.
// - `display`: the real `Session.prototype.resumedTranscriptPath` on a bare
//   `Object.create(Session.prototype)` with `resumedTranscriptFile` set to
//   each value: the `~`-shortened string, or null.
//
// Written to rust/crates/claudius-core/tests/fixtures/resumed_transcript_golden.json
// and replayed by crates/claudius-core/tests/resumed_transcript_golden.rs.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/resumed_transcript_golden.json");

// ------------------------------- recording -------------------------------

if (!process.env.RESUMED_TRANSCRIPT_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "resumed-transcript-golden-")));
    try {
      const home = join(root, "home");
      mkdirSync(home);
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          // db.ts reads its migrations from `process.cwd()`.
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            CLAUDE_CONFIG_DIR: join(root, "config"),
            RESUMED_TRANSCRIPT_GOLDEN_CHILD: root,
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
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const calls = fixture.finds.reduce((n, c) => n + c.calls.length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.finds.length} trees (${calls} calls), ${fixture.display.length} display forms (stable)`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT_DIR = process.env.RESUMED_TRANSCRIPT_GOLDEN_CHILD;

const hook = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = ${JSON.stringify(pathToFileURL(repo + "/").href)};
export async function resolve(spec, ctx, next) {
  const s = spec.startsWith("@/") ? new URL(spec.slice(2), ROOT).href : spec;
  if ((s.startsWith(".") || s.startsWith("file:")) && ctx.parentURL?.startsWith("file:")) {
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
    if (e?.code === "ERR_MODULE_NOT_FOUND" && !s.includes(":") && !s.startsWith(".")) return next(s + ".js", ctx);
    throw e;
  }
}
export async function load(url, ctx, next) {
  if (url.endsWith(".json")) {
    return next(url, { ...ctx, importAttributes: { ...ctx.importAttributes, type: "json" } });
  }
  return next(url, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const { Session, findResumedTranscriptPath } = await import(join(repo, "lib/server/session.ts"));
const { encodeProjectDir } = await import(join(repo, "lib/server/auto-memory.ts"));

const HOME = process.env.HOME;
const ID = "11112222-3333-4444-5555-666677778888";
const CWD = "/Users/x/proj";
const OWN = encodeProjectDir(CWD);
const SOURCE = encodeProjectDir("/Users/x/source");
const EMOJI = String.fromCodePoint(0x1f680);

// ------------------------------- finds -------------------------------
//
// Each tree is seeded under its own `base`, then every call is made on it.

const TREES = [
  {
    name: "the cwd's own project dir wins over another with the same name",
    files: [
      ["write", `${OWN}/${ID}.jsonl`],
      ["write", `${SOURCE}/${ID}.jsonl`],
    ],
    calls: [{ id: ID, cwd: CWD }],
  },
  {
    name: "a fork resumed in its worktree: the SOURCE project's dir",
    files: [
      ["mkdir", encodeProjectDir("/Users/x/wt")],
      ["write", `${SOURCE}/${ID}.jsonl`],
    ],
    calls: [{ id: ID, cwd: "/Users/x/wt" }],
  },
  {
    name: "several other dirs: the first in readdir order that has it",
    files: [
      ["write", `-b-one/${ID}.jsonl`],
      ["write", `-a-two/${ID}.jsonl`],
      ["write", `-c-three/${ID}.jsonl`],
      ["mkdir", OWN],
    ],
    calls: [{ id: ID, cwd: CWD }],
  },
  {
    name: "nothing anywhere, and ids the name check refuses",
    files: [["write", `${OWN}/other.jsonl`], ["write", `${OWN}/${ID}.txt`]],
    calls: [
      { id: ID, cwd: CWD },
      // `/^[\\w-]+$/`: no dots, slashes, spaces, empty or non-ASCII names,
      // and no traversal.
      { id: "", cwd: CWD },
      { id: "other", cwd: CWD },
      { id: "a.b", cwd: CWD },
      { id: "a b", cwd: CWD },
      { id: "a/b", cwd: CWD },
      { id: "../etc/passwd", cwd: CWD },
      { id: `..${OWN}`, cwd: CWD },
      { id: "\u00e9", cwd: CWD },
      { id: EMOJI, cwd: CWD },
      { id: "a\u0000b", cwd: CWD },
      { id: "under_score-and-DIGITS-123", cwd: CWD },
    ],
  },
  {
    name: "a file, a symlinked dir and a symlinked transcript in the base",
    files: [
      ["write", `loose/${ID}.jsonl`],
      ["write", `${ID}.jsonl`],
      ["mkdir", "$ROOT/elsewhere"],
      ["write", `$ROOT/elsewhere/${ID}.jsonl`],
      // A symlink to a directory: `d.isDirectory()` on a Dirent is false, so
      // the walk skips it.
      ["symlink", "$ROOT/elsewhere", "linked-dir"],
      // A symlinked transcript inside a real dir is followed (`stat`).
      ["mkdir", "-real-dir"],
      ["symlink", `$ROOT/elsewhere/${ID}.jsonl`, `-real-dir/${ID}.jsonl`],
      ["mkdir", OWN],
    ],
    calls: [{ id: ID, cwd: CWD }],
  },
  {
    name: "the cwd's own dir is a symlink",
    files: [
      ["mkdir", "$ROOT/target-dir"],
      ["write", `$ROOT/target-dir/${ID}.jsonl`],
      ["symlink", "$ROOT/target-dir", OWN],
    ],
    calls: [{ id: ID, cwd: CWD }],
  },
  {
    name: "a dangling symlinked transcript, and a directory named like one",
    files: [
      ["mkdir", OWN],
      ["symlink", "$ROOT/gone.jsonl", `${OWN}/${ID}.jsonl`],
      ["mkdir", `-dir-shaped/${ID}.jsonl`],
    ],
    calls: [{ id: ID, cwd: CWD }],
  },
  {
    name: "odd cwds: empty, relative, unicode, a trailing slash and a long one",
    files: [
      ["write", `${encodeProjectDir("")}/${ID}.jsonl`],
      ["write", `${encodeProjectDir("rel/dir")}/${ID}.jsonl`],
      ["write", `${encodeProjectDir(`/Users/x/${EMOJI}`)}/${ID}.jsonl`],
      ["write", `${encodeProjectDir("/Users/x/proj/")}/${ID}.jsonl`],
      ["write", `${encodeProjectDir(`/Users/x/${"d".repeat(120)}`)}/${ID}.jsonl`],
    ],
    calls: [
      { id: ID, cwd: "" },
      { id: ID, cwd: "rel/dir" },
      { id: ID, cwd: `/Users/x/${EMOJI}` },
      { id: ID, cwd: "/Users/x/proj/" },
      { id: ID, cwd: `/Users/x/${"d".repeat(120)}` },
    ],
  },
  {
    name: "a base that is missing, a file, or relative",
    files: [["write", `${OWN}/${ID}.jsonl`]],
    calls: [
      { id: ID, cwd: CWD, base: "$ROOT/no-such-base" },
      { id: ID, cwd: CWD, base: "$ROOT/a-file" },
      { id: ID, cwd: CWD, base: "" },
      { id: ID, cwd: CWD, base: "." },
      // A base with a trailing slash, and one with a `..` segment that
      // resolves back onto the real base.
      { id: ID, cwd: CWD, base: "$BASE/" },
      { id: ID, cwd: CWD, base: "$BASE/sub/.." },
      // A base under which the id's file sits in a dir named `..x`.
      { id: ID, cwd: CWD, base: "$BASE/../" },
    ],
  },
  {
    name: "the default base is the home's .claude/projects",
    files: [["write", `${OWN}/${ID}.jsonl`]],
    // The seeded base IS the default one for this tree, so the two-argument
    // call must find it.
    defaultBase: true,
    calls: [{ id: ID, cwd: CWD, base: "$DEFAULT" }, { id: ID, cwd: CWD }],
  },
];

const finds = [];
for (const [i, tree] of TREES.entries()) {
  const base = tree.defaultBase
    ? join(HOME, ".claude", "projects")
    : join(ROOT_DIR, "bases", String(i));
  mkdirSync(base, { recursive: true });
  writeFileSync(join(ROOT_DIR, "a-file"), "not a dir");
  const abs = (p) => (p.includes("$ROOT") ? p.split("$ROOT").join(ROOT_DIR) : join(base, p));
  for (const op of tree.files ?? []) {
    if (op[0] === "write") {
      mkdirSync(dirname(abs(op[1])), { recursive: true });
      writeFileSync(abs(op[1]), "{}\n");
    } else if (op[0] === "mkdir") {
      mkdirSync(abs(op[1]), { recursive: true });
    } else if (op[0] === "symlink") {
      mkdirSync(dirname(abs(op[2])), { recursive: true });
      symlinkSync(abs(op[1]), abs(op[2]));
    } else {
      throw new Error(`unknown file op ${op[0]}`);
    }
  }
  const norm = (v) =>
    v === undefined
      ? null
      : v.split(base).join("$BASE").split(ROOT_DIR).join("$ROOT").split(HOME).join("$HOME");
  const calls = [];
  for (const call of tree.calls) {
    const argBase =
      call.base === undefined
        ? base
        : call.base === "$DEFAULT"
          ? undefined
          : call.base.split("$BASE").join(base).split("$ROOT").join(ROOT_DIR);
    const got =
      argBase === undefined
        ? await findResumedTranscriptPath(call.id, call.cwd)
        : await findResumedTranscriptPath(call.id, call.cwd, argBase);
    calls.push({ ...call, found: norm(got) });
  }
  finds.push({ name: tree.name, defaultBase: !!tree.defaultBase, files: tree.files ?? [], calls });
}

// ------------------------------- display -------------------------------
//
// `resumedTranscriptPath()` on a bare session: the home shortened to `~`.

const DISPLAY = [
  undefined,
  "",
  join(HOME, ".claude", "projects", OWN, `${ID}.jsonl`),
  join(HOME, "x.jsonl"),
  HOME,
  `${HOME}x/y.jsonl`,
  "/elsewhere/a.jsonl",
  "/a.jsonl",
  `${HOME}/${EMOJI}/\u00e9.jsonl`,
  `${HOME}//double.jsonl`,
];
const display = DISPLAY.map((file) => {
  const s = Object.create(Session.prototype);
  if (file !== undefined) s.resumedTranscriptFile = file;
  const got = s.resumedTranscriptPath();
  const norm = (v) => (v === undefined ? null : v.split(HOME).join("$HOME"));
  return { file: norm(file), result: norm(got) };
});

// A file, not stdout: `process.exit` would cut a piped stdout short.
writeFileSync(join(ROOT_DIR, "out.json"), JSON.stringify({ finds, display }));
process.exit(0);

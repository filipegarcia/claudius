#!/usr/bin/env node
// Golden fixture for the Git page's pure rules (U12a): the commit prefix
// (lib/shared/commit-prefix.ts), the PR badge's label
// (lib/shared/pr-badge.ts), the poll's spacing (lib/client/git-poll.ts),
// the changes list's grouping, folder tree and row text
// (components/git/ChangesList.tsx), the diff's rows
// (components/git/DiffViewer.tsx) and the page's short error
// (`summarizeGitError`, app/[workspaceId]/git/page.tsx).
//
//   node rust/scripts/git-page-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with HOME in a temp
// dir and a resolve hook for the `@/` and extensionless imports, twice; both
// recordings must agree byte for byte. The components are JSX, which the
// type stripper can't load, so their private helpers are cut out of the
// real source text (each must be declared exactly once) into a .ts module
// in the temp dir and imported from there.
//
// Every section is a list of `{ args, out }`: `args` went through
// `JSON.stringify` / `JSON.parse` before the call, `out` is the result with
// `undefined` as `null`; a file is written as its path in the outputs; the
// file is ASCII, every other code unit written as a `\u` escape.
//
// Written to rust/app/crates/claudius-git/tests/fixtures/git_page_golden.json
// and replayed by app/crates/claudius-git/tests/git_page_golden.rs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "app/crates/claudius-git/tests/fixtures/git_page_golden.json");

if (!process.env.GIT_PAGE_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "git-page-golden-")));
    try {
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: { PATH: process.env.PATH, HOME: root, TZ: "UTC", GIT_PAGE_GOLDEN_CHILD: root },
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

const ROOT_DIR = process.env.GIT_PAGE_GOLDEN_CHILD;

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
  return next(s, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

// ------------------------------- the private helpers, cut out of the JSX

/** The one declaration `head` opens, through the first line that is `end`. */
function cut(file, head, end) {
  const src = readFileSync(join(repo, file), "utf8");
  const at = src.indexOf(`\n${head}`);
  if (at < 0 || src.indexOf(`\n${head}`, at + 1) >= 0) {
    throw new Error(`${file} no longer declares \`${head}\` exactly once: update the recorder`);
  }
  const stop = src.indexOf(`\n${end}\n`, at + 1);
  if (stop < 0) throw new Error(`${file}: \`${head}\` has no closing \`${end}\``);
  return src.slice(at + 1, stop + end.length + 1);
}

/** The one line that starts with `head`. */
function cutLine(file, head) {
  const lines = readFileSync(join(repo, file), "utf8").split("\n");
  const hits = lines.filter((l) => l.startsWith(head));
  if (hits.length !== 1) throw new Error(`${file} no longer has one \`${head}\` line`);
  return hits[0];
}

const exported = (src) => (src.startsWith("export ") ? src : `export ${src}`);
const LIST = "components/git/ChangesList.tsx";
const VIEWER = "components/git/DiffViewer.tsx";
const PAGE = "app/[workspaceId]/git/page.tsx";
const extracted = [
  "// Cut out of components/git/*.tsx and the Git page by git-page-golden.mjs.",
  exported(cut(LIST, "export function isPartialStage(", "}")),
  exported(cut(LIST, "export function defaultDiffMode(", "}")),
  exported(cut(LIST, "function groupFiles(", "}")),
  exported(cut(LIST, "function splitPath(", "}")),
  cutLine(LIST, "const byName = "),
  exported(cut(LIST, "export function buildDirTree(", "}")),
  cut(LIST, "function finalizeDir(", "}"),
  cut(LIST, "function compactDir(", "}"),
  exported(cut(LIST, "function dirKey(", "}")),
  exported(cut(LIST, "function statusCharForGroup(", "}")),
  exported(cut(LIST, "function rowTitle(", "}")),
  exported(cut(LIST, "function worktreeChangeLabel(", "}")),
  exported(cut(LIST, "function displayPath(", "}")),
  exported(cut(VIEWER, "function parseUnifiedDiff(", "}")),
  exported(cut(VIEWER, "function gutterLeft(", "}")),
  exported(cut(VIEWER, "function gutterRight(", "}")),
  exported(cut(VIEWER, "function prefix(", "}")),
  exported(cut(PAGE, "function summarizeGitError(", "}")),
].join("\n\n");
const extractedPath = join(ROOT_DIR, "extracted.ts");
writeFileSync(extractedPath, extracted);

const x = await import(pathToFileURL(extractedPath).href);
const { compilePattern, renderCommitPrefix } = await import(join(repo, "lib/shared/commit-prefix.ts"));
const { prBadgeLabel } = await import(join(repo, "lib/shared/pr-badge.ts"));
const { nextGitPollDelayMs } = await import(join(repo, "lib/client/git-poll.ts"));

// ------------------------------------------------------------------- cases

const sections = {};
function record(name, fn, argsList) {
  sections[name] = argsList.map((a) => {
    const args = JSON.parse(JSON.stringify(a));
    const r = fn(...args);
    return { args, out: r === undefined ? null : r };
  });
}
const one = (xs) => xs.map((v) => [v]);

// ---- the commit prefix

const PATTERNS = [
  "{type}/{id}-{rest}",
  "feat/{ticket}-{slug}",
  "{id}",
  "{team}/{id}",
  "{a}{b}",
  "{a}-{b}-{c}",
  "user/{name}/{topic}",
  "{type}({scope}):{rest}",
  "[{id}] {rest}",
  "{id}.{rest}",
  "a+b/{x}",
  "{x}",
  "{x}{x}",
  "{1x}/{y}",
  "{_x}/{y_2}",
  "no placeholders",
  "",
  "{type}/{id}",
  "{ a }/{b}",
  "{a}/{b}{",
  "release-{version}",
  "{a}/",
  "{toString}/{rest}",
];
const BRANCHES = [
  "feat/4715-add-search-filter",
  "feat/4729",
  "feat/4729-",
  "fix/12-a-b-c",
  "main",
  "",
  "team-x/ABC-123",
  "a/b/c",
  "user/ana/new-ui",
  "feat(api):tidy",
  "[42] do it",
  "4.2.1",
  "a+b/z",
  "release-2026.11",
  "x/y\nz",
  "caf\u00e9/\u00fc-\u00f1",
  "emoji/\u{1F600}-x",
  "ab",
  "abc",
  "a/",
  "a-b-c-d",
];
record(
  "compilePattern",
  (p) => {
    const c = compilePattern(p);
    return c ? c.names : null;
  },
  one(PATTERNS),
);
record(
  "patternExec",
  (p, b) => {
    const c = compilePattern(p);
    if (!c) return null;
    const m = c.re.exec(b);
    if (!m) return null;
    return c.names.map((n) => [n, m.groups?.[n] ?? null]);
  },
  // The adjacent `{a}{b}` gives back one code unit: no astral branch there
  // (a lone surrogate isn't JSON the replay can read).
  PATTERNS.flatMap((p) =>
    BRANCHES.filter((b) => !(p === "{a}{b}" && /[\ud800-\udfff]/.test(b))).map((b) => [p, b]),
  ),
);
const TEMPLATES = ["{type} #{id} - ", "feat #{ticket} - ", "[{id}] ", "{missing} {id}", "{toString}:{rest}", "", "plain ", "{rest}{rest}"];
const CONFIGS = [
  null,
  { enabled: false, branchPattern: "{type}/{id}-{rest}", template: "{type} #{id} - " },
  { enabled: true, branchPattern: "   ", template: "{id}" },
  ...PATTERNS.slice(0, 12).flatMap((p) => TEMPLATES.map((t) => ({ enabled: true, branchPattern: p, template: t }))),
];
record(
  "renderCommitPrefix",
  (b, c) => renderCommitPrefix(b, c),
  CONFIGS.flatMap((c) => [null, ...BRANCHES.slice(0, 12)].map((b) => [b, c])),
);

// ---- the PR badge

const badge = (host, number, extra = {}) => ({ host, number, url: "", state: "open", checks: "none", ...extra });
record(
  "prBadgeLabel",
  prBadgeLabel,
  one([
    badge("github", 123),
    badge("gitlab", 45),
    badge("github", 0),
    badge("bitbucket", 7),
    badge("github", 4716, { title: "feat: x", state: "draft", checks: "passing" }),
    badge("gitlab", 1.5),
    badge("github", 1e21),
    badge("github", -3),
  ]),
);

// ---- the poll

const DURATIONS = [null, 0, 1, 100, 1333, 1334, 1500, 4000, 15000, 19999, 20000, 20001, 60000, 1e9, -5];
record(
  "nextGitPollDelayMs",
  nextGitPollDelayMs,
  [4000, 0, 1000, 70000, -1, null].flatMap((base) => DURATIONS.map((d) => [base, d])),
);
// A slow repo's schedule: each refresh's duration -> the next spacing.
record(
  "pollSchedule",
  (durations) => durations.map((d) => nextGitPollDelayMs(4000, d)),
  [[[50, 900, 1400, 2500, 7000, 25000, 400]], [[]], [[null, 0, 30000]]],
);

// ---- the changes list

const f = (path, index, worktree, oldPath) => ({
  path,
  ...(oldPath ? { oldPath } : {}),
  index,
  worktree,
  untracked: false,
});
const u = (path) => ({ path, index: "?", worktree: "?", untracked: true });
const FILES = [
  f("lib/server/git.ts", "M", " "),
  f("lib/shared/commit-prefix.ts", "A", " "),
  f("components/git/BranchPicker.tsx", "R", " ", "components/git/BranchSwitcher.tsx"),
  f("app/[workspaceId]/git/page.tsx", "M", "M"),
  f("components/git/ChangesList.tsx", " ", "M"),
  f("docs/old-notes.md", " ", "D"),
  f("gone.txt", "A", "D"),
  f("both.txt", "A", "M"),
  f("types.ts", "T", " "),
  f("copy.ts", "C", " ", "orig.ts"),
  f("moved/new.ts", " ", "R", "old/new.ts"),
  f("same/dir/b.ts", "R", "M", "same/dir/a.ts"),
  f("conflict.ts", "U", "U"),
  f("clean.ts", " ", " "),
  f("ignored.ts", "!", "!"),
  u("lib/client/git-poll.ts"),
  u("vendor/nested-repo/"),
];
const TREE_FILES = [
  [FILES.slice(0, 4)],
  [
    [
      f("src/file10.ts", "M", " "),
      f("src/file2.ts", "M", " "),
      f("src/File1.ts", "M", " "),
      f("src/a/b/c/deep.ts", "M", " "),
      f("src/a/b/c/deeper/x.ts", "M", " "),
      f("src/B/x.ts", "M", " "),
      f("src/b/y.ts", "M", " "),
      f("src/_under.ts", "M", " "),
      f("src/-dash.ts", "M", " "),
      f("src/.dot.ts", "M", " "),
      f("src/\u00e9t\u00e9.ts", "M", " "),
      f("src/ete.ts", "M", " "),
      f("README.md", "M", " "),
      f("api/src/Migrations/001.sql", "A", " "),
      f("api/src/Migrations/002.sql", "A", " "),
      f("vendor/nested/", "?", "?"),
      f("x10/a.ts", "M", " "),
      f("x9/a.ts", "M", " "),
    ],
  ],
  [[]],
  [[f("only/one/path/file.ts", "M", " ")]],
  [[f("a.ts", "M", " "), f("A.ts", "M", " "), f("a.TS", "M", " ")]],
];
const pathsOf = (xs) => xs.map((v) => v.path);
const tree = (n) => ({
  name: n.name,
  path: n.path,
  dirs: n.dirs.map(tree),
  files: pathsOf(n.files),
  filePaths: n.filePaths,
});
record(
  "groupFiles",
  (files) => {
    const g = x.groupFiles(files);
    return { staged: pathsOf(g.staged), unstaged: pathsOf(g.unstaged), untracked: pathsOf(g.untracked) };
  },
  [[FILES], [[]], [FILES.slice().reverse()]],
);
record("buildDirTree", (files) => tree(x.buildDirTree(files)), TREE_FILES);
record("isPartialStage", x.isPartialStage, one(FILES));
record("defaultDiffMode", x.defaultDiffMode, one(FILES));
record(
  "splitPath",
  x.splitPath,
  one(["a.ts", "a/b.ts", "a/b/c.ts", "dir/", "dir//", "/abs/x", "", "/", "a//b", "trailing/slash/"]),
);
const MODES = ["staged", "worktree", "untracked"];
record(
  "statusCharForGroup",
  x.statusCharForGroup,
  FILES.flatMap((file) => MODES.map((m) => [file, m])),
);
record(
  "rowTitle",
  x.rowTitle,
  FILES.flatMap((file) => MODES.flatMap((m) => [[file, m, true], [file, m, false]])),
);
record("worktreeChangeLabel", x.worktreeChangeLabel, one(["M", "D", "T", "R", "C", "A", " ", "?", "U", ""]));
record(
  "displayPath",
  x.displayPath,
  FILES.flatMap((file) => MODES.flatMap((m) => [[file, m, true], [file, m, false]])),
);
record("dirKey", x.dirKey, [["staged", "a/b"], ["worktree", ""], ["untracked", "x"]]);

// ---- the diff

const DIFFS = [
  "",
  "diff --git a/x.ts b/x.ts\nindex 1b2c3d4..5e6f7a8 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,4 @@ fn main() {\n a\n-b\n+B\n+c\n d\n",
  "diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n",
  "diff --git a/d.ts b/d.ts\ndeleted file mode 100644\n--- a/d.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n",
  "diff --git a/a.ts b/b.ts\nsimilarity index 90%\nrename from a.ts\nrename to b.ts\n@@ -10,2 +10,2 @@\n ctx\n-x\n+y\n",
  "Binary files a/i.png and b/i.png differ\n",
  "@@ -5 +7 @@\n-a\n+b\n@@ -20,0 +23,1 @@ tail\n+z\n",
  "@@ bad header @@\n+x\n plain\n",
  "@@ -1,2 +1,2 @@\r\n a\r\n-b\r\n+c\r\n",
  "garbage line\n\n\n+orphan add\n-orphan del\n ctx\n",
  "@@ -1,1 +1,1 @@\n-caf\u00e9 \u{1F600}\n+caf\u00e9 \u{1F601}\n",
  "@@ -9007199254740993,1 +1,1 @@\n-x\n+y\n",
  "@@ -01,1 +002,1 @@\n x\n",
];
record(
  "parseUnifiedDiff",
  (d) =>
    x.parseUnifiedDiff(d).map((l) => ({
      ...l,
      left: x.gutterLeft(l),
      right: x.gutterRight(l),
      prefix: x.prefix(l),
    })),
  one(DIFFS),
);

// ---- the page's short error

record(
  "summarizeGitError",
  x.summarizeGitError,
  one([
    "",
    "plain",
    "git commit exited 1: husky - pre-commit hook failed\nlint: 3 errors",
    "git push exited 128: \n\n  fatal: no upstream  \nmore",
    "git branch -d exited 1: error: The branch 'x' is not fully merged.",
    "git rev-parse --abbrev-ref exited -1: boom",
    "git exited 1: no verb",
    "git commit exited x: not a code",
    "  git commit exited 1: leading space",
    "\r\n\r\nsecond line\r\nthird",
    "x".repeat(250),
    `git x exited 2: ${"\u00e9".repeat(205)}`,
    "   \n   \n",
    "line one\n\u2028line two",
    "git stash push exited 1:\tTab then text",
  ]),
);

// ASCII only: every other code unit (all inside strings) as a \u escape.
const ascii = JSON.stringify({ sections }, null, 1).replace(
  /[\u007f-\uffff]/g,
  (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
);
writeFileSync(join(ROOT_DIR, "out.json"), ascii + "\n");

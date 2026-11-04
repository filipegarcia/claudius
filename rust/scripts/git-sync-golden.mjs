#!/usr/bin/env node
// Golden fixture for the workspace sync routes (D09): the real
// `app/api/workspaces/[id]/git/{merge,rebase,pull-merge,remote,remote-host,
// pr-status}/route.ts` handlers, `lib/server/pr-status.ts` and the
// `lib/server/git.ts` functions under them, recorded against real `git` on
// scripted repos whose remotes are local bare repos, with fake `gh` / `glab`:
//
//   node rust/scripts/git-sync-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with the repo as its
// cwd, a resolve hook for the `@/` imports, and the pinned environment of
// git-branches-golden.mjs (D07): HOME, XDG_CONFIG_HOME and CLAUDE_CONFIG_DIR
// under a temp root, no system git config, GIT_CEILING_DIRECTORIES at the
// root, LANG / LC_ALL = C, TZ = UTC, a fixed author and committer, commit
// dates pinned per commit (so every hash, merge commits and rebased commits
// too, is stable). Nothing can reach a network: GIT_ALLOW_PROTOCOL=file (and
// `protocol.allow = never` in the global config) refuses every non-file
// transport, and `gh` / `glab` are only ever the fakes below. Three parts:
// * `hosts`: the real `detectGitRemoteHost` over remote URLs;
// * `badges`: `normalizeGithubPr` / `normalizeGitlabMr` over CLI stdout
//   texts, as `getPrStatus` runs them (`JSON.parse` first; `how` says which
//   step threw, if one did);
// * `steps`: the setup of every repo as data (`git` runs, with an optional
//   commit `date`; `write` / `big` / `rm` / `mkdir` / `symlink` / `chmod`;
//   `workspaces` writes workspaces.json; `sysbin` links the few tools the
//   fakes use; `fakes` installs the wrappers below; `wait` sleeps until `ms`
//   after the request marked `since` was sent), interleaved with the real
//   route handlers (`req`, or `par` for requests run at once), `state` (the
//   repo after a request: every ref, HEAD, status, MERGE_HEAD / REBASE_HEAD,
//   branch and remote config, read by real git) and `ls`. `got` is the
//   status, content type and body text, or `threw` (Next's empty 500), plus
//   `calls`: every git, gh and glab the handler ran, in order (program, cwd,
//   then argv; gh / glab add the env they saw), as the wrappers logged them
//   (sorted for a `par` step). The root shows as `$ROOT`.
//
// Every request runs with PATH = `$ROOT/fakebin:$ROOT/sysbin` (no other
// dir, so no real gh / glab can be found). The `git` wrapper (`fakeGit`,
// `@ROOT@` / `@GIT@` filled in) logs the call and then runs the real git,
// unless a one-shot marker for the call's dir (its last path segment `<d>`)
// says otherwise: `fakemarks/hold-<d>-<verb>` holds `<secs> <words>`; the
// first such call whose argv has the word sequence sleeps that long (its
// stdio detached, so a kill closes the pipes at once) and then goes on. So
// a call is killed at its timeout when the hold is longer (and, should the
// timeout not fire, answers for real afterwards), and finishes when it is
// shorter: 30 s / 10 s around the 15 s timeout, 16 s past it for the 10 min
// hook timeout, 5 s past the 1.5 s and 2 s ones. `<d>-<verb>-out` / `-err` / `-exit` replace
// the call with canned output (only a call whose argv has the word sequence
// in `<d>-<verb>-match`, when there is one); a marker is gone before its
// output is written. The `gh` / `glab` fake (`fakeGh`) logs its
// argv and env, sleeps `<prog>-<d>-sleep` seconds if that is there (10 s
// past the 6 s timeout, 3 s within it), then answers `<prog>-<d>-out` /
// `-err` / `-exit`, or else exits 1 ("no pull requests found").
// `nogit` requests run with PATH at an empty dir. The requests run in
// `$ROOT/servercwd`, a repo whose origin is a GitHub URL: an empty rootPath
// is no cwd to `execFile`, and `git --version` always runs there.
//
// Written to rust/crates/claudius-core/tests/fixtures/git_sync_golden.json;
// replayed by crates/claudius-core/tests/pr_status_golden.rs (`hosts`,
// `badges`) and crates/claudius-server/tests/git_sync.rs (`steps`, against
// the real binary, recreating every repo with the same steps).
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/git_sync_golden.json");

/** The pinned environment; `$ROOT` is the temp root. Mirrored by the replay. */
const ENV = {
  HOME: "$ROOT/home",
  XDG_CONFIG_HOME: "$ROOT/home/.config",
  CLAUDE_CONFIG_DIR: "$ROOT/config",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CEILING_DIRECTORIES: "$ROOT",
  GIT_ALLOW_PROTOCOL: "file",
  GIT_AUTHOR_NAME: "Golden",
  GIT_AUTHOR_EMAIL: "golden@example.com",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Golden",
  GIT_COMMITTER_EMAIL: "golden@example.com",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  LANG: "C",
  LC_ALL: "C",
  TZ: "UTC",
  // Overridden by pr-status.ts's own env for gh / glab:
  GH_PROMPT_DISABLED: "0",
  GLAB_CHECK_UPDATE: "true",
  // Passed through to gh / glab (`...process.env`):
  GOLDEN_CANARY: "inherited",
};

if (!process.env.GIT_SYNC_GOLDEN_CHILD) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-sync-golden-")));
  try {
    const env = { PATH: process.env.PATH, GIT_SYNC_GOLDEN_CHILD: root };
    for (const [k, v] of Object.entries(ENV)) env[k] = v.replaceAll("$ROOT", root);
    const r = spawnSync(
      process.execPath,
      ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
      { cwd: repo, stdio: "inherit", env },
    );
    process.exit(r.status ?? 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const ROOT = process.env.GIT_SYNC_GOLDEN_CHILD;

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
}
export async function load(url, ctx, next) {
  if (url.endsWith(".json")) {
    return next(url, { ...ctx, importAttributes: { ...ctx.importAttributes, type: "json" } });
  }
  return next(url, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const ROUTES = ["merge", "rebase", "pull-merge", "remote", "remote-host", "pr-status"];
const routes = {};
for (const r of ROUTES) routes[r] = await import(join(repo, `app/api/workspaces/[id]/git/${r}/route.ts`));
const gitHost = await import(join(repo, "lib/shared/git-host.ts"));
const prBadge = await import(join(repo, "lib/shared/pr-badge.ts"));

const ch = (...codes) => String.fromCharCode(...codes);
const NBSP = ch(0xa0);
const NEL = ch(0x85);
const BOM = ch(0xfeff);
const LSEP = ch(0x2028);
const IDEOSP = ch(0x3000);
const E_ACUTE = ch(0xe9);
const CAFE = "caf" + E_ACUTE;
const GRIN = ch(0xd83d, 0xde00);
const LONG_S = ch(0x17f);
const DOTLESS_I = ch(0x131);
const J = JSON.stringify;

// --------------------------------- hosts ---------------------------------

const URLS = [
  null,
  "",
  "https://github.com/o/r.git",
  "http://github.com/o/r",
  "HTTPS://GITHUB.COM/O/R",
  "git@github.com:o/r.git",
  "ssh://git@github.com/o/r.git",
  "ssh://git@github.com:22/o/r.git",
  "git://github.com/o/r",
  "git+ssh://git@github.com/o/r",
  "https://user:pass@github.com/o/r",
  "https://github.com:443/o/r",
  "https://gitlab.com/o/r",
  "https://user@gitlab.com/o/r",
  "git@gitlab.com:o/r.git",
  "ssh://git@gitlab.com:2222/o/r",
  "https://gitlab.example.com/o/r",
  "git@gitlab.example.com:o/r",
  "HTTPS://GitLab.Com/x",
  "https://github.mycorp.com/o/r",
  "https://gitlab.github.com/o/r",
  "https://github.gitlab.com/o/r",
  "https://github.com/gitlab/r",
  "git@github.com:gitlab/x",
  "https://github.com.attacker.net/x",
  "https://evil.com/github.com",
  "https://evil.com/?h=github.com",
  "https://mygithub.com/x",
  "https://github-enterprise.com/x",
  "https://notgitlab.com/x",
  "https://bitbucket.org/o/r",
  "https://github.com@evil.com/x",
  "https://evil.com@github.com/x",
  "https://a@b@github.com/x",
  "a@b@github.com:x",
  "https://@github.com/x",
  "https://user@/github",
  "https://github.com@/x",
  "https://github.com/x@gitlab.com",
  "github:///x",
  "https://user@",
  "https://",
  "https:///github.com",
  "https:/github.com/x",
  "1https://github.com/x",
  "-https://github.com/x",
  "https://github",
  "https://github.",
  "https://.github.",
  "https://github..com",
  "https://[::1]/github",
  "https://github.com\n/x",
  "https://github.com" + IDEOSP + "/x",
  " https://github.com/x",
  "../origin.git",
  "/abs/github.com/repo.git",
  "file:///tmp/github",
  "file://github.com/x",
  "C:\\repos\\github",
  "github:o/r",
  "gitlab:o/r",
  "github.com",
  "github.com:o/r",
  "user@github.com:o/r",
  "user@github.com",
  "@github.com:x",
  "@:x",
  ":x",
  "@",
  "github",
  "https://gith" + ch(0xfc) + "b.com/x",
  "https://g" + ch(0x130) + "thub.com/x",
  "https://" + ch(0xff27, 0xff29, 0xff34, 0xff28, 0xff35, 0xff22) + ".com/x",
  "https://GIT" + ch(0x212a) + "AB.com/x",
  "https://github.com" + ch(0xd800) + "/x",
  "https://github" + ch(0xdc00) + ".com/x",
  "ssh://github.com:o/r",
  "a+b.c-d://github.com/x",
  "A://github.com/x",
];
const hosts = URLS.map((url) => ({ url, got: gitHost.detectGitRemoteHost(url) }));

// --------------------------------- badges ---------------------------------

const gh = (o) => J(o);
const BADGES = [
  // GitHub: state and draft
  ["github", gh({ number: 12, state: "OPEN", isDraft: false, statusCheckRollup: [], title: "T", url: "https://github.com/o/r/pull/12" }) + "\n"],
  ["github", gh({ number: 1, state: "OPEN", isDraft: true })],
  ["github", gh({ number: 1, state: "OPEN", isDraft: "true" })],
  ["github", gh({ number: 1, state: "OPEN", isDraft: 1 })],
  ["github", gh({ number: 1, state: "MERGED", isDraft: true })],
  ["github", gh({ number: 1, state: "merged" })],
  ["github", gh({ number: 1, state: "Closed", isDraft: true })],
  ["github", gh({ number: 1, state: "clo" + LONG_S + "ed" })],
  ["github", gh({ number: 1, state: "DRAFT" })],
  ["github", gh({ number: 1, state: 5, isDraft: true })],
  ["github", gh({ number: 1, state: ["MERGED"] })],
  ["github", gh({ number: 1, state: null })],
  ["github", gh({ number: 1 })],
  // GitHub: number
  ["github", gh({ state: "OPEN" })],
  ["github", gh({ number: "12" })],
  ["github", gh({ number: null })],
  ["github", gh({ number: true })],
  ["github", gh({ number: [1] })],
  ["github", gh({ number: 0 })],
  ["github", gh({ number: 1.5 })],
  ["github", '{"number":-0}'],
  ["github", '{"number":1e400}'],
  ["github", '{"number":-1e400}'],
  ["github", '{"number":1e21}'],
  ["github", '{"number":1E2}'],
  ["github", '{"number":12345678901234567890}'],
  ["github", '{"number":5e-324}'],
  ["github", '{"number":1.0}'],
  ["github", '{"number":"x","number":3}'],
  ["github", '{"number":3,"number":"x"}'],
  ["github", '{"__proto__":{"number":1}}'],
  ["github", '{"number":1,"__proto__":null,"url":"u"}'],
  // GitHub: url and title
  ["github", gh({ number: 2, url: 5, title: 5 })],
  ["github", gh({ number: 2, url: "", title: "" })],
  ["github", gh({ number: 2, title: null, url: null })],
  ["github", '{"number":2,"title":"\\ud800x","url":"https://x/\\udc00"}'],
  ["github", '{"number":2,"title":"\\ud83d\\ude00 grin \\u2028 sep \\u0000 nul"}'],
  ["github", gh({ number: 2, title: CAFE + " " + GRIN + LSEP })],
  ["github", '{"url":"u","title":"t","number":4,"state":"OPEN","checks":"x","host":"gitlab"}'],
  // GitHub: the rollup
  ["github", gh({ number: 3, statusCheckRollup: {} })],
  ["github", gh({ number: 3, statusCheckRollup: "FAILURE" })],
  ["github", gh({ number: 3, statusCheckRollup: null })],
  ["github", gh({ number: 3, statusCheckRollup: [null, 5, "x", [], {}] })],
  ["github", gh({ number: 3, statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] })],
  ["github", gh({ number: 3, statusCheckRollup: [{ conclusion: "success" }] })],
  ["github", gh({ number: 3, statusCheckRollup: [{ conclusion: LONG_S + "uccess" }] })],
  ["github", gh({ number: 3, statusCheckRollup: [{ conclusion: "SUCCESS " }] })],
  ...["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "FAILED", "failure", "fa" + DOTLESS_I + "lure", "NEUTRAL", "SKIPPED", "STALE", "ACTION_REQUIRED", "STARTUP_FAILURE"].map((c) => [
    "github",
    gh({ number: 3, statusCheckRollup: [{ conclusion: c }] }),
  ]),
  ...["FAILURE", "ERROR", "SUCCESS", "PENDING", "EXPECTED", "pending", "expected", "success"].map((s) => [
    "github",
    gh({ number: 3, statusCheckRollup: [{ state: s }] }),
  ]),
  ...["IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED", "COMPLETED", "in_progress", "queued"].map((s) => [
    "github",
    gh({ number: 3, statusCheckRollup: [{ status: s }] }),
  ]),
  ["github", gh({ number: 3, statusCheckRollup: [{ status: "PENDING", conclusion: "SUCCESS" }] })],
  ["github", gh({ number: 3, statusCheckRollup: [{ conclusion: "SUCCESS" }, { status: "QUEUED" }] })],
  ["github", gh({ number: 3, statusCheckRollup: [{ status: "QUEUED" }, { conclusion: "FAILURE" }] })],
  ["github", gh({ number: 3, statusCheckRollup: [{ conclusion: "SUCCESS" }, { state: "FAILURE" }, { status: "QUEUED" }] })],
  ["github", gh({ number: 3, statusCheckRollup: [{ conclusion: "FAILURE" }, { status: { toString: 1 } }] })],
  ["github", gh({ number: 3, statusCheckRollup: [{ status: { toString: 1 } }, { conclusion: "FAILURE" }] })],
  ["github", gh({ number: 3, statusCheckRollup: [{ conclusion: { toString: "x" } }] })],
  ["github", gh({ number: 3, statusCheckRollup: [{ state: { toString: null } }] })],
  ["github", gh({ number: 3, statusCheckRollup: [{ status: { valueOf: 1 } }] })],
  ["github", gh({ number: 3, statusCheckRollup: [{ conclusion: ["failure"] }] })],
  ["github", gh({ number: 3, statusCheckRollup: [{ conclusion: [["success"]] }] })],
  ["github", gh({ number: 3, statusCheckRollup: [{ conclusion: [null, "x"] }] })],
  ["github", gh({ number: 3, statusCheckRollup: [{ conclusion: [{ toString: "x" }] }] })],
  ["github", gh({ number: 3, statusCheckRollup: [{ conclusion: { a: 1 } }] })],
  ["github", gh({ number: 3, statusCheckRollup: [{ conclusion: null, status: null, state: null }] })],
  ["github", gh({ number: 3, statusCheckRollup: [{ conclusion: true }] })],
  ["github", '{"number":3,"statusCheckRollup":[{"conclusion":1e400}]}'],
  ["github", gh({ number: 3, statusCheckRollup: [{ conclusion: 0 }] })],
  ["github", '{"number":3,"statusCheckRollup":[{"conclusion":"\\ud800SUCCESS"}]}'],
  ["github", gh({ number: 3, state: "MERGED", isDraft: false, statusCheckRollup: [{ conclusion: "FAILURE" }], title: "done", url: "https://github.com/o/r/pull/3" })],
  // Not a badge at all
  ["github", "null"],
  ["github", "[]"],
  ["github", J([{ number: 1 }])],
  ["github", '"x"'],
  ["github", "5"],
  ["github", "true"],
  ["github", ""],
  ["github", "\n"],
  ["github", "not json"],
  ["github", "no pull requests found for branch \"x\"\n"],
  ["github", BOM + J({ number: 1 })],
  ["github", "  \n\t" + J({ number: 1 }) + "\r\n  "],
  ["github", J({ number: 1 }) + "\n" + J({ number: 2 })],
  ["github", '{"number":1,}'],
  ["github", "{'number':1}"],
  ["github", '{"number":1,"pad":' + "[".repeat(200) + "]".repeat(200) + "}"],
  ["github", '{"number":1,"t":"' + "\\u00e9".repeat(3) + '"}'],
  // GitLab
  ["gitlab", J({ iid: 45, state: "opened", draft: false, web_url: "https://gitlab.com/o/r/-/merge_requests/45", title: "M", pipeline: { status: "success" } }) + "\n"],
  ["gitlab", J({ iid: 1, state: "merged", draft: true })],
  ["gitlab", J({ iid: 1, state: "MERGED" })],
  ["gitlab", J({ iid: 1, state: "Closed" })],
  ["gitlab", J({ iid: 1, state: "locked" })],
  ["gitlab", J({ iid: 1, state: "opened", draft: true })],
  ["gitlab", J({ iid: 1, state: "opened", work_in_progress: true })],
  ["gitlab", J({ iid: 1, draft: "true", work_in_progress: 1 })],
  ["gitlab", J({ iid: 1, state: 5 })],
  ["gitlab", J({ iid: "45" })],
  ["gitlab", J({ number: 45 })],
  ["gitlab", J({ iid: null })],
  ["gitlab", '{"iid":1e400}'],
  ["gitlab", '{"iid":-0,"web_url":"w"}'],
  ["gitlab", J({ iid: 2, url: "https://ignored", web_url: 5, title: [] })],
  ["gitlab", '{"iid":2,"title":"\\udbff","web_url":"\\ud83d\\ude00"}'],
  ...["success", "failed", "running", "pending", "created", "preparing", "scheduled", "waiting_for_resource", "canceled", "skipped", "manual", "SUCCESS", "Failed", "RUNNING", "success "].map((s) => [
    "gitlab",
    J({ iid: 3, pipeline: { status: s } }),
  ]),
  ["gitlab", J({ iid: 3, head_pipeline: { status: "failed" } })],
  ["gitlab", J({ iid: 3, pipeline: null, head_pipeline: { status: "failed" } })],
  ["gitlab", J({ iid: 3, pipeline: {}, head_pipeline: { status: "failed" } })],
  ["gitlab", J({ iid: 3, pipeline: [], head_pipeline: { status: "running" } })],
  ["gitlab", J({ iid: 3, pipeline: "success", head_pipeline: { status: "success" } })],
  ["gitlab", J({ iid: 3, pipeline: { status: 5 } })],
  ["gitlab", J({ iid: 3, pipeline: { status: ["success"] } })],
  ["gitlab", J({ iid: 3, pipeline: { status: { toString: 1 } } })],
  ["gitlab", J({ iid: 3, head_pipeline: [] })],
  ["gitlab", "null"],
  ["gitlab", "[]"],
  ["gitlab", J([{ iid: 1 }])],
  ["gitlab", ""],
  ["gitlab", "no open merge request\n"],
  ["gitlab", BOM + J({ iid: 1 })],
  ["gitlab", '{"iid":1,"pad":' + "[".repeat(200) + "]".repeat(200) + "}"],
];
const badges = BADGES.map(([host, stdout]) => {
  let raw;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { host, stdout, how: "parse", got: "null" };
  }
  try {
    const badge = host === "github" ? prBadge.normalizeGithubPr(raw) : prBadge.normalizeGitlabMr(raw);
    return { host, stdout, how: "value", got: J(badge) };
  } catch {
    return { host, stdout, how: "throw", got: "null" };
  }
});

// --------------------------------- steps ---------------------------------

const FAKEBIN = join(ROOT, "fakebin");
const SYSBIN = join(ROOT, "sysbin");
const MARKS = join(ROOT, "fakemarks");
const CALLS = join(ROOT, "fakelog");
const EMPTY_PATH = join(ROOT, "emptybin");
const FAKE_PATH = `${FAKEBIN}:${SYSBIN}`;
const REAL_PATH = process.env.PATH;

/** The git wrapper; `@ROOT@` is the root and `@GIT@` the real git. */
const FAKE_GIT = [
  "#!/bin/sh",
  "d='@ROOT@/fakemarks'",
  "cwd=$(pwd -P)",
  "h=${cwd##*/}",
  "rec=\"git$(printf '\\037')$cwd\"",
  "for a in \"$@\"; do rec=\"$rec$(printf '\\037')$a\"; done",
  "printf '%s\\036' \"$rec\" >> '@ROOT@/fakelog'",
  "f=\"$d/hold-$h-$1\"",
  "if [ -e \"$f\" ]; then",
  "  read -r secs pat < \"$f\"",
  "  case \" $* \" in *\" $pat \"*) rm -f \"$f\"; sleep \"$secs\" </dev/null >/dev/null 2>&1 ;; esac",
  "fi",
  "k=\"$d/$h-$1\"",
  "if [ -e \"$k-match\" ]; then",
  "  pat=$(cat \"$k-match\")",
  "  case \" $* \" in *\" $pat \"*) rm -f \"$k-match\" ;; *) k=\"$d/-\" ;; esac",
  "fi",
  "if [ -e \"$k-out\" ] || [ -e \"$k-err\" ] || [ -e \"$k-exit\" ]; then",
  "  c=0",
  "  if [ -e \"$k-exit\" ]; then c=$(cat \"$k-exit\"); fi",
  "  exec 3</dev/null 4</dev/null",
  "  if [ -e \"$k-out\" ]; then exec 3<\"$k-out\"; fi",
  "  if [ -e \"$k-err\" ]; then exec 4<\"$k-err\"; fi",
  "  rm -f \"$k-out\" \"$k-err\" \"$k-exit\"",
  "  cat <&3",
  "  cat <&4 >&2",
  "  exit \"$c\"",
  "fi",
  "exec '@GIT@' \"$@\"",
  "",
].join("\n");

/** The gh / glab fake (one script, both names); `@ROOT@` is the root. */
const FAKE_GH = [
  "#!/bin/sh",
  "p=${0##*/}",
  "d='@ROOT@/fakemarks'",
  "cwd=$(pwd -P)",
  "h=${cwd##*/}",
  "rec=\"$p$(printf '\\037')$cwd\"",
  "for a in \"$@\"; do rec=\"$rec$(printf '\\037')$a\"; done",
  "for v in GH_PROMPT_DISABLED GH_NO_UPDATE_NOTIFIER GLAB_CHECK_UPDATE GOLDEN_CANARY; do",
  "  eval \"x=\\${$v-unset}\"",
  "  rec=\"$rec$(printf '\\037')env $v=$x\"",
  "done",
  "printf '%s\\036' \"$rec\" >> '@ROOT@/fakelog'",
  "m=\"$d/$p-$h\"",
  "if [ -e \"$m-sleep\" ]; then",
  "  read -r secs < \"$m-sleep\"",
  "  rm -f \"$m-sleep\"",
  "  sleep \"$secs\" </dev/null >/dev/null 2>&1",
  "fi",
  "if [ -e \"$m-out\" ] || [ -e \"$m-err\" ] || [ -e \"$m-exit\" ]; then",
  "  c=0",
  "  if [ -e \"$m-exit\" ]; then c=$(cat \"$m-exit\"); fi",
  "  exec 3</dev/null 4</dev/null",
  "  if [ -e \"$m-out\" ]; then exec 3<\"$m-out\"; fi",
  "  if [ -e \"$m-err\" ]; then exec 4<\"$m-err\"; fi",
  "  rm -f \"$m-out\" \"$m-err\" \"$m-exit\"",
  "  cat <&3",
  "  cat <&4 >&2",
  "  exit \"$c\"",
  "fi",
  "echo \"no pull requests found for branch \\\"$3\\\"\" >&2",
  "exit 1",
  "",
].join("\n");

/** The tools the wrappers (and git's hooks) find on PATH. */
const SYS_TOOLS = ["sh", "cat", "rm", "sleep"];

/** What `state` reads, with real git, in the repo's dir. */
const STATE_CMDS = [
  ["for-each-ref", "--format=%(refname) %(objectname) %(symref)"],
  ["symbolic-ref", "-q", "HEAD"],
  ["rev-parse", "-q", "--verify", "HEAD"],
  ["--no-optional-locks", "status", "--porcelain=v1", "-b", "-uall", "-z"],
  ["rev-parse", "-q", "--verify", "MERGE_HEAD"],
  ["rev-parse", "-q", "--verify", "REBASE_HEAD"],
  ["config", "--local", "--get-regexp", "^(branch|remote)\\."],
];

const normalize = (text) => text.split(ROOT).join("$ROOT").split(ROOT.slice(1)).join("$ROOT_REL");
const abs = (p) => (p === "" ? ROOT : join(ROOT, p));
const marks = {};

function exec(step) {
  switch (step.op) {
    case "git": {
      const env = { ...process.env };
      if (step.date) env.GIT_AUTHOR_DATE = env.GIT_COMMITTER_DATE = step.date;
      const r = spawnSync("git", step.args, { cwd: abs(step.cwd), encoding: "utf8", env });
      if ((r.status !== 0) !== Boolean(step.fails)) {
        throw new Error(`git ${step.args.join(" ")} in ${step.cwd}: ${r.status}\n${r.stdout}${r.stderr}`);
      }
      break;
    }
    case "mkdir":
      mkdirSync(abs(step.path), { recursive: true });
      break;
    case "write":
      mkdirSync(dirname(abs(step.path)), { recursive: true });
      writeFileSync(abs(step.path), step.hex != null ? Buffer.from(step.hex, "hex") : step.text);
      break;
    case "big":
      mkdirSync(dirname(abs(step.path)), { recursive: true });
      writeFileSync(abs(step.path), step.head + "x".repeat(step.n) + step.tail);
      break;
    case "rm":
      rmSync(abs(step.path), { recursive: true, force: true });
      break;
    case "symlink":
      symlinkSync(step.target, abs(step.path));
      break;
    case "chmod":
      chmodSync(abs(step.path), parseInt(step.mode, 8));
      break;
    case "workspaces": {
      const workspaces = step.list.map((w, i) => ({
        id: w.id,
        name: w.id,
        rootPath: w.raw ?? abs(w.root),
        icon: { kind: "letter", letter: "W", color: "#d97757" },
        createdAt: 1_700_000_000_000 + i,
        updatedAt: 1_700_000_000_000 + i,
      }));
      const text = step.text ?? JSON.stringify({ version: 1, workspaces }, null, 2);
      mkdirSync(join(ROOT, "home/.claude/.claudius"), { recursive: true });
      writeFileSync(join(ROOT, "home/.claude/.claudius/workspaces.json"), text);
      break;
    }
    case "sysbin":
      mkdirSync(SYSBIN, { recursive: true });
      for (const tool of SYS_TOOLS) {
        const p = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
        if (!p.startsWith("/")) throw new Error(`no ${tool} on PATH`);
        symlinkSync(p, join(SYSBIN, tool));
      }
      break;
    case "fakes": {
      const git = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
      mkdirSync(FAKEBIN, { recursive: true });
      mkdirSync(MARKS, { recursive: true });
      writeFileSync(join(FAKEBIN, "git"), FAKE_GIT.replaceAll("@ROOT@", ROOT).replaceAll("@GIT@", git), { mode: 0o755 });
      for (const p of ["gh", "glab"]) writeFileSync(join(FAKEBIN, p), FAKE_GH.replaceAll("@ROOT@", ROOT), { mode: 0o755 });
      break;
    }
    case "state":
      step.got = STATE_CMDS.map((args) => {
        const r = spawnSync("git", args, { cwd: abs(step.cwd), encoding: "utf8" });
        return { code: r.status, out: normalize(r.stdout), err: normalize(r.stderr) };
      });
      break;
    case "ls":
      step.got = readdirSync(abs(step.path)).sort();
      break;
    default:
      throw new Error(`unknown op ${step.op}`);
  }
}

/** The calls the wrappers logged since the last read: `[program, cwd, ...argv]`. */
function readCalls() {
  if (!existsSync(CALLS)) return [];
  const text = readFileSync(CALLS, "utf8");
  rmSync(CALLS, { force: true });
  return text
    .split("\x1e")
    .filter((r) => r !== "")
    .map((r) => r.split("\x1f").map(normalize));
}

async function handle(step) {
  const url = `http://localhost/api/workspaces/${encodeURIComponent(step.id)}/git/${step.route}`;
  const ctx = { params: Promise.resolve({ id: step.id }) };
  try {
    let res;
    if (step.method === "GET") {
      res = await routes[step.route].GET(new Request(url), ctx);
    } else {
      const init = { method: "POST", headers: { "content-type": "application/json" } };
      if (step.bodyHex != null) init.body = Buffer.from(step.bodyHex, "hex");
      else if (step.body != null) init.body = step.body;
      res = await routes[step.route].POST(new Request(url, init), ctx);
    }
    return { status: res.status, type: res.headers.get("content-type"), body: normalize(await res.text()) };
  } catch (e) {
    return { threw: e instanceof Error ? e.message : String(e) };
  }
}

async function request(step) {
  process.env.PATH = step.nogit ? EMPTY_PATH : FAKE_PATH;
  try {
    if (step.mark) marks[step.mark] = Date.now();
    const got = await handle(step);
    got.calls = readCalls();
    return got;
  } finally {
    process.env.PATH = REAL_PATH;
  }
}

/** UTF-16 order of the joined call, as the replay sorts it. */
const callKey = (c) => c.join("\x1f");
async function parallel(step) {
  process.env.PATH = FAKE_PATH;
  try {
    const gots = await Promise.all(step.reqs.map(handle));
    step.reqs.forEach((r, i) => (r.got = gots[i]));
    step.calls = readCalls().sort((a, b) => (callKey(a) < callKey(b) ? -1 : callKey(a) > callKey(b) ? 1 : 0));
  } finally {
    process.env.PATH = REAL_PATH;
  }
}

// The step builders. Paths are relative to the root.
const S = [];
const G = (cwd, ...args) => S.push({ op: "git", cwd, args });
/** A commit (or any git run) at its own author and committer date. */
const GD = (cwd, date, ...args) => S.push({ op: "git", cwd, args, date });
const W = (path, text) => S.push({ op: "write", path, text });
const RM = (path) => S.push({ op: "rm", path });
const MKDIR = (path) => S.push({ op: "mkdir", path });
const LN = (path, target) => S.push({ op: "symlink", path, target });
const CHMOD = (path, mode) => S.push({ op: "chmod", path, mode });
const WS = (list, text) => S.push({ op: "workspaces", list, ...(text != null ? { text } : {}) });
const STATE = (cwd) => S.push({ op: "state", cwd });
const DIR = (path) => S.push({ op: "ls", path });
const WAIT = (since, ms) => S.push({ op: "wait", since, ms });
const MARK = (name, text) => W(`fakemarks/${name}`, text);
const D = (day) => `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`;
const hex = (s) => Buffer.from(s, "utf8").toString("hex");

const req = (label, method, route, id, extra) => ({ op: "req", label, method, route, id, ...extra });
const postReq = (label, route, id, body, extra) =>
  req(label, "POST", route, id, { ...(body === undefined ? {} : { body: typeof body === "string" ? body : J(body) }), ...extra });
/** A POST; `state` is the repo dir to read back afterwards. */
const POST = (label, route, id, body, state, extra) => {
  S.push(postReq(label, route, id, body, extra));
  if (state) STATE(state);
};
const POSTHEX = (label, route, id, h) => S.push(req(label, "POST", route, id, { bodyHex: h }));
const MERGE = (label, id, body, state, extra) => POST(label, "merge", id, body, state, extra);
const REBASE = (label, id, body, state, extra) => POST(label, "rebase", id, body, state, extra);
const PULL = (label, id, state, extra) => POST(label, "pull-merge", id, undefined, state, extra);
const REMOTE = (label, id, body, state, extra) => POST(label, "remote", id, body, state, extra);
const HOST = (label, id, extra) => S.push(req(label, "GET", "remote-host", id, extra));
const PR = (label, id, extra) => S.push(req(label, "GET", "pr-status", id, extra));
const PAR = (reqs) => S.push({ op: "par", reqs });

/** A commit of `files` (text, or `null` to delete) at day `day`. */
function commit(dir, day, msg, files) {
  for (const [p, t] of Object.entries(files)) {
    if (t === null) RM(`${dir}/${p}`);
    else W(`${dir}/${p}`, t);
  }
  G(dir, "add", "-A");
  GD(dir, D(day), "commit", "-qm", msg);
}
/** A repo with one commit and, when `origin` is set, a bare `<origin>.git`
 * next to it as `origin` (relative, so merge messages don't hold the root),
 * `main` pushed and tracking it. */
function repoWith(dir, day, files, origin) {
  MKDIR(dir);
  G(dir, "init", "-q");
  commit(dir, day, "base", files);
  if (origin) {
    MKDIR(`repos/${origin}.git`);
    G(`repos/${origin}.git`, "init", "-q", "--bare");
    G(dir, "remote", "add", "origin", `../${origin}.git`);
    G(dir, "push", "-q", "-u", "origin", "main");
  }
}
/** A second clone of `origin` to push upstream changes from. */
function upClone(origin, dir) {
  G("repos", "clone", "-q", `${origin}.git`, dir.slice("repos/".length));
  G(dir, "remote", "set-url", "origin", `../${origin}.git`);
}
const ghMark = (prog, d, kind, text) => MARK(`${prog}-${d}-${kind}`, text);

// -- global config, plain dirs, the server's cwd, the wrappers --
W("home/.gitconfig", '[init]\n\tdefaultBranch = main\n[protocol]\n\tallow = never\n[protocol "file"]\n\tallow = always\n');
MKDIR("emptybin");
MKDIR("plain");
W("plain/f.txt", "outside the repos\n");
MKDIR("servercwd");
G("servercwd", "init", "-q");
commit("servercwd", 1, "server cwd", { "server-cwd.txt": "the server's cwd\n" });
G("servercwd", "remote", "add", "origin", "https://github.com/server/cwd.git");
S.push({ op: "sysbin" });
S.push({ op: "fakes" });

// -- remote ops: rm, its origin and a second clone --
const RMR = "repos/rm";
repoWith(RMR, 2, { "f.txt": "base\n" }, "rm-origin");
G(RMR, "push", "-q", "origin", "main:refs/heads/doomed");
G(RMR, "fetch", "-q");
upClone("rm-origin", "repos/rm-up");
// -- push fallbacks --
repoWith("repos/pushup", 2, { "f.txt": "up\n" });
MKDIR("repos/pushup-origin.git");
G("repos/pushup-origin.git", "init", "-q", "--bare");
G("repos/pushup", "remote", "add", "upstream", "../pushup-origin.git");
repoWith("repos/pushtwo", 2, { "f.txt": "two\n" });
for (const r of ["a", "b"]) {
  MKDIR(`repos/pushtwo-${r}.git`);
  G(`repos/pushtwo-${r}.git`, "init", "-q", "--bare");
  G("repos/pushtwo", "remote", "add", r, `../pushtwo-${r}.git`);
}
repoWith("repos/pushnone", 2, { "f.txt": "none\n" });
repoWith("repos/pushdet", 2, { "f.txt": "det\n" }, "pushdet-origin");
G("repos/pushdet", "switch", "-q", "--detach", "HEAD");
repoWith("repos/pushopt", 2, { "f.txt": "opt\n" });
MKDIR("repos/pushopt-origin.git");
G("repos/pushopt-origin.git", "init", "-q", "--bare");
G("repos/pushopt", "remote", "add", "--", "-x", "../pushopt-origin.git");
repoWith("repos/pushdash", 2, { "f.txt": "dash\n" }, "pushdash-origin");
G("repos/pushdash", "update-ref", "refs/heads/-dash", "HEAD");
G("repos/pushdash", "symbolic-ref", "HEAD", "refs/heads/-dash");
repoWith("repos/pushcan", 2, { "f.txt": "can\n" }, "pushcan-origin");
// -- pull-merge --
const PM = "repos/pm";
repoWith(PM, 2, { "f.txt": "1\n2\n3\n", "g.txt": "g\n", "sub/s.txt": "s\n" }, "pm-origin");
upClone("pm-origin", "repos/pm-up");
const ODD = "repos/odd";
const ODD_FILES = ["a.txt", " sp .txt", CAFE + ".txt", "nl\nx.txt", "id" + IDEOSP, "tab\t"];
repoWith(ODD, 2, { ...Object.fromEntries(ODD_FILES.map((f) => [f, "base\n"])), "del.txt": "d\n", "gone.txt": "g\n" }, "odd-origin");
upClone("odd-origin", "repos/odd-up");
repoWith("repos/unrel", 2, { "u.txt": "unrelated\n" });
repoWith("repos/unrel-a", 3, { "a.txt": "a\n" }, "unrel-origin");
G("repos/unrel", "remote", "add", "origin", "../unrel-origin.git");
G("repos/unrel", "fetch", "-q", "origin");
G("repos/unrel", "branch", "-q", "--set-upstream-to=origin/main");
// -- merge, rebase --
const MG = "repos/mg";
repoWith(MG, 2, { "f.txt": "mg\n" });
G(MG, "switch", "-q", "-c", "feat");
commit(MG, 3, "feat", { "x.txt": "x\n" });
G(MG, "switch", "-q", "main");
G(MG, "branch", CAFE);
const RB = "repos/rb";
repoWith(RB, 2, { "f.txt": "1\n2\n3\n" });
G(RB, "tag", "base");
G(RB, "switch", "-q", "-c", "feat");
commit(RB, 3, "feat x", { "x.txt": "x\n" });
G(RB, "switch", "-q", "-c", "feat2", "base");
commit(RB, 4, "feat2 y", { "y.txt": "y\n" });
G(RB, "switch", "-q", "-c", "conf", "base");
commit(RB, 5, "conf", { "f.txt": "1\nconf\n3\n" });
G(RB, "switch", "-q", "main");
commit(RB, 6, "main m", { "m.txt": "m\n", "f.txt": "1\nmain\n3\n" });
G(RB, "branch", "nel" + NEL + "x", "feat");
// -- canned merge-likes --
repoWith("repos/can", 2, { "f.txt": "can\n" });
// -- hosts, pr --
MKDIR("repos/hosts/sub");
G("repos/hosts", "init", "-q");
const PRR = "repos/pr";
repoWith(PRR, 2, { "f.txt": "pr\n", "sub/k.txt": "k\n" });
G(PRR, "remote", "add", "origin", "https://github.com/o/r.git");
MKDIR("links");
LN("links/pr", "../repos/pr");
// -- empty, bare --
MKDIR("repos/empty");
G("repos/empty", "init", "-q");
MKDIR("repos/bare.git");
G("repos/bare.git", "init", "-q", "--bare");
G("repos/bare.git", "config", "remote.origin.url", "https://gitlab.com/bare/r.git");
// -- customizations --
const CUST_ROOT = "home/.claude/.claudius/customizations";
MKDIR(`${CUST_ROOT}/cust_a/src`);
G(`${CUST_ROOT}/cust_a/src`, "init", "-q");
commit(`${CUST_ROOT}/cust_a/src`, 2, "mirror", { "mirror.txt": "mirror\n" });
G(`${CUST_ROOT}/cust_a/src`, "remote", "add", "origin", "git@gitlab.example.com:team/mirror.git");
W(`${CUST_ROOT}/index.json`, J({ version: 1, customizations: [{ id: "cust_a" }, { id: "cust_b" }], publishes: [] }));
// -- slow: the timeouts, behind the wrappers' markers --
const SLOW = ["sfetch", "spull", "spush", "spushu", "spm", "srb", "smg", "srev", "srevm", "srem", "sremm", "slc", "slcm", "scfg", "scfgm", "sroot", "sgh", "sghm"];
for (const s of SLOW) repoWith(`repos/${s}`, 2, { "f.txt": `${s}\n` }, `${s}-origin`);
for (const s of ["spushu", "srev", "srevm", "srem", "sremm"]) G(`repos/${s}`, "switch", "-q", "-c", "nup");
G("repos/srb", "switch", "-q", "-c", "side");
commit("repos/srb", 3, "side", { "s.txt": "s\n" });
for (const s of ["scfg", "scfgm", "sgh", "sghm"]) G(`repos/${s}`, "remote", "set-url", "origin", `https://github.com/slow/${s}.git`);

const WORKSPACES = [
  { id: "wks_rm", root: RMR },
  { id: "wks_pushup", root: "repos/pushup" },
  { id: "wks_pushtwo", root: "repos/pushtwo" },
  { id: "wks_pushnone", root: "repos/pushnone" },
  { id: "wks_pushdet", root: "repos/pushdet" },
  { id: "wks_pushopt", root: "repos/pushopt" },
  { id: "wks_pushdash", root: "repos/pushdash" },
  { id: "wks_pushcan", root: "repos/pushcan" },
  { id: "wks_pm", root: PM },
  { id: "wks_pmsub", root: `${PM}/sub` },
  { id: "wks_odd", root: ODD },
  { id: "wks_unrel", root: "repos/unrel" },
  { id: "wks_mg", root: MG },
  { id: "wks_rb", root: RB },
  { id: "wks_can", root: "repos/can" },
  { id: "wks_hosts", root: "repos/hosts" },
  { id: "wks_hostsub", root: "repos/hosts/sub" },
  { id: "wks_pr", root: PRR },
  { id: "wks_prsub", root: `${PRR}/sub` },
  { id: "wks_prlink", root: "links/pr" },
  { id: "wks_empty", root: "repos/empty" },
  { id: "wks_bare", root: "repos/bare.git" },
  { id: "wks_plain", root: "plain" },
  { id: "wks_file", root: "plain/f.txt" },
  { id: "wks_missing", root: "nowhere/at/all" },
  { id: "wks_emptyroot", raw: "" },
  { id: "cust_x", root: MG },
  ...SLOW.map((s) => ({ id: `wks_${s}`, root: `repos/${s}` })),
];
WS(WORKSPACES);

// -- remote: bodies --
const R = (label, op, state, extra) => REMOTE(label, "wks_rm", op === undefined ? undefined : { op }, state, extra);
REMOTE("no body", "wks_rm");
REMOTE("empty body", "wks_rm", "");
REMOTE("malformed body", "wks_rm", "{");
REMOTE("null body: throws", "wks_rm", "null");
REMOTE("array body", "wks_rm", "[]");
REMOTE("string body", "wks_rm", '"fetch"');
REMOTE("no op", "wks_rm", {});
R("op null", null);
R("op number", 1);
R("op upper case", "FETCH");
R("op padded", " fetch");
R("op array", ["fetch"]);
R("op toString", "toString");
R("op merge", "merge");
REMOTE("op 1e400", "wks_rm", '{"op":1e400}');
REMOTE("duplicate op: the last wins", "wks_rm", '{"op":"nope","op":"fetch"}');
REMOTE("BOM-prefixed body", "wks_rm", BOM + J({ op: "fetch" }));
REMOTE("unknown workspace", "wks_nope", { op: "fetch" });
REMOTE("unknown workspace, null body", "wks_nope", "null");
// -- remote: fetch, pull, push --
R("fetch: nothing new", "fetch", RMR);
commit("repos/rm-up", 3, "upstream 1", { "f.txt": "upstream 1\n" });
G("repos/rm-up", "push", "-q", "origin", "main");
G("repos/rm-origin.git", "branch", "-D", "doomed");
R("fetch: a new commit and a pruned branch", "fetch", RMR);
R("pull: fast-forward", "pull", RMR);
R("pull: up to date", "pull", RMR);
R("push: up to date", "push", RMR);
commit(RMR, 4, "local 1", { "l.txt": "local\n" });
commit("repos/rm-up", 5, "upstream 2", { "u.txt": "upstream 2\n" });
G("repos/rm-up", "push", "-q", "origin", "main");
R("pull: diverged, --ff-only refuses", "pull", RMR);
R("push: rejected", "push", RMR);
PULL("pull-merge: a merge commit", "wks_rm", RMR);
R("push: the merge", "push", RMR);
STATE("repos/rm-origin.git");
G(RMR, "switch", "-q", "-c", "feat");
commit(RMR, 6, "feat", { "feat.txt": "feat\n" });
R("push: no upstream, then -u origin", "push", RMR);
STATE("repos/rm-origin.git");
R("push: now tracked, up to date", "push", RMR);
G(RMR, "switch", "-q", "-c", "local-only");
R("pull: no tracking information", "pull", RMR);
PULL("pull-merge: no tracking information", "wks_rm", RMR);
G(RMR, "switch", "-q", "--detach", "main");
R("push: detached HEAD", "push", RMR);
R("pull: detached HEAD", "pull", RMR);
PULL("pull-merge: detached HEAD", "wks_rm", RMR);
G(RMR, "switch", "-q", "main");
G(RMR, "remote", "add", "gone", "../gone.git");
R("fetch: a remote that is gone", "fetch", RMR);
G(RMR, "remote", "remove", "gone");
W(`${RMR}/.git/hooks/pre-push`, "#!/bin/sh\necho hook says no on stdout\necho hook says no on stderr >&2\nexit 1\n");
CHMOD(`${RMR}/.git/hooks/pre-push`, "755");
commit(RMR, 7, "local 2", { "l2.txt": "l2\n" });
R("push: a pre-push hook refuses", "push", RMR);
RM(`${RMR}/.git/hooks/pre-push`);
W(`${RMR}/.git/hooks/pre-push`, "#!/bin/sh\necho hook ok on stdout\necho hook ok on stderr >&2\n");
CHMOD(`${RMR}/.git/hooks/pre-push`, "755");
R("push: a pre-push hook's output", "push", RMR);
RM(`${RMR}/.git/hooks/pre-push`);
// -- remote: the push fallbacks --
REMOTE("push: no origin, the only remote", "wks_pushup", { op: "push" }, "repos/pushup");
STATE("repos/pushup-origin.git");
REMOTE("push: two remotes, neither origin", "wks_pushtwo", { op: "push" }, "repos/pushtwo");
REMOTE("push: no remotes", "wks_pushnone", { op: "push" });
MARK("pushnone-push-err", "fatal: The current branch main has no upstream branch.\n");
MARK("pushnone-push-exit", "128");
REMOTE("push: canned no upstream, no remotes", "wks_pushnone", { op: "push" });
REMOTE("push: detached HEAD with an origin", "wks_pushdet", { op: "push" });
MARK("pushdet-push-err", "fatal: no upstream branch\n");
MARK("pushdet-push-exit", "1");
REMOTE("push: canned no upstream, detached", "wks_pushdet", { op: "push" });
REMOTE("push: the only remote is named -x", "wks_pushopt", { op: "push" }, "repos/pushopt");
REMOTE("push: the branch is named -dash", "wks_pushdash", { op: "push" }, "repos/pushdash");
STATE("repos/pushdash-origin.git");
G("repos/pushcan", "switch", "-q", "-c", "c1");
const CANPUSH = (label, files, state) => {
  for (const [k, v] of Object.entries(files)) MARK(`pushcan-${k}`, v);
  REMOTE(label, "wks_pushcan", { op: "push" }, state);
};
CANPUSH("canned push: both streams, exit 0", { "push-out": "to stdout\n", "push-err": "to stderr\n" });
CANPUSH("canned push: exit 1, no output", { "push-exit": "1" });
CANPUSH("canned push: exit 3 with output", { "push-out": "partial\n", "push-err": "  boom  \n", "push-exit": "3" });
CANPUSH("canned push: upper case NO UPSTREAM BRANCH", { "push-err": "NO UPSTREAM BRANCH\n", "push-exit": "1" }, "repos/pushcan");
G("repos/pushcan", "switch", "-q", "-c", "c2");
CANPUSH("canned push: --SET-UPSTREAM", { "push-err": "use --SET-UPSTREAM\n", "push-exit": "1", "remote-out": " origin \n\n  b\n" }, "repos/pushcan");
G("repos/pushcan", "switch", "-q", "-c", "c3");
CANPUSH("canned push: a long s isn't an s", { "push-err": "no up" + LONG_S + "tream branch\n", "push-exit": "1" });
CANPUSH("canned push: no-upstream branch, hyphenated", { "push-err": "no-upstream branch\n", "push-exit": "1" });
CANPUSH("canned remotes: one, padded", { "push-err": "no upstream branch\n", "push-exit": "1", "remote-out": "\n up \n\n" });
CANPUSH("canned remotes: two, neither origin", { "push-err": "no upstream branch\n", "push-exit": "1", "remote-out": "a\nb\n" });
CANPUSH("canned remotes: blank lines only", { "push-err": "no upstream branch\n", "push-exit": "1", "remote-out": " \n\t\n" + IDEOSP + "\n" });
CANPUSH("canned remotes: origin among others", { "push-err": "no upstream branch\n", "push-exit": "1", "remote-out": "a\norigin\nb\n" }, "repos/pushcan");
G("repos/pushcan", "switch", "-q", "-c", "c4");
CANPUSH("canned remote fails", { "push-err": "no upstream branch\n", "push-exit": "1", "remote-exit": "1" });
CANPUSH("canned rev-parse fails", { "push-err": "no upstream branch\n", "push-exit": "1", "rev-parse-match": "--abbrev-ref HEAD", "rev-parse-err": "fatal: x\n", "rev-parse-exit": "128" });
CANPUSH("canned rev-parse: blank", { "push-err": "no upstream branch\n", "push-exit": "1", "rev-parse-match": "--abbrev-ref HEAD", "rev-parse-out": " \n" });
CANPUSH("canned rev-parse: HEAD", { "push-err": "no upstream branch\n", "push-exit": "1", "rev-parse-match": "--abbrev-ref HEAD", "rev-parse-out": "HEAD\n" });
CANPUSH("canned rev-parse: padded", { "push-err": "no upstream branch\n", "push-exit": "1", "rev-parse-match": "--abbrev-ref HEAD", "rev-parse-out": "  c4" + IDEOSP + "\n" }, "repos/pushcan");
MARK("pushcan-fetch-exit", "1");
REMOTE("canned fetch: exit 1, no output", "wks_pushcan", { op: "fetch" });
MARK("pushcan-fetch-out", "  " + IDEOSP + " fetched " + NEL + "\n");
REMOTE("canned fetch: the output JS-trimmed", "wks_pushcan", { op: "fetch" });
MARK("pushcan-pull-out", "out\n");
MARK("pushcan-pull-err", "err\n");
MARK("pushcan-pull-exit", "2");
REMOTE("canned pull: exit 2", "wks_pushcan", { op: "pull" });
// -- remote: not a repo --
for (const [label, id, extra] of [
  ["plain dir", "wks_plain"],
  ["a file", "wks_file"],
  ["missing dir", "wks_missing"],
  ["bare repo", "wks_bare"],
  ["empty repo", "wks_empty"],
  ["empty rootPath: the server's cwd, https refused", "wks_emptyroot"],
  ["cust_x is a workspace here", "cust_x"],
  ["no git", "wks_rm", { nogit: true }],
]) {
  REMOTE(`fetch: ${label}`, id, { op: "fetch" }, null, extra);
}
REMOTE("push: empty repo", "wks_empty", { op: "push" });
REMOTE("pull: empty repo", "wks_empty", { op: "pull" });
REMOTE("push: plain dir", "wks_plain", { op: "push" });

// -- pull-merge --
PULL("pull-merge: up to date", "wks_pm", PM);
PULL("pull-merge: a body is never read", "wks_pm", null, { body: "null" });
commit("repos/pm-up", 3, "up g", { "g.txt": "g2\n" });
G("repos/pm-up", "push", "-q", "origin", "main");
PULL("pull-merge: fast-forward", "wks_pm", PM);
commit("repos/pm-up", 4, "up s", { "sub/s.txt": "s2\n" });
G("repos/pm-up", "push", "-q", "origin", "main");
commit(PM, 5, "local h", { "h.txt": "h\n" });
W(`${PM}/.git/hooks/pre-merge-commit`, "#!/bin/sh\necho merge hook out\necho merge hook err >&2\n");
CHMOD(`${PM}/.git/hooks/pre-merge-commit`, "755");
PULL("pull-merge: a merge commit, with the hook's output", "wks_pm", PM);
RM(`${PM}/.git/hooks/pre-merge-commit`);
PULL("pull-merge: from the nested dir", "wks_pmsub", PM);
commit("repos/pm-up", 6, "up f", { "f.txt": "1\nup\n3\n" });
G("repos/pm-up", "push", "-q", "origin", "main");
commit(PM, 7, "local f", { "f.txt": "1\nlocal\n3\n" });
PULL("pull-merge: a conflict, left mid-merge", "wks_pm", PM);
PULL("pull-merge: again, mid-merge", "wks_pm", PM);
MERGE("merge: mid-merge, the usage error reads as conflicts", "wks_pm", { name: "main" }, PM);
REBASE("rebase: mid-merge", "wks_pm", { onto: "main" }, PM);
REMOTE("pull --ff-only: mid-merge", "wks_pm", { op: "pull" }, PM);
G(PM, "merge", "--abort");
STATE(PM);
W(`${PM}/f.txt`, "dirty\n");
PULL("pull-merge: a dirty file the merge would overwrite", "wks_pm", PM);
G(PM, "checkout", "-q", "--", "f.txt");
G(PM, "reset", "-q", "--hard", "HEAD~1");
commit("repos/pm-up", 8, "up new", { "new-up.txt": "new upstream\n" });
G("repos/pm-up", "push", "-q", "origin", "main");
W(`${PM}/new-up.txt`, "untracked, would be overwritten\n");
PULL("pull-merge: an untracked file the merge would overwrite", "wks_pm", PM);
RM(`${PM}/new-up.txt`);
PULL("pull-merge: then it merges", "wks_pm", PM);
// odd paths, modify/delete, add/add
commit("repos/odd-up", 3, "upstream odd", {
  ...Object.fromEntries(ODD_FILES.map((f) => [f, "upstream\n"])),
  "del.txt": "upstream changed\n",
  "gone.txt": null,
  "new.txt": "upstream new\n",
});
G("repos/odd-up", "push", "-q", "origin", "main");
commit(ODD, 4, "local odd", {
  ...Object.fromEntries(ODD_FILES.map((f) => [f, "local\n"])),
  "del.txt": null,
  "gone.txt": "local changed\n",
  "new.txt": "local new\n",
});
PULL("pull-merge: conflicts in odd paths, modify/delete, add/add", "wks_odd", ODD);
PULL("pull-merge: unrelated histories", "wks_unrel", "repos/unrel");
G("repos/unrel", "remote", "set-url", "origin", "../nope.git");
PULL("pull-merge: the upstream repo is gone", "wks_unrel", "repos/unrel");
for (const [label, id, extra] of [
  ["plain dir", "wks_plain"],
  ["a file", "wks_file"],
  ["missing dir", "wks_missing"],
  ["bare repo", "wks_bare"],
  ["empty repo", "wks_empty"],
  ["empty rootPath: https refused", "wks_emptyroot"],
  ["unknown workspace", "wks_nope"],
  ["no git", "wks_pm", { nogit: true }],
]) {
  PULL(`pull-merge: ${label}`, id, null, extra);
}
// canned
const CAN = (label, route, body, files) => {
  for (const [k, v] of Object.entries(files)) MARK(`can-${k}`, v);
  POST(label, route, "wks_can", body, "repos/can");
};
CAN("canned pull: exit 1, no output", "pull-merge", undefined, { "pull-exit": "1" });
CAN("canned pull: success output JS-trimmed", "pull-merge", undefined, { "pull-out": "  done \n", "pull-err": IDEOSP + "warn" + BOM + "\n" });
CAN("canned pull: unmerged paths listed, trimmed", "pull-merge", undefined, {
  "pull-exit": "1",
  "pull-err": "  conflict text  \n",
  "diff-out": "a\0 b \0\0c" + IDEOSP + "\0" + NEL + "d\0",
});
CAN("canned pull: the conflict list fails", "pull-merge", undefined, { "pull-exit": "1", "pull-err": "pull failed\n", "diff-exit": "1", "diff-out": "a\0" });
CAN("canned rebase: exit 1, no output", "rebase", { onto: "main" }, { "rebase-exit": "1" });
CAN("canned rebase: exit 0", "rebase", { onto: "main" }, { "rebase-out": "rebased\n", "rebase-err": "and more\n" });
CAN("canned merge: exit 1, no output", "merge", { name: "main" }, { "merge-exit": "1" });
CAN("canned merge: exit 0", "merge", { name: "main" }, { "merge-out": "merged\n" });
CAN("canned merge: exit 1, unmerged paths", "merge", { name: "main" }, { "merge-exit": "1", "merge-err": "x\n", "diff-out": "f.txt\0" });

// -- merge --
const M = (label, body, state, extra) => MERGE(label, "wks_mg", body, state, extra);
M("no body");
M("empty body", "");
M("malformed body", "{");
M("null body: throws", "null");
M("array body", "[]");
M("string body", '"feat"');
M("number body", "5");
M("null name", { name: null });
M("number name", { name: 5 });
M("1e400 name", '{"name":1e400}');
M("empty name", { name: "" });
M("blank name", { name: " \t\n " });
M("NBSP name", { name: NBSP });
M("BOM name", { name: BOM });
M("array name", { name: ["feat"] });
M("object name", { name: {} });
M("git merge has no --no-rebase", { name: "feat" }, MG);
M("unknown branch: the same usage error", { name: "nope" });
M("padded name is trimmed", { name: " feat " });
M("unicode name", { name: CAFE });
M("NEL name reaches git", { name: "nel" + NEL });
M("dash name", { name: "-x" });
M("padded dash name", { name: " --abort" });
M("dotdot", { name: "a..b" });
M("at-brace", { name: "main@{1}" });
M("tilde", { name: "main~1" });
M("trailing slash", { name: "feat/" });
M(".lock", { name: "x.lock" });
M("inner space", { name: "a b" });
M("255 units", { name: "x".repeat(255) });
M("256 units", { name: "x".repeat(256) });
M("NUL name: Node's TypeError", { name: "a\0b" });
M("BOM-prefixed body", BOM + J({ name: "feat" }));
M("duplicate key: the last wins", '{"name":"-x","name":"feat"}');
POSTHEX("invalid UTF-8 in the name", "merge", "wks_mg", hex('{"name":"x') + "ff" + hex('y"}'));
MERGE("unknown workspace", "wks_nope", { name: "feat" });
MERGE("unknown workspace, null body", "wks_nope", "null");
MERGE("cust_x is a workspace here", "cust_x", { name: "feat" });
for (const [label, id, extra] of [
  ["plain dir", "wks_plain"],
  ["a file", "wks_file"],
  ["missing dir", "wks_missing"],
  ["bare repo", "wks_bare"],
  ["empty repo", "wks_empty"],
  ["empty rootPath", "wks_emptyroot"],
  ["no git", "wks_mg", { nogit: true }],
]) {
  MERGE(`merge: ${label}`, id, { name: "feat" }, null, extra);
}
MERGE("merge: plain dir, invalid name: repo first", "wks_plain", { name: "-x" });

// -- rebase --
const RBQ = (label, body, state, extra) => REBASE(label, "wks_rb", body, state, extra);
G(RB, "switch", "-q", "feat");
RBQ("no body");
RBQ("null body: throws", "null");
RBQ("array body", "[]");
RBQ("no onto", {});
RBQ("onto null", { onto: null });
RBQ("onto number", { onto: 5 });
RBQ("onto 1e400", '{"onto":1e400}');
RBQ("onto empty", { onto: "" });
RBQ("onto blank", { onto: "  " });
RBQ("onto NBSP", { onto: NBSP });
RBQ("onto array", { onto: ["main"] });
RBQ("onto missing, checkoutBranch set", { checkoutBranch: "feat" });
RBQ("rebase feat onto main", { onto: "main" }, RB);
RBQ("again: up to date", { onto: "main" }, RB);
RBQ("onto padded: trimmed", { onto: " main\t" }, RB);
RBQ("onto a dash name", { onto: "-x" });
RBQ("onto --root", { onto: "--root" });
RBQ("onto dotdot", { onto: "main..feat" });
RBQ("onto tilde", { onto: "main~1" });
RBQ("onto caret", { onto: "main^" });
RBQ("onto with a space", { onto: "a b" });
RBQ("onto with a NUL", { onto: "a\0b" });
RBQ("onto unknown", { onto: "nope" }, RB);
RBQ("onto a NEL name", { onto: "nel" + NEL + "x" }, RB);
for (const [label, cb] of [
  ["false", "false"],
  ["0", "0"],
  ["empty", '""'],
  ["blank", '" "'],
  ["number", "5"],
  ["array", "[]"],
  ["object", "{}"],
  ["1e400", "1e400"],
  ["true", "true"],
]) {
  RBQ(`checkoutBranch ${label}`, `{"onto":"main","checkoutBranch":${cb}}`);
}
RBQ("checkoutBranch null: a plain rebase", { onto: "main", checkoutBranch: null }, RB);
RBQ("checkout feat2 and rebase it onto main", { onto: "main", checkoutBranch: "feat2" }, RB);
RBQ("checkoutBranch padded", { onto: "main", checkoutBranch: " feat2 " }, RB);
RBQ("checkoutBranch unknown", { onto: "main", checkoutBranch: "nope" }, RB);
RBQ("checkoutBranch dash", { onto: "main", checkoutBranch: "-x" }, RB);
RBQ("checkoutBranch NUL: unknown", { onto: "main", checkoutBranch: "a\0b" }, RB);
RBQ("checkoutBranch lone surrogate: unknown", '{"onto":"main","checkoutBranch":"\\ud800x"}', RB);
RBQ("checkoutBranch valid, onto invalid: switched first", { onto: "-x", checkoutBranch: "feat" }, RB);
RBQ("checkoutBranch valid, onto NUL", { onto: "a\0b", checkoutBranch: "feat2" }, RB);
RBQ("checkoutBranch valid, onto unknown", { onto: "nope", checkoutBranch: "feat" }, RB);
W(`${RB}/f.txt`, "dirty\n");
RBQ("dirty tree", { onto: "main" }, RB);
RBQ("dirty tree: checkoutBranch carries it, then the rebase refuses", { onto: "main", checkoutBranch: "feat2" }, RB);
G(RB, "checkout", "-q", "--", "f.txt");
G(RB, "switch", "-q", "conf");
RBQ("a conflict, left mid-rebase", { onto: "main" }, RB);
RBQ("again, mid-rebase", { onto: "main" }, RB);
RBQ("checkoutBranch, mid-rebase", { onto: "main", checkoutBranch: "feat" }, RB);
PULL("pull-merge: mid-rebase", "wks_rb", RB);
MERGE("merge: mid-rebase", "wks_rb", { name: "main" }, RB);
G(RB, "rebase", "--abort");
STATE(RB);
W(`${RB}/.git/hooks/pre-rebase`, "#!/bin/sh\necho no rebase on stdout\necho no rebase on stderr >&2\nexit 1\n");
CHMOD(`${RB}/.git/hooks/pre-rebase`, "755");
RBQ("a pre-rebase hook refuses", { onto: "main" }, RB);
RM(`${RB}/.git/hooks/pre-rebase`);
G(RB, "switch", "-q", "--detach", "feat2~1");
RBQ("detached HEAD rebases", { onto: "feat" }, RB);
G(RB, "switch", "-q", "main");
RBQ("onto a tag", { onto: "base" }, RB);
RBQ("onto itself", { onto: "main" }, RB);
REBASE("cust_x is a workspace here", "cust_x", { onto: "main" });
for (const [label, id, extra] of [
  ["unknown workspace", "wks_nope"],
  ["plain dir", "wks_plain"],
  ["a file", "wks_file"],
  ["missing dir", "wks_missing"],
  ["bare repo", "wks_bare"],
  ["empty repo", "wks_empty"],
  ["empty rootPath", "wks_emptyroot"],
  ["no git", "wks_rb", { nogit: true }],
]) {
  REBASE(`rebase: ${label}`, id, { onto: "main" }, null, extra);
}
REBASE("rebase: plain dir, invalid onto: repo first", "wks_plain", { onto: "-x" });
REBASE("rebase: plain dir, checkoutBranch: not a repo", "wks_plain", { onto: "main", checkoutBranch: "feat" });

// -- remote-host --
const H = (label, id = "wks_hosts", extra) => HOST(label, id, extra);
const SETURL = (url) => G("repos/hosts", "config", "remote.origin.url", url);
H("no origin");
G("repos/hosts", "remote", "add", "origin", "https://github.com/o/r.git");
H("github https");
H("nested dir", "wks_hostsub");
for (const url of [
  "git@gitlab.com:o/r.git",
  "ssh://git@gitlab.example.com:2222/o/r",
  "https://bitbucket.org/o/r",
  "../hosts-origin.git",
  "  https://github.com/padded  ",
  "https://GitHub.COM/Upper",
  "https://evil.com/github.com",
  "https://github.com.attacker.net/x",
  "https://gith" + ch(0xfc) + "b.com/x",
  "https://gitlab.com/" + GRIN + "/r",
  IDEOSP + "https://gitlab.com/x" + NEL,
]) {
  SETURL(url);
  H(`url ${J(url)}`);
}
G("repos/hosts", "config", "--add", "remote.origin.url", "https://gitlab.com/second.git");
H("two urls: the last wins");
G("repos/hosts", "config", "--unset-all", "remote.origin.url");
G("repos/hosts", "config", "remote.origin.url", "");
H("an empty url is none");
G("repos/hosts", "config", "remote.origin.url", " \t ");
H("a blank url is none");
G("repos/hosts", "config", "--unset-all", "remote.origin.url");
G("repos/hosts", "remote", "add", "upstream", "https://github.com/u/r.git");
H("only another remote");
H("plain dir", "wks_plain");
H("a file", "wks_file");
H("missing dir", "wks_missing");
H("bare repo: config still reads", "wks_bare");
H("empty repo", "wks_empty");
H("empty rootPath: the server's cwd", "wks_emptyroot");
H("no git", "wks_hosts", { nogit: true });
H("unknown workspace", "wks_nope");
H("customization mirror", "cust_a");
H("customization without a src dir", "cust_b");
H("customization not in the index", "cust_nope");
H("cust_x is a workspace, not a customization", "cust_x");
H("cust_ prefix only", "cust_");
H("custom without the underscore", "custom");
MARK("hold-servercwd---version", "5 --version");
H("git --version killed at 1.5 s", "wks_emptyroot");
DIR("fakemarks");

// -- pr-status --
const P = (label, id = "wks_pr", extra) => PR(label, id, extra);
const SW = (b) => G(PRR, "switch", "-q", "-c", b);
const GHM = (kind, text, d = "pr", prog = "gh") => ghMark(prog, d, kind, text);
const OPEN_PR = { number: 12, state: "OPEN", isDraft: false, statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }], title: "Add things", url: "https://github.com/o/r/pull/12" };
SW("c01");
GHM("out", J(OPEN_PR) + "\n");
P("an open PR, checks passing");
GHM("out", J({ number: 99, state: "MERGED" }));
P("within 30 s: the cached badge, gh not run");
DIR("fakemarks");
RM("fakemarks/gh-pr-out");
GHM("out", J({ number: 13, state: "OPEN", isDraft: true }), "sub");
P("the nested dir: its own cache key", "wks_prsub");
GHM("out", J({ number: 14, state: "CLOSED" }));
P("through a symlink: its own cache key", "wks_prlink");
SW("c02");
GHM("err", 'no pull requests found for branch "c02"\n');
GHM("exit", "1");
P("no PR: gh exits 1", "wks_pr", { mark: "c02" });
GHM("out", J({ number: 3 }));
P("a null is cached too");
DIR("fakemarks");
RM("fakemarks/gh-pr-out");
SW("c03");
GHM("out", "not json\n");
P("gh prints something that isn't JSON");
SW("c04");
GHM("exit", "0");
P("gh prints nothing");
SW("c05");
GHM("out", BOM + J({ number: 5 }));
P("a BOM before the JSON");
SW("c06");
GHM("out", '{"number":1e400,"title":"\\ud800x","url":"u","state":"OPEN","isDraft":true,"statusCheckRollup":[{"state":"PENDING"}]}');
P("Infinity and a lone surrogate");
SW("c07");
GHM("out", J({ number: 7, title: CAFE + " " + GRIN, statusCheckRollup: [{ conclusion: "FAILURE" }] }));
GHM("err", "warning: noise on stderr\n");
P("stderr on success is ignored");
SW("c08");
S.push({ op: "big", path: "fakemarks/gh-pr-out", head: '{"number":8,"title":"', n: 1024 * 1024, tail: '"}' });
P("past the 1 MiB maxBuffer");
SW("c09");
RM("fakebin/gh");
P("no gh on PATH");
S.push({ op: "fakes" });
SW("c10");
GHM("out", "null\n");
P("gh prints null");
SW("c11");
GHM("out", '{"number":11,"state":"OPEN","isDraft":false,"statusCheckRollup":[{"status":"QUEUED"},{"conclusion":"SUCCESS"}],"title":"pending","url":"https://github.com/o/r/pull/11"}');
GHM("exit", "0");
P("pending checks");
SW("c18");
S.push({ op: "write", path: "fakemarks/gh-pr-out", hex: hex('{"number":18,"title":"bad ') + "ff" + hex(' byte"}') });
P("invalid UTF-8 from gh");
SW("c12");
GHM("out", '{"number":12}');
GHM("exit", "2");
P("JSON on stdout but exit 2");
G(PRR, "switch", "-q", "--detach", "HEAD");
P("detached HEAD: no gh");
G(PRR, "update-ref", "refs/heads/-dash", "HEAD");
G(PRR, "symbolic-ref", "HEAD", "refs/heads/-dash");
GHM("out", J({ number: 15 }));
P("a branch named -dash reaches gh as is");
SW(CAFE);
GHM("out", J({ number: 16, title: "unicode branch" }));
P("a unicode branch");
SW("nel" + NEL + "x");
GHM("out", J({ number: 17 }));
P("a NEL branch");
SW("c13");
GHM("out", J({ number: 18 }));
P("github: gh");
G(PRR, "remote", "set-url", "origin", "git@gitlab.com:o/r.git");
GHM("out", J({ iid: 45, state: "opened", draft: false, web_url: "https://gitlab.com/o/r/-/merge_requests/45", title: "M", pipeline: { status: "running" } }), "pr", "glab");
P("gitlab, same branch: its own cache key, glab");
GHM("out", J({ iid: 46 }), "pr", "glab");
P("gitlab within 30 s: cached");
DIR("fakemarks");
RM("fakemarks/glab-pr-out");
SW("c14");
P("glab with no MR: exits 1");
SW("c15");
RM("fakebin/glab");
P("no glab on PATH");
S.push({ op: "fakes" });
G(PRR, "remote", "set-url", "origin", "https://bitbucket.org/o/r.git");
SW("c16");
P("another host: no CLI");
G(PRR, "remote", "remove", "origin");
P("no origin: no CLI");
G(PRR, "remote", "add", "origin", "https://github.com/o/r.git");
SW("c17");
GHM("out", J({ number: 17 }));
MARK("hold-pr-rev-parse", "5 --abbrev-ref HEAD");
P("the branch read killed at 2 s");
DIR("fakemarks");
RM("fakemarks/gh-pr-out");
MARK("hold-servercwd---version", "5 --version");
P("git --version killed at 1.5 s");
DIR("fakemarks");
GHM("out", J({ number: 19, title: "server cwd" }), "servercwd");
P("empty rootPath: the server's cwd", "wks_emptyroot");
GHM("out", J({ iid: 20, title: "mirror", pipeline: { status: "failed" } }), "src", "glab");
P("customization mirror: glab", "cust_a");
P("customization without a src dir", "cust_b");
P("customization not in the index", "cust_nope");
P("cust_x is a workspace, not a customization", "cust_x");
P("unknown workspace", "wks_nope");
P("plain dir", "wks_plain");
P("missing dir", "wks_missing");
P("bare repo: no branch", "wks_bare");
P("no git", "wks_pr", { nogit: true });
DIR("fakemarks");

// -- the timeouts: one request per call site, all at once --
MARK("hold-sfetch-fetch", "16 --all --prune");
MARK("hold-spull-pull", "16 --ff-only");
MARK("hold-spush-push", "16 push");
MARK("hold-spushu-push", "16 -u origin");
MARK("hold-spm-pull", "16 --no-rebase --no-edit");
MARK("hold-srb-rebase", "16 main");
MARK("hold-smg-merge", "16 --no-rebase");
MARK("hold-srev-rev-parse", "30 --abbrev-ref HEAD");
MARK("hold-srevm-rev-parse", "10 --abbrev-ref HEAD");
MARK("hold-srem-remote", "30 remote");
MARK("hold-sremm-remote", "10 remote");
for (const d of ["slc", "slcm"]) {
  MARK(`${d}-pull-err`, "canned pull failure\n");
  MARK(`${d}-pull-exit`, "1");
  MARK(`${d}-diff-out`, "f.txt\0");
}
MARK("hold-slc-diff", "30 --diff-filter=U");
MARK("hold-slcm-diff", "10 --diff-filter=U");
MARK("hold-scfg-config", "30 remote.origin.url");
MARK("hold-scfgm-config", "10 remote.origin.url");
MARK("hold-sroot-rev-parse", "30 --show-toplevel");
for (const d of ["sgh", "sghm"]) GHM("out", J({ number: 23, title: d }), d);
GHM("sleep", "10", "sgh");
GHM("sleep", "3", "sghm");
PAR([
  postReq("slow: fetch past 15 s still answers", "remote", "wks_sfetch", { op: "fetch" }),
  postReq("slow: pull past 15 s still answers", "remote", "wks_spull", { op: "pull" }),
  postReq("slow: push past 15 s still answers", "remote", "wks_spush", { op: "push" }),
  postReq("slow: push -u past 15 s still answers", "remote", "wks_spushu", { op: "push" }),
  postReq("slow: pull-merge past 15 s still answers", "pull-merge", "wks_spm"),
  postReq("slow: rebase past 15 s still answers", "rebase", "wks_srb", { onto: "main" }),
  postReq("slow: merge past 15 s still answers", "merge", "wks_smg", { name: "main" }),
  postReq("slow: the push fallback's rev-parse killed at 15 s", "remote", "wks_srev", { op: "push" }),
  postReq("slow: the push fallback's rev-parse at 10 s still answers", "remote", "wks_srevm", { op: "push" }),
  postReq("slow: the push fallback's git remote killed at 15 s", "remote", "wks_srem", { op: "push" }),
  postReq("slow: the push fallback's git remote at 10 s still answers", "remote", "wks_sremm", { op: "push" }),
  postReq("slow: the conflict list killed at 15 s", "pull-merge", "wks_slc"),
  postReq("slow: the conflict list at 10 s still answers", "pull-merge", "wks_slcm"),
  req("slow: config --get killed at 15 s", "GET", "remote-host", "wks_scfg"),
  req("slow: config --get at 10 s still answers", "GET", "remote-host", "wks_scfgm"),
  postReq("slow: the repo root read killed at 15 s", "merge", "wks_sroot", { name: "main" }),
  req("slow: gh killed at 6 s", "GET", "pr-status", "wks_sgh"),
  req("slow: gh at 3 s still answers", "GET", "pr-status", "wks_sghm"),
]);
DIR("fakemarks");
for (const s of ["spull", "spushu", "spm", "srb", "srev", "srevm", "sremm"]) STATE(`repos/${s}`);
for (const s of ["spushu", "srevm", "sremm"]) STATE(`repos/${s}-origin.git`);

// -- the cache expires after 30 s --
WAIT("c02", 32_000);
G(PRR, "switch", "-q", "c02");
GHM("out", J({ number: 21, state: "OPEN", title: "after the cache" }));
P("after 30 s: gh runs again");

// -- a workspaces.json that doesn't parse: getWorkspace throws --
WS([], "{ not json");
MERGE("broken store", "wks_mg", { name: "feat" });
REBASE("broken store", "wks_rb", "null");
PULL("broken store", "wks_pm");
REMOTE("broken store", "wks_rm", { op: "fetch" });
H("broken store", "wks_hosts");
P("broken store", "wks_pr");
H("broken store, a customization still answers", "cust_a");
G(`${CUST_ROOT}/cust_a/src`, "switch", "-q", "-c", "late");
GHM("out", J({ iid: 22 }), "src", "glab");
P("broken store, a customization still answers", "cust_a");
DIR("fakemarks");

// The server's own cwd, where an empty rootPath runs git (`cwd: ""` is no cwd).
mkdirSync(join(ROOT, "servercwd"), { recursive: true });
process.chdir(join(ROOT, "servercwd"));
const steps = [];
for (const step of S) {
  if (step.op === "req") step.got = await request(step);
  else if (step.op === "par") await parallel(step);
  else if (step.op === "wait") {
    const left = marks[step.since] + step.ms - Date.now();
    if (left > 0) await new Promise((r) => setTimeout(r, left));
  } else exec(step);
  steps.push(step);
}

const gitVersion = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout.trim();
const fixture = {
  gitVersion,
  env: ENV,
  fakeGit: FAKE_GIT,
  fakeGh: FAKE_GH,
  sysTools: SYS_TOOLS,
  stateCmds: STATE_CMDS,
  hosts,
  badges,
  steps,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
const reqs = steps.flatMap((s) => (s.op === "req" ? [s] : s.op === "par" ? s.reqs : []));
console.log(
  `wrote ${out.slice(repo.length + 1)}: ${hosts.length} hosts, ${badges.length} badges; ${steps.length} steps (${reqs.length} requests, ${steps.filter((s) => s.op === "state").length} states) on ${gitVersion}`,
);
process.exit(0);

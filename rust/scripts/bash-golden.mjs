#!/usr/bin/env node
// Golden fixture for `!` bash mode (S10), recorded from the TS sources.
//
//   node rust/scripts/bash-golden.mjs     (node@22: session.ts needs
//                                          better-sqlite3, which bun can't load)
//
// Re-runs itself under `--experimental-transform-types` with HOME at a temp
// dir and a resolve hook for the extensionless / `@/` imports. Records:
//
// - `scenarios`: `BashSession` (lib/server/bash-mode.ts) driven step by step
//   on one shell each, with a fixed env. Steps: ["start", label, command,
//   timeoutMs?] (no await), ["await", label, withinMs] (its result, or
//   "pending"), ["exec", label, command, timeoutMs?] (start + await),
//   ["sleep", ms], ["dispose"], ["gone", label, fromLabel, withinMs] (poll
//   `kill -0` on the pids that `fromLabel`'s stdout printed until they are
//   all gone or the time is up: {gone, pids}). `$TMP` stands for the
//   shell's cwd, and an output over 1000 chars is summarized as
//   {len, head, tail}.
// - `route`: the real `POST /api/sessions/:id/bash` handler, in order on one
//   live session (a bare `Session` whose `runBashCommand` is the real one,
//   on a real shell), with a fake `sudo` first on PATH that prints its args
//   and, after `-S`, the password line it reads. Each case: the HTTP status
//   and body ("threw" when the handler threw: Next's empty 500), with a
//   random uuid shown as "<uuid>". Then every broadcast event, and what the
//   next prompt would carry (`takePendingBashBlocks`).
//
// Written to rust/crates/claudius-core/tests/fixtures/bash_golden.json and
// replayed by crates/claudius-core/tests/bash_golden.rs (scenarios) and
// crates/claudius-server/tests/bash.rs (route).
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/bash_golden.json");
// What the fake `sudo` prints; the Rust replay writes the same script.
const FAKE_SUDO = `#!/bin/sh\nprintf 'sudo[%s]' "$*"\nif [ "$1" = "-S" ]; then IFS= read -r pw; printf ' pw[%s]' "$pw"; fi\n`;

if (!process.env.BASH_GOLDEN_CHILD) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "bash-golden-")));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "sudo"), FAKE_SUDO);
  chmodSync(join(bin, "sudo"), 0o755);
  const r = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
    {
      stdio: "inherit",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, BASH_GOLDEN_CHILD: "1" },
    },
  );
  rmSync(home, { recursive: true, force: true });
  process.exit(r.status ?? 1);
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
}
export async function load(url, ctx, next) {
  if (url.endsWith(".json")) {
    return next(url, { ...ctx, importAttributes: { ...ctx.importAttributes, type: "json" } });
  }
  return next(url, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const { BashSession } = await import(join(repo, "lib/server/bash-mode.ts"));
const { takePendingBashBlocks } = await import(join(repo, "lib/server/pending-bash-output.ts"));
const { Session } = await import(join(repo, "lib/server/session.ts"));
const { sessionManager } = await import(join(repo, "lib/server/session-manager.ts"));
const { POST } = await import(join(repo, "app/api/sessions/[id]/bash/route.ts"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ─────────────────────────────── scenarios ───────────────────────────────

const LONG = "head -c 16777300 /dev/zero | tr '\\0' a";
const SCENARIOS = [
  ["basics", "tmp", [
    ["exec", "echo", "echo hi"],
    ["exec", "blank_lines", "printf 'a\\n\\n'"],
    ["exec", "no_newline", "printf 'no newline'"],
    ["exec", "only_newlines", "printf '\\n\\n'"],
    ["exec", "stderr", "echo err >&2"],
    ["exec", "both", "echo out; echo err >&2; (exit 3)"],
    ["exec", "false", "false"],
    ["exec", "cd", "mkdir -p sub && cd sub && pwd"],
    ["exec", "pwd", "pwd"],
    ["exec", "export", "export FOO=bar"],
    ["exec", "env", "echo \"$FOO\""],
    ["exec", "fn_def", "f() { echo fn:$1; }"],
    ["exec", "fn_call", "f x"],
    ["exec", "invalid_utf8", "printf '\\xff\\xfeA'"],
    ["exec", "cut_utf8", "printf 'caf\\xc3'"],
    ["exec", "unicode", "printf 'é😀'"],
    ["exec", "crlf", "printf 'a\\r\\nb\\r\\n'"],
    ["exec", "multiline", "echo a\necho b"],
    ["exec", "continuation", "echo a \\"],
    ["exec", "read_eats_wrapper", "read x; echo got:$x"],
    ["exec", "after_read", "echo next"],
    ["exec", "not_found", "nosuchcommand_zz"],
    ["exec", "dollar0", "echo $0"],
  ]],
  ["exit", "tmp", [
    ["exec", "cd", "mkdir -p d && cd d && echo in"],
    ["exec", "exit", "echo bye; exit 3"],
    ["exec", "fresh", "pwd"],
  ]],
  ["killed", "tmp", [
    ["exec", "kill9", "echo partial; echo err >&2; kill -9 $$"],
    ["exec", "fresh", "echo back"],
  ]],
  ["timeout", "tmp", [
    ["exec", "sleep", "sleep 5", 300],
    ["exec", "respawned", "echo alive"],
    ["exec", "open_quote", "echo \"abc", 400],
    ["exec", "after_quote", "echo ok"],
  ]],
  ["queue", "tmp", [
    ["start", "a", "sleep 0.3; echo a"],
    ["start", "b", "echo b"],
    ["start", "c", "echo c >&2"],
    ["await", "a", 5000],
    ["await", "b", 5000],
    ["await", "c", 5000],
  ]],
  ["stray", "tmp", [
    ["exec", "bg", "(sleep 0.3; echo late; echo late2 >&2) &"],
    ["sleep", 800],
    ["exec", "now", "echo now"],
  ]],
  // `close` doesn't drain the queue: b waits for the next command.
  ["exit_stalls_queue", "tmp", [
    ["start", "a", "exit 3"],
    ["start", "b", "echo queued"],
    ["await", "a", 5000],
    ["await", "b", 600],
    ["exec", "c", "echo trigger"],
    ["await", "b", 5000],
  ]],
  ["dispose", "tmp", [
    ["start", "a", "sleep 2"],
    ["start", "b", "echo queued"],
    ["sleep", 300],
    ["dispose"],
    ["await", "a", 1500],
    ["await", "b", 800],
    ["exec", "after", "echo after"],
  ]],
  // CC 2.1.300: the timeout SIGTERMs the group, then SIGKILLs the survivors
  // 1.5 s later, so a background job that ignores TERM cannot outlive it.
  // (`trap '' TERM` in a subshell is inherited by its children, so the
  // `sleep`s ignore TERM too.)
  ["kill_escalation", "tmp", [
    ["exec", "bg", "(trap '' TERM; while :; do /bin/sleep 1; done) >/dev/null 2>&1 & echo $!; /bin/sleep 30", 300],
    ["gone", "bg_gone", "bg", 6000],
    ["exec", "after", "echo alive"],
  ]],
  // The same escalation on dispose (session end).
  ["dispose_escalation", "tmp", [
    ["exec", "bg", "(trap '' TERM; while :; do /bin/sleep 1; done) >/dev/null 2>&1 & echo $!"],
    ["dispose"],
    ["gone", "bg_gone", "bg", 6000],
  ]],
  ["missing_cwd", "missing", [
    ["exec", "first", "echo hi"],
    ["exec", "again", "echo again"],
  ]],
  ["truncation", "tmp", [
    ["exec", "long", LONG, 4000],
    ["exec", "after", "echo after"],
  ]],
];

const summarize = (s) => (s.length > 1000 ? { len: s.length, head: s.slice(0, 20), tail: s.slice(-20) } : s);

/** `kill -0`: a live process (a reaped child is gone, a zombie is not). */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll the pids `fromLabel`'s stdout printed until none is alive or
 * `withinMs` is up. Without the SIGKILL escalation a TERM-ignoring job
 * stays alive and this records `gone: false`. The pids themselves are
 * nondeterministic, so the source result's stdout is rewritten to
 * `<pid>` once they have been read (the Rust replay does the same).
 */
async function gone(results, fromLabel, withinMs) {
  const src = results.find((r) => r.label === fromLabel);
  if (!src || src.result === "pending") throw new Error(`gone: no result for ${fromLabel}`);
  const pids = String(src.result.stdout).trim().split(/\s+/).map(Number);
  if (!pids.length || pids.some((p) => !Number.isInteger(p) || p <= 1)) throw new Error(`gone: bad pids ${pids}`);
  src.result.stdout = String(src.result.stdout).replace(/\d+/g, "<pid>");
  const t0 = Date.now();
  while (pids.some(alive) && Date.now() - t0 < withinMs) await sleep(50);
  return { gone: !pids.some(alive), pids: pids.length };
}

async function scenario([, where, steps], root) {
  const base = realpathSync(mkdtempSync(join(root, "s-")));
  const cwd = where === "missing" ? join(base, "missing") : base;
  const norm = (s) => summarize(s.split(base).join("$TMP"));
  const bash = new BashSession(cwd, { PATH: "/usr/bin:/bin", HOME: base });
  const started = {};
  const results = [];
  const record = (label, r) =>
    results.push({ label, result: r === "pending" ? r : { ...r, stdout: norm(r.stdout), stderr: norm(r.stderr) } });
  for (const [op, a, b, c] of steps) {
    if (op === "start") started[a] = bash.exec(b, c ? { timeoutMs: c } : undefined);
    else if (op === "await") record(a, await Promise.race([started[a], sleep(b).then(() => "pending")]));
    else if (op === "exec") record(a, await bash.exec(b, c ? { timeoutMs: c } : undefined));
    else if (op === "sleep") await sleep(a);
    else if (op === "dispose") bash.dispose();
    else if (op === "gone") results.push({ label: a, result: await gone(results, b, c) });
    else throw new Error(`unknown step ${op}`);
  }
  bash.dispose();
  return results;
}

// ───────────────────────────────── route ─────────────────────────────────

const ROUTE_BODIES = [
  "",
  "{",
  "null",
  "[]",
  '"echo hi"',
  '{"command":5}',
  '{"command":""}',
  '{"command":" \\t\\n"}',
  '{"command":"\\u00a0\\ufeff"}',
  '{"command":"a\\u0000b"}',
  '{"command":" \\u0000"}',
  '{"command":"\\u0085"}',
  '{"command":"echo hi","uuid":"u-1"}',
  '{"command":"printf out; printf err >&2","uuid":"u-2"}',
  '{"command":"echo hi"}',
  '{"command":"echo hi","uuid":null}',
  '{"command":"echo hi","uuid":5}',
  '{"command":"echo hi","uuid":{"a":[1]}}',
  '{"command":"sudo ls","sudoPassword":"pw","uuid":"u-3a-b"}',
  '{"command":"  sudo ls","sudoPassword":"pw","uuid":"u-4"}',
  '{"command":"\\u00a0sudo ls","sudoPassword":"pw","uuid":"u-5"}',
  '{"command":"\\u0085sudo ls","sudoPassword":"pw","uuid":"u-6"}',
  '{"command":"sudoers","sudoPassword":"pw","uuid":"u-7"}',
  '{"command":"echo sudo","sudoPassword":"pw","uuid":"u-8"}',
  '{"command":"sudo a && sudo b","sudoPassword":"pw","uuid":"u-9"}',
  '{"command":"sudo id","sudoPassword":"pw","uuid":5}',
  '{"command":"sudo a; sudo b","sudoPassword":"pw","uuid":5}',
  '{"command":"sudo id","sudoPassword":"","uuid":"u-12"}',
  '{"command":"sudo id","sudoPassword":5,"uuid":"u-13"}',
  '{"command":"echo multi\\necho line","uuid":"u-14"}',
  '{"command":"sudo -n true","sudoPassword":"p\'w\\"$x","uuid":"u-15"}',
  '{"command":"sudo cat","sudoPassword":"line1\\nline2","uuid":"u-16"}',
  '{"command":"SUDO ls","sudoPassword":"pw","uuid":"u-17"}',
  '{"command":"cd /tmp && echo moved","uuid":"u-18"}',
  '{"command":"pwd","uuid":"u-19"}',
  '{"command":"export FOO=bar","uuid":"u-20"}',
  '{"command":"echo $FOO","uuid":"u-21"}',
  '{"command":"(exit 7)","uuid":"u-22"}',
];

async function route(root) {
  const cwd = realpathSync(mkdtempSync(join(root, "route-")));
  const host = Object.create(Session.prototype);
  host.id = "golden-session";
  host.cwd = cwd;
  const events = [];
  host.broadcast = (ev) => events.push(ev);
  sessionManager.get = (id) => (id === host.id ? host : undefined);
  const call = async (id, body) => {
    try {
      const res = await POST(new Request("http://x/api", { method: "POST", body }), { params: Promise.resolve({ id }) });
      const json = await res.json();
      if (typeof json.uuid === "string" && UUID_RE.test(json.uuid) && !body.includes(json.uuid)) json.uuid = "<uuid>";
      return { status: res.status, body: json };
    } catch (e) {
      return { threw: e instanceof Error ? e.message : String(e) };
    }
  };
  const cases = [{ id: "missing", body: '{"command":"echo hi"}', got: await call("missing", '{"command":"echo hi"}') }];
  for (const body of ROUTE_BODIES) cases.push({ id: "live", body, got: await call(host.id, body) });
  for (const ev of events) {
    if (typeof ev.message?.uuid === "string" && UUID_RE.test(ev.message.uuid)) ev.message.uuid = "<uuid>";
  }
  const pending = takePendingBashBlocks(host);
  const { dropBashSession } = await import(join(repo, "lib/server/bash-mode.ts"));
  dropBashSession(host.id);
  return { sessionId: host.id, cases, events, pending };
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "bash-golden-run-")));
try {
  const scenarios = [];
  for (const s of SCENARIOS) {
    const results = await scenario(s, root);
    scenarios.push({ name: s[0], cwd: s[1], steps: s[2], results });
    console.log(
      `${s[0]}: ${results
        .map((r) => `${r.label}=${r.result === "pending" ? "pending" : (r.result.gone ?? r.result.exitCode)}`)
        .join(" ")}`,
    );
  }
  const routeOut = await route(root);
  console.log(`route: ${routeOut.cases.length} cases, ${routeOut.events.length} events`);
  writeFileSync(out, `${JSON.stringify({ fakeSudo: FAKE_SUDO, scenarios, route: routeOut }, null, 2)}\n`);
  console.log(`wrote ${out.slice(repo.length + 1)}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

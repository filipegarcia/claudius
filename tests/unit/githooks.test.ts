import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";

/**
 * Guardrails for the git hook recovery harness.
 *
 * Why this exists: git GUIs launch hooks with a stripped PATH that doesn't
 * include `~/.bun/bin` or `/opt/homebrew/bin`. We solved it once by adding
 * `.githooks/_runtime.sh` and sourcing it from each hook. The failure mode
 * we're guarding against now is "a future hook gets added and someone
 * forgets the source line" — the new hook fails on bun/npm fallback in
 * GUIs and we'd silently regress for every contributor running off a
 * non-terminal commit flow.
 *
 * Pure file-content asserts so the test stays fast and doesn't depend on
 * which runtime the CI runner happens to ship.
 */

const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const HOOKS_DIR = join(REPO_ROOT, ".githooks");

const RUNTIME_FILENAME = "_runtime.sh";
const README_FILENAME = "README.md";
// Anything starting with `_` is an internal helper. Anything matching this
// list (or the runtime/readme) is exempt from the "must source _runtime.sh"
// check. README is plain markdown; the runtime is what gets sourced.
const NON_HOOK_FILES = new Set<string>([RUNTIME_FILENAME, README_FILENAME]);

function listHooks(): string[] {
  return readdirSync(HOOKS_DIR)
    .filter((name) => {
      if (name.startsWith(".")) return false;
      if (NON_HOOK_FILES.has(name)) return false;
      const stat = statSync(join(HOOKS_DIR, name));
      return stat.isFile();
    })
    .sort();
}

describe(".githooks resilience", () => {
  test("every hook sources _runtime.sh before doing real work", () => {
    const hooks = listHooks();
    expect(hooks.length).toBeGreaterThan(0); // sanity — at least pre-commit + pre-push
    const missing: string[] = [];
    for (const name of hooks) {
      const body = readFileSync(join(HOOKS_DIR, name), "utf8");
      // The exact line we expect, modulo whitespace. Tolerant of leading
      // indentation and `_runtime.sh` vs absolute path — both forms work.
      const ok = /\.\s+["'$].*?_runtime\.sh["'$ ]/.test(body);
      if (!ok) missing.push(name);
    }
    expect(missing, `hooks missing the \`. _runtime.sh\` source line: ${missing.join(", ")}`).toEqual([]);
  });

  test("_runtime.sh sets RUN + RUN_DIRECT for callers", () => {
    const runtime = readFileSync(join(HOOKS_DIR, RUNTIME_FILENAME), "utf8");
    // Both vars must be assigned in every branch. Plain string-presence
    // checks because the assignment patterns are stable.
    expect(runtime).toMatch(/RUN=/);
    expect(runtime).toMatch(/RUN_DIRECT=/);
    // And the fallback error path must exit so callers don't crash on
    // unset $RUN later.
    expect(runtime).toMatch(/exit 1/);
  });

  test("every hook + the runtime parses as POSIX sh", () => {
    const candidates = [RUNTIME_FILENAME, ...listHooks()];
    for (const name of candidates) {
      const path = join(HOOKS_DIR, name);
      // `sh -n` parses without executing. Throws on syntax error; quiet
      // on success. We don't capture stdout because sh -n is silent on
      // success.
      expect(() => execFileSync("/bin/sh", ["-n", path])).not.toThrow();
    }
  });
});

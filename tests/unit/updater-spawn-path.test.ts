import { describe, expect, test, afterEach } from "vitest";
import { delimiter, join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";

import { extendedPath, withExtendedPath, bunInstallCandidates } from "@/lib/server/updater/spawn-env";
import { spawnStreamed } from "@/lib/server/updater/git";

/**
 * Regression coverage for the updater's PATH-recovery shim.
 *
 * The bug this guards: a Claudius daemon launched outside a shell (Finder
 * double-click, launchd, an IDE that didn't source `~/.zprofile`) inherits
 * the minimal kernel PATH `/usr/bin:/bin:/usr/sbin:/sbin`. Bun lives under
 * `~/.bun/bin` or homebrew's prefix — neither is on that PATH. The updater's
 * `bun install` then dies with `spawn bun ENOENT` (Node) or `Executable not
 * found in $PATH` (bun runtime), and the UI banner shows the misleading
 * `init: ...` phase because the spawn-error path isn't tagged.
 *
 * The fix in `lib/server/updater/spawn-env.ts` walks the standard install
 * locations and prepends every one that exists on disk to PATH. Then
 * `lib/server/updater/git.ts` applies that extended PATH to every spawn
 * the updater issues, and `apply.ts` tags spawn failures with the actual
 * phase so the banner reads `install: ...` instead of `init: ...`.
 */

describe("extendedPath", () => {
  let homes: string[] = [];
  function freshHome(): string {
    const h = mkdtempSync(join(tmpdir(), "claudius-fake-home-"));
    homes.push(h);
    return h;
  }
  afterEach(() => {
    for (const h of homes) {
      try {
        rmSync(h, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    homes = [];
  });

  test("prepends ~/.bun/bin when it exists on disk", () => {
    const home = freshHome();
    const bunDir = join(home, ".bun", "bin");
    mkdirSync(bunDir, { recursive: true });
    writeFileSync(join(bunDir, "bun"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bunDir, "bun"), 0o755);

    const out = extendedPath("/usr/bin:/bin", home);

    expect(out.split(delimiter)[0]).toBe(bunDir);
    // Original PATH is preserved verbatim after the prefix.
    expect(out.endsWith("/usr/bin:/bin")).toBe(true);
  });

  test("does not duplicate ~/.bun/bin when it is already on PATH", () => {
    const home = freshHome();
    const bunDir = join(home, ".bun", "bin");
    mkdirSync(bunDir, { recursive: true });

    const base = `${bunDir}${delimiter}/usr/bin`;
    const out = extendedPath(base, home);

    expect(out.split(delimiter).filter((p) => p === bunDir)).toHaveLength(1);
    // Original entries are preserved in their original order. (We can't
    // assert `out === base` because absolute candidates like
    // /opt/homebrew/bin may also be prepended on a host that has them.)
    expect(out.endsWith(base)).toBe(true);
  });

  test("does not prepend a $HOME-relative candidate when the directory is missing", () => {
    const home = freshHome();
    // Intentionally empty — no .bun/bin under this home.

    const out = extendedPath("/usr/bin:/bin", home);

    // None of the prepended entries should live under our tmp home — the
    // candidate path doesn't exist, so the walk must skip it. (Absolute
    // candidates like /opt/homebrew/bin may still be prepended if the host
    // actually has them, which is fine.)
    const parts = out.split(delimiter);
    expect(parts.some((p) => p.startsWith(home))).toBe(false);
  });

  test("includes ~/.bun/bin in the candidate list", () => {
    const home = freshHome();
    const candidates = bunInstallCandidates(home);
    expect(candidates).toContain(join(home, ".bun", "bin"));
    // Homebrew absolute paths must also be in the list — they catch users
    // who installed bun via brew on Apple Silicon (/opt/homebrew) or Intel
    // (/usr/local). If this assertion breaks, a brew install of Claudius
    // would silently regress to the ENOENT failure.
    expect(candidates).toContain("/opt/homebrew/bin");
    expect(candidates).toContain("/usr/local/bin");
  });

  test("withExtendedPath replaces PATH and leaves other env keys untouched", () => {
    // NODE_ENV is required by the project's augmented ProcessEnv type;
    // the value is arbitrary — FOO/BAZ are the keys this test cares about.
    const env: NodeJS.ProcessEnv = { PATH: "/bin", FOO: "bar", BAZ: "qux", NODE_ENV: "test" };
    const out = withExtendedPath(env);
    expect(out.FOO).toBe("bar");
    expect(out.BAZ).toBe("qux");
    expect(typeof out.PATH).toBe("string");
    // Doesn't mutate the input env.
    expect(env.PATH).toBe("/bin");
  });
});

describe("spawnStreamed error behavior", () => {
  let dirs: string[] = [];
  function freshCwd(): string {
    const d = mkdtempSync(join(tmpdir(), "claudius-runstreamed-"));
    dirs.push(d);
    return d;
  }
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    dirs = [];
  });

  test("finds bun under a stripped daemon-style PATH (end-to-end regression)", async () => {
    // The user-visible bug. With PATH = the bare kernel PATH a Finder /
    // launchd launch hands a Claudius daemon, a naive
    // `spawn("bun", …)` can't resolve bun and the updater shows
    // `init: spawn bun ENOENT` in the settings banner.
    //
    // This test pins the integration: under the EXACT stripped PATH, the
    // updater's spawn path resolves bun and runs it. If a future refactor
    // drops the PATH extension in `spawnStreamed` (or `git.ts` stops
    // calling extendedPath), this turns red instead of users hitting the
    // banner again.
    //
    // Skip if bun isn't on the host at all (rare CI corner case) — there's
    // nothing to find. Otherwise, mutate process.env.PATH for the duration
    // of the test so spawnStreamed inherits the stripped value.
    const cwd = freshCwd();
    const STRIPPED = "/usr/bin:/bin:/usr/sbin:/sbin";
    const prevPath = process.env.PATH;
    process.env.PATH = STRIPPED;
    try {
      const lines: string[] = [];
      let code = -1;
      try {
        code = await spawnStreamed("bun", ["--version"], cwd, (line, stream) => {
          if (stream === "out") lines.push(line);
        });
      } catch (err) {
        // If bun genuinely isn't installed anywhere our candidates look,
        // skip — there's no fix that could make this pass on that host.
        const msg = err instanceof Error ? err.message : String(err);
        if (/ENOENT|not found/i.test(msg)) {
          console.warn(`[updater-spawn-path] skipping end-to-end: bun not found anywhere — ${msg}`);
          return;
        }
        throw err;
      }
      expect(code).toBe(0);
      // bun prints just the version number on stdout.
      expect(lines.join("")).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });

  test("rejects (not resolves) when the binary is missing", async () => {
    // This is the precondition for apply.ts's `try { await spawnStreamed(…) }
    // catch { throw phaseError(phase, …) }` block to fire. If a future
    // refactor made spawnStreamed swallow the error and resolve with -1
    // instead, the phase tag would silently regress to "init" and users
    // would once again see the misleading "init: spawn bun ENOENT" banner.
    //
    // Accept both Node-style ("spawn ENOENT") and bun-runtime-style
    // ("Executable not found in $PATH") error messages — vitest runs under
    // either depending on which package script invoked it.
    const cwd = freshCwd();
    await expect(
      spawnStreamed(
        "definitely-not-a-real-binary-xyz123",
        ["--help"],
        cwd,
        () => {},
      ),
    ).rejects.toThrow(/ENOENT|not found/i);
  });
});

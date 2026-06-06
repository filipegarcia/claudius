import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BashSession } from "@/lib/server/bash-mode";

/**
 * Persistent-bash integration test. Spawns a REAL bash subprocess at a
 * scratch cwd and exercises the sentinel protocol end-to-end. We don't
 * mock spawn — the protocol is the whole point and a mock would just
 * test the mock.
 *
 * Skipped on platforms that don't ship bash at /bin/bash (Windows).
 * macOS + every Linux distro ships it, so CI is covered.
 */

const HAVE_BASH = process.platform !== "win32";
const d = HAVE_BASH ? describe : describe.skip;

d("BashSession", () => {
  let scratch: string;
  let bash: BashSession;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "claudius-bash-test-"));
    bash = new BashSession(scratch);
  });

  afterEach(() => {
    bash.dispose();
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  test("runs a simple command and returns stdout + exit 0", async () => {
    const r = await bash.exec("echo hi");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hi");
    expect(r.stderr).toBe("");
    expect(r.timedOut).toBe(false);
  });

  test("captures stderr and a non-zero exit code", async () => {
    // `(exit 3)` runs in a subshell — the persistent bash captures the
    // exit code in $? without dying. A bare `exit 3` would kill the
    // shell (documented gotcha; the next `!cmd` would respawn).
    const r = await bash.exec("echo oops 1>&2; (exit 3)");
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("oops");
  });

  test("cd persists across commands (the whole point of persistent bash)", async () => {
    await bash.exec(`cd "${scratch}"`);
    const r = await bash.exec("pwd");
    expect(r.stdout.trim()).toBe(scratch);
  });

  test("env exports persist across commands", async () => {
    await bash.exec("export CLAUDIUS_TEST_VAR=marker");
    const r = await bash.exec("echo $CLAUDIUS_TEST_VAR");
    expect(r.stdout.trim()).toBe("marker");
  });

  test("serialises concurrent execs (no sentinel cross-talk)", async () => {
    const [a, b] = await Promise.all([
      bash.exec("echo first"),
      bash.exec("echo second"),
    ]);
    // FIFO: first call's promise resolves first. Both finished.
    expect(a.stdout).toContain("first");
    expect(b.stdout).toContain("second");
    // Sentinels stripped — no leak of `__CLAUDIUS_BASH_END_…__` into either.
    expect(a.stdout).not.toContain("__CLAUDIUS_BASH_END_");
    expect(b.stdout).not.toContain("__CLAUDIUS_BASH_END_");
  });

  test("timeout kills the shell and reports timedOut", async () => {
    const r = await bash.exec("sleep 5", { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);
  });

  test("respawns after a timeout — next command runs cleanly", async () => {
    await bash.exec("sleep 5", { timeoutMs: 200 });
    // After timeout, the next exec should respawn bash and succeed. The
    // env from before is GONE (new process) — by design; persistence is
    // a best-effort comfort, timeouts are a hard reset.
    const r = await bash.exec("echo alive");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("alive");
  });

  test("heredoc wrapper isolates a password from bash's own stdin reader", async () => {
    // The sudo flow (Session.runBashCommand) injects the password through
    // a per-call heredoc inside the command, NOT via the raw `stdin` opt
    // (bash itself consumes the stdin buffer between commands, so a raw
    // write isn't safe for secrets). This test mirrors the heredoc shape
    // — `cat <<DELIM\nsecret\nDELIM` — and asserts the body reaches the
    // command's stdin without being eaten by bash.
    const r = await bash.exec("cat <<'__DELIM__'\nsecret\n__DELIM__");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("secret");
  });
});

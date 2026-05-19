import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execShellCommand } from "@/lib/server/shell";

/**
 * Unit tests for the shell-exec helper that powers the /git page console
 * prompt. Each test spawns a real `bash -c` child — none of this is
 * mockable in any meaningful way because the whole point is the
 * stdout/stderr/exit/signal/cwd behaviour of an actual subprocess.
 *
 * Kept fast (each command exits in a few ms; the slowest test is the
 * timeout one at ~120 ms) so the suite stays under a second total.
 */
describe("execShellCommand", () => {
  test("captures stdout and returns exitCode 0 on success", async () => {
    const r = await execShellCommand(tmpdir(), "echo hello");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trimEnd()).toBe("hello");
    expect(r.stderr).toBe("");
    expect(r.signal).toBeNull();
    expect(r.truncated).toBe(false);
  });

  test("captures stderr without polluting stdout", async () => {
    const r = await execShellCommand(tmpdir(), "echo good; echo bad >&2");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trimEnd()).toBe("good");
    expect(r.stderr.trimEnd()).toBe("bad");
  });

  test("propagates a non-zero exit code", async () => {
    const r = await execShellCommand(tmpdir(), "false");
    expect(r.exitCode).toBe(1);
    expect(r.signal).toBeNull();
  });

  test("supports shell features (pipes, chaining, env expansion)", async () => {
    // All three would fail under an execFile-with-tokens implementation —
    // the test pins the contract that we ARE running through a real shell.
    const r = await execShellCommand(
      tmpdir(),
      "echo apple banana cherry | tr ' ' '\\n' | wc -l",
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("3");

    const chain = await execShellCommand(tmpdir(), "echo a && echo b");
    expect(chain.stdout.trimEnd()).toBe("a\nb");

    const envExpand = await execShellCommand(tmpdir(), "echo $HOME");
    // $HOME should expand to *something* (not the literal "$HOME"). We
    // don't pin the value because CI / dev environments differ.
    expect(envExpand.stdout.trim()).not.toBe("$HOME");
    expect(envExpand.stdout.trim().length).toBeGreaterThan(0);
  });

  test("runs in the supplied cwd", async () => {
    // Drop a sentinel file into a fresh tmpdir and read it back via the
    // child — directly proves "cwd was honored" without depending on
    // `$PWD` / `pwd` symlink-resolution quirks (macOS resolves /var to
    // /private/var, which made the obvious comparison fail).
    const cwd = mkdtempSync(join(tmpdir(), "shell-exec-cwd-"));
    try {
      writeFileSync(join(cwd, "marker"), "in-this-cwd");
      const r = await execShellCommand(cwd, "cat marker");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("in-this-cwd");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("times out long-running commands with SIGTERM, preserving prior output", async () => {
    // The command prints a line, then sleeps past the deadline. We expect
    // the early line to land in stdout AND signal === 'SIGTERM' so the UI
    // can tell "timeout" apart from a normal non-zero exit.
    const r = await execShellCommand(
      tmpdir(),
      "echo before-sleep; sleep 5",
      { timeoutMs: 150 },
    );
    expect(r.stdout.trimEnd()).toBe("before-sleep");
    expect(r.signal).toBe("SIGTERM");
    // exitCode is -1 (or null in Node, which we coerce) when a signal
    // killed the child. Asserting "not 0" is sufficient and version-stable.
    expect(r.exitCode).not.toBe(0);
  });

  test("truncates output past maxOutputBytes and reports it", async () => {
    // Generate exactly 50 bytes of stdout but cap at 16 — bash's `printf`
    // with a repeat spec is the most concise way to produce a known-size
    // payload without shelling out to dd / yes.
    const r = await execShellCommand(
      tmpdir(),
      "printf '%.0sa' {1..50}",
      { maxOutputBytes: 16 },
    );
    expect(r.exitCode).toBe(0);
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(16);
    // The remaining 34 'a's were dropped on the floor; the prefix we did
    // keep must still be all 'a's.
    expect(r.stdout).toMatch(/^a+$/);
  });

  test("error path: tokenized argv from input doesn't become a separate command", async () => {
    // Sanity check that bash -c treats the input as a single command
    // string, not a tokenized argv (otherwise `;` would not separate).
    // This is also the behaviour the security comment in shell.ts pins —
    // pipes / semicolons / redirects must be interpreted, not literal.
    const r = await execShellCommand(tmpdir(), "echo first; echo second");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trimEnd()).toBe("first\nsecond");
  });
});

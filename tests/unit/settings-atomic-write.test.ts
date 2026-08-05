/**
 * `writeSettings` durability contract.
 *
 * CI's e2e run hit a real `SyntaxError: Unexpected end of JSON input` out of
 * `readSettings()`: a GET /api/settings raced a concurrent PUT and read the
 * file inside `fs.writeFile`'s truncate-then-write window. The fix writes a
 * sibling temp file and `rename`s it into place, so a reader only ever sees
 * the fully-old or the fully-new file.
 *
 * The race itself is timing-dependent and makes for a flaky assertion, so
 * these pin the *mechanism* instead — the observable properties that only
 * hold if the rename path is intact:
 *
 *   1. The destination's inode changes on every write. That is the whole
 *      guarantee: a live reader's already-open handle keeps pointing at the
 *      complete old file, and the new content becomes visible in one step.
 *      A plain `fs.writeFile` reuses the inode and truncates it in place —
 *      exactly the window that produced the CI failure.
 *   2. No temp files are left behind in the user's `.claude` dir, including
 *      after a burst of concurrent writers (which would collide if temp
 *      names weren't unique per write).
 *   3. `rename` swaps the inode, so an existing file's mode has to be
 *      carried over explicitly — settings.json can hold `apiKeyHelper` /
 *      `env` secrets, and silently widening 0600 → 0644 would be a real
 *      (if quiet) regression.
 */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { readSettings, writeSettings } from "@/lib/server/settings";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "claudius-settings-atomic-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const settingsPath = () => join(cwd, ".claude", "settings.json");

describe("writeSettings", () => {
  test("creates the .claude dir and round-trips through readSettings", async () => {
    await writeSettings("project", cwd, { model: "claude-opus-5" });
    expect(await readSettings("project", cwd)).toEqual({ model: "claude-opus-5" });
  });

  test("replaces the file via rename rather than truncating it in place", async () => {
    await writeSettings("project", cwd, { model: "a" });
    const first = statSync(settingsPath()).ino;

    await writeSettings("project", cwd, { model: "b" });
    const second = statSync(settingsPath()).ino;

    // Same inode ⇒ the destination was opened with O_TRUNC and rewritten in
    // place, which is the torn-read window this function exists to avoid.
    expect(second).not.toBe(first);
    expect(await readSettings("project", cwd)).toEqual({ model: "b" });
  });

  test("leaves no temp files behind, even under concurrent writers", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => writeSettings("project", cwd, { model: `m-${i}` })),
    );
    expect(readdirSync(join(cwd, ".claude"))).toEqual(["settings.json"]);
    // Each concurrent write must have had its own temp file — two writers
    // sharing one temp name would interleave into a corrupt document.
    expect(() => JSON.parse(readFileSync(settingsPath(), "utf8"))).not.toThrow();
  });

  test("writes through a symlinked settings.json instead of replacing the link", async () => {
    // `~/.claude/settings.json` symlinked into a dotfiles repo is a common
    // setup; rename would sever it and the user's dotfiles would silently
    // stop tracking their settings.
    const real = join(cwd, "dotfiles-settings.json");
    writeFileSync(real, "{}\n");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    symlinkSync(real, settingsPath());

    await writeSettings("project", cwd, { model: "via-symlink" });

    expect(lstatSync(settingsPath()).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({ model: "via-symlink" });
    expect(await readSettings("project", cwd)).toEqual({ model: "via-symlink" });
  });

  test("preserves the mode of an existing settings.json across the rename", async () => {
    await writeSettings("project", cwd, { model: "a" });
    chmodSync(settingsPath(), 0o600);

    await writeSettings("project", cwd, { model: "b" });

    expect(statSync(settingsPath()).mode & 0o777).toBe(0o600);
    expect(await readSettings("project", cwd)).toEqual({ model: "b" });
  });
});

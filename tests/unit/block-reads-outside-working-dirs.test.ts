/**
 * CC 2.1.257 parity — "Added a one-time prompt in auto mode before the
 * first file read outside the working directories, with the option to
 * block such reads (permissions.blockReadsOutsideWorkingDirectories)".
 *
 * Claudius has no one-time-prompt equivalent (auto mode's classifier is
 * server-side, inside the SDK), so this exercises the plain settings
 * round-trip instead: `updatePermissions` patching the new
 * `blockReadsOutsideWorkingDirectories` boolean onto `PermissionRules`,
 * per scope — same tmpdir-as-HOME approach as `auto-mode-settings.test.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { readSettings, updatePermissions } from "@/lib/server/settings";

let home: string;
let cwd: string;
let originalHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claudius-block-reads-home-"));
  cwd = mkdtempSync(join(tmpdir(), "claudius-block-reads-project-"));
  originalHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("updatePermissions — blockReadsOutsideWorkingDirectories", () => {
  test("round-trips true through project scope", async () => {
    await updatePermissions("project", cwd, { blockReadsOutsideWorkingDirectories: true });
    const settings = await readSettings("project", cwd);
    expect(settings.permissions?.blockReadsOutsideWorkingDirectories).toBe(true);
  });

  test("defaults to unset (undefined), not false, when never patched", async () => {
    const settings = await readSettings("project", cwd);
    expect(settings.permissions?.blockReadsOutsideWorkingDirectories).toBeUndefined();
  });

  test("is independent per scope — enabling in local doesn't touch user or project", async () => {
    await updatePermissions("local", cwd, { blockReadsOutsideWorkingDirectories: true });
    expect((await readSettings("local", cwd)).permissions?.blockReadsOutsideWorkingDirectories).toBe(true);
    expect((await readSettings("project", cwd)).permissions?.blockReadsOutsideWorkingDirectories).toBeUndefined();
    expect((await readSettings("user", cwd)).permissions?.blockReadsOutsideWorkingDirectories).toBeUndefined();
  });

  test("can be flipped back off without disturbing sibling permission fields", async () => {
    await updatePermissions("project", cwd, { allow: ["Bash"], blockReadsOutsideWorkingDirectories: true });
    await updatePermissions("project", cwd, { blockReadsOutsideWorkingDirectories: false });
    const settings = await readSettings("project", cwd);
    expect(settings.permissions?.blockReadsOutsideWorkingDirectories).toBe(false);
    expect(settings.permissions?.allow).toEqual(["Bash"]);
  });
});

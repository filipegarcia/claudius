/**
 * SDK 0.3.314 — `permissions.blockWritesOutsideWorkingDirectories`, the
 * write-side twin of `blockReadsOutsideWorkingDirectories`. Exercises the
 * plain settings round-trip: `updatePermissions` patching the boolean per
 * scope, independent of the reads flag and of allow/ask/deny rules.
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
  home = mkdtempSync(join(tmpdir(), "claudius-block-writes-home-"));
  cwd = mkdtempSync(join(tmpdir(), "claudius-block-writes-project-"));
  originalHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("updatePermissions — blockWritesOutsideWorkingDirectories", () => {
  test("round-trips true through project scope", async () => {
    await updatePermissions("project", cwd, { blockWritesOutsideWorkingDirectories: true });
    const settings = await readSettings("project", cwd);
    expect(settings.permissions?.blockWritesOutsideWorkingDirectories).toBe(true);
  });

  test("is scoped: local write does not leak into project/user", async () => {
    await updatePermissions("local", cwd, { blockWritesOutsideWorkingDirectories: true });
    expect((await readSettings("local", cwd)).permissions?.blockWritesOutsideWorkingDirectories).toBe(true);
    expect((await readSettings("project", cwd)).permissions?.blockWritesOutsideWorkingDirectories).toBeUndefined();
    expect((await readSettings("user", cwd)).permissions?.blockWritesOutsideWorkingDirectories).toBeUndefined();
  });

  test("is independent of the reads flag and preserves rules", async () => {
    await updatePermissions("project", cwd, {
      allow: ["Bash"],
      blockReadsOutsideWorkingDirectories: true,
    });
    await updatePermissions("project", cwd, { blockWritesOutsideWorkingDirectories: true });
    await updatePermissions("project", cwd, { blockWritesOutsideWorkingDirectories: false });
    const p = (await readSettings("project", cwd)).permissions;
    expect(p?.allow).toEqual(["Bash"]);
    expect(p?.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(p?.blockWritesOutsideWorkingDirectories).toBe(false);
  });
});

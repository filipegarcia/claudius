/**
 * CC 2.1.246 parity — "Added an Auto mode tab to /permissions for viewing
 * and editing auto mode classifier rules". `updateAutoMode` is the
 * server-side half: it patches the `autoMode.{environment,allow,soft_deny,
 * hard_deny}` block, always against the "user" scope (`~/.claude/settings.json`)
 * regardless of the `projectCwd` passed in — upstream never reads `autoMode`
 * from project or project-local settings, so there's no scope parameter to
 * accept in the first place. Mirrors `settings-atomic-write.test.ts`'s
 * tmpdir-as-HOME approach.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { readSettings, updateAutoMode, writeSettings } from "@/lib/server/settings";

let home: string;
let cwd: string;
let originalHome: string | undefined;

beforeEach(() => {
  // Separate directories for HOME and the "project" cwd — `pathFor("user", …)`
  // ignores its `projectCwd` argument entirely and always resolves via
  // `homedir()`, so reusing one tmpdir for both would make "user" and
  // "project" scope collide on the same file and defeat the very isolation
  // these tests check for.
  home = mkdtempSync(join(tmpdir(), "claudius-auto-mode-home-"));
  cwd = mkdtempSync(join(tmpdir(), "claudius-auto-mode-project-"));
  originalHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("updateAutoMode", () => {
  test("writes to the user scope regardless of the projectCwd argument", async () => {
    await updateAutoMode(cwd, { environment: ["$defaults", "Org: Acme"] });
    expect(await readSettings("user", cwd)).toEqual({
      autoMode: { environment: ["$defaults", "Org: Acme"] },
    });
    // Never touches project/local scope.
    expect(await readSettings("project", cwd)).toEqual({});
    expect(await readSettings("local", cwd)).toEqual({});
  });

  test("merges into an existing autoMode block instead of replacing it", async () => {
    await updateAutoMode(cwd, { environment: ["$defaults"] });
    await updateAutoMode(cwd, { allow: ["$defaults", "Deploy to staging"] });
    expect((await readSettings("user", cwd)).autoMode).toEqual({
      environment: ["$defaults"],
      allow: ["$defaults", "Deploy to staging"],
    });
  });

  test("a later patch overwrites only the section it names", async () => {
    await updateAutoMode(cwd, { soft_deny: ["$defaults", "Never force-push"] });
    await updateAutoMode(cwd, { soft_deny: [] });
    expect((await readSettings("user", cwd)).autoMode?.soft_deny).toEqual([]);
  });

  test("round-trips other ClaudeSettings keys untouched", async () => {
    await writeSettings("user", cwd, { model: "claude-opus-5", disableAutoMode: "disable" });
    await updateAutoMode(cwd, { hard_deny: ["$defaults"] });
    expect(await readSettings("user", cwd)).toEqual({
      model: "claude-opus-5",
      disableAutoMode: "disable",
      autoMode: { hard_deny: ["$defaults"] },
    });
  });
});

/**
 * CC 2.1.280 parity — "[VSCode] Added each skill's source, token estimate
 * and on/off state to the Slash commands dialog, with a click to change the
 * state". `updateSkillOverride` is the server-side half of Claudius's
 * `/skills` overlay toggle: it patches the SDK's `Settings.skillOverrides`
 * key (kept verbatim so the engine reads it natively — see the doc comment
 * on `ClaudeSettings.skillOverrides`), always against `"project"` scope
 * (`.claude/settings.json`), same reasoning as `enabledPlugins`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  isSkillOverrideValue,
  readSettings,
  updateSkillOverride,
  writeSettings,
} from "@/lib/server/settings";

let home: string;
let cwd: string;
let originalHome: string | undefined;

beforeEach(() => {
  // `pathFor("user", …)` always resolves via `homedir()` regardless of the
  // `projectCwd` argument — without overriding HOME, "user" scope reads the
  // developer machine's real `~/.claude/settings.json`. Same isolation
  // `auto-mode-settings.test.ts` uses.
  home = mkdtempSync(join(tmpdir(), "claudius-skill-overrides-home-"));
  cwd = mkdtempSync(join(tmpdir(), "claudius-skill-overrides-project-"));
  originalHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("isSkillOverrideValue", () => {
  test("accepts the SDK's four literals", () => {
    expect(isSkillOverrideValue("on")).toBe(true);
    expect(isSkillOverrideValue("name-only")).toBe(true);
    expect(isSkillOverrideValue("user-invocable-only")).toBe(true);
    expect(isSkillOverrideValue("off")).toBe(true);
  });

  test("rejects anything else", () => {
    expect(isSkillOverrideValue("On")).toBe(false);
    expect(isSkillOverrideValue("disabled")).toBe(false);
    expect(isSkillOverrideValue(undefined)).toBe(false);
    expect(isSkillOverrideValue(null)).toBe(false);
    expect(isSkillOverrideValue(1)).toBe(false);
  });
});

describe("updateSkillOverride", () => {
  test("writes to project scope only, never user or local", async () => {
    await updateSkillOverride(cwd, "pdf-fill", "off");
    expect(await readSettings("project", cwd)).toEqual({
      skillOverrides: { "pdf-fill": "off" },
    });
    expect(await readSettings("user", cwd)).toEqual({});
    expect(await readSettings("local", cwd)).toEqual({});
  });

  test("setting a name to 'on' deletes its entry rather than storing 'on'", async () => {
    await updateSkillOverride(cwd, "pdf-fill", "off");
    await updateSkillOverride(cwd, "pdf-fill", "on");
    expect((await readSettings("project", cwd)).skillOverrides).toBeUndefined();
  });

  test("dropping the last override removes the skillOverrides key entirely", async () => {
    await updateSkillOverride(cwd, "pdf-fill", "off");
    await updateSkillOverride(cwd, "pdf-fill", "on");
    const settings = await readSettings("project", cwd);
    expect("skillOverrides" in settings).toBe(false);
  });

  test("merges into existing overrides instead of replacing the whole map", async () => {
    await updateSkillOverride(cwd, "pdf-fill", "off");
    await updateSkillOverride(cwd, "code-review", "name-only");
    expect((await readSettings("project", cwd)).skillOverrides).toEqual({
      "pdf-fill": "off",
      "code-review": "name-only",
    });
  });

  test("round-trips other ClaudeSettings keys untouched", async () => {
    await writeSettings("project", cwd, { model: "claude-opus-5" });
    await updateSkillOverride(cwd, "pdf-fill", "user-invocable-only");
    expect(await readSettings("project", cwd)).toEqual({
      model: "claude-opus-5",
      skillOverrides: { "pdf-fill": "user-invocable-only" },
    });
  });
});

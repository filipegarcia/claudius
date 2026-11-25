import { describe, expect, test } from "vitest";

import {
  settingOverriddenBy,
  settingOverrideNote,
  USER_SCOPE_WINS_SETTING_KEYS,
} from "@/lib/shared/setting-override";

/** CC 2.1.327 — "Added a note in /config when other settings override a row". */
const PATHS = {
  user: "/Users/me/.claude/settings.json",
  project: "/Users/me/project/.claude/settings.json",
  local: "/Users/me/project/.claude/settings.local.json",
};
const scopes = (user: object, project: object, local: object) => [
  { scope: "user" as const, path: PATHS.user, settings: user },
  { scope: "project" as const, path: PATHS.project, settings: project },
  { scope: "local" as const, path: PATHS.local, settings: local },
];

describe("settingOverriddenBy", () => {
  test("a higher scope that sets the same scalar key wins", () => {
    const s = scopes({ model: "opus" }, { model: "sonnet" }, {});
    expect(settingOverriddenBy("model", "user", s)).toEqual({ scope: "project", path: PATHS.project });
  });

  test("the highest scope that sets it is the one named", () => {
    const s = scopes({ model: "opus" }, { model: "sonnet" }, { model: "haiku" });
    expect(settingOverriddenBy("model", "user", s)).toEqual({ scope: "local", path: PATHS.local });
    expect(settingOverriddenBy("model", "project", s)).toEqual({ scope: "local", path: PATHS.local });
  });

  test("lower scopes never override, and local is never overridden", () => {
    const s = scopes({ model: "opus" }, { model: "sonnet" }, { model: "haiku" });
    expect(settingOverriddenBy("model", "local", s)).toBeNull();
    expect(settingOverriddenBy("model", "project", scopes({ model: "opus" }, { model: "sonnet" }, {}))).toBeNull();
  });

  test("applies even when the viewed tab leaves the key unset", () => {
    expect(settingOverriddenBy("theme", "user", scopes({}, { theme: "dark" }, {}))).toEqual({
      scope: "project",
      path: PATHS.project,
    });
  });

  test("booleans, numbers and empty strings count; null and missing don't", () => {
    expect(settingOverriddenBy("autoMemoryEnabled", "user", scopes({}, { autoMemoryEnabled: false }, {}))?.scope).toBe("project");
    expect(settingOverriddenBy("cleanupPeriodDays", "user", scopes({}, {}, { cleanupPeriodDays: 0 }))?.scope).toBe("local");
    expect(settingOverriddenBy("attributionProject", "user", scopes({}, { attributionProject: "" }, {}))?.scope).toBe("project");
    expect(settingOverriddenBy("model", "user", scopes({ model: "opus" }, { model: null }, {}))).toBeNull();
    expect(settingOverriddenBy("model", "user", scopes({ model: "opus" }, {}, {}))).toBeNull();
  });

  test("object and list values merge across scopes, so they're never overridden", () => {
    const s = scopes(
      { claudeMdExcludes: ["a"], statusLine: { command: "a" } },
      { claudeMdExcludes: ["b"], statusLine: { command: "b" } },
      {},
    );
    expect(settingOverriddenBy("claudeMdExcludes", "user", s)).toBeNull();
    expect(settingOverriddenBy("statusLine", "user", s)).toBeNull();
  });

  test("permissions, env, hooks and enabledPlugins are never overridden", () => {
    for (const key of ["permissions", "env", "hooks", "enabledPlugins"]) {
      expect(settingOverriddenBy(key, "user", scopes({}, { [key]: "x" }, {}))).toBeNull();
    }
  });

  test("keys session.ts forwards from user scope at the flag layer are skipped", () => {
    for (const key of ["includeCoAuthoredBy", "advisorModel", "workflowSizeGuideline", "crossSessionInbound"]) {
      expect(USER_SCOPE_WINS_SETTING_KEYS.has(key)).toBe(true);
      expect(settingOverriddenBy(key, "user", scopes({ [key]: "a" }, { [key]: "b" }, {}))).toBeNull();
    }
  });

  test("keys Claudius reads from the user file only are skipped", () => {
    for (const key of ["feedbackSurveyRate", "sessionRecapEnabled"]) {
      expect(USER_SCOPE_WINS_SETTING_KEYS.has(key)).toBe(true);
    }
    expect(settingOverriddenBy("feedbackSurveyRate", "user", scopes({ feedbackSurveyRate: 0.1 }, { feedbackSurveyRate: 0 }, {}))).toBeNull();
    expect(settingOverriddenBy("sessionRecapEnabled", "user", scopes({}, { sessionRecapEnabled: false }, {}))).toBeNull();
  });

  test("managed-settings-only keys are skipped (no settings file applies)", () => {
    expect(
      settingOverriddenBy("forceLoginGatewayUrl", "user", scopes({}, { forceLoginGatewayUrl: "https://gw.example.com" }, {})),
    ).toBeNull();
  });

  test("a scope missing from the payload is ignored", () => {
    expect(settingOverriddenBy("model", "user", [{ scope: "user", path: PATHS.user, settings: { model: "opus" } }])).toBeNull();
  });
});

describe("settingOverrideNote", () => {
  test("names the scope and the file from .claude/ on, without the word 'overridden'", () => {
    const note = settingOverrideNote({ scope: "project", path: PATHS.project });
    expect(note).toBe("Project (.claude/settings.json) takes precedence");
    expect(note.toLowerCase()).not.toContain("overridden");
    expect(settingOverrideNote({ scope: "local", path: PATHS.local })).toBe("Local (.claude/settings.local.json) takes precedence");
    expect(settingOverrideNote({ scope: "local", path: "C:\\p\\.claude\\settings.local.json" })).toBe(
      "Local (.claude\\settings.local.json) takes precedence",
    );
  });
});

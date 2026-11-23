import { describe, expect, test } from "vitest";
import { enabledPluginState, VERSION_LIST_NOT_ENABLED_MESSAGE, versionListNote } from "@/lib/shared/enabled-plugin-value";

/**
 * CC 2.1.323 — "Fixed plugins with a version list in enabledPlugins staying
 * off with no message". Only `true` turns a marketplace plugin on; a version
 * list leaves it off, and the plugins page now says why.
 */
describe("enabledPluginState (CC 2.1.323)", () => {
  test("true is on; a version list is off with a reason", () => {
    expect(enabledPluginState(true)).toBe("on");
    expect(enabledPluginState(["1.2.0"])).toBe("version-list");
    expect(enabledPluginState([])).toBe("version-list");
  });

  test("false / missing / other scalars are off", () => {
    for (const v of [false, undefined, null, 0, 1, "true"]) {
      expect(enabledPluginState(v), String(v)).toBe("off");
    }
  });

  test("an object value is off — the engine loads only an entry that is exactly true", () => {
    expect(enabledPluginState({ channel: "beta" })).toBe("off");
  });

  test("the reason is the engine's wording", () => {
    expect(VERSION_LIST_NOT_ENABLED_MESSAGE).toBe(
      "Not enabled because its enabledPlugins entry is a version list. Only the value true turns on a marketplace plugin.",
    );
  });
});

describe("versionListNote (CC 2.1.323)", () => {
  test("no version list → no note", () => {
    expect(versionListNote([], ["user"], "user")).toBeNull();
  });

  test("the fix is on this tab only when this scope holds the list", () => {
    expect(versionListNote(["user"], [], "user")).toEqual({ scopes: ["user"], fixHere: true });
    expect(versionListNote(["user"], [], "project")).toEqual({ scopes: ["user"], fixHere: false });
  });

  test("true in a higher-precedence scope wins, so the plugin loads and there is no note", () => {
    expect(versionListNote(["user"], ["project"], "user")).toBeNull();
    expect(versionListNote(["project"], ["local"], "project")).toBeNull();
  });

  test("a version list in a higher-precedence scope overrides a lower true", () => {
    expect(versionListNote(["local"], ["user"], "user")).toEqual({ scopes: ["local"], fixHere: false });
  });
});

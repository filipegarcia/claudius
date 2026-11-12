import { describe, expect, test } from "vitest";
import { enabledPluginState, VERSION_LIST_NOT_ENABLED_MESSAGE } from "@/lib/shared/enabled-plugin-value";

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

  test("an object value keeps its pre-2.1.323 reading (on) — the engine gives no reason for it", () => {
    expect(enabledPluginState({ channel: "beta" })).toBe("on");
  });

  test("the reason is the engine's wording", () => {
    expect(VERSION_LIST_NOT_ENABLED_MESSAGE).toBe(
      "Not enabled because its enabledPlugins entry is a version list. Only the value true turns on a marketplace plugin.",
    );
  });
});

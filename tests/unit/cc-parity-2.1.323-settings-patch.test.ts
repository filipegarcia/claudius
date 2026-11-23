import { describe, expect, test } from "vitest";
import {
  applyRuleDelta,
  applySettingsPatch,
  diffSettings,
  isEmptyPatch,
  parseSettingsPatch,
} from "@/lib/shared/settings-patch";

/**
 * CC 2.1.323 — "Fixed a setting saved in a running session undoing a hand
 * edit made to settings.json moments earlier". The Settings page sends only
 * the keys the user changed; the server merges them into a fresh read.
 */
describe("diffSettings / applySettingsPatch", () => {
  test("a save keeps a key hand-edited on disk after the page loaded", () => {
    const baseline = { model: "opus", theme: "dark", env: { A: "1" } };
    const draft = { ...baseline, theme: "light" }; // the user changed only theme
    const patch = diffSettings(baseline, draft);
    expect(patch).toEqual({ set: { theme: "light" }, unset: [] });
    // Meanwhile the file was hand-edited: model changed, a key was added.
    const onDisk = { model: "sonnet", theme: "dark", env: { A: "1" }, verbose: true };
    expect(applySettingsPatch(onDisk, patch)).toEqual({ model: "sonnet", theme: "light", env: { A: "1" }, verbose: true });
  });

  test("a removed key is unset; an untouched key the file no longer has stays gone", () => {
    const baseline = { model: "opus", outputStyle: "Explanatory" };
    const draft = { model: "opus" };
    const patch = diffSettings(baseline, draft);
    expect(patch).toEqual({ set: {}, unset: ["outputStyle"] });
    // The user deleted `model` by hand: Save must not bring it back.
    expect(applySettingsPatch({ outputStyle: "Explanatory" }, patch)).toEqual({});
  });

  test("nested objects compare by value; undefined counts as removed", () => {
    expect(isEmptyPatch(diffSettings({ env: { A: "1" } }, { env: { A: "1" } }))).toBe(true);
    expect(diffSettings({ env: { A: "1" } }, { env: { A: "2" } })).toEqual({ set: { env: { A: "2" } }, unset: [] });
    expect(diffSettings({ a: 1 }, { a: undefined })).toEqual({ set: {}, unset: ["a"] });
  });

  test("prototype-polluting keys are ignored", () => {
    const out = applySettingsPatch({}, { set: JSON.parse('{"__proto__": {"x": 1}, "ok": 2}'), unset: [] });
    expect(out).toEqual({ ok: 2 });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe("parseSettingsPatch", () => {
  test("accepts set/unset and rejects bad shapes", () => {
    expect(parseSettingsPatch({ set: { a: 1 }, unset: ["b"] })).toEqual({ set: { a: 1 }, unset: ["b"] });
    expect(parseSettingsPatch({ set: { a: 1 } })).toEqual({ set: { a: 1 }, unset: [] });
    for (const bad of [null, [], "x", { set: [] }, { unset: [1] }, { unset: "a" }]) {
      expect(parseSettingsPatch(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("applyRuleDelta (/permissions add/remove)", () => {
  test("keeps a rule hand-added to the file since the page loaded", () => {
    expect(applyRuleDelta(["Bash(ls)", "Read(**)"], { add: ["Bash(git status)"] })).toEqual([
      "Bash(ls)",
      "Read(**)",
      "Bash(git status)",
    ]);
    expect(applyRuleDelta(["Bash(ls)", "Read(**)"], { remove: ["Bash(ls)"] })).toEqual(["Read(**)"]);
    expect(applyRuleDelta(undefined, { add: ["A", "A"] })).toEqual(["A"]);
    expect(applyRuleDelta(["A"], { add: ["A"] })).toEqual(["A"]);
  });
});

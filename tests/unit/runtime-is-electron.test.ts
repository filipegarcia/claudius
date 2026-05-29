/**
 * Unit coverage for the universal `isElectron()` / `isWeb()` flag
 * (`lib/shared/runtime.ts`).
 *
 * Vitest runs in plain Node, so both realms are reachable by mutating
 * `globalThis.window` (renderer branch) and `process.env` (Node branch),
 * the same technique `use-electron.test.ts` uses.
 */
import { afterEach, describe, expect, test } from "vitest";

import { isElectron, isWeb } from "@/lib/shared/runtime";

type MutableGlobal = { window?: { claudius?: unknown } | undefined };

function setWindow(value: MutableGlobal["window"]) {
  (globalThis as unknown as MutableGlobal).window = value;
}
function clearWindow() {
  delete (globalThis as unknown as MutableGlobal).window;
}

afterEach(() => {
  clearWindow();
  delete process.env.CLAUDIUS_ELECTRON;
});

describe("isElectron — renderer realm", () => {
  test("true when window.claudius.isElectron is set", () => {
    setWindow({ claudius: { isElectron: true } });
    expect(isElectron()).toBe(true);
    expect(isWeb()).toBe(false);
  });

  test("false in a plain browser tab (no bridge)", () => {
    setWindow({});
    expect(isElectron()).toBe(false);
    expect(isWeb()).toBe(true);
  });

  test("renderer branch ignores the server env flag", () => {
    // window present (renderer) wins even if the env flag is somehow set.
    setWindow({});
    process.env.CLAUDIUS_ELECTRON = "1";
    expect(isElectron()).toBe(false);
  });
});

describe("isElectron — Node realm", () => {
  test("true when CLAUDIUS_ELECTRON=1 and no window", () => {
    process.env.CLAUDIUS_ELECTRON = "1";
    expect(isElectron()).toBe(true);
  });

  test("false for the standalone web server (flag unset)", () => {
    expect(isElectron()).toBe(false);
    expect(isWeb()).toBe(true);
  });

  test("false for any value other than the literal \"1\"", () => {
    process.env.CLAUDIUS_ELECTRON = "true";
    expect(isElectron()).toBe(false);
  });
});

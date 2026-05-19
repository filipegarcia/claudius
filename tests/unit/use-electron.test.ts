/**
 * Phase 2 of docs/electron-conversion/PLAN.md.
 *
 * Vitest runs in plain Node, so `typeof window === "undefined"` is the
 * default. We exercise both branches of `readBridgeOnClient` by
 * mutating `globalThis.window` per test — keeps the suite free of
 * jsdom/happy-dom even though the function is "DOM-facing".
 */
import { afterEach, describe, expect, test } from "vitest";

import {
  readBridgeOnClient,
  readBridgeOnServer,
} from "@/lib/client/useElectron";

type MutableGlobal = {
  window?: { claudius?: unknown } | undefined;
};

function setWindow(value: MutableGlobal["window"]) {
  (globalThis as unknown as MutableGlobal).window = value;
}

function clearWindow() {
  delete (globalThis as unknown as MutableGlobal).window;
}

afterEach(() => {
  clearWindow();
});

describe("useElectron bridge detection", () => {
  test("readBridgeOnServer always returns null", () => {
    expect(readBridgeOnServer()).toBeNull();
  });

  test("returns null when window is missing (Node / SSR)", () => {
    // Vitest's Node environment guarantees window is undefined unless
    // a previous test set it; assert that, then call the reader.
    clearWindow();
    expect(readBridgeOnClient()).toBeNull();
  });

  test("returns null when window exists but window.claudius is undefined", () => {
    setWindow({});
    expect(readBridgeOnClient()).toBeNull();
  });

  test("returns the bridge when window.claudius is mounted", () => {
    const fakeBridge = {
      isElectron: true,
      platform: "darwin",
      bridgeVersion: 2,
      menu: { on: () => () => {} },
      window: {
        minimize: () => {},
        maximize: () => {},
        close: () => {},
        toggleFullscreen: () => {},
        toggleDevTools: () => {},
      },
      badge: { set: () => {} },
      notifications: { show: () => {}, onClick: () => () => {} },
      dialog: {
        openWorkspace: async () => null,
        openFile: async () => null,
      },
      deepLinks: { onOpen: () => () => {} },
      updater: {
        check: () => {},
        apply: () => {},
        onStatus: () => () => {},
      },
    };
    setWindow({ claudius: fakeBridge });
    const got = readBridgeOnClient();
    expect(got).toBe(fakeBridge);
  });
});

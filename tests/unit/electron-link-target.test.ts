/**
 * Pure-routing coverage for `electron/ipc/link-target.ts`.
 *
 * The actual `BrowserWindow` / `shell.openExternal` calls live in main.ts
 * and `electron/ipc/in-app-browser.ts` and can't be driven from vitest.
 * The branching logic — localhost carve-out vs external vs in-app — is in
 * the pure `resolveLinkAction` function tested here. If this is right and
 * the preload's `linkTarget.set` reaches the cached `currentTarget`, the
 * window-open handler does the right thing on every click.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}));

import {
  __resetLinkTargetForTest,
  getLinkTarget,
  isHttpUrl,
  isLocalhostHttpUrl,
  registerLinkTargetHandlers,
  resolveLinkAction,
  TOPIC_SET,
} from "@/electron/ipc/link-target";

afterEach(() => {
  __resetLinkTargetForTest();
  vi.clearAllMocks();
});

describe("resolveLinkAction", () => {
  test("loopback URLs ignore the preference and stay internal", () => {
    for (const url of [
      "http://127.0.0.1:3000/",
      "http://localhost:3000/api/sessions",
      "http://localhost/whatever",
      "http://[::1]:3000/",
    ]) {
      expect(resolveLinkAction(url, "external")).toBe("internal-allow");
      expect(resolveLinkAction(url, "in-app")).toBe("internal-allow");
    }
  });

  test("external https in 'external' mode → external (default)", () => {
    expect(resolveLinkAction("https://anthropic.com", "external")).toBe(
      "external",
    );
    expect(resolveLinkAction("http://example.com/path", "external")).toBe(
      "external",
    );
  });

  test("external https in 'in-app' mode → in-app", () => {
    expect(resolveLinkAction("https://anthropic.com", "in-app")).toBe("in-app");
    expect(resolveLinkAction("http://example.com", "in-app")).toBe("in-app");
  });

  test("non-http schemes always fall back to 'external' (OS handler)", () => {
    for (const url of [
      "mailto:hi@example.com",
      "claudius://session/abc",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "ftp://example.com",
    ]) {
      // No matter the preference, non-http never goes to the in-app viewer.
      expect(resolveLinkAction(url, "external")).toBe("external");
      expect(resolveLinkAction(url, "in-app")).toBe("external");
    }
  });

  test("malicious lookalikes do NOT match the localhost carve-out", () => {
    // Anchored at the start of the string — `?host=` / path tricks shouldn't
    // bypass the gate and hand the page our preload.
    expect(
      resolveLinkAction("http://attacker.example/?host=127.0.0.1", "external"),
    ).toBe("external");
    expect(
      resolveLinkAction("http://attacker.example/?host=127.0.0.1", "in-app"),
    ).toBe("in-app");
    expect(resolveLinkAction("https://localhost.example.com", "in-app")).toBe(
      "in-app",
    );
  });

  test("empty / non-string inputs → 'external' (safest fallback)", () => {
    expect(resolveLinkAction("", "external")).toBe("external");
    expect(resolveLinkAction("", "in-app")).toBe("external");
    // @ts-expect-error — deliberately passing wrong type to verify guard.
    expect(resolveLinkAction(null, "in-app")).toBe("external");
    // @ts-expect-error — deliberately passing wrong type to verify guard.
    expect(resolveLinkAction(undefined, "in-app")).toBe("external");
  });
});

describe("URL classifiers", () => {
  test("isLocalhostHttpUrl matches 127.0.0.1 / localhost / [::1]", () => {
    expect(isLocalhostHttpUrl("http://127.0.0.1")).toBe(true);
    expect(isLocalhostHttpUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isLocalhostHttpUrl("http://localhost")).toBe(true);
    expect(isLocalhostHttpUrl("http://localhost:3000/api")).toBe(true);
    expect(isLocalhostHttpUrl("http://[::1]:3000")).toBe(true);
    // https → false (Claudius only ever talks loopback over plain http)
    expect(isLocalhostHttpUrl("https://127.0.0.1")).toBe(false);
    expect(isLocalhostHttpUrl("https://localhost")).toBe(false);
    expect(isLocalhostHttpUrl("ftp://localhost")).toBe(false);
  });

  test("isHttpUrl matches only http(s) schemes", () => {
    expect(isHttpUrl("http://example.com")).toBe(true);
    expect(isHttpUrl("https://example.com")).toBe(true);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpUrl("mailto:x@example.com")).toBe(false);
    expect(isHttpUrl("claudius://x")).toBe(false);
  });
});

describe("registerLinkTargetHandlers + cached state", () => {
  test("starts at the conservative default ('external')", () => {
    expect(getLinkTarget()).toBe("external");
  });

  test("`link-target:set` updates the cache when the payload is valid", async () => {
    const electron = (await import("electron")) as unknown as {
      ipcMain: { on: ReturnType<typeof vi.fn> };
    };
    registerLinkTargetHandlers();
    const handler = electron.ipcMain.on.mock.calls.find(
      (c) => c[0] === TOPIC_SET,
    )?.[1] as (event: unknown, raw: unknown) => void;
    expect(typeof handler).toBe("function");

    handler({}, "in-app");
    expect(getLinkTarget()).toBe("in-app");
    handler({}, "external");
    expect(getLinkTarget()).toBe("external");
  });

  test("garbage payloads are ignored — cache doesn't change", async () => {
    const electron = (await import("electron")) as unknown as {
      ipcMain: { on: ReturnType<typeof vi.fn> };
    };
    registerLinkTargetHandlers();
    const handler = electron.ipcMain.on.mock.calls.find(
      (c) => c[0] === TOPIC_SET,
    )?.[1] as (event: unknown, raw: unknown) => void;

    handler({}, "in-app");
    expect(getLinkTarget()).toBe("in-app");

    // Each of these is invalid; cache must stay at the previous value.
    handler({}, "INVALID");
    handler({}, 42);
    handler({}, null);
    handler({}, undefined);
    handler({}, { kind: "external" });
    expect(getLinkTarget()).toBe("in-app");
  });
});

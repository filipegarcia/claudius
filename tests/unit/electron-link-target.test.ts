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
  isInternalAppUrl,
  isLocalhostHttpUrl,
  registerLinkTargetHandlers,
  resolveLinkAction,
  TOPIC_SET,
} from "@/electron/ipc/link-target";

/** Canonical app origin used by the dev pipeline and tests below. */
const APP_ORIGIN = "http://localhost:3000";

afterEach(() => {
  __resetLinkTargetForTest();
  vi.clearAllMocks();
});

describe("resolveLinkAction", () => {
  test("URLs at the app origin ignore the preference and stay internal", () => {
    for (const url of [
      "http://127.0.0.1:3000/",
      "http://localhost:3000/api/sessions",
      "http://[::1]:3000/",
    ]) {
      expect(resolveLinkAction(url, "external", APP_ORIGIN)).toBe(
        "internal-allow",
      );
      expect(resolveLinkAction(url, "in-app", APP_ORIGIN)).toBe(
        "internal-allow",
      );
    }
  });

  test("loopback URLs on a DIFFERENT port follow the preference (NOT internal)", () => {
    // Regression: the original `startsWith("http://localhost")` carve-out
    // matched any port. A user clicking a link to their own admin app on
    // `http://localhost:81` would short-circuit to a default child window
    // titled "Claudius" instead of opening in the in-app viewer / browser.
    const adminUrl = "http://localhost:81/admin";
    expect(resolveLinkAction(adminUrl, "external", APP_ORIGIN)).toBe(
      "external",
    );
    expect(resolveLinkAction(adminUrl, "in-app", APP_ORIGIN)).toBe("in-app");
    // Bare-host links (no port) also don't qualify — the embedded server
    // always binds an explicit port.
    expect(
      resolveLinkAction("http://localhost/whatever", "external", APP_ORIGIN),
    ).toBe("external");
    expect(
      resolveLinkAction("http://localhost/whatever", "in-app", APP_ORIGIN),
    ).toBe("in-app");
  });

  test("external https in 'external' mode → external (default)", () => {
    expect(
      resolveLinkAction("https://anthropic.com", "external", APP_ORIGIN),
    ).toBe("external");
    expect(
      resolveLinkAction("http://example.com/path", "external", APP_ORIGIN),
    ).toBe("external");
  });

  test("external https in 'in-app' mode → in-app", () => {
    expect(
      resolveLinkAction("https://anthropic.com", "in-app", APP_ORIGIN),
    ).toBe("in-app");
    expect(resolveLinkAction("http://example.com", "in-app", APP_ORIGIN)).toBe(
      "in-app",
    );
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
      expect(resolveLinkAction(url, "external", APP_ORIGIN)).toBe("external");
      expect(resolveLinkAction(url, "in-app", APP_ORIGIN)).toBe("external");
    }
  });

  test("malicious lookalikes do NOT match the internal carve-out", () => {
    // URL parsing (not `startsWith`) — `?host=` / path tricks shouldn't
    // bypass the gate and hand the page our preload.
    expect(
      resolveLinkAction(
        "http://attacker.example/?host=127.0.0.1",
        "external",
        APP_ORIGIN,
      ),
    ).toBe("external");
    expect(
      resolveLinkAction(
        "http://attacker.example/?host=127.0.0.1",
        "in-app",
        APP_ORIGIN,
      ),
    ).toBe("in-app");
    expect(
      resolveLinkAction("https://localhost.example.com", "in-app", APP_ORIGIN),
    ).toBe("in-app");
  });

  test("remote-backend origin: loopback links are NOT internal", () => {
    // When the app loads from a remote backend, a localhost link is a
    // link to the USER'S machine, not the app — never hand it the preload.
    const remoteOrigin = "https://devbox.example.com:8443";
    expect(
      resolveLinkAction(
        "http://localhost:3000/",
        "external",
        remoteOrigin,
      ),
    ).toBe("external");
    expect(
      resolveLinkAction("http://localhost:3000/", "in-app", remoteOrigin),
    ).toBe("in-app");
    // The remote origin itself stays internal regardless of preference.
    expect(
      resolveLinkAction(
        "https://devbox.example.com:8443/api/x",
        "external",
        remoteOrigin,
      ),
    ).toBe("internal-allow");
  });

  test("empty / non-string inputs → 'external' (safest fallback)", () => {
    expect(resolveLinkAction("", "external", APP_ORIGIN)).toBe("external");
    expect(resolveLinkAction("", "in-app", APP_ORIGIN)).toBe("external");
    // @ts-expect-error — deliberately passing wrong type to verify guard.
    expect(resolveLinkAction(null, "in-app", APP_ORIGIN)).toBe("external");
    // @ts-expect-error — deliberately passing wrong type to verify guard.
    expect(resolveLinkAction(undefined, "in-app", APP_ORIGIN)).toBe("external");
  });
});

describe("isInternalAppUrl", () => {
  test("exact-origin match", () => {
    expect(isInternalAppUrl("http://localhost:3000/foo", APP_ORIGIN)).toBe(
      true,
    );
    expect(isInternalAppUrl("http://localhost:3001/foo", APP_ORIGIN)).toBe(
      false,
    );
  });

  test("loopback hostname equivalence on the SAME port", () => {
    expect(isInternalAppUrl("http://127.0.0.1:3000/", APP_ORIGIN)).toBe(true);
    expect(isInternalAppUrl("http://[::1]:3000/", APP_ORIGIN)).toBe(true);
  });

  test("loopback hostname equivalence DOES NOT apply across ports", () => {
    expect(isInternalAppUrl("http://127.0.0.1:8080/", APP_ORIGIN)).toBe(false);
    expect(isInternalAppUrl("http://localhost:81/admin", APP_ORIGIN)).toBe(
      false,
    );
  });

  test("non-loopback hostname doesn't get the equivalence carve-out", () => {
    expect(
      isInternalAppUrl(
        "http://anything-else.example:3000/",
        APP_ORIGIN,
      ),
    ).toBe(false);
  });

  test("scheme mismatch is never internal", () => {
    expect(isInternalAppUrl("https://localhost:3000/", APP_ORIGIN)).toBe(false);
  });

  test("malformed URLs return false (never internal)", () => {
    expect(isInternalAppUrl("not a url", APP_ORIGIN)).toBe(false);
    expect(isInternalAppUrl("http://", APP_ORIGIN)).toBe(false);
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

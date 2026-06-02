import { describe, expect, test } from "vitest";

import { shouldDeliverOsNotification } from "@/lib/client/useNotifications";

/**
 * Pure-helper coverage for the OS-toast gate. The function is the seam that
 * decides whether `useNotifications.notify` should reach the Electron bridge
 * or the browser-side `new Notification(...)` constructor. The cases below
 * pin the platform asymmetry that produced the
 * "badge ticks but Notification Center stays empty" bug in the packaged
 * Electron build — if any of these flip, the corresponding regression is
 * back.
 */

const BASE = {
  enabled: true,
  state: "granted" as const,
  hasBridge: false,
  attending: false,
  isSameSession: false,
  isActionableKind: false,
};

describe("shouldDeliverOsNotification — master switch", () => {
  test("workspace `enabled = false` always blocks, both platforms", () => {
    expect(shouldDeliverOsNotification({ ...BASE, enabled: false })).toBe(false);
    expect(
      shouldDeliverOsNotification({ ...BASE, enabled: false, hasBridge: true }),
    ).toBe(false);
  });
});

describe("shouldDeliverOsNotification — web (no Electron bridge)", () => {
  test("requires browser permission === 'granted'", () => {
    expect(shouldDeliverOsNotification({ ...BASE, state: "granted" })).toBe(true);
    expect(shouldDeliverOsNotification({ ...BASE, state: "default" })).toBe(false);
    expect(shouldDeliverOsNotification({ ...BASE, state: "denied" })).toBe(false);
    expect(shouldDeliverOsNotification({ ...BASE, state: "unsupported" })).toBe(false);
  });
});

describe("shouldDeliverOsNotification — Electron bridge", () => {
  test("ignores browser `Notification.permission` because macOS gates on signing identity, not the renderer flag", () => {
    // This is the regression pin for the original bug. Inside Electron the
    // renderer's `Notification.permission` is often "default" (no
    // requestPermission() flow was ever run), but the main-process bridge
    // can still deliver because macOS authorises by app signature. Gating
    // on `state` here suppressed every toast and left the Notification
    // Center empty even though the dock badge ticked.
    for (const s of ["default", "granted", "denied", "unsupported"] as const) {
      expect(
        shouldDeliverOsNotification({ ...BASE, hasBridge: true, state: s }),
      ).toBe(true);
    }
  });
});

describe("shouldDeliverOsNotification — same-session foreground suppression", () => {
  test("suppresses non-actionable rows when the user is attending the asking session", () => {
    expect(
      shouldDeliverOsNotification({
        ...BASE,
        hasBridge: true,
        attending: true,
        isSameSession: true,
        isActionableKind: false,
      }),
    ).toBe(false);
  });

  test("permission/ask/plan still fires even when attending the asking session", () => {
    // Symmetric with the SSE auto-read gate's actionable carve-out — see
    // NotificationsProvider's sameSessionVisible block and ACTIONABLE_KINDS.
    expect(
      shouldDeliverOsNotification({
        ...BASE,
        hasBridge: true,
        attending: true,
        isSameSession: true,
        isActionableKind: true,
      }),
    ).toBe(true);
  });

  test("not attending → deliver regardless of session match", () => {
    expect(
      shouldDeliverOsNotification({
        ...BASE,
        hasBridge: true,
        attending: false,
        isSameSession: true,
      }),
    ).toBe(true);
  });

  test("different session → deliver", () => {
    expect(
      shouldDeliverOsNotification({
        ...BASE,
        hasBridge: true,
        attending: true,
        isSameSession: false,
      }),
    ).toBe(true);
  });
});

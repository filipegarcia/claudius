"use client";

/**
 * Electron auto-updater state for the renderer.
 *
 * Phase 7 of docs/electron-conversion/PLAN.md.
 *
 * Subscribes to `bridge.updater.onStatus(...)` and exposes the latest
 * `ClaudiusUpdaterStatus` plus `check()` / `apply()` invokers. Returns
 * `null` when not running inside Electron so consumers can fall back
 * to the existing git-pull updater.
 */
import { useCallback, useEffect, useState } from "react";

import { useClaudius, useElectronSubscription } from "./useElectron";
import type { ClaudiusUpdaterStatus } from "../shared/electron";

export type ElectronUpdaterState = {
  status: ClaudiusUpdaterStatus;
  check: () => void;
  apply: () => void;
  /**
   * Deep-link to macOS Privacy & Security → App Management so the user
   * can unblock self-replacement of the .app bundle. No-op when the
   * bridge is older than v7 (older packaged builds won't have the
   * IPC handler) or when the host platform isn't darwin.
   */
  openAppManagementSettings: () => void;
};

export function useElectronUpdater(): ElectronUpdaterState | null {
  const bridge = useClaudius();
  const [status, setStatus] = useState<ClaudiusUpdaterStatus>({ kind: "idle" });

  useElectronSubscription<ClaudiusUpdaterStatus>(
    bridge?.updater.onStatus,
    setStatus,
  );

  // On first mount inside Electron, fire a check so the user sees
  // up-to-date state without having to click "check now". The bridge
  // is a no-op in dev/unpackaged builds (the main-side handler short-
  // circuits to a normalized `idle` / `error`).
  useEffect(() => {
    if (!bridge) return;
    bridge.updater.check();
  }, [bridge]);

  const check = useCallback(() => bridge?.updater.check(), [bridge]);
  const apply = useCallback(() => bridge?.updater.apply(), [bridge]);
  // Guard with a runtime feature-detect — older packaged builds load a
  // preload that doesn't expose this method, and we don't want to crash
  // when the renderer ships ahead of the main process.
  const openAppManagementSettings = useCallback(
    () => bridge?.updater.openAppManagementSettings?.(),
    [bridge],
  );

  if (!bridge) return null;
  return { status, check, apply, openAppManagementSettings };
}

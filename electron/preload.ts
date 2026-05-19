/**
 * Preload script for the Claudius renderer.
 *
 * Phase 1: minimal preload that just exposes a feature-detection flag
 * (`window.claudius.isElectron`) so the React tree can branch on
 * "running inside Electron" without leaking any other API surface.
 *
 * Phase 2 will extend this with the full IPC bridge (menu, window,
 * badge, notifications, dialog, deepLinks, updater) following the
 * contract in `lib/shared/electron.d.ts`.
 */
import { contextBridge } from "electron";

const api = {
  isElectron: true as const,
  platform: process.platform as NodeJS.Platform,
  // Coarse version identifier so the renderer can branch on capability
  // tiers in the future. Bumped whenever the IPC surface changes.
  bridgeVersion: 1 as const,
};

contextBridge.exposeInMainWorld("claudius", api);

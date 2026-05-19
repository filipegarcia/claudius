"use client";

/**
 * Mounts cross-cut Electron event subscriptions (menu actions, dock
 * file drops) from the root layout. Renders nothing — exists only as
 * a client-component host for `useElectronGlobalActions()`.
 *
 * Phase 8 follow-up of docs/electron-conversion/PLAN.md.
 */
import { useElectronGlobalActions } from "@/lib/client/useElectronGlobalActions";

export function ElectronGlobalActions() {
  useElectronGlobalActions();
  return null;
}

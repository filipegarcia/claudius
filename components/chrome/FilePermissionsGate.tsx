"use client";

/**
 * First-launch host for the macOS file-permission priming modal.
 *
 * Mounted once from the root layout (alongside the other Electron
 * cross-cut hosts). On mount it asks the main process whether priming has
 * already run; if not — and we're on macOS in the desktop app — it shows
 * `FilePermissionsModal` so the user can front-load the TCC Files & Folders
 * prompts. No-op in the browser build and on non-macOS desktop builds.
 *
 * Show-once semantics: the moment the modal is shown we persist the "seen"
 * marker (in Electron `userData`, which survives reinstalls), so ANY
 * dismissal — Allow, Not now, or the close button — stops it auto-showing
 * again. It only reappears if the user explicitly re-opens it from
 * Settings → File permissions. macOS exposes no API to query whether
 * access is already granted (the only way to check is a read that itself
 * prompts), so we deliberately don't probe — we just never nag.
 */
import { useEffect, useState } from "react";
import { FilePermissionsModal } from "@/components/onboarding/FilePermissionsModal";
import { useClaudius } from "@/lib/client/useElectron";

export function FilePermissionsGate() {
  const bridge = useClaudius();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!bridge || bridge.platform !== "darwin") return;
    let cancelled = false;
    void bridge.permission
      .status()
      .then((s) => {
        if (cancelled || s.completed) return;
        // Persist the marker as soon as we decide to show it, so this is a
        // strict show-once: whatever the user does with the modal (or if
        // they just close the app), it won't auto-open on the next launch.
        void bridge.permission.markSeen().catch(() => {});
        setOpen(true);
      })
      .catch(() => {
        // Status check failed (older main process / IPC error) — stay quiet
        // rather than block first launch on a permissions popup.
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  if (!open) return null;
  return <FilePermissionsModal onClose={() => setOpen(false)} />;
}

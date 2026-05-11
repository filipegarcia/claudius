"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  NotificationClickBehavior,
  NotificationRow,
  WorkspaceNotificationPrefs,
} from "@/lib/shared/notifications";
import type { Workspace } from "@/lib/server/workspaces-store";

export type NotifyState = "default" | "granted" | "denied" | "unsupported";

/**
 * Legacy global flag. Kept readable for one boot so users coming from the
 * old code path don't lose their opt-in; once the value has been migrated
 * onto the active workspace's defaults we delete it. New writes go to the
 * workspace prefs via PATCH /api/workspaces/:id.
 */
const LEGACY_ENABLE_KEY = "claudius.notifications.enabled";
const LEGACY_MIGRATED_KEY = "claudius.notifications.migrated";

type Options = {
  /** Active workspace — drives per-workspace prefs lookup. */
  workspace: Workspace | null;
  /**
   * Callback invoked when a "jump" notification is clicked. The provider
   * passes the row's workspaceId + target so the router can navigate cross-
   * workspace if needed. Omit to fall back to plain `window.focus()`.
   */
  onJump?: (notification: NotificationRow) => void;
  /**
   * Active session id, for the visibility-gate suppression. We don't ping the
   * OS for the very session the user is currently watching in the foreground.
   */
  activeSessionId?: string | null;
};

export function useNotifications(opts: Options) {
  const { workspace, onJump, activeSessionId } = opts;
  const [state, setState] = useState<NotifyState>("unsupported");
  const visibleRef = useRef(true);
  const onJumpRef = useRef(onJump);
  onJumpRef.current = onJump;
  const activeSessionRef = useRef(activeSessionId ?? null);
  activeSessionRef.current = activeSessionId ?? null;

  // Permission state + visibility tracking.
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setState("unsupported");
      return;
    }
    setState(Notification.permission as NotifyState);
    function onVis() {
      visibleRef.current = !document.hidden;
    }
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // One-shot legacy migration: if the user had previously opted in via the
  // localStorage flag and the workspace has no notifications.enabled set,
  // promote that opt-in into the workspace prefs and clear the legacy key.
  useEffect(() => {
    if (!workspace) return;
    try {
      if (window.localStorage.getItem(LEGACY_MIGRATED_KEY) === "1") return;
      const flag = window.localStorage.getItem(LEGACY_ENABLE_KEY);
      if (flag !== "1") {
        window.localStorage.setItem(LEGACY_MIGRATED_KEY, "1");
        return;
      }
      if (workspace.defaults?.notifications?.enabled !== undefined) {
        window.localStorage.removeItem(LEGACY_ENABLE_KEY);
        window.localStorage.setItem(LEGACY_MIGRATED_KEY, "1");
        return;
      }
      const next: WorkspaceNotificationPrefs = {
        ...(workspace.defaults?.notifications ?? {}),
        enabled: true,
      };
      const defaults = { ...(workspace.defaults ?? {}), notifications: next };
      void fetch(`/api/workspaces/${workspace.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaults }),
      })
        .then(() => {
          window.localStorage.removeItem(LEGACY_ENABLE_KEY);
          window.localStorage.setItem(LEGACY_MIGRATED_KEY, "1");
        })
        .catch(() => {
          // Migration is best-effort; the user can still opt in via the UI.
        });
    } catch {
      // localStorage unavailable (private mode, etc) — no-op
    }
  }, [workspace]);

  const prefs = workspace?.defaults?.notifications;
  const enabled = !!prefs?.enabled;
  const onClick: NotificationClickBehavior = prefs?.onClick ?? "jump";

  const requestPermission = useCallback(async () => {
    if (typeof Notification === "undefined") return "unsupported" as const;
    const r = await Notification.requestPermission();
    setState(r as NotifyState);
    return r;
  }, []);

  /**
   * Persist a new value for `notifications.enabled` on the active workspace.
   * Requests permission if needed; on denial, returns false and leaves the
   * stored value unchanged.
   */
  const setEnabled = useCallback(
    async (next: boolean): Promise<boolean> => {
      if (!workspace) return false;
      if (next && state !== "granted") {
        const r = await requestPermission();
        if (r !== "granted") return false;
      }
      const nextPrefs: WorkspaceNotificationPrefs = {
        ...(workspace.defaults?.notifications ?? {}),
        enabled: next,
      };
      const defaults = { ...(workspace.defaults ?? {}), notifications: nextPrefs };
      const res = await fetch(`/api/workspaces/${workspace.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaults }),
      });
      return res.ok;
    },
    [workspace, state, requestPermission],
  );

  /**
   * Fire an OS notification for a persisted row. Honours the visibility
   * gate (skipped when the tab is foregrounded on the same session) and the
   * per-workspace click behaviour (`jump` vs `dismiss`).
   */
  const notify = useCallback(
    (row: NotificationRow) => {
      if (!enabled || state !== "granted") return;
      if (typeof Notification === "undefined") return;
      const sameSession =
        row.sessionId && activeSessionRef.current === row.sessionId;
      if (visibleRef.current && sameSession) return;
      try {
        const n = new Notification(row.title, {
          body: row.body ?? undefined,
          icon: "/icon.svg",
          tag: row.id,
        });
        n.onclick = () => {
          window.focus();
          n.close();
          if (onClick === "jump") onJumpRef.current?.(row);
        };
      } catch {
        // Some browsers throw on tag re-use or quota; we don't want to crash
        // the surrounding render
      }
    },
    [enabled, state, onClick],
  );

  return {
    state,
    enabled,
    onClick,
    setEnabled,
    requestPermission,
    notify,
  };
}

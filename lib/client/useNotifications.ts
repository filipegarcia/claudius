"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  isActionableKind,
  type NotificationClickBehavior,
  type NotificationRow,
  type WorkspaceNotificationPrefs,
} from "@/lib/shared/notifications";
import type { Workspace } from "@/lib/server/workspaces-store";

import { readBridgeOnClient } from "./useElectron";
import { useAttentionRef } from "./useAttentionRef";

export type NotifyState = "default" | "granted" | "denied" | "unsupported";

/**
 * Pure helper: decide whether an OS-toast attempt should proceed for one
 * notification row. Split out of {@link useNotifications}.notify so the
 * gating contract is unit-testable without standing up React + IPC mocks.
 *
 * The platform split is load-bearing:
 *  - **Electron** (`hasBridge=true`) — skip the browser-`Notification.permission`
 *    check. macOS gates delivery on the app's *signing identity*, not on the
 *    renderer's permission flag, so a packaged build whose renderer reports
 *    `permission === "default"` will still deliver fine when we hand the
 *    payload to the main-process bridge. Gating on `state !== "granted"`
 *    here is what produced the "badge ticks but Notification Center stays
 *    empty" bug — the IPC was never reached because the renderer's flag was
 *    treated as authoritative.
 *  - **Web** (`hasBridge=false`) — the browser's `Notification.permission` IS
 *    authoritative; `new Notification(...)` will throw / no-op when it isn't
 *    `"granted"`, so we bail before constructing one.
 *
 * Returns true when the caller should dispatch the OS toast; false when it
 * should silently skip.
 */
export function shouldDeliverOsNotification(opts: {
  enabled: boolean;
  state: NotifyState;
  hasBridge: boolean;
  attending: boolean;
  isSameSession: boolean;
  isActionableKind: boolean;
}): boolean {
  if (!opts.enabled) return false;
  // Web-only: the renderer's permission flag IS the OS authorisation. Electron
  // delegates that decision to macOS via the bridge's signing identity.
  if (!opts.hasBridge && opts.state !== "granted") return false;
  // Same-session foreground suppression — except for actionable kinds, which
  // must surface even when the user is parked on the asking session because
  // they may have Cmd-Tab'd to another app and the modal can be minimised.
  if (opts.attending && opts.isSameSession && !opts.isActionableKind) {
    return false;
  }
  return true;
}

/**
 * Fire a one-off **test** notification through the same delivery path real
 * ones use — the Electron native bridge inside the desktop app, the browser
 * `Notification` API on the web. Deliberately bypasses the workspace
 * `enabled` pref and the foreground-visibility gate: it's a manual "does this
 * work?" check (and, on macOS, the prompt that gets the app authorized in
 * System Settings → Notifications).
 *
 * Returns `true` if a notification was dispatched, `false` if the platform
 * blocked it (unsupported, or web permission denied).
 */
export async function sendTestNotification(): Promise<boolean> {
  const title = "Claudius";
  const body = "Test notification — this is how Claude will ping you.";

  // Desktop: route through main so the click can raise the window, exactly
  // like a real notification.
  const bridge = readBridgeOnClient();
  if (bridge) {
    bridge.notifications.show({ title, body });
    return true;
  }

  // Web: the browser Notification API. Request permission if we don't have
  // it yet so the test button doubles as the opt-in prompt.
  if (typeof Notification === "undefined") return false;
  let perm = Notification.permission;
  if (perm !== "granted") {
    try {
      perm = await Notification.requestPermission();
    } catch {
      return false;
    }
  }
  if (perm !== "granted") return false;
  try {
    const n = new Notification(title, { body, icon: "/icon.svg" });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}

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
  // Lazy init reads the live Notification.permission once on first
  // render. On the server `Notification` is undefined → "unsupported".
  // On the client, after hydration, this matches the current browser
  // permission. The brief SSR-vs-client mismatch on first paint is
  // acceptable because no Notifications UI is rendered before
  // hydration completes anyway.
  const [state, setState] = useState<NotifyState>(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
    return Notification.permission as NotifyState;
  });
  // "Is the user attending to this window" — visible AND (in Electron) the
  // window is focused. Drives the same-session OS-notify suppression below.
  // Using window focus (not just `document.hidden`) is what lets an Electron
  // user who Cmd-Tabbed away — window still on screen — actually get the toast.
  const visibleRef = useAttentionRef();
  // The notification's onclick handler is bound ONCE for the lifetime
  // of an OS-toast; we want it to read the latest `onJump` /
  // `activeSessionId` without forcing the whole effect to re-run on
  // every prop change. Writing the ref's `.current` during render is
  // the documented escape hatch for "always-fresh values in a handler"
  // until React 19's `useEffectEvent` ships out of experimental.
  const onJumpRef = useRef(onJump);
  // eslint-disable-next-line react-hooks/refs
  onJumpRef.current = onJump;
  const activeSessionRef = useRef(activeSessionId ?? null);
  // eslint-disable-next-line react-hooks/refs
  activeSessionRef.current = activeSessionId ?? null;

  // (Visibility/focus tracking now lives in `useAttentionRef` above.)

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
  // Default-on semantics: a workspace whose `notifications.enabled` has
  // never been set should still get toasts. The previous `!!prefs?.enabled`
  // treated `undefined` as off and silently dropped every notification on
  // fresh / migrated workspaces — the user saw "Workspace notifications:
  // Off" in the popover with no visible action that had ever turned it off,
  // and couldn't figure out why nothing rang. Only an EXPLICIT `enabled:
  // false` (the user toggled it off) disables now. This matches the
  // server-side {@link isKindEnabled} semantics in `notification-bus.ts`,
  // which also treat absent prefs as "allowed" — keeping the two ends
  // symmetric is what closes the "toast suppressed but row persisted"
  // class of gap.
  const enabled = prefs?.enabled !== false;
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

  // Phase 6 of docs/electron-conversion/PLAN.md — when the Electron
  // main process fires `notification:click <sessionId>` back to the
  // renderer, we need to resolve the sessionId to the most recent
  // NotificationRow so `onJump` has the right payload. The toast may
  // outlive the in-memory list refresh, so we cache rows keyed by
  // sessionId here.
  const lastNotifiedRef = useRef<Map<string, NotificationRow>>(new Map());

  /**
   * Fire an OS notification for a persisted row. Honours the visibility
   * gate (skipped when the tab is foregrounded on the same session) and the
   * per-workspace click behaviour (`jump` vs `dismiss`).
   *
   * Phase 6 of docs/electron-conversion/PLAN.md — inside Electron we
   * route through the IPC bridge so main can raise the BrowserWindow
   * on click (the renderer's `window.focus()` is unreliable when the
   * window is hidden behind other apps). Outside Electron we keep the
   * browser-native `new Notification(...)` path.
   */
  const notify = useCallback(
    (row: NotificationRow) => {
      const bridge = readBridgeOnClient();
      const sameSession =
        !!row.sessionId && activeSessionRef.current === row.sessionId;
      const deliver = shouldDeliverOsNotification({
        enabled,
        state,
        hasBridge: !!bridge,
        attending: visibleRef.current,
        isSameSession: sameSession,
        isActionableKind: isActionableKind(row.kind),
      });
      if (!deliver) return;

      if (bridge) {
        // Electron path — main owns the lifecycle and the click → focus
        // flow. The click handler is registered once below in an effect.
        // We stash the row keyed by sessionId so the click callback can
        // resolve it back to a `NotificationRow` for `onJump`.
        if (row.sessionId) lastNotifiedRef.current.set(row.sessionId, row);
        bridge.notifications.show({
          title: row.title,
          body: row.body ?? "",
          sessionId: row.sessionId ?? undefined,
        });
        return;
      }

      if (typeof Notification === "undefined") return;
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
    // `visibleRef` is a stable ref from useAttentionRef — listed to satisfy
    // exhaustive-deps; its identity never changes so notify() stays stable.
    [enabled, state, onClick, visibleRef],
  );

  // Phase 6 — subscribe to notification-click events coming back from
  // the Electron main process. The payload is the `sessionId` we sent
  // with `show(...)`; we look up the matching row via the click
  // behaviour and route through `onJump`. The renderer-native fallback
  // path attaches its own `onclick` per-notification, so this only
  // fires inside Electron.
  useEffect(() => {
    const bridge = readBridgeOnClient();
    if (!bridge) return undefined;
    const unsubscribe = bridge.notifications.onClick((sessionId) => {
      if (onClick !== "jump") return;
      // Use the most recent row for this session — the OS toast may
      // outlive the in-memory list refresh.
      const row = sessionId
        ? lastNotifiedRef.current.get(sessionId)
        : undefined;
      if (row) onJumpRef.current?.(row);
    });
    return unsubscribe;
  }, [onClick]);

  return {
    state,
    enabled,
    onClick,
    setEnabled,
    requestPermission,
    notify,
  };
}

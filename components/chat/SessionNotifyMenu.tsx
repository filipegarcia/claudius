"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff, Check } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { SessionNotificationPrefs } from "@/lib/shared/notifications";

/**
 * Per-session notifications popover. Pinned to the status line so the
 * controls live next to the session they affect.
 *
 * Three levers:
 *   1. **Workspace notifications** — single switch that drives the
 *      browser-Notification opt-in via the parent's `onToggleWorkspace`.
 *   2. **Block this session** — kills inbox writes for this session id.
 *      Persisted on the per-workspace SQLite `session_notification_prefs`.
 *   3. **Snooze N minutes** — sets `snooze_until` to now + N. Cleared by the
 *      "Clear snooze" item or by setting block.
 */

type Props = {
  /** Active session id; the popover is disabled when null. */
  sessionId: string | null;
  /** Browser-Notification permission state. */
  permissionState: "default" | "granted" | "denied" | "unsupported";
  /** Whether the workspace currently has notifications enabled. */
  workspaceEnabled: boolean;
  /** Toggle the workspace-level enabled flag. */
  onToggleWorkspace: () => void | Promise<void>;
};

type Pref = SessionNotificationPrefs;

const SNOOZE_PRESETS: Array<{ label: string; minutes: number }> = [
  { label: "15 min", minutes: 15 },
  { label: "1 hour", minutes: 60 },
  { label: "2 hours", minutes: 120 },
  { label: "Until tomorrow", minutes: 12 * 60 },
];

export function SessionNotifyMenu({
  sessionId,
  permissionState,
  workspaceEnabled,
  onToggleWorkspace,
}: Props) {
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState<Pref | null>(null);
  const [loading, setLoading] = useState(false);
  // Time anchor for snooze-relative checks. We can't call `Date.now()` during
  // render (react-hooks/purity) so we keep it in state and tick it while the
  // popover is open. Closed → no tick, no re-render.
  const [now, setNow] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [open]);

  const fetchPrefs = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/sessions/${id}/notification-prefs`);
      if (!res.ok) return;
      const data = (await res.json()) as Pref;
      setPrefs(data);
    } catch {
      // best-effort
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !sessionId) return;
    void fetchPrefs(sessionId);
  }, [open, sessionId, fetchPrefs]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      if (panelRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const patch = useCallback(
    async (body: { blocked?: boolean; snoozeMinutes?: number | null }) => {
      if (!sessionId) return;
      // Optimistic — derive the next prefs locally so the menu doesn't flash
      // back to the prior state while the POST round-trips.
      setPrefs((prev) => {
        const base: Pref = prev ?? {
          sessionId,
          blocked: false,
          snoozeUntil: null,
        };
        const next: Pref = { ...base };
        if (typeof body.blocked === "boolean") next.blocked = body.blocked;
        if (body.snoozeMinutes !== undefined) {
          next.snoozeUntil =
            body.snoozeMinutes == null
              ? null
              : Date.now() + Math.floor(body.snoozeMinutes) * 60_000;
        }
        return next;
      });
      try {
        const res = await fetch(`/api/sessions/${sessionId}/notification-prefs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          const data = (await res.json()) as Pref;
          setPrefs(data);
        }
      } catch {
        // Failure — re-fetch authoritative state.
        if (sessionId) void fetchPrefs(sessionId);
      }
    },
    [sessionId, fetchPrefs],
  );

  const blocked = prefs?.blocked === true;
  const snoozedUntil =
    prefs?.snoozeUntil && now > 0 && prefs.snoozeUntil > now ? prefs.snoozeUntil : null;
  const muted = blocked || snoozedUntil !== null;

  const supported = permissionState !== "unsupported";

  const triggerTitle = !supported
    ? "Notifications not supported in this browser"
    : permissionState === "denied"
      ? "Notifications denied — change in browser settings"
      : muted
        ? blocked
          ? "Notifications blocked for this session"
          : `Snoozed until ${new Date(snoozedUntil!).toLocaleTimeString()}`
        : workspaceEnabled && permissionState === "granted"
          ? "Notifications on"
          : "Notifications off — click to configure";

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        title={triggerTitle}
        className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 hover:bg-[var(--panel)]"
      >
        {workspaceEnabled && permissionState === "granted" && !muted ? (
          <Bell className="h-3 w-3 text-emerald-400" />
        ) : (
          <BellOff className="h-3 w-3 text-[var(--muted)]" />
        )}
      </button>
      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-[calc(100%+6px)] z-50 w-64 rounded-md border border-[var(--border)] bg-[var(--panel)] py-1 text-xs shadow-lg"
        >
          <div className="px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">
            Notifications
          </div>

          <button
            onClick={() => void onToggleWorkspace()}
            className="flex w-full items-center justify-between gap-2 px-3 py-1.5 hover:bg-[var(--panel-2)]"
          >
            <span className="text-[var(--foreground)]">
              Workspace notifications
            </span>
            <span className={cn("text-[10px]", workspaceEnabled ? "text-emerald-400" : "text-[var(--muted)]")}>
              {workspaceEnabled ? "On" : "Off"}
            </span>
          </button>
          {permissionState === "denied" && (
            <div className="mx-3 my-1 rounded border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-[10px] text-[var(--muted)]">
              Browser permission denied. Change in site settings.
            </div>
          )}

          {sessionId ? (
            <>
              <div className="my-1 h-px bg-[var(--border)]" />
              <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                This session
              </div>
              <button
                onClick={() => void patch({ blocked: !blocked, snoozeMinutes: blocked ? undefined : null })}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 hover:bg-[var(--panel-2)]"
              >
                <span className="text-[var(--foreground)]">Block this session</span>
                <span className={cn("text-[10px]", blocked ? "text-rose-400" : "text-[var(--muted)]")}>
                  {blocked ? "Blocked" : "Off"}
                </span>
              </button>

              <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                Snooze
              </div>
              <ul>
                {SNOOZE_PRESETS.map((p) => (
                  <li key={p.minutes}>
                    <button
                      disabled={blocked || loading}
                      onClick={() => void patch({ snoozeMinutes: p.minutes, blocked: false })}
                      className="flex w-full items-center justify-between gap-2 px-3 py-1.5 hover:bg-[var(--panel-2)] disabled:opacity-40"
                    >
                      <span>{p.label}</span>
                      {snoozedUntil && now > 0 &&
                        Math.abs(snoozedUntil - (now + p.minutes * 60_000)) < 2 * 60_000 && (
                          <Check className="h-3 w-3 text-emerald-400" />
                        )}
                    </button>
                  </li>
                ))}
              </ul>
              {snoozedUntil && (
                <button
                  onClick={() => void patch({ snoozeMinutes: null })}
                  className="block w-full px-3 py-1.5 text-left text-[10px] text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
                >
                  Clear snooze (resumes at{" "}
                  {new Date(snoozedUntil).toLocaleTimeString()})
                </button>
              )}
            </>
          ) : (
            <div className="px-3 py-2 text-[10px] text-[var(--muted)]">
              Per-session controls appear once a session is bound.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

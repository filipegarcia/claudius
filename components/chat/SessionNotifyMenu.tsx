"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff, Check, Send } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { sendTestNotification } from "@/lib/client/useNotifications";
import { useIsElectron } from "@/lib/client/useElectron";
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
  const isElectron = useIsElectron();
  // Transient feedback for the "Send test notification" button: "idle" →
  // "sent" / "blocked", auto-clearing after a beat.
  const [testState, setTestState] = useState<"idle" | "sent" | "blocked">("idle");
  const testTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (testTimerRef.current) clearTimeout(testTimerRef.current);
  }, []);
  const onSendTest = useCallback(async () => {
    const ok = await sendTestNotification();
    setTestState(ok ? "sent" : "blocked");
    if (testTimerRef.current) clearTimeout(testTimerRef.current);
    testTimerRef.current = setTimeout(() => setTestState("idle"), 3000);
  }, []);
  // Time anchor for snooze-relative checks. We can't call `Date.now()` during
  // render (react-hooks/purity) so we keep it in state and tick it while the
  // popover is open. Closed → no tick, no re-render.
  const [now, setNow] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Tick "now" whenever the popover is open — used for snooze-relative
  // checks. `Date.now()` is impure so it can't run during render; the
  // effect callback ticks it once on open and then every 30s. The
  // setState inside the interval callback is asynchronous-by-clock, so
  // it doesn't trip react-hooks/set-state-in-effect.
  useEffect(() => {
    if (!open) return;
    // The on-open `setNow(Date.now())` is intentional setup work —
    // capturing the current time the moment the popover opens. We can't
    // hoist this to a useState lazy initializer or to render because
    // `Date.now()` is impure (react-hooks/purity), and we don't want to
    // wait 30s for the first interval tick to learn the time. Keeping it
    // here is the documented escape hatch for "synchronizing with an
    // external system" (the wall clock).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [open]);

  // Trigger a re-fetch of prefs whenever the popover opens or the session
  // id changes (while open). The fetch itself happens in the effect below;
  // setState calls only inside Promise callbacks.
  const [prefsTrigger, setPrefsTrigger] = useState(0);
  const [lastFetchKey, setLastFetchKey] = useState<string | null>(null);
  const fetchKey = open && sessionId ? sessionId : null;
  if (lastFetchKey !== fetchKey) {
    setLastFetchKey(fetchKey);
    if (fetchKey) setPrefsTrigger((n) => n + 1);
  }

  useEffect(() => {
    if (!open || !sessionId) return;
    const controller = new AbortController();
    fetch(`/api/sessions/${sessionId}/notification-prefs`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as Pref;
      })
      .then((data) => {
        setPrefs(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLoading(false);
      });
    return () => controller.abort();
  }, [prefsTrigger, sessionId, open]);

  // setLoading(true) on each trigger lives in render, alongside the
  // trigger bump — keeps it out of the fetch effect's body.
  const [lastTriggerSeen, setLastTriggerSeen] = useState(prefsTrigger);
  if (lastTriggerSeen !== prefsTrigger) {
    setLastTriggerSeen(prefsTrigger);
    setLoading(true);
  }

  const fetchPrefs = useCallback((id: string) => {
    setLastFetchKey(id);
    setPrefsTrigger((n) => n + 1);
  }, []);

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
    ? `Notifications not supported ${isElectron ? "on this device" : "in this browser"}`
    : permissionState === "denied"
      ? isElectron
        ? "Notifications denied — enable Claudius in macOS System Settings → Notifications"
        : "Notifications denied — change in browser settings"
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
        data-testid="session-notify-trigger"
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

          {/* Fire a sample notification through the real delivery path so the
              user can confirm OS banners work (and, on macOS, trigger the
              first-time System Settings authorization). */}
          <button
            data-testid="session-notify-test"
            onClick={() => void onSendTest()}
            disabled={!supported}
            className="flex w-full items-center justify-between gap-2 px-3 py-1.5 hover:bg-[var(--panel-2)] disabled:opacity-40"
          >
            <span className="flex items-center gap-1.5 text-[var(--foreground)]">
              <Send className="h-3 w-3" />
              Send test notification
            </span>
            {testState === "sent" && (
              <span className="text-[10px] text-emerald-400">Sent</span>
            )}
            {testState === "blocked" && (
              <span className="text-[10px] text-rose-400">Blocked</span>
            )}
          </button>

          {permissionState === "denied" && (
            <div className="mx-3 my-1 rounded border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-[10px] text-[var(--muted)]">
              {isElectron
                ? "Denied — enable Claudius in macOS System Settings → Notifications."
                : "Browser permission denied. Change in site settings."}
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

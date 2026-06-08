"use client";

import { useEffect } from "react";
import { CheckCircle2, Clock, X } from "lucide-react";

/**
 * Transient inline notification surfaced when the SERVER auto-closes the
 * to-do snapshot — either because every item finished
 * (`reason: "completed"`) or because the list went idle past the
 * staleness threshold (`reason: "stale"`).
 *
 * Mounted in the same chat-column slot the `TodosBanner` lives in, so
 * the visual transition reads as "list of todos → list disappeared,
 * here's why" rather than "list silently vanished." Auto-dismisses
 * after `DISMISS_MS`; the user can also × it eagerly. The parent owns
 * the `payload` state (set in `applyEvent` on the SSE event) and is
 * responsible for clearing it via `onDismiss` — we re-arm the timer on
 * every `payload.id` change so back-to-back auto-clears don't get
 * swallowed by an in-flight fade.
 *
 * Distinct from `QuitWarningToast`: that one's a global HUD pinned to
 * the viewport; this one rides the chat-column layout so it feels
 * connected to the to-do list that just left.
 *
 * Manual user clears (the Clear button on the banner) do NOT surface
 * here — the user already knows what they just did, and an "I cleared
 * the list" notification for an action the user just took reads as
 * dismissive or chatty. Filtering happens server-side in
 * `Session.clearTodos` (`reason !== "manual"` gate).
 */
const DISMISS_MS = 6_000;

type Props = {
  payload:
    | { id: number; reason: "stale" | "completed"; count: number }
    | null;
  onDismiss: () => void;
};

export function TodosAutoClearedToast({ payload, onDismiss }: Props) {
  // Single effect: arm an auto-dismiss timer keyed off the payload id
  // so a back-to-back re-fire restarts the countdown cleanly. No local
  // state — we render directly off the parent's payload and call
  // `onDismiss` when the timer or the manual × fires. The earlier
  // local-copy-shadow design tripped react-hooks/set-state-in-effect
  // and bought nothing (we don't fade, we just unmount).
  useEffect(() => {
    if (!payload) return;
    const t = window.setTimeout(onDismiss, DISMISS_MS);
    return () => window.clearTimeout(t);
    // `payload.id` is the retrigger handle — every new fire bumps it.
  }, [payload?.id, payload, onDismiss]);

  if (!payload) return null;

  const Icon = payload.reason === "completed" ? CheckCircle2 : Clock;
  const tone =
    payload.reason === "completed"
      ? "text-emerald-300 border-emerald-500/30 bg-emerald-500/5"
      : "text-amber-300 border-amber-500/30 bg-amber-500/5";
  const headline =
    payload.reason === "completed"
      ? payload.count === 1
        ? "Cleared 1 completed to-do"
        : `Cleared ${payload.count} completed to-dos`
      : payload.count === 1
      ? "Cleared 1 stale to-do (24h idle)"
      : `Cleared ${payload.count} stale to-dos (24h idle)`;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="todos-auto-cleared-toast"
      className="border-b border-[var(--border)] bg-[var(--panel-2)]/40"
    >
      <div
        className={`mx-auto flex w-full max-w-[var(--chat-col)] items-center gap-2 border-l-2 ${tone} px-4 py-1.5 text-xs`}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 truncate">{headline}</span>
        <button
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

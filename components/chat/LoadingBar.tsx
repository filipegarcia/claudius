"use client";

/**
 * Thin indeterminate progress bar shown directly under the StatusLine while the
 * agent is starting up (`!ready`) or processing a turn (`pending`). Visible
 * regardless of scroll position so the user always has a global "Claude is
 * doing something" cue.
 *
 * The bar is purely decorative — actual progress comes from the activity rail,
 * tool history, and the inline `Working…` row inside MessageList.
 */
type Props = {
  /** True until the session has bound (we're spinning up). */
  ready: boolean;
  /** True while a turn is in flight. */
  pending: boolean;
  /** True during the initial SSE replay window — suppress the bar so it doesn't
   *  fight with `Loading older messages…` and the splash flash. */
  replaying?: boolean;
};

export function LoadingBar({ ready, pending, replaying = false }: Props) {
  const active = !replaying && (!ready || pending);

  // Reserve the 2px row even when idle so the layout doesn't jump as turns
  // start/stop. `aria-busy` flips so screen readers know the state.
  return (
    <div
      role="progressbar"
      aria-busy={active}
      aria-label={active ? "Claude is working" : undefined}
      className={`relative h-[3px] w-full overflow-hidden ${active ? "bg-[var(--accent)]/10" : "bg-transparent"}`}
    >
      {active && (
        <div
          className="absolute inset-y-0 left-0 w-1/4 animate-indeterminate-slide rounded-full bg-[var(--accent)] shadow-[0_0_8px_var(--accent)]"
        />
      )}
    </div>
  );
}

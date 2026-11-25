/**
 * CC 2.1.332 parity — "[VSCode] Fixed Rewind staying on 'Checking code
 * changes…' while Claude's process hung at its start".
 *
 * "Restore files" sends the SDK's `rewind_files` control request through
 * `POST /api/sessions/[id]/rewind`. When the CLI process exists but never
 * answers (hung while starting), the route awaited it forever and the button
 * sat on its spinner, disabled. Now the route gives up after
 * {@link REWIND_ROUTE_TIMEOUT_MS} with a 504, and the button aborts its fetch
 * after {@link REWIND_CLIENT_TIMEOUT_MS} as a backstop (longer than the
 * route's, which may first spend time restarting a dead session).
 */

export const REWIND_ROUTE_TIMEOUT_MS = 20_000;
export const REWIND_CLIENT_TIMEOUT_MS = 45_000;

export const TIMED_OUT: unique symbol = Symbol("timed out");

/** `p`'s value, or {@link TIMED_OUT} once `ms` passes first. */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * What the dialog says when the rewind got no answer. The control request
 * isn't cancelled by giving up on it, so a real restore may still be applied
 * once the process answers: don't claim it failed.
 */
export function rewindTimeoutMessage(dryRun: boolean): string {
  return dryRun
    ? "Claude's process isn't responding, so the code changes couldn't be checked. Try again once it has started."
    : "Claude's process isn't responding. The restore may still be applied once it answers, so check your files before trying again.";
}

import { useMemo } from "react";
import { useRouter } from "next/navigation";

/**
 * Navigation-intent signal for programmatic `router.push` / `router.replace`.
 *
 * The `?session=` URL writer in `use-session.ts` defers its
 * `history.replaceState` by 500 ms and skips it if the user navigated
 * meanwhile. Anchor clicks (capture-phase listener) and Navigation API
 * `navigate` events are visible to it, but a programmatic `router.push` only
 * touches history when its RSC payload commits. A push issued inside the
 * window, e.g. a native slash command (`/usage`, `/rate-limit-options`), was
 * then superseded by the writer's `replaceState` (Next syncs native history
 * calls into its router, which drops the pending navigation), and the URL
 * stayed on the chat. Fast backends hit this every time; see TODO I11 in
 * `rust/TODO.md`.
 *
 * Pushes made through {@link useNavIntentRouter} bump a module-level counter
 * *before* navigating. The writer compares the counter before and after its
 * wait, so any intent inside the window cancels the write, just like an
 * anchor click does.
 */
let intents = 0;

/** Record that the app is about to navigate programmatically. */
export function markNavigating(): void {
  intents += 1;
}

/**
 * Monotonic count of recorded intents. Compare two reads to ask "was a
 * navigation started in between?". A counter, not a timestamp, so two events
 * in the same millisecond can't tie.
 */
export function navIntentSeq(): number {
  return intents;
}

type Router = ReturnType<typeof useRouter>;

/** `router` with `push` / `replace` recording an intent first. */
export function withNavIntent(router: Router): Router {
  return {
    ...router,
    push: (href, options) => {
      markNavigating();
      router.push(href, options);
    },
    replace: (href, options) => {
      markNavigating();
      router.replace(href, options);
    },
  };
}

/** Drop-in `useRouter()` whose `push` / `replace` record a navigation intent. */
export function useNavIntentRouter(): Router {
  const router = useRouter();
  return useMemo(() => withNavIntent(router), [router]);
}

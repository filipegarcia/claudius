/**
 * React hooks for the Electron bridge.
 *
 * Phase 2 of docs/electron-conversion/PLAN.md.
 *
 * These are the canonical way for components to talk to the main
 * process. They:
 *  - feature-detect `window.claudius` (so the web build degrades to a
 *    no-op),
 *  - are SSR-safe (return the "browser" answer during server render so
 *    React hydration doesn't flash),
 *  - never touch `ipcRenderer` directly — that surface lives in
 *    `electron/preload.ts`.
 *
 * **Calling convention:** components should branch with
 * `const bridge = useClaudius()` and treat `bridge` as nullable. Don't
 * write `if (useIsElectron()) ...` — the hook order would change
 * across renders, which violates React rules.
 */
// The `Window.claudius` global is augmented in `lib/shared/electron.d.ts`;
// TypeScript picks it up via the project's `**/*.ts` include glob, so no
// explicit import or triple-slash reference is needed here.
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

/**
 * The internal store is a no-op (`subscribe` returns an empty
 * unsubscriber). The "value" only changes once between SSR and
 * hydration, and after hydration `window.claudius` is stable for the
 * lifetime of the renderer, so we never need to re-render.
 */
const NOOP_UNSUBSCRIBE = () => {};
function subscribeNoop(): () => void {
  return NOOP_UNSUBSCRIBE;
}

/**
 * Exported for unit testing. Returns the bridge if one is mounted on
 * the current realm's `window`, else `null`. Node treats
 * `typeof window` as `undefined`, which lets us drive both branches
 * from a vitest spec by mutating `globalThis`.
 */
export function readBridgeOnClient(): Window["claudius"] | null {
  if (typeof window === "undefined") return null;
  return window.claudius ?? null;
}

/** SSR-side reader — always `null`, matches the React contract. */
export function readBridgeOnServer(): null {
  return null;
}

/**
 * Returns the live `window.claudius` bridge, or `null` when the
 * renderer is a regular browser tab (or during SSR).
 *
 * Stable identity: the returned object reference does not change for
 * the lifetime of the renderer, so it's safe to put in dependency
 * arrays.
 */
export function useClaudius(): Window["claudius"] | null {
  return useSyncExternalStore(
    subscribeNoop,
    readBridgeOnClient,
    readBridgeOnServer,
  );
}

/**
 * Convenience boolean for callers that only care about the runtime
 * environment, not the bridge methods.
 */
export function useIsElectron(): boolean {
  return useClaudius() !== null;
}

/**
 * Subscribe a callback to a menu action (`tab.new`, `tab.close`, …).
 *
 * The callback ref is updated each render so the latest closure is
 * always invoked without re-subscribing on every render. This matches
 * the pattern used by the existing shortcut registry in
 * `lib/client/shortcuts.ts`.
 *
 * In the browser build this is a no-op — components can call it
 * unconditionally.
 */
export function useElectronAction(
  actionId: string,
  cb: () => void,
): void {
  const bridge = useClaudius();
  const cbRef = useRef(cb);
  // Sync the ref inside an effect so React 19's "no ref writes during
  // render" rule stays happy. Runs after every render — cheap, never
  // re-subscribes the menu listener.
  useEffect(() => {
    cbRef.current = cb;
  });

  useEffect(() => {
    if (!bridge) return undefined;
    const unsubscribe = bridge.menu.on(actionId, () => {
      cbRef.current();
    });
    return unsubscribe;
  }, [bridge, actionId]);
}

/**
 * Subscribe to an arbitrary push channel exposed by the bridge.
 * Currently used for notification clicks, deep links, and updater
 * status. Generic over the payload type so consumers can keep their
 * own narrowing.
 */
export function useElectronSubscription<T>(
  subscribe:
    | ((cb: (value: T) => void) => () => void)
    | null
    | undefined,
  cb: (value: T) => void,
): void {
  const cbRef = useRef(cb);
  useEffect(() => {
    cbRef.current = cb;
  });

  useEffect(() => {
    if (!subscribe) return undefined;
    const unsubscribe = subscribe((value) => {
      cbRef.current(value);
    });
    return unsubscribe;
  }, [subscribe]);
}

/**
 * Returns a stable invoker that triggers `window.claudius?.method` if
 * present, else a fallback. Useful at call sites like:
 *
 *   const openWorkspace = useElectronInvoke(
 *     (b) => b.dialog.openWorkspace(),
 *     () => Promise.resolve(null),
 *   );
 *
 * In the browser build the fallback runs synchronously.
 */
export function useElectronInvoke<TArgs extends unknown[], TResult>(
  call: (bridge: NonNullable<Window["claudius"]>, ...args: TArgs) => TResult,
  fallback: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  const bridge = useClaudius();
  return useCallback(
    (...args: TArgs) =>
      bridge ? call(bridge, ...args) : fallback(...args),
    // `call` and `fallback` are expected to be stable identities from
    // module scope; we don't list them to avoid surprising
    // dependencies. Callers who pass inline functions get fresh
    // invokers, which is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bridge],
  );
}

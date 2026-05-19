/**
 * Type contract for the `window.claudius` bridge exposed by
 * `electron/preload.ts`.
 *
 * Phase 2 of docs/electron-conversion/PLAN.md.
 *
 * Single source of truth shared between:
 *  - `electron/preload.ts` (implementation; runs in the preload sandbox)
 *  - `lib/client/useElectron.ts` (React-side feature detection + helpers)
 *  - any component that wants to call a native affordance and fall back
 *    when `window.claudius` is `undefined` (i.e. the browser build).
 *
 * **Invariant:** the contract MUST stay strictly additive. Removing a
 * method or narrowing a signature breaks shipped Electron builds whose
 * bundled renderer is older than the main process they're loaded into
 * (rare today; not impossible once auto-update lands in Phase 7).
 */

/** Shape of the OS-notification payload sent from the renderer. */
export type ClaudiusNotificationOpts = {
  title: string;
  body: string;
  /**
   * When set, clicking the notification focuses the window and tells
   * the renderer to `switchSession(sessionId)`. Plumbed through in
   * Phase 6.
   */
  sessionId?: string;
  /** Override silent / default beep behavior. */
  silent?: boolean;
};

/** Status events surfaced by `electron-updater` to the renderer. */
export type ClaudiusUpdaterStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; percent: number }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };

/** File-dialog filter, matching Electron's `FileFilter`. */
export type ClaudiusFileFilter = {
  name: string;
  extensions: string[];
};

/**
 * The bridge object that the preload mounts on `window`. Every
 * subsystem is namespaced so it's clear at the call site which phase
 * owns the path (and what to mock in unit tests).
 */
export type ClaudiusBridge = {
  /** Always `true` when present — useful as a feature-detection guard. */
  readonly isElectron: true;
  /** OS the renderer is running on. */
  readonly platform: NodeJS.Platform;
  /**
   * Coarse version identifier. Bumped whenever a new method is added
   * so the renderer can branch on capability tiers across older
   * packaged builds.
   */
  readonly bridgeVersion: number;

  /**
   * Subscribe to menu-driven actions. The OS menu (phase 3) and the
   * shortcut registry both dispatch into this single stream so the
   * renderer has one code path to handle them.
   *
   * @returns an unsubscribe function — call when the component
   *   unmounts.
   */
  menu: {
    on(action: string, cb: () => void): () => void;
  };

  /** Native window controls (phase 4). */
  window: {
    minimize(): void;
    maximize(): void;
    close(): void;
    toggleFullscreen(): void;
    toggleDevTools(): void;
  };

  /** Dock / taskbar unread badge (phase 6). */
  badge: {
    set(count: number): void;
  };

  /** OS notifications (phase 6). */
  notifications: {
    show(opts: ClaudiusNotificationOpts): void;
    /**
     * Subscribe to notification clicks. The callback receives the
     * `sessionId` originally attached to the notification so the
     * renderer can `switchSession(sessionId)`.
     */
    onClick(cb: (sessionId: string | undefined) => void): () => void;
  };

  /** Native file/folder dialogs (phase 8). */
  dialog: {
    openWorkspace(): Promise<string | null>;
    openFile(opts?: { filters?: ClaudiusFileFilter[] }): Promise<string | null>;
  };

  /**
   * Custom-protocol deep links (`claudius://...`). Fired both at cold
   * start (queued until renderer subscribes) and warm focus events
   * (phase 8).
   */
  deepLinks: {
    onOpen(cb: (url: string) => void): () => void;
  };

  /** Auto-update lifecycle (phase 7). */
  updater: {
    check(): void;
    apply(): void;
    onStatus(cb: (status: ClaudiusUpdaterStatus) => void): () => void;
  };
};

declare global {
  interface Window {
    /**
     * Present iff the renderer is running inside Electron's preload-
     * isolated context. In a regular browser tab this is `undefined`.
     */
    claudius?: ClaudiusBridge;
  }
}

// File is a .d.ts ambient module — keep an explicit `export {}` so
// TypeScript treats the file as a module rather than a script, which
// is the only way to mix `declare global` with named type exports.
export {};

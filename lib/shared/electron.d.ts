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
   *
   * Versions:
   *  - 1: initial menu + window bridge (Phase 2)
   *  - 2: notifications + badge + dialog + deepLinks + updater (Phases 6–8)
   *  - 3: menu.setAccelerators + menu.setRecording
   *  - 4: chat.onNewWithText + chat.onAppendToComposer (right-click extras)
   *  - 5: linkTarget.set (route external links to default browser or
   *       sandboxed in-app viewer)
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
    /**
     * Push the renderer's resolved shortcut bindings (as Electron
     * accelerator strings, keyed by action id) to the main process so
     * it can rebuild the native menu with the user's customized chords.
     * Lets a remap in /settings take effect on the OS-menu-owned
     * accelerators (tab navigation, command palette, …) that the
     * renderer's `keydown` listener can't reach while a text field is
     * focused. Added in bridgeVersion 3.
     */
    setAccelerators(accelerators: Record<string, string>): void;
    /**
     * Toggle "recording" mode for the /settings shortcut recorder. While
     * enabled, the native menu is rebuilt display-only (its accelerators
     * stop intercepting) and the reserved-chord swallow is suspended, so a
     * chord the menu owns (⌘T, ⌘W, …) reaches the recorder instead of
     * firing the menu item it's bound to. Always pair `true` with a later
     * `false`. Added in bridgeVersion 3.
     */
    setRecording(enabled: boolean): void;
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

  /**
   * OS-level "open folder/file as workspace" events — Phase 8.
   *
   * Fires when:
   *  - the user drops a folder on the dock icon (mac `open-file`)
   *  - the user double-clicks a folder while Claudius is the default
   *    handler (win/linux `open-file` via shell file association)
   *
   * The payload is the absolute path the OS handed us.
   */
  workspaces: {
    onOpenFolder(cb: (path: string) => void): () => void;
  };

  /**
   * Chat-pane affordances driven by the main process — currently the
   * right-click selection actions wired up in
   * `electron/ipc/context-menu.ts`. Renderer code prefills composers; no
   * push channel here auto-sends a message.
   *
   *  - `onNewWithText(text)` — "Start New Chat With Selection" / Quick
   *    Actions (Explain, Summarize). Creates a fresh session and prefills
   *    its composer. Added in bridgeVersion 4.
   *  - `onAppendToComposer(text)` — "Append Selection to Current Chat".
   *    Appends to the active session's composer instead of branching off.
   *    Added in bridgeVersion 4.
   */
  chat: {
    onNewWithText(cb: (text: string) => void): () => void;
    onAppendToComposer(cb: (text: string) => void): () => void;
  };

  /**
   * Outbound-link routing preference. Pushed by the renderer whenever the
   * user changes `Settings → Link target`; the main process caches it and
   * consults the cache inside `setWindowOpenHandler`. Added in
   * bridgeVersion 5.
   */
  linkTarget: {
    set(target: "external" | "in-app"): void;
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

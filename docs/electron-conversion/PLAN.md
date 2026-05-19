# Plan — Convert Claudius into an Electron app (with browser parity)

## Context

Claudius today is a Next.js 16 App Router web app that wraps `@anthropic-ai/claude-agent-sdk`, persists per-workspace state in SQLite via `better-sqlite3`, and streams agent output to the browser over SSE. It has **58 pages** (35 workspace-scoped + 11 global + 12 bare-path redirect stubs), **113 API routes** (3 of them SSE), a centralized keyboard-shortcut registry, and a session-tab strip already wired to `Cmd+Shift+←/→` and `Cmd+Shift+1..9`.

Two pain points motivate this conversion:

1. **Reserved browser chords.** `Cmd+T`, `Cmd+W`, `Cmd+Shift+T`, `Cmd+N`, `Cmd+Q` are reserved by the browser and can't be intercepted from a web page. `shortcuts.ts` even lists them as "reserved." The only way to own them is to run inside an Electron renderer with a real OS menu / `before-input-event`.
2. **Native polish.** Custom title bar, OS notifications + dock badge, deep links, auto-update, "Open Workspace…" dialog, drag-and-drop folder onto dock — none of these are reachable from a tab.

**Approach (chosen):** *Hybrid* — embed the existing Next.js server inside Electron's main process on a private localhost port; the renderer is just a `BrowserWindow` pointed at it, so every page, every API route, and every SSE stream keeps working unchanged. On top of that, layer a thin IPC bridge (`window.claudius.*`) for native-only concerns: menu accelerators, window control, OS notifications, dock badge, deep links, file dialogs, auto-update. The browser build stays a first-class target — feature-detecting `window.claudius` lets the same React tree degrade gracefully.

**Window model:** single `BrowserWindow`, reuse the existing in-page `SessionTabs` strip.
**Distribution:** `electron-builder`, **mac + Windows + Linux day-one**.

---

## Architecture at a glance

```
┌──────────────────────────────────────────────────────────────┐
│ Electron Main (Node)                                         │
│  ├─ Embed Next.js: import("next").default({ dev:false })     │
│  │  ├─ next.prepare() then handle req → all 113 API routes   │
│  │  └─ Listens on http://127.0.0.1:<ephemeral-port>          │
│  ├─ Native menu (File/Edit/View/Window/Help)                 │
│  ├─ IPC handlers: dialog, badge, notifications, deep links   │
│  ├─ Auto-updater (electron-updater)                          │
│  └─ Protocol: claudius://workspace/<id>?session=<id>         │
│                                                              │
│ Electron Preload (contextIsolated)                           │
│  └─ exposes window.claudius = { isElectron, menu.on(...),    │
│       openWorkspaceDialog(), setBadge(n), notify(...),       │
│       onDeepLink(cb), updater.{check,apply,onStatus} }       │
│                                                              │
│ Renderer = BrowserWindow → http://127.0.0.1:<port>           │
│  └─ Existing Next.js client. Hooks feature-detect            │
│     window.claudius and call into IPC when present.          │
└──────────────────────────────────────────────────────────────┘
```

**Invariant:** no client code calls `ipcRenderer` directly. Everything goes through `window.claudius.*` (typed in `lib/shared/electron.d.ts`) and degrades to a no-op or web-equivalent in the browser build.

---

## Files we will create

- `electron/main.ts` — app lifecycle, embed Next, create window, register protocol
- `electron/preload.ts` — `contextBridge.exposeInMainWorld("claudius", api)`
- `electron/menu.ts` — `Menu.buildFromTemplate(...)` with all accelerators
- `electron/server.ts` — `nextServer.prepare()`; picks free port; returns base URL
- `electron/ipc/dialogs.ts` — file/folder dialogs
- `electron/ipc/notifications.ts` — OS notifications + `app.setBadgeCount`
- `electron/ipc/window.ts` — minimize/maximize/close, fullscreen, dev tools
- `electron/ipc/updater.ts` — `electron-updater` wrapper
- `electron/ipc/deep-links.ts` — `claudius://` URL parsing + routing
- `electron/tsconfig.json` — main-process TS config (CommonJS, node target)
- `electron-builder.yml` — packaging config (mac dmg+zip, win nsis, linux AppImage+deb)
- `build/icons/` — `.icns`, `.ico`, `.png`
- `build/entitlements.mac.plist` — Hardened Runtime entitlements
- `lib/shared/electron.d.ts` — `Window.claudius` type contract
- `lib/client/useElectron.ts` — `useIsElectron()`, `useElectronAction(actionId, fn)`
- `components/chrome/TitleBar.tsx` — custom frameless title bar
- `components/chrome/TrafficLights.tsx` — mac-style window controls (win/linux fallback uses lucide icons)
- `components/overlays/CommandPalette.tsx` — Cmd+K palette
- `tests/electron/**` — Playwright `_electron.launch()` specs

## Files we will modify

- `package.json` — add `electron`, `electron-builder`, `electron-updater`, scripts, `build` block
- `next.config.ts` — set `output: "standalone"` for packaged builds (gated by env)
- `lib/client/shortcuts.ts` — register new actions; flag those owned by the OS menu in Electron
- `components/chat/SessionTabs.tsx` — bind to registry actions instead of hard-coded chords; close-tab + reopen support
- `app/layout.tsx` — render `<TitleBar />` when `useIsElectron()`; add drag regions
- `lib/client/useFaviconBadge.ts` — also call `window.claudius?.badge.set(n)`
- `lib/client/useNotifications.ts` — also call `window.claudius?.notifications.show(...)`
- `lib/server/updater/*` — delegate to `window.claudius.updater` when in Electron
- `middleware.ts` — accept `127.0.0.1` host
- `eslint.config.mjs` — override for `electron/**`
- `playwright.config.ts` — add `chromium-electron` project
- `.github/workflows/electron-release.yml` — matrix build for mac/win/linux

> **All 113 API routes and 58 pages are untouched.**

---

# Phases

Each phase has four blocks:
- **Goal** — one-liner outcome.
- **Requirements** — what must be true for this phase to be "real."
- **Tasks** — checkbox TODOs.
- **Tests** — checkbox verifications (manual + automated).

---

## Phase 0 — Project scaffolding

**Goal:** Add Electron tooling without breaking the current web build.

### Requirements
- R0.1 Adding Electron deps must not regress `bun run build`, `bun run lint`, `bun run test`, or `bun run test:e2e`.
- R0.2 Source layout: Electron code lives under `electron/`; nothing in `app/` or `lib/` imports from `electron/`.
- R0.3 Native module (`better-sqlite3`) must rebuild for Electron's ABI without manual steps.
- R0.4 `electron-builder.yml` declares mac (`dmg`+`zip`), win (`nsis`+`portable`), linux (`AppImage`+`deb`+`rpm`) targets.
- R0.5 `dist-electron/`, `release/`, `out/` are gitignored.

### Tasks
- [ ] Add deps: `electron@^32`, `electron-builder@^25`, `electron-updater@^6`, `concurrently`, `wait-on`, `cross-env`.
- [ ] Add scripts to `package.json`:
  - [ ] `electron:dev` → `concurrently "bun run dev" "wait-on http://127.0.0.1:3000 && cross-env ELECTRON_START_URL=http://127.0.0.1:3000 electron electron/main.ts"`
  - [ ] `electron:build` → `next build && tsc -p electron/tsconfig.json`
  - [ ] `electron:dist` / `:dist:mac` / `:dist:win` / `:dist:linux`
- [ ] Create `electron/tsconfig.json` (`target: node18`, `module: commonjs`, `outDir: dist-electron`).
- [ ] Add `postinstall: electron-builder install-app-deps` (no-op when Electron not installed).
- [ ] Append `dist-electron/`, `out/`, `release/` to `.gitignore`.
- [ ] Write `electron-builder.yml`: `appId`, target list, `asarUnpack: ["**/*.node", "node_modules/next/**"]`, mac `category`/`hardenedRuntime`/`entitlements`, win `signtoolOptions`, linux `category`.
- [ ] Add `build/entitlements.mac.plist` with `com.apple.security.cs.allow-jit` and `com.apple.security.cs.allow-unsigned-executable-memory`.
- [ ] ESLint override for `electron/**`.

### Tests
- [ ] `bun run build` succeeds (web build unaffected).
- [ ] `bun run lint` passes on `electron/**` and the rest of the tree.
- [ ] `bun run test:e2e` passes (web Playwright project unchanged).
- [ ] `bun install` produces a working `better-sqlite3` for both Node and Electron (`node -e "require('better-sqlite3')"` + an Electron smoke).
- [ ] `electron-builder --help` resolves cleanly from project root.

---

## Phase 1 — Embed Next.js in main

**Goal:** Renderer loads the existing Claudius UI from a localhost port served by Next.js running inside the Electron main process.

### Requirements
- R1.1 Next.js is started from `electron/server.ts` via `next({ dev:false }).prepare()` on an ephemeral port (`server.listen(0, "127.0.0.1")`).
- R1.2 In dev, `ELECTRON_START_URL` overrides to the running `next dev` (port 3000).
- R1.3 All 113 API routes are reachable from the renderer over loopback HTTP.
- R1.4 All 3 SSE endpoints stream events into the renderer without buffering or premature close.
- R1.5 `better-sqlite3` opens `~/.claude/projects/<encoded-cwd>/.claudius.db` from the packaged build.
- R1.6 `lib/server/preview-server.ts`'s spawned `next dev` still launches inside the packaged app (via `asarUnpack`).
- R1.7 `next.config.ts` builds with `output: "standalone"` when `CLAUDIUS_PACKAGED=1`; default web build is unaffected.

### Tasks
- [ ] Implement `electron/server.ts`:
  ```ts
  import next from "next";
  import { createServer } from "node:http";
  const app = next({ dev: false, dir: appDir });
  await app.prepare();
  const server = createServer(app.getRequestHandler());
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  ```
  Return `http://127.0.0.1:${port}`.
- [ ] Implement `electron/main.ts`: `app.whenReady()` → start server → `createWindow(url)` → `loadURL(url)`. Honor `ELECTRON_START_URL` in dev.
- [ ] Set `CLAUDIUS_PACKAGED=1` in the packaged build's env (electron-builder `extraMetadata` or runtime flag).
- [ ] Gate `output: "standalone"` in `next.config.ts` on `CLAUDIUS_PACKAGED`.
- [ ] `electron-builder.yml`'s `files` glob includes `.next/standalone/**`, `.next/static/**`, `public/**`.
- [ ] `asarUnpack` for `node_modules/next/**`, `node_modules/.bin/next`, `**/*.node`.

### Tests
- [ ] Dev launch: `bun run electron:dev` — window opens, navigates to chat, no console errors.
- [ ] Prod launch: `bun run electron:build && electron dist-electron/main.js` — window opens, port is ephemeral, no `EADDRINUSE` collisions on relaunch.
- [ ] SSE smoke: open a session, send a prompt, watch the chat stream tokens token-by-token (no buffering). Repeat for `/api/notifications/stream` and `/api/schedule/[id]/runs/[runId]/stream`.
- [ ] SQLite smoke: create a workspace, restart the app, confirm the workspace persists.
- [ ] Preview-server smoke: open `/customize/[id]` for any customization, confirm the inline preview iframe renders (the spawned `next dev` works).
- [ ] Automated: Playwright `chromium-electron` test that loads `/`, expects a redirect to `/<workspaceId>`, and asserts the chat textarea is focusable.

---

## Phase 2 — IPC bridge & preload

**Goal:** Define a typed, sandboxed `window.claudius` API and a React hook that feature-detects it.

### Requirements
- R2.1 BrowserWindow opts: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- R2.2 Preload exposes **only** the typed surface; no raw `ipcRenderer`.
- R2.3 The contract is shared with the renderer via `lib/shared/electron.d.ts`.
- R2.4 `useIsElectron()` is SSR-safe (uses `useSyncExternalStore`) and returns `false` during SSR.
- R2.5 In the web build, `window.claudius` is `undefined`; every call site has a documented fallback.

### Tasks
- [ ] Write `electron/preload.ts` with `contextBridge.exposeInMainWorld("claudius", api)`.
- [ ] Define `lib/shared/electron.d.ts`:
  ```ts
  type ClaudiusBridge = {
    isElectron: true;
    platform: "darwin" | "win32" | "linux";
    menu: { on(action: string, cb: () => void): () => void };
    window: { minimize(): void; maximize(): void; close(): void; toggleFullscreen(): void; toggleDevTools(): void };
    badge: { set(count: number): void };
    notifications: { show(opts: { title: string; body: string; sessionId?: string }): void };
    dialog: { openWorkspace(): Promise<string | null>; openFile(opts?: { filters? }): Promise<string | null> };
    deepLinks: { onOpen(cb: (url: string) => void): () => void };
    updater: { check(): void; apply(): void; onStatus(cb: (s) => void): () => void };
  };
  declare global { interface Window { claudius?: ClaudiusBridge } }
  ```
- [ ] Write `lib/client/useElectron.ts`: `useIsElectron()` + `useElectronAction(actionId, fn)`.
- [ ] Audit lint: no `app/**` or `components/**` file may import from `electron/**`.

### Tests
- [ ] Unit (vitest): `useIsElectron()` returns `false` when `window.claudius` is missing; `true` when stubbed.
- [ ] Electron Playwright: assert `window.claudius.isElectron === true` and `platform` matches `process.platform`.
- [ ] Web Playwright: assert `window.claudius === undefined`.
- [ ] Security audit: in the renderer console, `typeof require === "undefined"` and `typeof process === "undefined"` (sandbox enforced).

---

## Phase 3 — Native menu + keyboard bindings ⭐

**Goal:** Own the reserved browser chords (`Cmd+T`/`W`/`Shift+T`/`1..9`) via a real OS menu; route menu events into the existing shortcut registry.

### Requirements
- R3.1 Every new chord is registered in `lib/client/shortcuts.ts` as a first-class action with a stable `actionId`.
- R3.2 Menu items dispatch the **same** action ids the in-page handler uses — single source of truth.
- R3.3 OS-reserved chords are intercepted before the renderer sees them (`webContents.on('before-input-event')` fallback).
- R3.4 Browser build still works: when the chord isn't reachable from the web, the user can rebind it in Settings to an alternative (e.g. `Cmd+Shift+T` for "new tab" in browser mode).
- R3.5 Mac menu layout differs from win/linux (mac has the app menu at index 0).

### Tasks
- [ ] Extend `lib/client/shortcuts.ts` actions:
  - [ ] `tab.new`, `tab.close`, `tab.reopen`, `tab.next`, `tab.prev`, `tab.go1`..`tab.go9`, `tab.last`
  - [ ] `nav.commandPalette`, `nav.toggleSidebar`, `nav.cheatsheet`
  - [ ] `window.minimize`, `window.zoom`, `window.toggleFullscreen`
  - [ ] `view.toggleDevTools`, `view.reload`, `view.zoomIn`/`Out`/`Reset`
  - [ ] `app.preferences`, `app.quit`, `app.openWorkspace`
- [ ] Build `electron/menu.ts` with mac vs win/linux templates. Each `click` either calls a native API or `mainWindow.webContents.send("menu:action", actionId)`.
- [ ] Modify `components/chat/SessionTabs.tsx`:
  - [ ] Replace hard-coded `Cmd+Shift+...` handlers with `useElectronAction(...)`/registry subscriptions.
  - [ ] Implement `openNewTab()`, `closeActiveTab()`, `reopenLastClosed()` (in-memory undo stack + `open-tabs-db`).
- [ ] Add `before-input-event` listener in `electron/main.ts` that `preventDefault()`s our owned chords so the renderer never receives them.
- [ ] Update `components/settings/ShortcutsSection.tsx` to badge menu-owned chords as "Owned by app menu" in Electron.

### Tests
- [ ] Manual:
  - [ ] `Cmd+T` opens a new tab.
  - [ ] `Cmd+W` closes active tab; on the last tab it opens a fresh chat (configurable) rather than killing the window.
  - [ ] `Cmd+Shift+T` reopens the most recently closed tab with its label restored.
  - [ ] `Cmd+1..9` jumps to tab N; `Cmd+9` jumps to last when fewer than 9 exist.
  - [ ] `Cmd+,` opens `/settings`.
  - [ ] `Cmd+K` opens the command palette.
  - [ ] `Cmd+/` opens the cheatsheet overlay.
  - [ ] `Cmd+R` reloads renderer.
  - [ ] `Cmd+0/+/-` zooms.
- [ ] Automated (Playwright Electron):
  - [ ] After `keyboard.press("Meta+T")`, expect a new entry in `[data-testid=session-tab]`.
  - [ ] After `keyboard.press("Meta+W")`, expect the active tab to be removed.
  - [ ] After `keyboard.press("Meta+Shift+T")`, expect the closed tab to return with its label.
  - [ ] Open menu programmatically via `electronApp.evaluate(({Menu}) => Menu.getApplicationMenu()?.items[1].submenu?.items.map(i => i.label))` and snapshot.
- [ ] Web Playwright: registry actions still fire via their non-reserved chords (`Cmd+Shift+Arrow`).

---

## Phase 4 — Custom title bar + window chrome

**Goal:** A distinct, polished window chrome that works on all three platforms.

### Requirements
- R4.1 BrowserWindow opts: `frame: false`, `titleBarStyle: "hiddenInset"` (mac), `titleBarOverlay` (win), `trafficLightPosition` (mac).
- R4.2 `<TitleBar />` renders only when `useIsElectron()` is true; the web build keeps its current chrome.
- R4.3 Draggable regions don't trap clicks on interactive children (`WebkitAppRegion: no-drag` opt-out on buttons).
- R4.4 Title bar shows: workspace icon + name, active session title, right-aligned: workspace switcher, settings cog, (win/linux only) minimize/maximize/close.
- R4.5 Theme-aware: respects the existing `[data-theme]` palette.

### Tasks
- [ ] BrowserWindow construction with the three platform variants.
- [ ] `components/chrome/TitleBar.tsx` (drag region, layout, theming).
- [ ] `components/chrome/TrafficLights.tsx` for win/linux (lucide-react minimize/maximize/close icons → IPC `window.minimize/maximize/close`).
- [ ] Render `<TitleBar />` in `app/layout.tsx` above `UpdaterBanner` + `CustomizationBanner`.
- [ ] Verify the rail (`SideNav`) starts below the title bar without overlap.

### Tests
- [ ] Manual: drag the title bar moves the window on all three OSes.
- [ ] Manual: traffic lights minimize/maximize/close window on mac; corresponding buttons work on win/linux.
- [ ] Manual: theme switch updates title bar colors live.
- [ ] Automated (Playwright Electron): snapshot of title bar per platform with both light and dark themes (gated to platform-matching runners).
- [ ] Automated: `data-testid=titlebar` exists in Electron, absent in web.

---

## Phase 5 — Command palette (Cmd+K)

**Goal:** A discoverable cross-cut launcher that works in both runtimes.

### Requirements
- R5.1 Triggered by `nav.commandPalette` (`Cmd+K`); registered as a normal shortcut action.
- R5.2 Searches across: nav destinations, open sessions, slash commands, agent names, skill names, keybindings.
- R5.3 Closes on `Escape`, outside click, or selection.
- R5.4 Same component used in web and Electron; no Electron-only code paths.

### Tasks
- [ ] `components/overlays/CommandPalette.tsx` — fuzzy search (reuse the existing fuzzy match if any; else a simple `score = matchedRanges.length / target.length`).
- [ ] Sources:
  - [ ] Nav items from `SideNav` config
  - [ ] Open sessions from `useSession()`/`/api/sessions`
  - [ ] Slash commands from `lib/shared/slash-commands.ts` (already exists)
  - [ ] Agents from `/api/agents`, skills from `/api/skills`
  - [ ] Shortcuts from `lib/client/shortcuts.ts` registry
- [ ] Render in `app/layout.tsx` (portal pattern) so it's available on every route.

### Tests
- [ ] Manual: `Cmd+K` opens; typing "git" surfaces `/git` and `git.*` slash commands; `Enter` activates.
- [ ] Manual: `Esc` closes; outside click closes; selection closes.
- [ ] Automated: Playwright (both projects) — press Cmd+K, type "skills", assert at least one result row, press Enter, expect navigation to `/skills` page.

---

## Phase 6 — OS notifications + dock/taskbar badge

**Goal:** Surface high-priority agent events through the OS, not just the favicon.

### Requirements
- R6.1 `lib/client/useNotifications.ts` fires `window.claudius?.notifications.show(...)` for `ask-user-question`, `permission-request`, and `agent-finished` **only when `document.hidden`** (don't double-notify when the user is looking at the window).
- R6.2 Clicking an OS notification focuses the window and dispatches `switchSession(sessionId)` (deep-linked via IPC).
- R6.3 `useFaviconBadge` fires `window.claudius?.badge.set(unread)` in addition to favicon updates.
- R6.4 `app.setBadgeCount(n)` on mac, `mainWindow.setOverlayIcon(...)` on Windows, best-effort on Linux (Unity launcher).
- R6.5 Setting in `/settings`: "Show OS notifications when window is hidden" (default on).

### Tasks
- [ ] `electron/ipc/notifications.ts` — handle `notify`, build `new Notification(...)`, on click `mainWindow.show() + send("notification:click", sessionId)`.
- [ ] `electron/ipc/badge.ts` — `app.setBadgeCount` / `setOverlayIcon` per platform.
- [ ] Modify `lib/client/useFaviconBadge.ts` to also call `window.claudius?.badge.set(n)`.
- [ ] Modify `lib/client/useNotifications.ts` to also call `window.claudius?.notifications.show(...)`.
- [ ] New settings card in `app/settings/page.tsx` for OS notification preferences.

### Tests
- [ ] Manual: hide window, send a session a `/ask` prompt, OS notification appears, clicking it focuses the window on that session.
- [ ] Manual: notifications **do not** fire when window is focused.
- [ ] Manual: badge increments when a hidden session finishes a turn; clears when read.
- [ ] Automated (Playwright Electron): stub `Notification` constructor, dispatch a fake `ask-user-question`, expect `Notification` called with the expected `title`/`body`/`sessionId`.
- [ ] Automated: stub `app.setBadgeCount` via `electronApp.evaluate`, assert it's called with the unread count.

---

## Phase 7 — Auto-update

**Goal:** Packaged app auto-updates via `electron-updater`; web build keeps its existing updater banner.

### Requirements
- R7.1 `electron-builder.yml` `publish` block configured (GitHub Releases by default).
- R7.2 `electron/ipc/updater.ts` wraps `autoUpdater.checkForUpdates()` / `downloadUpdate()` / `quitAndInstall()`.
- R7.3 IPC events `checking | available | downloading (with progress) | downloaded | error` surface via `updater.onStatus`.
- R7.4 In Electron, `lib/server/updater/*` is short-circuited to delegate to the IPC bridge; the banner uses the IPC state.
- R7.5 Mac builds are signed + notarized; Windows builds are signed; Linux .deb is GPG-signed.

### Tasks
- [ ] `electron/ipc/updater.ts` wrapper around `electron-updater`.
- [ ] Configure `publish` in `electron-builder.yml`.
- [ ] Modify `components/banners/UpdaterBanner.tsx` to subscribe to `window.claudius?.updater.onStatus(...)` when present.
- [ ] Modify `lib/server/updater/*` to no-op when `process.env.CLAUDIUS_PACKAGED === "1"`.
- [ ] Signing/notarization scaffolding: env vars `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

### Tests
- [ ] Manual end-to-end: build `v0.0.1-test`, install, then build `v0.0.2-test` to a private GH release; relaunch `v0.0.1-test` and watch update download + install.
- [ ] Automated (Playwright Electron): stub `electron-updater`, fire `update-available` and `update-downloaded`, assert the banner reflects state transitions.
- [ ] Build verification: `spctl -a -vv "Claudius.app"` accepts the notarized binary on mac.
- [ ] Build verification: `signtool verify /pa Claudius.exe` succeeds on Windows.

---

## Phase 8 — Deep links + dialogs + drag-drop

**Goal:** Native entry points into the app — `claudius://` URLs, "Open Workspace…" dialog, dock-drop folders.

### Requirements
- R8.1 `app.setAsDefaultProtocolClient("claudius")` registered.
- R8.2 `claudius://workspace/<id>?session=<id>` opens the right workspace + session, both warm and cold start.
- R8.3 `app.on("open-file")` (mac) and `second-instance` (win/linux) handle cold-start payloads.
- R8.4 "Open Workspace…" menu item invokes `dialog.showOpenDialog({ properties: ["openDirectory"] })` and POSTs to `/api/workspaces`.
- R8.5 Drag-drop a folder onto the dock icon (mac) or app window adds it as a workspace.

### Tasks
- [ ] `electron/ipc/deep-links.ts` — parse URLs, queue until renderer is ready, then `webContents.send("deeplink:open", url)`.
- [ ] `electron/ipc/dialogs.ts` — `openWorkspace`, `openFile(filters?)`.
- [ ] Renderer subscriber in `lib/client/useElectron.ts` for `deepLinks.onOpen`.
- [ ] Wire `/files` page's file picker through `window.claudius?.dialog.openFile()` when present.
- [ ] Title-bar drop handler: on `drop`, take the dropped path → POST `/api/workspaces`.
- [ ] mac `open-file` handler in `electron/main.ts`.

### Tests
- [ ] Manual cold-start: `open "claudius://workspace/abc?session=def"` from terminal → app launches and lands on that session.
- [ ] Manual warm-start: same URL while app is open → focuses + navigates.
- [ ] Manual: "File → Open Workspace…" picks a folder, the workspace appears in the rail.
- [ ] Manual: drag a folder onto the title bar → workspace added.
- [ ] Automated (Playwright Electron): send a fake `second-instance` event with a deep-link arg, assert renderer navigation.

---

## Phase 9 — Per-screen verification & wiring

**Goal:** Every page in the app renders + functions correctly inside Electron.

### Requirements
- R9.1 Each screen has at least one smoke test (manual or automated) confirming it renders without console errors in Electron.
- R9.2 Where natural, native affordances replace web-only equivalents (e.g. file picker → `dialog.openFile`).
- R9.3 All three SSE endpoints reconnect cleanly after `Cmd+R` and after sleep/wake.

### Tasks (workspace-scoped — `app/[workspaceId]/`)
- [ ] `/` (Chat) — tabs, image paste, file drag-drop attach
- [ ] `/sessions`
- [ ] `/sessions/[id]`
- [ ] `/files` (use `dialog.openFile` when present)
- [ ] `/git` (verify `git` is on PATH; show a doctor warning if not)
- [ ] `/memory`
- [ ] `/assets`
- [ ] `/cost`
- [ ] `/agents`
- [ ] `/skills`
- [ ] `/mcp` (stdio servers spawn from main; env inherited)
- [ ] `/hooks`
- [ ] `/schedule` (SSE for run output)
- [ ] `/permissions`
- [ ] `/docker` (customization-gated)
- [ ] `/tracker` (customization-gated)
- [ ] `/database` (customization-gated)
- [ ] `/notebooks` (customization-gated)
- [ ] `/workspace`
- [ ] `/keybindings` (banner: "Some chords owned by app menu")
- [ ] `/dev/ask-rail-preview`
- [ ] `/dev/chat-ask`
- [ ] `/dev/chat-empty`
- [ ] `/dev/chat-todos`
- [ ] `/dev/chat-verbose`
- [ ] `/dev/minecraft-preview`
- [ ] `/dev/tool-call-preview`

### Tasks (global — `app/*`)
- [ ] `/settings` (add Electron tab: notifications, auto-update, default protocol)
- [ ] `/plugins`
- [ ] `/doctor` (add: Electron version, Chromium version, native-module status, code-sign status, dock-badge support)
- [ ] `/usage`
- [ ] `/community`
- [ ] `/customize` + `/customize/[id]` + `/customize/settings` (verify `preview-server.ts` works under `asarUnpack`)
- [ ] `/release-notes`
- [ ] `/updater` (delegates to `window.claudius.updater` in Electron)

### Tasks (bare-path redirect stubs)
- [ ] No code changes — middleware redirects still apply.

### Tests
- [ ] Run the full existing Playwright suite under the `chromium-electron` project — if it passes, every API route is wired.
- [ ] Manual sweep checklist (the page lists above) — open each, no console errors, primary action works.
- [ ] SSE reconnect:
  - [ ] `Cmd+R` then verify `/api/notifications/stream` resumes within 2s.
  - [ ] Sleep laptop for 10s, wake, verify `/api/sessions/[id]/stream` resumes (auto-reconnect logic in `use-session.ts`).
- [ ] Verify each customization-gated page renders only when its customization is enabled.

---

## Phase 10 — Tests (infrastructure)

**Goal:** A `chromium-electron` Playwright project that runs alongside the existing web project on every CI run.

### Requirements
- R10.1 New Playwright project `chromium-electron` uses `_electron.launch({ args: ["dist-electron/main.js"], env: { CLAUDIUS_PACKAGED: "1" } })`.
- R10.2 The existing `chromium` web project continues to pass without changes.
- R10.3 CI runs both projects on every PR (mac + linux runners minimum; win nightly).
- R10.4 Test helpers exist for: window resolution, opening palette, opening menu, asserting tab state.

### Tasks
- [ ] Add the new Playwright project in `playwright.config.ts`.
- [ ] Helpers: `electron/test-utils/launch.ts`, `electron/test-utils/menu.ts`, `electron/test-utils/tabs.ts`.
- [ ] Convert key existing specs to run in both projects (parametrize on browser type vs Electron launch).
- [ ] CI: extend `.github/workflows/e2e.yml` (or equivalent) with a job per OS.

### Tests
- [ ] CI: both projects green on PR.
- [ ] Smoke: `bun run test:e2e -- --project=chromium-electron` runs locally.
- [ ] Lint: `bun run lint electron tests/electron` clean.

---

## Phase 11 — Packaging, signing, CI

**Goal:** Reproducible signed artifacts for mac (intel+arm64), Windows (x64), and Linux (x64) on every tag.

### Requirements
- R11.1 `electron-builder.yml` mac target with `hardenedRuntime: true`, `entitlements: build/entitlements.mac.plist`, `notarize: { teamId }`.
- R11.2 Windows EV cert (preferred) for SmartScreen bypass; otherwise document the warning.
- R11.3 Linux .deb GPG-signed.
- R11.4 `latest-mac.yml` / `latest.yml` / `latest-linux.yml` published for `electron-updater` feed.
- R11.5 GH Actions workflow `electron-release.yml`: triggered on `v*` tag, OS matrix, signed artifacts uploaded.
- R11.6 Native module rebuilds verified per OS × arch.

### Tasks
- [ ] Provision mac Developer ID + notarization secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).
- [ ] Provision win signing cert (`WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`).
- [ ] Provision Linux GPG key (`LINUX_GPG_KEY`, `LINUX_GPG_PASSPHRASE`).
- [ ] Write `.github/workflows/electron-release.yml` with mac-13/mac-14-arm/ubuntu-latest/windows-latest runners.
- [ ] Wire the `publish` block in `electron-builder.yml` to GitHub Releases.
- [ ] Document the release process in `RELEASING.md`.

### Tests
- [ ] CI: tagging `v1.0.0-rc1` produces signed artifacts on all OSes within 30 min.
- [ ] Manual: install `.dmg` on a clean mac profile, `spctl -a -vv` passes, no "downloaded from internet" Gatekeeper bypass needed.
- [ ] Manual: install `.exe` on a clean Windows VM, `signtool verify /pa` passes, no unsigned warning.
- [ ] Manual: install `.deb` on Ubuntu 22.04, `apt install ./Claudius.deb` succeeds, signature verified.
- [ ] Manual: `latest-mac.yml` URL is reachable and parseable by `electron-updater`.

---

## Phase 12 — Docs & rollout

**Goal:** Users can install and learn the new app; we cut a clean beta release.

### Requirements
- R12.1 `README.md` updated with install paths per OS and a keyboard cheatsheet.
- R12.2 `CHANGELOG.md` entry summarizes the conversion.
- R12.3 Marketing screenshots refreshed to include the new chrome.
- R12.4 A private beta channel tests the auto-updater loop before public release.

### Tasks
- [ ] Update `README.md` (install, keyboard cheat-sheet, screenshots).
- [ ] Append to `CHANGELOG.md`.
- [ ] `bun run site:screenshots` to refresh marketing PNGs.
- [ ] Cut tag `v1.0.0-electron-beta` → private channel.
- [ ] Collect a week of telemetry/crash reports.
- [ ] Promote to `v1.0.0` once green.

### Tests
- [ ] Manual: a teammate follows `README.md` from scratch, installs on a fresh machine, completes a chat session.
- [ ] Manual: auto-updater loop validated: install `1.0.0-beta.1`, ship `1.0.0-beta.2`, app updates on relaunch.
- [ ] Manual: screenshot diff shows the new title bar across all themes.

---

## Critical files to read before starting each phase

| Phase | Read first |
|---|---|
| 1 (embed Next) | `next.config.ts`, `middleware.ts`, `lib/server/db.ts`, `lib/server/runtime-dir.ts` |
| 2 (IPC) | `lib/client/shortcuts.ts` |
| 3 (menu + chords) | `lib/client/shortcuts.ts`, `components/chat/SessionTabs.tsx`, `components/nav/SideNav.tsx`, `lib/client/use-session.ts` |
| 4 (title bar) | `app/layout.tsx`, `components/nav/WorkspaceSwitcher.tsx` |
| 5 (palette) | `components/chat/SlashCommandPicker.tsx`, `lib/client/shortcuts.ts` |
| 6 (notifications) | `lib/client/useFaviconBadge.ts`, `lib/client/useNotifications.ts`, `lib/server/notification-bus.ts` |
| 7 (updater) | `lib/server/updater/*`, `components/banners/UpdaterBanner.tsx` |
| 8 (deep links) | `middleware.ts`, `app/api/workspaces/route.ts` |
| 9 (per-screen) | each page under `app/[workspaceId]/`, plus the 3 SSE routes |
| 10 (tests) | `playwright.config.ts`, `tests/e2e/**` |
| 11 (packaging) | `package.json` `build` block, electron-builder docs |

---

## Reuse — don't reinvent

- `lib/client/shortcuts.ts` — already a real keybinding registry with platform abstraction, collision detection, and a settings UI. All new chords go through it.
- `components/chat/SessionTabs.tsx` — already renders tabs, persists via `/api/sessions/open-tabs`, handles overflow. Extend.
- `lib/server/open-tabs-db.ts` — persists open tabs; "reopen closed" needs only an in-memory undo stack on top.
- `lib/server/notification-bus.ts` + `/api/notifications/stream` — feed OS notifications from here; no new pipeline.
- `lib/client/useTabClaim.ts` — already coordinates session ownership across browser tabs via `BroadcastChannel`. Single-window Electron doesn't need replacement.
- `lib/server/preview-server.ts` — already spawns a nested `next dev`; the only Electron-specific change is `asarUnpack` for the Next binary.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `better-sqlite3` ABI mismatch (built for Node, not Electron) | `postinstall: electron-builder install-app-deps`; CI rebuild per platform |
| `preview-server.ts` spawning `next dev` fails inside `asar` | `asarUnpack: ["node_modules/next/**", "node_modules/.bin/next"]` |
| Hardened-runtime + JIT for V8 in child Next process | Entitlement `com.apple.security.cs.allow-jit` in `entitlements.mac.plist` |
| SSE keep-alive over loopback buffering | Add `X-Accel-Buffering: no` (already present); integration test for token streaming |
| `git` not on PATH in packaged mac | `/doctor` warns; fallback to bundled `isomorphic-git` for read-only ops |
| `Cmd+W` closes window when no tabs left | If last tab, open a fresh chat instead; user setting to override |
| Browser build regressions | Keep `bun run test:e2e` green; every IPC call site has a documented fallback |
| Mac native-module signing | electron-builder handles via `asarUnpack`; verify `codesign --verify --deep` post-build |
| Windows SmartScreen warning without EV cert | Document; budget EV cert (~$300/yr) |

---

## Verification — end-to-end happy path

1. **Browser parity (unchanged):** `bun run dev` → `bun run test:e2e` passes; `bun run build && bun run start` smokes the 10 marketing routes.
2. **Electron dev:** `bun run electron:dev` → window opens. Manually verify: `Cmd+T`, `Cmd+W`, `Cmd+Shift+T`, `Cmd+1..9`, `Cmd+K`, menu items, OS notification with window hidden, dock badge live, drag-drop folder onto title bar.
3. **Per-screen sweep:** click through every entry in Phase 9. No console errors; SSE streams reconnect after `Cmd+R`; file dialogs return real paths; deep links route correctly.
4. **Packaged smoke:** `bun run electron:dist:mac` → install the `.dmg` on a clean profile → first-run, auto-update check, `spctl -a -vv Claudius.app` passes.
5. **Triple-platform CI:** push release tag → GH Actions produces signed mac/win/linux artifacts and updates `latest*.yml`.
6. **Auto-update loop:** ship `1.0.1-beta`, install `1.0.0-beta` from fresh `.dmg`, confirm in-app updater detects → downloads → quit-and-installs.

---

## Out of scope (followups)

- Multi-window detach (Chrome-style tab tear-off)
- Touch Bar items on macOS
- Native macOS share menu / Quick Look integration
- Tray icon + background mode (scheduler firing with window closed — needs design)
- Replacing `localhost` with `file://` + custom protocol for the renderer (would break SSE)

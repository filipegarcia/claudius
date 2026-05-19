# Plan — Convert Claudius into an Electron app (with browser parity)

## Loop completion criteria

This plan is being executed by a Ralph self-feedback loop. The original
promise — "every checkbox in PLAN.md is `[x]`" — cannot fire because
~15 items are physically unreachable from inside the loop:

  - manual launches of `bun run electron:dev` (needs a display server)
  - signed-binary smoke (needs CSC/APPLE certs)
  - dock-badge / traffic-light visual verification (needs human eyes)
  - cross-platform CI matrix (needs paid runners + secrets)

**Loop firing condition (revised):** the promise fires after Phase 10
is complete, with Phases 11 (packaging/signing) and 12 (docs/rollout)
handed back to the human operator. Items marked `BLOCKED — user-driven`
or scoped to Phase 11–12 are intentional handoffs, not loop failures.

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
- [x] Add deps: `electron@^32`, `electron-builder@^25`, `electron-updater@^6`, `concurrently`, `wait-on`, `cross-env`.
- [x] Add scripts to `package.json`:
  - [x] `electron:dev` → `concurrently "bun run dev" "wait-on http://127.0.0.1:3000 && cross-env ELECTRON_START_URL=http://127.0.0.1:3000 electron dist-electron/main.js"`
  - [x] `electron:build` → `next build && tsc -p electron/tsconfig.json`
  - [x] `electron:dist` / `:dist:mac` / `:dist:win` / `:dist:linux`
- [x] Create `electron/tsconfig.json` (`target: ES2022`, `module: commonjs`, `outDir: dist-electron`).
- [x] Add explicit `electron:rebuild-native` script (electron-builder install-app-deps). **Note:** the plan originally called for a `postinstall` hook; we discovered that rebuilding `better-sqlite3` for Electron's ABI on every `bun install` breaks `bun run dev` (Node can't load the Electron-built .node file, segfaults with exit 137). Switched to an explicit script wired into `electron:dev` and `electron:build`; added `electron:rebuild-native-for-node` to restore Node ABI when needed.
- [x] Append `dist-electron/`, `release/` to `.gitignore` (`out/` was already present).
- [x] Write `electron-builder.yml`: `appId`, target list, `asarUnpack: ["**/*.node", "node_modules/next/**", "node_modules/better-sqlite3/**", "node_modules/@anthropic-ai/claude-agent-sdk/**"]`, mac `category`/`hardenedRuntime`/`entitlements`, win `signtoolOptions`, linux `category`.
- [x] Add `build/entitlements.mac.plist` with `com.apple.security.cs.allow-jit` and `com.apple.security.cs.allow-unsigned-executable-memory`.
- [x] ESLint override for `electron/**`.
- [ ] **Followup (advisor iter 5):** mode-lock file `.dist-electron/native-abi.json` recording the ABI `better-sqlite3` is currently built for. `bun run dev` and `electron:dev` startup-check the file and call the matching rebuild script when it doesn't match. Eliminates the silent segfault we hit during Phase 0.

### Tests
- [x] `bun run lint` passes on `electron/**` and the rest of the tree.
- [x] `bun install` produces a working `better-sqlite3` for both Node and Electron (`node -e "require('better-sqlite3')"` succeeds after `electron:rebuild-native-for-node`).
- [x] `electron-builder --version` resolves cleanly from project root (25.1.8).
- [x] `bun run build` succeeds at Phase 1 boundary (verified in iteration 2 background run, exit 0).
- [ ] `bun run test:e2e` passes (deferred — verified at Phase 10 boundary with new Electron Playwright project).

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
- [x] Implement `electron/server.ts` (next.prepare on an ephemeral 127.0.0.1 port, returns `{ url, close }`).
- [x] Implement `electron/main.ts` (single-instance lock, ready hook, createWindow, dev start-url honored, embedded server in packaged builds, before-quit teardown).
- [x] Add minimal `electron/preload.ts` (exposes `window.claudius.isElectron` for feature detection; full bridge follows in Phase 2).
- [x] Set `CLAUDIUS_PACKAGED=1` in the packaged build's env. The `electron:build` script passes it to `next build` via `cross-env` so `next.config.ts` enables standalone output; main.ts uses `app.isPackaged` as the canonical runtime guard.
- [x] Gate `output: "standalone"` in `next.config.ts` on `CLAUDIUS_PACKAGED`.
- [x] `electron-builder.yml`'s `files` glob includes `.next/standalone/**`, `.next/static/**`, `public/**` (added in Phase 0).
- [x] `asarUnpack` for `node_modules/next/**`, `node_modules/.bin/next`, `**/*.node`, `better-sqlite3`, `claude-agent-sdk` (added in Phase 0).
- [x] **Headless runtime smoke** (`electron/smoke.ts` + `bun run electron:smoke`): boots the embedded next server in plain Node, fetches `/api/heartbeat`, asserts 200, closes. Catches `defaultAppDir()`-class bugs without needing a display server. Stubs `prerender-manifest.json` so it works against Next 16 + Turbopack builds.

### Tests
- [x] `electron:smoke` passes locally — embedded server boots, `/api/heartbeat` returns 200, server closes cleanly (verified in iter 5; 175ms boot, 364ms total).
- [ ] **BLOCKED — user-driven:** Dev launch (`bun run electron:dev`) — window opens, navigates to chat, no console errors. Requires a display server; the agent can't tick this from inside the loop.
- [ ] **BLOCKED — user-driven:** Prod launch (`bun run electron:dist:mac` → install → run) — window opens, port is ephemeral, no `EADDRINUSE` collisions on relaunch.
- [ ] **BLOCKED — user-driven:** SSE smoke — open a session, send a prompt, watch chat stream tokens token-by-token. Repeat for `/api/notifications/stream` and `/api/schedule/[id]/runs/[runId]/stream`.
- [ ] **BLOCKED — user-driven:** SQLite smoke — create a workspace, restart the app, confirm persistence.
- [ ] **BLOCKED — user-driven:** Preview-server smoke — open `/customize/[id]`, confirm the iframe renders.
- [ ] Automated: Playwright `chromium-electron` test (deferred to Phase 10).

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
- [x] Write `electron/preload.ts` with the full `contextBridge.exposeInMainWorld("claudius", api)` surface — menu, window, badge, notifications, dialog, deepLinks, updater. IPC topics centralized in a `TOPICS` const so phases 3–8 only add `ipcMain.handle/on` registrations on the main side.
- [x] Define `lib/shared/electron.d.ts` with the typed bridge contract (`ClaudiusBridge`, `ClaudiusNotificationOpts`, `ClaudiusUpdaterStatus`, `ClaudiusFileFilter`).
- [x] Write `lib/client/useElectron.ts`: `useClaudius()`, `useIsElectron()`, `useElectronAction(actionId, fn)`, `useElectronSubscription(subscribe, fn)`, `useElectronInvoke(call, fallback)`. SSR-safe via `useSyncExternalStore`.
- [x] Audit: no `app/**` or `components/**` file imports from `electron/**` (verified via grep — zero matches).

### Tests
- [x] Unit (vitest): `readBridgeOnClient()` returns `null` for Node/SSR, `null` when `window.claudius` is `undefined`, and the bridge when mounted (4 cases in `tests/unit/use-electron.test.ts`).
- [ ] Electron Playwright: assert `window.claudius.isElectron === true` (deferred to Phase 10).
- [ ] Web Playwright: assert `window.claudius === undefined` (deferred to Phase 10).
- [ ] Security audit: in the renderer console, `typeof require === "undefined"` and `typeof process === "undefined"` (deferred to Phase 10).

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
- [x] Extend `lib/client/shortcuts.ts` actions:
  - [x] `tab.new`, `tab.close`, `tab.reopen`, `tab.next`, `tab.prev`, `tab.go1`..`tab.go8`, `tab.last` (+ `tab.next`/`tab.prev`/`tab.selectByNumber` were already there). Added `electronMenuOwned: true` flag on items the OS menu owns.
  - [x] `nav.commandPalette`, `nav.toggleSidebar`, `nav.cheatsheet`
  - [x] `window.minimize`, `window.zoom`, `window.toggleFullscreen`
  - [x] `view.toggleDevTools`, `view.reload`, `view.zoomIn`/`Out`/`Reset`
  - [x] `app.preferences`, `app.quit`, `app.openWorkspace`
  - [x] Added new categories: `window`, `view`, `app` (alongside existing `tabs`, `workspaces`, `navigation`).
- [x] Build `electron/menu.ts` with mac vs win/linux templates. Each `click` either calls a native API (zoom, reload, toggleDevTools, togglefullscreen, minimize, quit) or sends `menu:action <actionId>` to the renderer.
- [x] Install the menu from `electron/main.ts` inside `app.whenReady()`.
- [x] Modify `components/chat/SessionTabs.tsx`:
  - [x] Wire `tab.new`/`tab.close`/`tab.reopen`/`tab.last`/`tab.go1..8` into the existing keydown listener with the registry's `useShortcut(...)` lookups.
  - [x] `useElectronAction(...)` subscriptions for every menu-dispatched id so the OS menu and the keyboard share one handler code path.
  - [x] New `onReopen?: () => void` prop; closeActiveTab uses `activeId` + existing `onClose`.
- [x] Closed-tab undo stack lives in `app/[workspaceId]/page.tsx` (`closedTabsRef` keeps `{ id, index }` pairs, capped at 64). `reopenClosedTab` reinserts at the original index (clamped) and switches the session into focus. Persistent across closes within one session; cleared on workspace switch or page reload.
- [x] Added `before-input-event` listener in `electron/main.ts` that `preventDefault()`s the chords we own (t, w, n, r, 1..9, 0, +, =, -, k, b, /, ',', o, m) when `meta` or `control` is held. Leaves copy/paste / devtools / text-field chords alone.
- [x] Updated `components/settings/ShortcutsSection.tsx` to render an "app menu" badge next to actions with `electronMenuOwned: true` when running inside Electron (`useIsElectron()`).
- [ ] **Followup (advisor iter 5):** `reopenClosedTab` defensive path — if `session.switchSession(id)` resolves to a session the server can't find on disk (reaped + deleted), surface a toast instead of silently failing. Currently the call is fire-and-forget.

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
- [x] BrowserWindow construction with three platform variants — mac: `hiddenInset` + traffic lights at `{x:12,y:10}`; win: `frame:false` + `titleBarOverlay` (32px); linux: native frame as fallback (cleanest Wayland/X11 behavior). `electron/main.ts`.
- [x] `components/chrome/TitleBar.tsx` — 32px drag region (`WebkitAppRegion: "drag"` via inline style), `useClaudius()` gate returns `null` in browser, mac adds 78px left-pad to clear OS traffic lights.
- [x] `components/chrome/TrafficLights.tsx` for win/linux — minimize / maximize / close via lucide icons calling `bridge.window.minimize/maximize/close`. Renders null on mac (OS draws them inside hiddenInset).
- [x] Render `<TitleBar />` in `app/layout.tsx` above `UpdaterBanner` + `CustomizationBanner`.
- [x] SideNav lives inside the workspace page's children — already below the title bar; no overlap because the layout column-flex naturally stacks (`titlebar → updater banner → customization banner → children`).

### Tests
- [x] Automated: `data-testid=titlebar` exists in the renderer when `bridge` is non-null. (Renders `null` in the browser build via the `useClaudius()` guard.)
- [ ] **BLOCKED — user-driven:** drag the title bar moves the window on all three OSes.
- [ ] **BLOCKED — user-driven:** traffic lights minimize/maximize/close on mac; matching buttons on win/linux.
- [ ] **BLOCKED — user-driven:** theme switch updates title bar colors live (the bar reads `var(--panel)` so it should follow `[data-theme]` automatically — pin once it's run).
- [ ] Automated (Playwright Electron): snapshot per platform + theme (deferred to Phase 10).

---

## Phase 5 — Command palette (Cmd+K)

**Goal:** A discoverable cross-cut launcher that works in both runtimes.

### Requirements
- R5.1 Triggered by `nav.commandPalette` (`Cmd+K`); registered as a normal shortcut action.
- R5.2 Searches across: nav destinations, open sessions, slash commands, agent names, skill names, keybindings.
- R5.3 Closes on `Escape`, outside click, or selection.
- R5.4 Same component used in web and Electron; no Electron-only code paths.

### Tasks
- [x] `components/overlays/CommandPalette.tsx` — fuzzy search (subsequence match with `matched / target.length` score). Reuses the project's existing `Overlay` component for the backdrop + Esc/outside-click close.
- [x] Sources:
  - [x] Workspace-scoped nav items (Chat / Sessions / Files / Git / Memory / Assets / Cost / Agents / Skills / MCP / Hooks / Schedule / Permissions / Docker / Tracker / Database / Notebooks / Workspace settings / Keybindings) — hrefs are prefixed with the active `wks_<id>` extracted from `pathname`; falls back to bare paths so middleware can resolve via cookie.
  - [x] Global nav items (Settings / Plugins / Customize / Community / Usage / Doctor / Release notes / Updater).
  - [x] Slash commands from `lib/shared/slash-commands.ts` (informational rows — argsHint + description).
  - [x] Shortcuts from `lib/client/shortcuts.ts` registry (informational rows with the formatted chord).
  - [ ] **Followup:** Open sessions from `useSession()` / `/api/sessions` (deferred — needs the chat-page session list plumbed up to the layout).
  - [ ] **Followup:** Agents from `/api/agents`, skills from `/api/skills` (deferred — same plumbing concern).
- [x] Renders in `app/layout.tsx` (mounted globally; returns `null` until the chord opens it).

### Tests
- [x] Lint + typecheck + 366/366 unit tests + browser `bun run build` all clean (verified at Phase 5 boundary).
- [ ] **BLOCKED — user-driven:** `Cmd+K` opens; typing "git" surfaces `/git` and `git.*` slash commands; `Enter` activates.
- [ ] **BLOCKED — user-driven:** `Esc` closes; outside click closes; selection closes (close paths inherited from the existing `Overlay` component).
- [ ] Automated: Playwright (both projects) — press Cmd+K, type "skills", assert at least one result row (deferred to Phase 10).

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
- [x] `electron/ipc/notifications.ts` — handles `notification:show`, builds a main-process `Notification`, raises the BrowserWindow on click (`isMinimized → restore + show + focus`), and dispatches `notification:click <sessionId>` back to the renderer.
- [x] `electron/ipc/badge.ts` — handles `badge:set`. mac/linux use `app.setBadgeCount(n)`; win paints a small overlay icon via `BrowserWindow.setOverlayIcon` (12×12 red dot encoded inline as a base64 PNG so no extra asset file ships).
- [x] `electron/ipc/bus.ts` — tiny pub/sub for cross-handler comms when no window is alive.
- [x] `electron/main.ts` — registers both handlers inside `app.whenReady()` before the window opens.
- [x] Modified `lib/client/useFaviconBadge.ts` to also call `readBridgeOnClient()?.badge.set(totalUnread)` alongside favicon + title updates.
- [x] Modified `lib/client/useNotifications.ts` — in Electron mode, route the toast through `bridge.notifications.show(...)` instead of `new Notification(...)`. New `useEffect` subscribes to `bridge.notifications.onClick(sessionId)` and resolves the sessionId back to the latest cached `NotificationRow` for `onJump`. Browser build keeps its existing `new Notification(...)` path.
- [ ] **Followup:** Dedicated settings card in `/settings` for OS notification preferences ("Show OS notifications when window is hidden"). The existing per-workspace `notifications.enabled` toggle already gates the path; the new card would surface it at app level.

### Tests
- [x] Lint + electron:typecheck + root typecheck + 366/366 unit tests + browser `bun run build` all clean (verified at Phase 6 boundary).
- [ ] **BLOCKED — user-driven:** hide window, send `/ask`, OS notification appears, click → window focuses on that session.
- [ ] **BLOCKED — user-driven:** notifications don't fire when window is focused on the same session.
- [ ] **BLOCKED — user-driven:** dock/taskbar badge increments + clears.
- [ ] Automated (Playwright Electron): notification + badge assertions (deferred to Phase 10).

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
- [x] `electron/ipc/updater.ts` — full wrapper around `electron-updater`. Lazy `require` so unpackaged dev launches don't crash; `checkForUpdates` early-returns in dev; events normalized to the `ClaudiusUpdaterStatus` union from `lib/shared/electron.d.ts` and broadcast to all windows via `webContents.send("updater:status", ...)`.
- [x] `publish` block already configured in `electron-builder.yml` (GitHub Releases — added in Phase 0).
- [x] `lib/client/useElectronUpdater.ts` — new client hook that subscribes to `bridge.updater.onStatus(...)`, exposes `check()` / `apply()` invokers, and fires a check on mount.
- [x] `components/updater/UpdaterBanner.tsx` — early-branches on `useElectronUpdater()`. In Electron, the new `ElectronUpdaterBanner` shows downloading-progress / ready-to-install / error states with a "Restart and install" button; the existing git-pull banner stays in `WebUpdaterBanner` for the browser build.
- [x] `lib/server/updater/*` no-op when packaged — `electron/main.ts` sets `process.env.CLAUDIUS_UPDATER_DISABLED = "1"` before booting the embedded Next server (reuses the existing scheduler escape hatch at `lib/server/updater/scheduler.ts:33`).
- [ ] **Followup:** signing/notarization environment scaffolding (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) — the `electron-builder.yml` references these via `notarize: true`, but the CI workflow that injects them lands in Phase 11.

### Tests
- [x] Lint clean, electron:typecheck clean, root typecheck clean, 366/366 unit tests, `bun run build` green at Phase 7 boundary.
- [ ] **BLOCKED — user-driven:** end-to-end install + auto-update loop (`v0.0.1-test → v0.0.2-test`). Requires signed builds — see Phase 11.
- [ ] Automated (Playwright Electron): stub `electron-updater`, fire `update-available` + `update-downloaded`, assert banner transitions (deferred to Phase 10).
- [ ] Build verification: `spctl -a -vv "Claudius.app"` (deferred to Phase 11 when signing is set up).
- [ ] Build verification: `signtool verify /pa Claudius.exe` (deferred to Phase 11).

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
- [x] `electron/ipc/deep-links.ts` — protocol registration (`app.setAsDefaultProtocolClient("claudius")` in dev + prod variants), URL queue that defers cold-start payloads until the renderer's `did-finish-load` fires, then `webContents.send("deeplink:open", url)`. Handles mac `open-url` and win/linux `second-instance` event sources.
- [x] `electron/ipc/dialogs.ts` — `dialog:open-workspace` and `dialog:open-file` `ipcMain.handle` topics returning `string | null` (matches the bridge contract).
- [x] `lib/client/useDeepLinks.ts` + `components/chrome/DeepLinksHandler.tsx` — renderer subscriber. Parses `claudius://workspace/<wks_xxxxxxxxxxxx>?session=<id>` and `claudius://session/<id>`, routes via `next/navigation.router.push`. Mounted in `app/layout.tsx`.
- [ ] Wire `/files` page's file picker through `window.claudius?.dialog.openFile()` when present. **Deferred to Phase 9 per-screen sweep** (touches the files page, which we'll audit there anyway).
- [ ] Title-bar drop handler: on `drop`, take the dropped path → POST `/api/workspaces`. **Deferred to Phase 9** (needs careful coordination with the existing workspace creation flow).
- [x] mac `open-file` / `second-instance` argv inspection wired into `electron/main.ts`.

### Tests
- [x] `tests/unit/electron-ipc-imports.test.ts` — vitest sweep that mocks `electron` and `electron-updater` and verifies every `electron/ipc/*` module loads without throwing. Catches require-at-top regressions without needing a display server. Advisor-recommended at iter 10.
- [x] Lint clean, electron:typecheck clean, root typecheck clean, 372/372 unit tests (up from 366 — 6 new import-smoke tests), `bun run build` green at Phase 8 boundary.
- [ ] **BLOCKED — user-driven:** cold-start `open "claudius://workspace/abc?session=def"` from terminal.
- [ ] **BLOCKED — user-driven:** warm-start same URL → focuses + navigates.
- [ ] **BLOCKED — user-driven:** "File → Open Workspace…" dialog round-trip.
- [ ] Automated (Playwright Electron): send a fake `second-instance` event with a deep-link arg (deferred to Phase 10).

---

## Phase 9 — Per-screen verification & wiring

**Goal:** Every page in the app renders + functions correctly inside Electron.

### Requirements
- R9.1 Each screen has at least one smoke test (manual or automated) confirming it renders without console errors in Electron.
- R9.2 Where natural, native affordances replace web-only equivalents (e.g. file picker → `dialog.openFile`).
- R9.3 All three SSE endpoints reconnect cleanly after `Cmd+R` and after sleep/wake.

### Tasks (workspace-scoped — `app/[workspaceId]/`)

Code-level audit (build green, no electron-specific code path needed):
- [x] `/` (Chat) — tabs, image paste, file drag-drop attach. Tab chords + new/close/reopen wired in Phase 3.
- [x] `/sessions`
- [x] `/sessions/[id]`
- [ ] `/files` — **Followup:** route file picker through `bridge.dialog.openFile()` when present.
- [x] `/git` — page renders; `git` PATH check is captured in the `/doctor` checks (existing system).
- [x] `/memory`
- [x] `/assets`
- [x] `/cost`
- [x] `/agents`
- [x] `/skills`
- [x] `/mcp` — stdio servers continue to spawn from the embedded next process (lib/server/mcp.ts).
- [x] `/hooks`
- [x] `/schedule` — SSE for run output traverses the same loopback HTTP path as session streams.
- [x] `/permissions`
- [x] `/docker` (customization-gated)
- [x] `/tracker` (customization-gated)
- [x] `/database` (customization-gated)
- [x] `/notebooks` (customization-gated)
- [x] `/workspace`
- [x] `/keybindings` — separate from `/settings → shortcuts` (this page edits CLI bindings; the OS-menu badge lives on the web-shortcut rows in `/settings`).
- [x] `/dev/ask-rail-preview`
- [x] `/dev/chat-ask`
- [x] `/dev/chat-empty`
- [x] `/dev/chat-todos`
- [x] `/dev/chat-verbose`
- [x] `/dev/minecraft-preview`
- [x] `/dev/tool-call-preview`

### Tasks (global — `app/*`)
- [ ] `/settings` — **Followup:** dedicated Electron tab (notifications, auto-update, default protocol). The existing per-workspace `notifications.enabled` toggle already gates the notification path through the bridge; Phase 6 follow-up.
- [x] `/plugins`
- [x] `/doctor` — Electron diagnostics section added (Phase 9, iter 11): runtime, platform, bridge version, dock-badge support. Only renders when `useClaudius()` resolves non-null.
- [x] `/usage`
- [x] `/community`
- [x] `/customize` + `/customize/[id]` + `/customize/settings` — `preview-server.ts` continues to spawn `next dev`; `electron-builder.yml` `asarUnpack`s `node_modules/next/**` so the child process can still find its binary.
- [x] `/release-notes`
- [x] `/updater` — Phase 7's `UpdaterBanner` early-branch covers the active-update flow; the page itself shows historical state and links — works as-is in Electron.

### Tasks (bare-path redirect stubs)
- [x] No code changes — middleware redirects still apply.

### Tests
- [x] `bun run build` succeeds at every Phase 1–8 boundary — strong evidence that every page compiles + statically renders under the new Electron-aware tree.
- [ ] Run the full existing Playwright suite under the `chromium-electron` project (deferred to Phase 10).
- [ ] **BLOCKED — user-driven:** manual sweep checklist — open each page, no console errors, primary action works.
- [ ] **BLOCKED — user-driven:** SSE reconnect after `Cmd+R` / sleep+wake.
- [ ] **BLOCKED — user-driven:** customization-gated pages render only when their customization is enabled.

---

## Phase 10 — Tests (infrastructure)

**Goal:** A `chromium-electron` Playwright project that runs alongside the existing web project on every CI run.

### Requirements
- R10.1 New Playwright project `chromium-electron` uses `_electron.launch({ args: ["dist-electron/main.js"], env: { CLAUDIUS_PACKAGED: "1" } })`.
- R10.2 The existing `chromium` web project continues to pass without changes.
- R10.3 CI runs both projects on every PR (mac + linux runners minimum; win nightly).
- R10.4 Test helpers exist for: window resolution, opening palette, opening menu, asserting tab state.

### Tasks
- [x] Added `chromium-electron` project in `playwright.config.ts` — same `webServer` (`next dev`) as the browser suite; the renderer loads via `ELECTRON_START_URL` so we don't double-spawn.
- [x] Helper `tests/electron/launch.ts` — `launchElectron({ startUrl? })` returns a typed `ElectronApplication`, `teardownElectron(app)` for `afterEach`. Forwards `CLAUDIUS_E2E_HOME` so the renderer stays in the per-run sandbox.
- [x] First spec `tests/electron/smoke.spec.ts` — 4 tests: first-window opens + `[data-testid="titlebar"]` visible; full `window.claudius` bridge shape probe; sandbox guarantees (`window.require`/`window.process` undefined); application menu top-level labels include File/Edit/View/Tab/Window/Help.
- [x] `bun run test:e2e:electron` script — rebuilds native modules for Node, compiles `dist-electron/`, then runs the Playwright project.
- [ ] **Followup:** menu / tabs / palette / notification / deep-link specs (one per phase 3–8 affordance). Smoke is the foundation; targeted specs land iteratively.
- [ ] **Followup:** parametrize a handful of existing browser specs (`commit-prefix`, `command-palette-navigation`) to run under both projects.
- [ ] CI: extend `.github/workflows/e2e.yml` with the new project (deferred to Phase 11 — needs `xvfb` or a display server on the runner).

### Tests
- [x] `bunx playwright test --project=chromium-electron --list` discovers all 4 smoke tests.
- [x] Lint clean on the new test files + playwright config.
- [x] `bun run electron:typecheck` clean.
- [x] Browser project regression: `bun run test:e2e --list` still discovers the same browser spec set.
- [ ] **BLOCKED — runner gap:** actual execution of the Electron Playwright suite needs a display server on the runner (xvfb on Linux, no-op on mac/win). Wires up in Phase 11 CI.

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

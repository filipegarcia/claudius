# Electron E2E coverage tracker

Maintained by the `electron-e2e` Ralph loop (see
`docs/electron-conversion/E2E_LOOP_PROMPT.md`). Each iteration of the
loop picks an uncovered scenario from a category below, writes a
Playwright Electron spec for it, runs it locally headed, and ticks the
checkbox here if it passes.

Convention:
- `- [ ]` — not covered yet (designer picks from these).
- `- [x] (file.spec.ts)` — covered, green. Filename in parens.
- `- [ ] X [in-progress]` — implementor is working on it right now.
- `- [ ] X [bug-in-app: <one-liner>]` — implementor wrote the test, it
  fails because the APP is broken (not the spec). Test stays in repo
  with `test.fail()` and the bug is also tracked in
  `tests/electron/BUGS.md`.

## 1. System integrations

- [x] `window.claudius` bridge has the expected shape (`smoke.spec.ts`)
- [x] Sandbox: `require` and `process` undefined on window (`smoke.spec.ts`)
- [x] Application menu has File / Edit / View / Tab / Window / Help (`smoke.spec.ts`)
- [ ] `bridge.dialog.openWorkspace()` returns the selected folder (mock `dialog.showOpenDialog`)
- [ ] `bridge.dialog.openFile()` honors `filters` argument
- [ ] `bridge.deepLinks.onOpen(cb)` fires on a fake `second-instance` event
- [ ] `bridge.notifications.show(...)` creates a `Notification` on the main process
- [ ] `bridge.badge.set(n)` calls `app.setBadgeCount(n)` (mac)
- [ ] `bridge.updater.check()` triggers a status broadcast
- [ ] `bridge.updater.onStatus(cb)` receives `{ kind: "idle" }` in dev mode (no error)
- [ ] `bridge.workspaces.onOpenFolder(cb)` fires when main emits `workspace:open-folder`
- [ ] `bridge.menu.on(action, cb)` receives a synthesized menu click

## 2. Window management

- [x] Title bar element renders with `data-testid="titlebar"` (`smoke.spec.ts`)
- [ ] Title bar height is exactly 32px
- [ ] Title bar has `WebkitAppRegion: drag` on inner text node
- [ ] `bridge.window.minimize()` sets `mainWindow.isMinimized() === true`
- [ ] `bridge.window.maximize()` toggles maximize state
- [ ] `bridge.window.close()` shuts the BrowserWindow
- [ ] `bridge.window.toggleFullscreen()` toggles fullscreen
- [ ] Close button quits app on all platforms (no dock-survivor)
- [ ] Window remembers position across launches (if implemented — otherwise mark `[bug-in-app: not implemented]`)
- [ ] Window has min-width 800px enforced

## 3. Settings page

- [x] `/settings` route renders without console errors (`settings-page-renders-without-console-errors.spec.ts`)
- [ ] Switching scope (User / Project / Local) reloads settings
- [ ] Theme picker change persists across reload (set, refresh, assert dataset.theme matches)
- [ ] Editor picker change persists across reload
- [ ] Rate-limit warning preset switch persists
- [ ] Shortcut row recorder captures a new chord
- [ ] Shortcut row reset restores default
- [ ] Showing raw JSON toggle reveals the textarea
- [ ] Edit raw JSON → Save round-trips through the file
- [ ] Cancel discards unsaved edits

## 4. Top bar / chrome

- [x] Title bar renders only in Electron (not in chromium browser project) (`smoke.spec.ts` — Electron half; the chromium project never asserts a titlebar testid because the component returns null in the browser build)
- [x] Title bar background uses `var(--panel-2)` token (`top-bar-background-panel-2.spec.ts`)
- [ ] Title text reads "Claudius"
- [ ] Title bar persists across route navigation (`/`, `/settings`, `/community`)
- [ ] Updater banner stays hidden in dev (no "Updater error")
- [ ] Customization banner mounts when a customization is active
- [ ] On win/linux the three-button cluster (min/max/close) is visible
- [ ] On mac the three-button cluster is null and OS traffic lights occupy the space

## 5. Notifications + badge

> Loop note: rows in this section need a Notification-constructor spy
> wired into `launched.app.evaluate(...)` before they can run
> deterministically (Electron's `Notification` can't easily be observed
> from the renderer). Parked until that test-infra ships.

- [ ] An `agent.idle` notification fires when window is hidden
- [ ] Same notification does NOT fire when window is focused
- [ ] Clicking the OS notification focuses the window and switches session
- [ ] Badge increments on a hidden unread event
- [ ] Badge clears when the unread is read
- [ ] Notifications settings card mounts under `/settings`

## 6. App features — chat surface

- [x] Chat composer accepts keystrokes (`prompt-input`) (`chat-composer-accepts-keystrokes.spec.ts`)
- [ ] Send button fires `POST /api/sessions` (with mock)
- [ ] Slash command picker opens on `/`
- [ ] At-mention file picker opens on `@`
- [ ] Image paste creates an attachment preview
- [ ] Image drag-drop creates an attachment preview
- [ ] Composer Cmd+Enter sends
- [ ] Composer Shift+Enter inserts newline
- [ ] Composer resize handle drags vertically
- [ ] Session-tab `+` opens a new session
- [ ] Session-tab close `×` removes the tab
- [ ] `Cmd+T` opens a new session tab (Electron-only)
- [ ] `Cmd+W` closes the active session tab (Electron-only)
- [ ] `Cmd+Shift+T` reopens the most-recently-closed tab
- [ ] `Cmd+1..9` jumps to tab N
- [ ] Compact mode hides tool calls
- [ ] Verbose mode shows everything
- [ ] Session rename via banner persists
- [ ] Session clear empties the chat

## 7. App features — workspace switcher + rail

- [ ] Workspace tiles render one per workspace in `workspaces.json`
- [ ] Active workspace tile has the accent ring
- [ ] Right-click on tile opens context menu
- [ ] Context-menu rename persists
- [ ] Context-menu color change persists
- [ ] `+ New workspace` button opens the form modal
- [ ] Filling the form + clicking Save creates a workspace
- [ ] Cancel button closes the form
- [ ] Escape closes the form
- [ ] Click outside the form closes it
- [ ] SideNav reorder via drag persists in `workspaces.json`
- [ ] Workspace switch returns to last-visited URL
- [ ] `Cmd+Shift+]` cycles to next workspace
- [ ] `Cmd+Shift+[` cycles to previous workspace

## 8. App features — command palette

- [ ] `Cmd+K` opens the palette
- [ ] Escape closes it
- [ ] Outside click closes it
- [ ] Typing filters nav destinations
- [ ] Typing filters slash commands
- [ ] Enter activates selection
- [ ] Up/Down navigates results
- [ ] Empty state shows when no matches

## 9. Web parity (same data both runtimes)

- [ ] Workspace created in web shows up in Electron without restart
- [ ] Settings saved in web reflect in Electron
- [ ] Session started in web is resumable in Electron
- [ ] Notification raised on the server stream appears in Electron rail
- [ ] Asset uploaded in web is visible in Electron `/assets`
- [ ] Workspace deletion is reflected in both

## 10. Per-page render smoke (no console errors, primary action works)

Workspace-scoped (`app/[workspaceId]/`):

- [ ] `/<wks>` (chat root)
- [ ] `/<wks>/sessions`
- [ ] `/<wks>/sessions/<id>`
- [ ] `/<wks>/files`
- [ ] `/<wks>/git`
- [ ] `/<wks>/memory`
- [ ] `/<wks>/assets`
- [ ] `/<wks>/cost`
- [ ] `/<wks>/agents`
- [ ] `/<wks>/skills`
- [ ] `/<wks>/mcp`
- [ ] `/<wks>/hooks`
- [ ] `/<wks>/schedule`
- [ ] `/<wks>/permissions`
- [ ] `/<wks>/docker` (customization-gated)
- [ ] `/<wks>/tracker` (customization-gated)
- [ ] `/<wks>/database` (customization-gated)
- [ ] `/<wks>/notebooks` (customization-gated)
- [ ] `/<wks>/workspace`
- [ ] `/<wks>/keybindings`

Global (`app/*`):

- [ ] `/settings`
- [ ] `/plugins`
- [ ] `/doctor` (must show the Electron section)
- [ ] `/usage`
- [ ] `/community`
- [ ] `/customize`
- [ ] `/customize/[id]`
- [ ] `/customize/settings`
- [ ] `/release-notes`
- [ ] `/updater`

## 11. Deep links + dialogs + drag-drop

- [ ] `claudius://workspace/<id>` warm-start focuses + navigates
- [ ] `claudius://workspace/<id>?session=<sid>` lands on the session
- [ ] `claudius://session/<sid>` resolves the workspace
- [ ] `File → Open Workspace…` round-trips through dialog + POST /api/workspaces
- [ ] Dropping a folder on the dock posts to /api/workspaces

## 12. Keyboard shortcuts owned by the OS menu

- [ ] `Cmd+,` opens `/settings`
- [ ] `Cmd+Q` quits the app
- [ ] `Cmd+R` reloads the renderer
- [ ] `Cmd+0` / `Cmd+=` / `Cmd+-` zoom in / reset / out
- [ ] `Alt+Cmd+I` toggles DevTools

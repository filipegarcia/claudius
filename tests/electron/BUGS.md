# Electron app bugs surfaced by the e2e loop

When the e2e Ralph loop writes a spec that fails because the *app* is
broken (not the spec), the implementor leaves the failing test in repo
wrapped in `test.fail()` (so CI surfaces the regression but doesn't go
red) and records the bug here so a human can pick it up.

## Format

Each bug is a section like:

```md
## <one-line title>

- **Spec**: `tests/electron/<file>.spec.ts` line `NNN`
- **Category**: <category from COVERAGE.md>
- **First seen**: <iso date>
- **Repro**: <copy-paste from the spec or a one-paragraph description>
- **Expected**: <what should happen>
- **Actual**: <what does happen>
- **Notes**: <any debugging the loop already did>
```

---

<!-- new bug sections go here -->

## Cmd+, menu item dispatches `app.preferences` but no renderer subscriber navigates to /settings

- **Spec**: `tests/electron/keybinding-cmd-comma-opens-settings.spec.ts`
- **Category**: §12 Keyboard shortcuts owned by the OS menu
- **First seen**: 2026-05-20
- **Repro**:
  1. Launch Electron, wait for the workspace rail to mount.
  2. Programmatically click the application menu item whose
     accelerator is `Cmd+,` (or `Ctrl+,` on win/linux). That
     fires `webContents.send("menu:action", "app.preferences")`
     via `electron/menu.ts`.
  3. Wait for the renderer URL to become `/settings`.
- **Expected**: Renderer subscribes to `app.preferences` via
  `useElectronAction(...)` and pushes `/settings` into the
  `next/navigation` router.
- **Actual**: URL never changes. The accelerator + menu wiring is
  in place but `lib/client/shortcuts.ts` only *defines* the action
  — no component calls `useElectronAction("app.preferences", () =>
  router.push("/settings"))`.
- **Notes**:
  - Likely fix: bind the handler inside
    `components/chrome/ElectronGlobalActions.tsx` next to the
    existing `app.openWorkspace` binding. Pattern would be:
    ```ts
    useElectronAction("app.preferences", () => router.push("/settings"));
    ```
  - The same gap probably exists for every `app.*` action in
    shortcuts.ts that isn't bound to a renderer component
    (`app.quit` is OS-owned so OK; `app.openWorkspace` IS bound).
    Worth a follow-up audit.

## Electron rail doesn't pick up cross-runtime workspace creation without a reload

- **Spec**: `tests/electron/web-parity-workspace-created-elsewhere-appears.spec.ts`
- **Category**: §9 Web parity (same data both runtimes)
- **First seen**: 2026-05-20
- **Repro**:
  1. Launch Electron, wait for the workspace rail to mount with N tiles.
  2. `POST /api/workspaces` with a fresh `{ name, rootPath }` body
     (the same call the web UI's "+ New workspace" form makes).
  3. Wait for the rail to show N+1 tiles.
- **Expected**: Rail observes the new workspace within a few seconds
  — either by polling `/api/workspaces`, by subscribing to an SSE
  workspace stream, or by re-fetching on window-focus.
- **Actual**: Rail stays at N tiles indefinitely (15s timeout in the
  spec, never resolves). User must manually `Cmd+R` for the new
  workspace to appear.
- **Notes**:
  - The web side has the same gap — the workspace list doesn't
    cross-tab-sync either — but the cost is lower there since
    multi-tab is rarer than multi-runtime.
  - Likely fix: have `useWorkspaces` subscribe to a server-side
    workspace SSE stream, or fire a refetch on `visibilitychange`
    when the window regains focus.
  - The same row in COVERAGE.md will graduate from
    `[bug-in-app]` → `[x]` once the renderer auto-refreshes; the
    spec's `test.fail()` will start failing (the inverted assertion),
    which is the signal to remove the `.fail()` wrapper.

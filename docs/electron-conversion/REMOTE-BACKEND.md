# Remote backend mode

Run the Claudius backend (Next.js server + Claude Agent SDK + SQLite) in a
container, devbox, or remote VM — and connect a host-installed Electron
shell to it. The renderer talks HTTP/SSE to the remote backend; the host
process is purely the native-affordance shell (OS notifications, file
dialogs, dock badge, app menu, the right-click context menu, link-target
routing).

```
HOST                                  REMOTE (container/VM/devbox)
┌──────────────────┐                  ┌──────────────────────────┐
│ Electron .app    │                  │ Next.js server (3000)    │
│  ├─ main proc    │                  │  ├─ App Router routes    │
│  │  (notifs,     │                  │  ├─ SSE /stream          │
│  │   dialogs,    │  ─── HTTP/SSE ──→│  ├─ Claude Agent SDK     │
│  │   menu, IPC   │                  │  ├─ better-sqlite3       │
│  │   bridge)     │                  │  └─ workspaces.json      │
│  └─ renderer     │ ←── HTML/JS ─────│                          │
│     (loads remote│                  │ Bound to 0.0.0.0:3000    │
│      origin)     │                  │ Port-mapped to host      │
└──────────────────┘                  └──────────────────────────┘
```

## How to enable

The packaged `.app` honors a `CLAUDIUS_REMOTE_URL` env var (or `--remote-url=`
CLI flag). When set, `resolveStartUrl()` in `electron/main.ts` skips the
embedded-Next bootstrap entirely and the renderer loads from the remote
origin.

### Container side

Bind the Next server on `0.0.0.0` (default `next start` listens on `127.0.0.1`,
which isn't reachable through Docker port mapping):

```Dockerfile
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "run", "start"]
```

Map the port at run time. If you want to share workspaces with host Claude
Code, also mount `~/.claude`:

```sh
docker run -p 3000:3000 \
  -v ~/.claude:/root/.claude \
  -v /Users/filipegarcia/Projects:/projects \
  claudius-backend
```

Workspaces inside Claudius will reference container paths (`/projects/foo`,
not `/Users/filipegarcia/Projects/foo`), so mount the host directories you
want to work on into known container locations.

### Host side

Launch the `.app` via its binary path so env vars are honored (`open .app`
strips them on macOS):

```sh
CLAUDIUS_REMOTE_URL=http://localhost:3000 \
  /Applications/Claudius.app/Contents/MacOS/Claudius
```

Or with the flag, which `open .app` *will* forward:

```sh
open /Applications/Claudius.app --args --remote-url=http://localhost:3000
```

## What stays on the host

These all live in the Electron main process and work identically against a
remote backend:

- OS notifications (`bridge.notifications.show`) — the host's signed app
  identity is what macOS gates Notification Center on; signing isn't affected
  by where the backend lives.
- Native file dialogs (`bridge.dialog.openWorkspace`, `openFile`) — these
  return *host* paths. If you want to use the resulting path inside the
  container, that path must be mounted into the container.
- The OS menu + accelerators (electron/menu.ts).
- The right-click context menu + spell-checker (electron/ipc/context-menu.ts).
- The link-target routing — "external browser" vs "in-app viewer"
  preference (electron/ipc/link-target.ts).
- Dock / taskbar badge + deep-link protocol handler.
- Auto-updater for the host shell binary itself. The container backend
  has its own update path (whatever you rebuild + redeploy).

## What lives in the container

- Workspaces (`workspaces.json`, `.claudius.db`, sessions JSONL).
- All `/api/*` routes — sessions, files, git, hooks, MCP, plugins.
- The Claude Agent SDK process — child `claude` invocations spawn inside
  the container.
- The MCP servers configured for the active workspace.

If a feature needs container-side and host-side state to agree (e.g. the
notification-preferences toggle is server-state, but the OS toast renders
on the host), the IPC bridge already mediates that — see
`useNotifications.ts` and `electron/ipc/notifications.ts`.

## Trust boundary

The renderer is mounted with the Claudius preload, exposing
`window.claudius` (notifications, dialogs, menu IPC). The
`http://localhost` / `http://127.0.0.1` / `http://[::1]` URLs are considered
trusted by `lib/shared/link-target.ts` and keep the preload on.

If you reach the backend via a non-loopback origin
(`http://host.docker.internal`, a LAN IP, Tailscale, etc.), the *main
window* still gets the preload (it's attached to the `BrowserWindow`
unconditionally via `webPreferences.preload`) — but **`setWindowOpenHandler`
will route child windows of that origin through the in-app browser viewer's
sandboxed-window path** (no preload). If your remote-backend setup needs
child windows of a non-loopback origin to also keep the preload, widen the
carve-out in `electron/ipc/link-target.ts:isLocalhostHttpUrl` to include
your hostname.

## Single-instance lock + multiple shells

The packaged app uses `app.requestSingleInstanceLock()` keyed on userData.
If you want to run an *embedded* Claudius and a *remote-backed* Claudius
side-by-side, give the second one its own profile so it bypasses the lock:

```sh
.../Claudius.app/Contents/MacOS/Claudius \
  --user-data-dir=/tmp/claudius-remote \
  --remote-url=http://localhost:3000
```

## Caveats / known limits

- **Dock-drop folder paths**: when the user drops a folder onto the dock,
  the host main process sends the *host* absolute path to the renderer.
  The renderer then `POST`s it to `/api/workspaces` — which lands in the
  container, where that host path doesn't exist. Either drop folders that
  are mounted into the container at the same path, or add workspaces
  manually via Settings.
- **Auto-update**: the embedded server's git-pull auto-updater is the only
  updater that's disabled when remote-backed (we never spin up the server
  in remote mode). The host shell's `electron-updater` keeps working.
- **macOS notification permission**: a fresh adhoc-signed launch may
  re-prompt if you rebuild and the cdhash changes. See
  `build/after-pack.js`.

# Notifications

How notifications work in Claudius: where they appear, what triggers them, and how the surfaces stay in sync.

This doc is a reference for diagnosing "why didn't a notification show up?" / "why is the badge stuck?" — it maps every trigger to every display surface so you can find the wire that broke.

---

## 1. Where notifications show up (display surfaces)

Notifications surface in several distinct places. Each surface is fed by a different code path, so a bug can affect one without affecting the others.

### 1.1 OS toast (browser or Electron native)

- **Browser path:** `new Notification(title, { body, icon, tag })` — see [`lib/client/useNotifications.ts`](../lib/client/useNotifications.ts).
- **Electron path:** Renderer calls `window.claudius.notifications.show(...)` → IPC → main process fires native OS notification — see [`electron/ipc/notifications.ts`](../electron/ipc/notifications.ts).
- **Click behavior:** Configurable per-workspace as `"jump"` (route to the session) or `"dismiss"`. Electron can also bring the window to the foreground on click (browser `window.focus()` is unreliable when the window is hidden).
- **Suppression:** Skipped if the tab is visible AND the user is on the same session AND the kind is "background-suppressible" (see §4.2).
- **Dedupe:** The `tag` field is set to the notification ID so a re-fire replaces rather than stacks.

### 1.2 Favicon + document title badge

- **File:** [`lib/client/useFaviconBadge.ts`](../lib/client/useFaviconBadge.ts).
- **Title:** `"(N) Claudius"` when total unread > 0, else `"Claudius"`. Count is clamped to `"99+"`.
- **Favicon:** Canvas-rendered PNG with a red circle in the top-right. The static `<link rel="icon">` Next.js inserts is parked so the dynamic PNG wins.
- **Scope:** Sums unread across **all** workspaces (the favicon represents the whole app, not the active workspace).

### 1.3 Electron dock / taskbar badge

- **File:** [`electron/ipc/badge.ts`](../electron/ipc/badge.ts).
- **macOS:** `app.setBadgeCount(n)` → red bubble on the dock icon.
- **Windows:** `BrowserWindow.setOverlayIcon(...)` → red dot overlay on the taskbar.
- **Linux:** `app.setBadgeCount(n)` for Unity-style launchers, falls back to window flash otherwise.
- **Driven by:** the same total-unread number that drives the favicon.

### 1.4 Workspace tile badges (sidebar)

- **File:** [`components/nav/WorkspaceSwitcher.tsx`](../components/nav/WorkspaceSwitcher.tsx).
- **Display:** Red circle in the top-right of each workspace icon, showing that workspace's unread count.
- **Source:** `counts[workspaceId]` from `useNotificationsContext()`.

### 1.5 Hamburger menu badge (mobile)

- **File:** [`components/nav/SideNav.tsx`](../components/nav/SideNav.tsx).
- **Display:** Badge on the mobile sidebar toggle.
- **Scope:** Sums unread from all workspaces **except** the active one (the user is already inside the active workspace).

### 1.6 Per-session tab badges

- **File:** [`components/chat/SessionTabs.tsx`](../components/chat/SessionTabs.tsx).
- **Display:** Small numeric badge on each tab.
- **Source:** `unreadBySession[sessionId]` from the notification context.
- **Why it matters:** This is how the user spots a backgrounded session that has a permission request or ask-question waiting.

### 1.7 Notification drawer (bell icon)

- **File:** [`components/nav/NotificationsDrawer.tsx`](../components/nav/NotificationsDrawer.tsx).
- **Trigger:** Bell icon in the activity panel; opens a popover listing recent unread items across all workspaces, newest first.
- **Content:** Title, body, kind icon, workspace label (if not the active workspace).
- **Actions:** Click row to jump/dismiss, per-row mark-read, "mark all read", and a "Allow notifications" prompt if browser permission is not granted.
- **Limit:** Shows the 50 most recent unread rows; refetches on open and on `stateVersion` change.

### 1.8 Community room badges (separate system)

- **File:** [`lib/client/use-community-notifications.ts`](../lib/client/use-community-notifications.ts).
- **Scope:** Parallel system for the external chat-server community chat — does **not** flow through the notification bus.
- **Storage:** Per-room unread watermarks in localStorage.
- **Suppression:** Auto-advances when the user lands on a room; never badges echoes of the user's own messages.

---

## 2. What triggers notifications

The server-side `notification-bus` ([`lib/server/notification-bus.ts`](../lib/server/notification-bus.ts)) is the single funnel. It maps **session events** and **scheduler events** to **notification kinds**, persists rows, and broadcasts state updates.

### 2.1 Event → kind mapping

Defined in `mapEventToKind()` in [`lib/server/notification-bus.ts`](../lib/server/notification-bus.ts):

| Source event                          | Notification kind          | Title                            | Body                          |
|---------------------------------------|----------------------------|----------------------------------|-------------------------------|
| `permission_request`                  | `permission_request`       | "Claude needs permission"        | Tool name                     |
| `ask_user_question`                   | `ask_user_question`        | "Claude is asking a question"    | First question text           |
| `plan_approval_request`               | `plan_approval_request`    | "Claude has a plan to review"    | First line of plan            |
| session `error`                       | `session_error`            | "Session error"                  | Error message                 |
| scheduler `error`                     | `scheduled_run_finished`   | "Scheduled run errored"          | Error message                 |
| SDK `result` (turn ended)             | `session_idle`             | "Claude finished a turn"         | CWD path                      |
| scheduler `run_finished`              | `scheduled_run_finished`   | "Scheduled run finished/failed"  | Note field                    |

### 2.2 Where each trigger is recorded

- **Session events** — [`lib/server/session.ts`](../lib/server/session.ts) calls `notificationBus.recordSessionEvent(cwd, sessionId, event, { hasSubscribers })` on every broadcast event. `hasSubscribers` gates OS-toast suppression for background-suppressible kinds (see §4.2).
- **Scheduler events** — [`lib/server/scheduler.ts`](../lib/server/scheduler.ts) calls `notificationBus.recordSchedulerEvent(job.cwd, runId, jobId, { type: "run_finished", status, costUsd, note })` after each run finishes.
- **Resolve path** — when the user answers a permission/question/plan, the resolver calls `notificationBus.markReadByRequestId(...)` so the matching inbox row clears.

### 2.3 SSE event types

Two flavors flow over [`app/api/notifications/stream`](../app/api/notifications/stream/route.ts):

```ts
type NotificationStreamEvent =
  | { type: "notification"; notification: NotificationRow }   // drives OS toasts + drawer
  | { type: "state"; workspaceId; version; totalUnread; perSession }  // drives badges
```

Multiple `record()` calls in the same tick coalesce into a single state emit via `setTimeout(0)`.

---

## 3. Trigger × surface matrix

Quick reference for "which surfaces light up for which kinds." `✓` = lights up, `~` = lights up unless suppressed (see §4.2), `—` = does not light up.

| Kind                       | OS toast | Favicon + title | Dock/taskbar | Workspace tile | Session tab | Drawer | Default on? |
|----------------------------|----------|-----------------|--------------|----------------|-------------|--------|-------------|
| `permission_request`       | ✓        | ✓               | ✓            | ✓              | ✓           | ✓      | yes         |
| `ask_user_question`        | ✓        | ✓               | ✓            | ✓              | ✓           | ✓      | yes         |
| `plan_approval_request`    | ✓        | ✓               | ✓            | ✓              | ✓           | ✓      | yes         |
| `session_idle`             | ~        | ✓               | ✓            | ✓              | ✓           | ✓      | yes         |
| `scheduled_run_finished`   | ✓        | ✓               | ✓            | ✓              | ✓ (if session-tied) | ✓ | yes  |
| `session_error`            | ~        | ✓               | ✓            | ✓              | ✓           | ✓      | **opt-in**  |

**Key invariant:** State (badges) updates **always** fire — only the OS toast can be suppressed. If a badge isn't updating, the bus's state emit is broken, not the toast path.

**Actionable-kind OS toasts** (rows marked `✓` for the OS-toast column on `permission_request` / `ask_user_question` / `plan_approval_request`): unconditional — they fire even when you're foregrounded on the asking session. Same-session suppression only applies to non-actionable kinds. See §4.2.

---

## 4. Auto-read & suppression rules

### 4.1 Visibility auto-read

In [`components/notifications/NotificationsProvider.tsx`](../components/notifications/NotificationsProvider.tsx): when a notification arrives over SSE, it's auto-marked read if **all** of the following are true:

- The user is on that session's tab (URL `sessionId` matches).
- The active workspace matches the row's workspace.
- `document.hidden === false` (tab is visible).
- The kind is **not actionable** (see below).

A `visibilitychange` listener also fires the same auto-read sweep when a tab becomes visible.

### 4.2 Actionable kinds never auto-clear and never suppress their OS toast

`ACTIONABLE_KINDS` = `permission_request`, `ask_user_question`, `plan_approval_request`. These are special on three axes:

- **No auto-clear on visibility gestures.** Switching to the tab, foregrounding the window, or sitting on the session while the row arrives must NOT mark them read — the agent is blocked, and clearing them silently would leave only the modal as a cue (which the user can minimize).
- **No same-session OS-toast suppression.** Even when the user is foregrounded on the session that just asked the question, the OS popup still fires. The user may have Cmd-Tab'd to another app between submitting the turn and the question coming back — `document.hidden` stays `false` while the Claudius tab is foregrounded but another app has focus, so without this carve-out the popup is silently dropped exactly when the user needs it most.
- **Cleared only by `markReadByRequestId`.** Fired server-side from the resolver paths (`resolvePermission`, `submitAskAnswer`, `resolvePlan`) once the user has actually answered. The defensive cleanup paths — per-tool `ctx.signal` abort listeners and `drainPendingDecisions` (session reap / `end()`) — also fire `markReadByRequestId` for every entry they drop, so a session that gets reaped or aborted mid-question doesn't leave an unresolvable badge behind.
- **Orphan sweep at `Session.start()`.** A fresh `Session` instance has empty `pendingAskQuestions` / `pendingPermissions` / `pendingPlans` maps by construction, so any unread actionable row in the DB tied to its session id is by definition orphaned from a prior lifecycle (dev-mode HMR rebuild, hard server crash, anywhere the abort cascade didn't run). `notificationBus.sweepOrphanedActionableForSession(cwd, sessionId)` runs once at `start()` and marks those rows read so the per-tab badge clears on the next page load. Without this sweep the badge would persist forever — the normal "I selected the tab" auto-read (`markReadBySession`) excludes actionable kinds on purpose.

These rules are enforced in **three** places that must stay in sync — if you ever add a fourth actionable kind, audit all three:

1. Server SQL in `markReadBySession()` (`WHERE kind NOT IN (...ACTIONABLE_KINDS)`) — [`lib/server/notifications-db.ts`](../lib/server/notifications-db.ts).
2. Client SSE auto-read gate in `NotificationsProvider` (`!isActionableKind(row.kind)`) — [`components/notifications/NotificationsProvider.tsx`](../components/notifications/NotificationsProvider.tsx).
3. Client OS-toast gate in `useNotifications.notify` (`!isActionableKind(row.kind)`) — [`lib/client/useNotifications.ts`](../lib/client/useNotifications.ts).

### 4.3 Background-suppressible OS toasts

`session_idle` and `session_error` are "background-suppressible." If the session has no subscribers AND it's not the active session, the bus persists the row + emits state (so badges tick) but **skips the toast SSE event** (no popup).

Rationale: the user will see these via the tab strip when they look back; we don't want a popup parade for chatty turns.

### 4.4 Dedup via `requestId`

The `notifications` table has a partial UNIQUE index on `request_id` (nullable). When a session re-attaches and the SDK replays a `permission_request`, the duplicate insert is `INSERT OR IGNORE`d. This is why a refresh doesn't re-pop modals.

---

## 5. Settings & configuration

### 5.1 Per-workspace prefs

Stored in `WorkspaceDefaults.notifications` ([`lib/shared/notifications.ts`](../lib/shared/notifications.ts)):

```ts
type WorkspaceNotificationPrefs = {
  enabled?: boolean;                  // master switch — undefined = enabled (see below)
  onClick?: "jump" | "dismiss";       // default: "jump"
  enabledKinds?: NotificationKind[];  // default: DEFAULT_ENABLED_KINDS
};
```

**Default-on semantics for `enabled`.** Absent (`undefined`) is treated as enabled across every read site: the runtime gate (`useNotifications.ts`), the workspace settings form (`/workspace`), and the server-side `isKindEnabled` filter. Only an EXPLICIT `enabled: false` (the user toggled it off) disables the workspace. This avoids the silent "Workspace notifications: Off" surprise on fresh/migrated workspaces — when the user has never seen a toggle they shouldn't have to find one to make notifications work. The three sites MUST stay in sync; if you add a new reader, use the `prefs?.enabled !== false` form (NOT `!!prefs?.enabled`, which flips absent to `false`).

UI: [`app/[workspaceId]/workspace/page.tsx`](../app/[workspaceId]/workspace/page.tsx) — master toggle, click behavior, default-on kinds checkboxes, opt-in kinds. When the user unchecks a kind, the page POSTs `/api/notifications/read-by-kind` to clear that kind's backlog.

### 5.2 Per-session prefs

Stored in the `session_notification_prefs` table ([`lib/server/notifications-db.ts`](../lib/server/notifications-db.ts)):

```ts
type SessionNotificationPrefs = {
  sessionId: string;
  blocked: boolean;             // kill all notifications for this session
  snoozeUntil: number | null;   // epoch ms; null = not snoozed
};
```

UI: [`components/chat/SessionNotifyMenu.tsx`](../components/chat/SessionNotifyMenu.tsx) — bell icon in the chat status line. Toggles workspace-wide notifications, blocks this session, and offers snooze presets (15m / 1h / 2h / until tomorrow).

### 5.3 Browser permission flow

`useNotifications.setEnabled(true)` calls `Notification.requestPermission()` if not already granted. If denied, the workspace pref stays off. A one-time migration promotes the legacy `claudius.notifications.enabled` localStorage flag into workspace defaults.

---

## 6. API routes

All under [`app/api/notifications/`](../app/api/notifications/):

| Route                       | Method | Purpose                                                |
|-----------------------------|--------|--------------------------------------------------------|
| `/stream`                   | GET    | SSE for notification + state updates                   |
| `/counts`                   | GET    | Cross-workspace unread totals (boot + recovery)        |
| `/`                         | GET    | List notifications (workspace or all), `unreadOnly=1` |
| `/[id]/read`                | POST   | Mark a single notification read                        |
| `/read-all`                 | POST   | Mark every unread in a workspace read                  |
| `/read-by-session`          | POST   | Mark a session's non-actionable unread read            |
| `/read-by-kind`             | POST   | Mark a kind's unread read (when user disables a kind)  |
| `/dev-emit`                 | POST   | Dev-only: synthesize an event for e2e tests            |

---

## 7. Database schema

[`lib/server/db-migrations/005_notifications.sql`](../lib/server/db-migrations/005_notifications.sql):

```sql
CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  run_id      TEXT,
  job_id      TEXT,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  payload     TEXT,             -- JSON
  request_id  TEXT,              -- dedup key, nullable
  created_at  INTEGER NOT NULL,
  read_at     INTEGER,           -- NULL = unread
  UNIQUE(request_id)             -- partial: NULLs don't conflict
);

CREATE TABLE session_notification_prefs (
  session_id    TEXT PRIMARY KEY,
  blocked       INTEGER NOT NULL,
  snooze_until  INTEGER          -- epoch ms, NULL = not snoozed
);
```

---

## 8. HMR / dev-mode gotcha

[`lib/server/notification-bus.ts`](../lib/server/notification-bus.ts) builds a singleton bus. Hot Module Replacement destroys and rebuilds the module, but three pieces of state must survive:

1. **Subscribers** — live SSE connections to open browser tabs.
2. **Per-workspace `version`** — clients gate on `version > lastVersion`; resetting to 0 makes them ignore fresh state.
3. **`lastUserInputAt`** — needed for idle-window suppression.

The bus uses a `BUS_BUILD_TAG` marker on `globalThis` to migrate these across rebuilds. **If you see "badge stuck after editing server code," check that the marker tag and migration code are in sync.**

---

## 9. Diagnosing common issues

**First check: the workspace's notifications switch.** Pretty much every "no toast fires anywhere" report eventually traces back to `WorkspaceDefaults.notifications.enabled === false`, or — historically — `undefined` being treated as "off" in the renderer hook while the server still persisted rows. Open the bell-icon popover in the session status line, or `/workspace`, and confirm **"Workspace notifications: On"**. The test-notification button under that popover deliberately bypasses every gate and is the fastest way to prove the OS path is healthy: if the test pings but real notifications don't, the workspace switch (or a per-session block / snooze) is the culprit, not the bus.

As of the default-on change, fresh / unmigrated workspaces report `On` automatically — only an explicit user toggle to `false` disables. Mirrored across three sites: the runtime gate (`useNotifications`), the workspace settings page (`/workspace`), and the server-side `isKindEnabled`. If you change one, change the other two.

| Symptom                                          | Likely cause                                                                                   | Where to look                                                            |
|--------------------------------------------------|------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------|
| **No toasts fire but the test-notification works** | Workspace switch is off (or absent and the resolver isn't using the default-on `!== false` form). The test-notification deliberately bypasses `enabled` so it works regardless — that asymmetry is exactly what makes this diagnostic. | `enabled = prefs?.enabled !== false` in `useNotifications.ts`; mirror in `/workspace` page; `isKindEnabled` in `notification-bus.ts` |
| **Session finished but no `session_idle` notification, status stuck on "running"** | Same root cause — see §10. SDK never emitted `result`, or a `pending*` map didn't clean up, or `markUserInput` was never called for this session. | §10 below                                                |
| Badge stuck after resolving permission           | `markReadByRequestId` not called from resolver; or `requestId` mismatch                        | resolve handler in [`lib/server/session.ts`](../lib/server/session.ts), `markReadByRequestId` |
| OS toast doesn't fire when tab is hidden         | Browser permission not granted; or kind is background-suppressible and session has no subscribers | `useNotifications.ts`, `isBackgroundSuppressible` in bus                 |
| Tab badge doesn't update                         | `state` SSE event not arriving; version gate rejected a stale value                            | `NotificationsProvider`, `/stream` route                                 |
| Notification duplicated on refresh               | `request_id` not set on the source event — bus has nothing to dedupe on                        | `mapEventToKind` callers                                                 |
| Badge resets to 0 after editing server code      | HMR migration broken                                                                           | `BUS_BUILD_TAG` block in `notification-bus.ts`                           |
| Auto-read clearing a permission request          | Actionable-kind filter missing in one of the two enforcement sites                             | `ACTIONABLE_KINDS` uses in `notifications-db.ts` AND `NotificationsProvider` |
| Drawer empty but favicon shows count             | Drawer query filter (50 most recent, unread, scope) mismatched with the count source           | `NotificationsDrawer.tsx`, `/api/notifications` GET                     |
| Notification fires for active session            | Visibility/auto-read gate not running — check `document.hidden` and URL `sessionId` parsing    | `NotificationsProvider` `sameSessionVisible` block                       |
| Actionable kind (permission / ask / plan) doesn't pop a toast when you're on the asking session | Same-session OS-toast suppression missing the `!isActionableKind(row.kind)` carve-out — see §4.2, rule #3 | `useNotifications.notify` gate                                           |
| Per-tab badge stuck on an actionable row long after the modal is gone | Pending entry dropped without firing `markReadByRequestId` (server restart, HMR, reap, abort cascade). The `Session.start()` sweep is the catch-all; the per-tool abort handlers and `drainPendingDecisions` cover in-session drops. | `sweepOrphanedActionableForSession` in `notification-bus.ts`; `drainPendingDecisions` and the three `ctx.signal.addEventListener("abort", ...)` blocks in `session.ts` |

---

## 10. Recurring failure: "session finished but no notification, status stuck on running"

**This is the bug pattern most likely to come back.** The session-status indicator (`running` dot vs. idle) and the `session_idle` OS notification are driven by the **same** server-side state machine. If status is stuck on "running" after a turn finishes, the notification is also missing — and vice versa. Treat them as one symptom.

### 10.1 The chain of events for a finished turn

For a session to flip `running → idle` AND fire `session_idle`, all of these must happen in order:

1. User submits input → `Session.sendUserMessage()` runs:
   - Sets `turnInFlight = true`
   - Calls `notificationBus.markUserInput(this.id)` (stamps `lastUserInputAt`)
   - Calls `broadcastTurnStatusIfChanged()` → emits `turn_status: "running"`
2. SDK does its work, emits messages.
3. SDK emits a `result` message → `consume()` runs:
   - Sets `turnInFlight = false`
   - Calls `broadcastTurnStatusIfChanged()` → if `getStatus()` is now `"idle"`, emits `turn_status: "idle"`
4. The `sdk` event with `result` reaches `notificationBus.recordSessionEvent`:
   - `mapEventToKind` checks `lastUserInputAt.get(sessionId)` — must be **non-zero**, else returns `null`
   - If non-zero, returns `{ kind: "session_idle", title: "Claude finished a turn", body: cwd }`
   - Bus persists the row and emits the `notification` SSE event (unless background-suppressible & no subscribers)

**Any single failure in this chain leaves status stuck AND the notification missing.**

### 10.2 Where this chain breaks (in order of likelihood)

**A. `pending*` map didn't clean up** — [`lib/server/session.ts` `getStatus()`](../lib/server/session.ts) returns `"running"` if **any** of `pendingPermissions`, `pendingAskQuestions`, `pendingPlans` is non-empty. If a resolver path forgets to `.delete(requestId)` from its map (or the abort handler races with the resolve), the map keeps a phantom entry forever and the session never flips to idle. The `result` event still fires, but `broadcastTurnStatusIfChanged` sees `next === lastBroadcastStatus === "running"` and bails — no `turn_status` event goes out.

**Where to check:** every site that mutates the three `pending*` maps must call `broadcastTurnStatusIfChanged()` after the mutation. Search for `pending(Permissions|AskQuestions|Plans)\.(set|delete)` and confirm a status-broadcast call follows. The abort handlers on lines ~614, ~651, ~677 of `session.ts` are the high-risk sites — they fire on `ctx.signal.abort` and could race the normal resolve path.

**Backstop in place:** `Session.drainPendingDecisions(reason)` resolves + deletes every entry in the three maps. It's called from `consume()` finally (before the status broadcast, so `getStatus()` actually flips to `"idle"`) and from `Session.end()` (after `abortController.abort()`). This guarantees a Session can't stay stuck in `"running"` after its iterator exits or `end()` is called, even if the SDK's per-tool `ctx.signal` cascade missed an entry. **Do not remove this drain** — it's the safety net for the SDK-owned cascade.

**B. SDK never emitted `result`** — the agent crashed, was aborted, or the iterator returned without a terminal `result` message. The defensive path at [`session.ts:1990-1992`](../lib/server/session.ts) catches this: when `consume()` exits its loop, it force-sets `turnInFlight = false` and re-broadcasts status.

**Backstop in place:** `consume()` now tracks `sawResult` and `sawError`. In `finally`, if neither was seen AND the signal wasn't aborted (i.e., this wasn't a reaper kill or user-initiated stop with `query.interrupt()` having broadcast an error already), the session routes a synthetic `sdk: { type: "result" }` event through `notificationBus.recordSessionEvent`. The event never reaches subscribers or the replay buffer — going through the bus directly preserves disk/buffer parity. The bus's existing `lastUserInputAt` gate still suppresses for sessions where the user never typed in this process lifetime. **The synthetic only fires when both real-event paths missed**, so there's no double-notify risk.

**C. `markUserInput` was never called for this session** — `mapEventToKind` for `sdk` `result` returns `null` if `lastUserInputAt.get(sessionId) === 0`. This is a deliberate gate to suppress notifications for replayed sessions / resumed conversations where we never saw the user type. Real-world triggers:
- HMR cleared the `lastUserInputAt` map and the migration didn't preserve it (check `BUS_BUILD_TAG` in [`notification-bus.ts:825`](../lib/server/notification-bus.ts)).
- Session was resumed from disk; the agent's first turn fires `result` but the user never `sendUserMessage`'d in this process lifetime.
- A scheduler run (no session) — by design, returns `null` early because `ctx.sessionId` is unset.

**D. `broadcastTurnStatusIfChanged` dedupe ate a legitimate event** — if `lastBroadcastStatus` is somehow out of sync with reality (e.g. set to `"idle"` but `getStatus()` is also `"idle"` because the map cleanup happened in the wrong order), the flip emits nothing. This is rare but possible if a future refactor introduces a path that mutates `turnInFlight` without going through `broadcastTurnStatusIfChanged`.

**E. The `state` SSE event went out but the client gate rejected it** — `NotificationsProvider` uses a monotonic `version` gate; if the bus's per-workspace version regressed (HMR migration bug), the client ignores the update. Status would still flip if `turn_status` is delivered over the per-session SSE stream (that's a separate connection), but cross-tab badges and `state`-driven UI would stay stale.

### 10.3 Quickest diagnostic when this recurs

1. **Confirm the symptom is paired.** Open the session that's stuck. Is the "running" dot showing? Did the OS notification fail to fire? If both, you're in this failure mode. If only one, it's a different bug — go back to §9.
2. **Check the three `pending*` maps.** In dev, log `Session.getStatus()` components after the turn "ends":
   ```ts
   console.log({
     turnInFlight: this.turnInFlight,
     perms: this.pendingPermissions.size,
     asks: this.pendingAskQuestions.size,
     plans: this.pendingPlans.size,
   });
   ```
   If any of the three is non-zero with no live UI for it, you found a leaked pending entry → fix the resolver/abort path.
3. **Check the SSE stream for the session.** Watch DevTools Network → the session's `/api/sessions/.../stream` connection. Did a `result`-typed `sdk` message arrive? Did a `turn_status` event with `status: "idle"` arrive?
   - `result` arrived, `turn_status` didn't → `getStatus()` is still returning `"running"` → §10.2.A (pending map leak).
   - Neither arrived → SDK never finished cleanly → §10.2.B (safety-net case; `session_idle` won't fire even after server recovers status).
4. **Check `lastUserInputAt` for the session.** In a dev console attached to the server, inspect `notificationBus.lastUserInputAt.get(sessionId)`. If 0/undefined → §10.2.C.

### 10.4 Invariant to preserve when editing this code

**Every mutation of `turnInFlight` or any of `pendingPermissions` / `pendingAskQuestions` / `pendingPlans` must be immediately followed by `broadcastTurnStatusIfChanged()`.** The `getStatus()` definition is the source of truth for "is the session done"; both the UI indicator and the `session_idle` notification ultimately depend on it.

If you add a new "pending agent decision" map in the future (e.g. a new kind of approval request), it must:
- Be checked in `getStatus()`.
- Trigger `broadcastTurnStatusIfChanged()` on every `.set`, `.delete`, and abort-listener path.
- Either be filtered out of, or explicitly handled by, `isStatusSyncRelevant()` in the bus.

---

## 10. Architecture at a glance

```
┌──────────────────┐    ┌──────────────────┐    ┌─────────────────────┐
│ session.ts       │    │ scheduler.ts     │    │ resolve handlers    │
│ (broadcast)      │    │ (run_finished)   │    │ (markReadByReqId)   │
└────────┬─────────┘    └────────┬─────────┘    └──────────┬──────────┘
         │ recordSessionEvent     │ recordSchedulerEvent      │
         ▼                        ▼                            ▼
              ┌──────────────────────────────────────────┐
              │   notification-bus.ts (singleton)        │
              │   - mapEventToKind                       │
              │   - persist row (dedup on request_id)    │
              │   - emit `notification` SSE (if !suppressed) │
              │   - emit `state` SSE (always, coalesced) │
              └──────────────────┬───────────────────────┘
                                 │ SSE
              ┌──────────────────▼───────────────────────┐
              │  NotificationsProvider (client)          │
              │  - auto-read gate (non-actionable)       │
              │  - fan out to consumers                  │
              └──┬──────┬──────┬──────┬──────┬──────┬────┘
                 │      │      │      │      │      │
                 ▼      ▼      ▼      ▼      ▼      ▼
              OS toast Favicon Tile  Tab  Drawer  Dock
                      + title badge  badge        badge
```

The bus is the single funnel. Everything downstream is just a different rendering of the same state.

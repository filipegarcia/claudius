/**
 * Shared notification types. Used by both server (notification-bus, API
 * routes) and client (NotificationsProvider, drawer, browser-notification
 * hook).
 *
 * Notifications surface attention-worthy events from sessions and scheduled
 * jobs into a single per-workspace inbox. Storage is per-workspace SQLite
 * (`.claudius.db`, migration 005). The bus filters at write-time using
 * per-session `session_notification_prefs` and per-workspace
 * `WorkspaceDefaults.notifications.enabledKinds`.
 */

export type NotificationKind =
  /** Tool permission requested (Allow/Deny card). */
  | "permission_request"
  /** AskUserQuestion form opened. */
  | "ask_user_question"
  /** Plan approval requested (ExitPlanMode). */
  | "plan_approval_request"
  /** Session emitted an error event. */
  | "session_error"
  /** Session finished a turn after a long-running idle window. */
  | "session_idle"
  /** A scheduled job's run finished (success or non-success). */
  | "scheduled_run_finished";

/**
 * Default kind set used when a workspace has no `enabledKinds` configured.
 *
 * `session_error` is intentionally NOT in the defaults: the SDK throws an
 * "error" for every user-initiated abort, every reaper kill, every "No
 * conversation found" resume failure, and a handful of other transient
 * states the user doesn't care about. Errors that actually matter surface
 * in the chat transcript itself — popping a separate notification on top
 * is noise. Users who want it can opt in from the workspace settings page;
 * see the "Session error" toggle in the secondary section below the main
 * grid.
 */
export const DEFAULT_ENABLED_KINDS: NotificationKind[] = [
  "permission_request",
  "ask_user_question",
  "plan_approval_request",
  "session_idle",
  "scheduled_run_finished",
];

/**
 * Kinds the user can enable from settings but that ship OFF. Currently just
 * `session_error` — see the comment on {@link DEFAULT_ENABLED_KINDS} for
 * the rationale. The settings UI renders these in a separate section so
 * the visual hierarchy matches the default-on/opt-in split.
 */
export const OPT_IN_KINDS: NotificationKind[] = ["session_error"];

/** All kinds in their preferred display order (defaults first, opt-ins last). */
export const ALL_NOTIFICATION_KINDS: NotificationKind[] = [
  ...DEFAULT_ENABLED_KINDS,
  ...OPT_IN_KINDS,
];

/**
 * Kinds where the agent is **blocked on the user** until they explicitly
 * resolve the request (Allow/Deny, answer the question, Accept/Reject the
 * plan). These notifications must NOT be auto-cleared by "I'm looking at
 * this session" gestures — switching to the tab, foregrounding the browser
 * window, or sitting on the session while the row arrives. The ONLY path
 * that should mark them read is `markReadByRequestId`, fired server-side
 * from the resolve handlers (`resolvePermission`, `submitAskAnswer`,
 * `resolvePlan`) once the user has actually answered.
 *
 * Without this exclusion, a user who switches into the session — or whose
 * browser tab regains visibility — would silently clear the inbox row and
 * the per-tab badge for a still-pending request, leaving the AskUserQuestion
 * modal as the only surviving cue. If the user then minimised the modal
 * they'd have no indicator at all.
 *
 * Mirror the filter in both `markReadBySession` (server SQL) and the SSE
 * auto-read predicate in `NotificationsProvider` so the two channels can't
 * drift.
 */
export const ACTIONABLE_KINDS: NotificationKind[] = [
  "permission_request",
  "ask_user_question",
  "plan_approval_request",
];

/** True when the kind is one the agent is blocked on; see {@link ACTIONABLE_KINDS}. */
export function isActionableKind(kind: NotificationKind): boolean {
  return ACTIONABLE_KINDS.includes(kind);
}

/** Behaviour when the user clicks an OS notification or a row in the drawer. */
export type NotificationClickBehavior = "jump" | "dismiss";

/** Per-workspace notification preferences (lives on WorkspaceDefaults). */
export type WorkspaceNotificationPrefs = {
  /** Master switch. Defaults to `true` once the user has granted browser permission. */
  enabled?: boolean;
  /** Click behaviour for OS notifications and drawer rows. Defaults to `"jump"`. */
  onClick?: NotificationClickBehavior;
  /** Which kinds the bus is allowed to write. Absent ⇒ {@link DEFAULT_ENABLED_KINDS}. */
  enabledKinds?: NotificationKind[];
};

/** Per-session block/snooze flags. Persisted in `session_notification_prefs`. */
export type SessionNotificationPrefs = {
  sessionId: string;
  /** When true, the bus drops every event for this session. */
  blocked: boolean;
  /** Epoch ms; null or in the past means "not snoozed". */
  snoozeUntil: number | null;
};

/**
 * A persisted notification row as returned to clients. Wire-shape between
 * the API and the React hooks. Mirrors columns in the `notifications` table
 * but uses camelCase and parses `payload` JSON eagerly.
 */
export type NotificationRow = {
  id: string;
  workspaceId: string;
  /** Originating session id, if any. Null for scheduler-only rows. */
  sessionId: string | null;
  /** Originating scheduler run id, if any. */
  runId: string | null;
  /** Originating scheduler job id, if any. */
  jobId: string | null;
  kind: NotificationKind;
  title: string;
  body: string | null;
  /** Free-shape JSON payload. Common fields: `toolName`, `requestId`, `status`. */
  payload: Record<string, unknown> | null;
  createdAt: number;
  /** Epoch ms when the row was marked read, or null. */
  readAt: number | null;
};

/**
 * Authoritative per-workspace unread state. Carries the workspace total AND
 * the per-session map AND a monotonic `version` counter — clients gate every
 * incoming update on `version > last` so a slow / out-of-order response can
 * never overwrite fresh state.
 *
 * Replaces the prior `{ type: "count", workspaceId, unread }` event so the
 * workspace-tile badge and the per-tab badges always agree by construction.
 */
export type WorkspaceUnreadState = {
  workspaceId: string;
  /** Monotonically increasing per-workspace. Strictly larger than the last value the server emitted. */
  version: number;
  /** `SELECT COUNT(*) WHERE read_at IS NULL` — workspace total. */
  totalUnread: number;
  /** Per-session unread counts; only keys with > 0 unread appear. */
  perSession: Record<string, number>;
};

/**
 * Envelope pushed over the SSE notification stream. The single
 * `/api/notifications/stream` endpoint fans out new-row events (for OS toasts
 * and the inbox `recent` buffer) and `state` events (the canonical
 * unread-count source).
 */
export type NotificationStreamEvent =
  | { type: "notification"; notification: NotificationRow }
  | ({ type: "state" } & WorkspaceUnreadState);

/** Where a notification points. Used by the jump-to-session router helper. */
export type NotificationJumpTarget = {
  sessionId?: string;
  jobId?: string;
  runId?: string;
};

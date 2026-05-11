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

/** Default kind set used when a workspace has no `enabledKinds` configured. */
export const DEFAULT_ENABLED_KINDS: NotificationKind[] = [
  "permission_request",
  "ask_user_question",
  "plan_approval_request",
  "session_error",
  "session_idle",
  "scheduled_run_finished",
];

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
 * Envelope pushed over the SSE notification stream. The single
 * `/api/notifications/stream` endpoint fans out both new-row and
 * count-changed events for every workspace the user can see.
 */
export type NotificationStreamEvent =
  | { type: "notification"; notification: NotificationRow }
  | { type: "count"; workspaceId: string; unread: number };

/** Where a notification points. Used by the jump-to-session router helper. */
export type NotificationJumpTarget = {
  sessionId?: string;
  jobId?: string;
  runId?: string;
};

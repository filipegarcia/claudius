"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Bell,
  Calendar,
  CheckCheck,
  HelpCircle,
  KeySquare,
  Sparkles,
  Hourglass,
} from "lucide-react";
import { useNotificationCenter } from "@/lib/client/useNotificationCenter";
import { useNotificationsContext } from "@/components/notifications/NotificationsProvider";
import { useWorkspaces } from "@/lib/client/useWorkspaces";
import { cn } from "@/lib/utils/cn";
import { isActionableKind, type NotificationKind, type NotificationRow } from "@/lib/shared/notifications";

/**
 * Notification bar + flyout panel rendered at the top of the right-rail
 * Activity panel, above the session ("model") card.
 *
 * Cross-workspace: shows EVERY workspace's unread notifications in one
 * inbox so the badge count matches the favicon. Each row carries a small
 * workspace label when it's from a workspace other than the active one,
 * so the user can tell where a notification came from before clicking
 * (which jumps to that workspace).
 *
 * Conventions:
 *   • absolute-positioned popover anchored below the trigger
 *   • click-outside + Escape closes
 *   • badge styling matches the workspace-tile pattern
 */
export function NotificationsDrawer() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { permissionState, requestPermission } = useNotificationsContext();
  const { items: allWorkspaces, activeId: activeWorkspaceId } = useWorkspaces();
  const center = useNotificationCenter(activeWorkspaceId);
  const unread = center.unread;
  // Cross-workspace drawer: build a name lookup so each row can tell the
  // user which workspace it came from. The label only shows when the row's
  // workspace is NOT the active one — for in-workspace notifications, the
  // workspace name would be visual noise.
  const workspaceNames = useMemo(() => {
    const out: Record<string, string> = {};
    for (const w of allWorkspaces) out[w.id] = w.name;
    return out;
  }, [allWorkspaces]);
  // The server filters `unreadOnly=1`, and the provider's recent-buffer merge
  // in `useNotificationCenter` only includes rows where `readAt == null`. No
  // client-side filter needed here — the prior `items.filter(readAt==null)`
  // was the safety net for the old paginated-by-created_at fetch that could
  // cut off older unread when read rows piled up at the top.
  const visibleItems = center.items;

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      if (panelRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Refresh whenever the panel is opened so we pick up rows that arrived
  // while the drawer was closed AND haven't been merged into `recent` yet
  // (because they predate the EventSource lifetime of this tab).
  //
  // Depend on `center.refresh` (a stable useCallback keyed on workspaceId),
  // not on `center` itself — `center` is a fresh object literal each render,
  // so depending on it spun this into an infinite refresh loop and the
  // drawer stayed pinned on "Loading…".
  const refresh = center.refresh;
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const titleAttr = unread > 0 ? `${unread} unread notifications` : "Notifications";

  return (
    <div className="relative mb-3">
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        title={titleAttr}
        data-testid="notifications-drawer-trigger"
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 px-2 py-1.5 text-left text-[11px] transition hover:bg-[var(--panel-2)]",
          unread > 0 ? "text-[var(--foreground)]" : "text-[var(--muted)]",
        )}
      >
        <Bell className="h-3 w-3 text-[var(--accent)]" />
        <span className="font-medium">Notifications</span>
        {unread > 0 && (
          <span
            data-testid="notifications-drawer-badge"
            className="ml-auto flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[9px] font-medium leading-none text-white"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          ref={panelRef}
          data-testid="notifications-drawer-panel"
          className="absolute right-0 top-full z-50 mt-1 w-80 rounded-md border border-[var(--border)] bg-[var(--panel)] py-1 shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 px-3 py-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
              Notifications
            </span>
            {unread > 0 && (
              <button
                onClick={() => void center.markAllRead()}
                className="flex items-center gap-1 text-[10px] text-[var(--muted)] hover:text-[var(--foreground)]"
              >
                <CheckCheck className="h-3 w-3" /> Mark all read
              </button>
            )}
          </div>

          {permissionState === "default" && (
            <div className="mx-2 mb-1 rounded border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2 py-2 text-[11px] text-[var(--foreground)]">
              Browser notifications are off.{" "}
              <button
                onClick={() => void requestPermission()}
                className="font-medium text-[var(--accent)] hover:underline"
              >
                Turn on
              </button>
            </div>
          )}
          {permissionState === "denied" && (
            <div className="mx-2 mb-1 rounded border border-[var(--border)] bg-[var(--panel-2)] px-2 py-2 text-[10px] text-[var(--muted)]">
              Browser notifications are blocked in this browser&apos;s site
              settings. The in-app inbox still works.
            </div>
          )}

          <div className="max-h-96 overflow-auto">
            {center.loading && visibleItems.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-[var(--muted)]">Loading…</div>
            ) : visibleItems.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-[var(--muted)]">
                You&apos;re all caught up.
              </div>
            ) : (
              <ul>
                {visibleItems.map((row) => (
                  <NotificationRowItem
                    key={row.id}
                    row={row}
                    workspaceLabel={
                      row.workspaceId !== activeWorkspaceId
                        ? workspaceNames[row.workspaceId] ?? null
                        : null
                    }
                    onClick={() => {
                      // Close the drawer and jump FIRST. Marking read goes in
                      // parallel — awaiting its network round-trip would delay
                      // (and previously sometimes silently lose) the jump.
                      setOpen(false);
                      void center.markRead(row.id);
                      void center.jumpTo(row);
                    }}
                    onMarkRead={() => void center.markRead(row.id)}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NotificationRowItem({
  row,
  onClick,
  onMarkRead,
  workspaceLabel,
}: {
  row: NotificationRow;
  onClick: () => void | Promise<void>;
  onMarkRead: () => void;
  /**
   * Friendly name of the row's workspace, shown when the row is from a
   * workspace other than the active one. Null when same-workspace — the
   * label would just be visual noise in that case.
   */
  workspaceLabel: string | null;
}) {
  const unread = row.readAt == null;
  // NB: row wrapper is a div-role-button rather than a real <button>. The
  // inline "Mark read" affordance below MUST be a real <button> so it can
  // own the keyboard/focus contract, and nested <button>s are invalid HTML
  // — Chrome/Safari deliver clicks inconsistently to the outer button when
  // there's an interactive descendant, which silently broke the jump-to-
  // session action.
  //
  // Blocked-session peek (Claude Code TUI parity, 2.1.207): the agent-view
  // row for a still-pending permission/question/plan-review row now leads
  // with the QUESTION itself rather than the generic kind label, and shows
  // a worded staleness clock ("waiting 3m") instead of the same timestamp
  // rendered twice. Only applies while the row is unread AND its kind is
  // one the agent is actually blocked on (`isActionableKind`) — once
  // answered/read, the row reverts to the generic title-first layout like
  // every other notification.
  const isPeek = unread && isActionableKind(row.kind) && !!row.body;
  return (
    <li
      data-testid={`notification-row-${row.id}`}
      data-kind={row.kind}
      data-unread={unread ? "true" : "false"}
      className={cn("border-b border-[var(--border)] last:border-b-0", unread && "bg-[var(--panel-2)]/40")}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          void onClick();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            void onClick();
          }
        }}
        className="flex w-full cursor-pointer items-start gap-2 px-3 py-2 text-left hover:bg-[var(--panel-2)] focus:outline-none focus-visible:bg-[var(--panel-2)]"
      >
        <span className="mt-0.5 shrink-0 text-[var(--muted)]">
          <KindIcon kind={row.kind} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span
              data-testid="notification-primary-text"
              className={cn(
                "truncate text-xs",
                unread ? "font-medium text-[var(--foreground)]" : "text-[var(--muted)]",
              )}
            >
              {isPeek ? row.body : row.title}
            </span>
            {unread && (
              <span aria-hidden className="ml-auto inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
            )}
          </span>
          {isPeek ? (
            <span className="line-clamp-2 text-[10px] text-[var(--muted)]">{row.title}</span>
          ) : (
            row.body && <span className="line-clamp-2 text-[10px] text-[var(--muted)]">{row.body}</span>
          )}
          <span className="flex items-center gap-2 text-[9px] text-[var(--muted)]/70">
            {workspaceLabel && (
              <span className="rounded bg-[var(--panel-2)] px-1 py-px font-mono text-[9px] text-[var(--muted)]">
                {workspaceLabel}
              </span>
            )}
            <span data-testid="notification-clock-text">
              {isPeek ? `waiting ${formatWaiting(row.createdAt)}` : formatRelative(row.createdAt)}
            </span>
            {unread && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onMarkRead();
                }}
                className="hover:text-[var(--foreground)]"
              >
                Mark read
              </button>
            )}
          </span>
        </span>
      </div>
    </li>
  );
}

function KindIcon({ kind }: { kind: NotificationKind }) {
  // Inline the switch so the React 19 lint rule `react-hooks/static-components`
  // sees a stable component reference at each return site (versus a dynamic
  // `const Icon = lookup(kind); <Icon />` which it flags as "creating
  // components during render").
  const cls = "h-3.5 w-3.5";
  switch (kind) {
    case "permission_request":
      return <KeySquare className={cls} />;
    case "ask_user_question":
      return <HelpCircle className={cls} />;
    case "plan_approval_request":
      return <Sparkles className={cls} />;
    case "session_error":
      return <AlertCircle className={cls} />;
    case "session_idle":
      return <Hourglass className={cls} />;
    case "scheduled_run_finished":
      return <Calendar className={cls} />;
    default:
      return <Bell className={cls} />;
  }
}

function formatRelative(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

/**
 * Worded staleness clock for a still-pending blocked-session peek — e.g.
 * "waiting 3m". Same bucketing as `formatRelative` but phrased as an
 * ongoing wait rather than a point-in-time timestamp, since the row hasn't
 * been answered yet (Claude Code TUI parity, 2.1.207).
 */
function formatWaiting(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 60_000) return "<1m";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}

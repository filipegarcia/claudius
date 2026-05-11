"use client";

import { Pin, Trash2, ShieldAlert } from "lucide-react";
import type { Message as ChatMessage } from "@/lib/shared/community";
import { cn } from "@/lib/utils/cn";

type Props = {
  message: ChatMessage;
  isOwn: boolean;
  isAdmin: boolean;
  isPinned: boolean;
  onDelete?: () => void;
  onPin?: () => void;
  onBan?: () => void;
};

/**
 * One chat row.
 *
 * Layout: header (nick + relative timestamp + admin/pinned chips) above
 * the body. Admin messages get an accent left bar so they stand out from
 * the wall of regular chatter. Own messages are right-aligned IRC-style
 * to make scanning faster.
 *
 * Moderation controls (delete / pin / ban) only render when this client
 * is admin — they're invisible to everyone else.
 */
export function Message({
  message,
  isOwn,
  isAdmin,
  isPinned,
  onDelete,
  onPin,
  onBan,
}: Props) {
  return (
    <div
      className={cn(
        "group flex w-full",
        isOwn ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "max-w-[78%] rounded-2xl border border-[var(--border)] px-3 py-2",
          message.isAdmin
            ? "border-l-2 border-l-[var(--accent)] bg-[var(--panel-2)]"
            : isOwn
              ? "bg-[var(--panel-2)]"
              : "bg-[var(--panel)]",
        )}
      >
        <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-[var(--muted)]">
          <span
            className={cn(
              "font-mono font-medium",
              message.isAdmin ? "text-[var(--accent)]" : "text-[var(--foreground)]",
            )}
          >
            {message.nick}
          </span>
          {message.isAdmin && (
            <span className="rounded bg-[var(--accent)]/10 px-1 py-px font-mono text-[9px] uppercase tracking-wider text-[var(--accent)]">
              admin
            </span>
          )}
          {isPinned && (
            <span className="inline-flex items-center gap-0.5 font-mono text-[9px] uppercase tracking-wider text-[var(--muted)]">
              <Pin className="h-2.5 w-2.5" /> pinned
            </span>
          )}
          <span className="font-mono">{formatTime(message.createdAt)}</span>
        </div>
        <div className="whitespace-pre-wrap break-words text-sm leading-6">
          {message.body}
        </div>
        {isAdmin && (onDelete || onPin || onBan) && (
          <div className="mt-1 flex justify-end gap-1 opacity-0 transition group-hover:opacity-100">
            {onPin && (
              <button
                type="button"
                onClick={onPin}
                title={isPinned ? "Already pinned" : "Pin"}
                disabled={isPinned}
                className="rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-30"
              >
                <Pin className="h-3.5 w-3.5" />
              </button>
            )}
            {onBan && !message.isAdmin && (
              <button
                type="button"
                onClick={onBan}
                title={`Ban ${message.nick}`}
                className="rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--accent)]"
              >
                <ShieldAlert className="h-3.5 w-3.5" />
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                onClick={onDelete}
                title="Delete"
                className="rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--accent)]"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Render the timestamp compactly. Under a minute we say "now", under an
 * hour we say "Nm", under a day "Nh", otherwise the local time.
 */
function formatTime(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 60_000) return "now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

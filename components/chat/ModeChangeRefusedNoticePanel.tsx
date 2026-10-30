"use client";

import { useEffect } from "react";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { ShieldAlert, X } from "lucide-react";
import { PERMISSION_MODE_META } from "@/components/chat/ModeSelector";

/**
 * CC 2.1.314 parity — "[Cloud sessions] Fixed the permission mode picker
 * staying on Auto after a running cloud or Remote Control session refused
 * the switch; it now shows the mode in use and tells you".
 *
 * In Claudius the session's engine can refuse a `set_permission_mode`
 * (bypass disabled by settings, a mode the host doesn't support, …). The
 * server rolls back and `POST /mode` answers 409; the mode pill shows the
 * mode still in use, and this transient banner says the switch didn't
 * happen. Same shape and slot as `AutoModeOffNoticePanel`, its sibling for
 * the host-initiated kick-out.
 */
export type ModeChangeRefusedNotice = {
  uuid: string;
  requested: PermissionMode;
  mode: PermissionMode;
  reason: string;
};

const AUTO_DISMISS_MS = 10_000;

export function modeChangeRefusedText(requested: PermissionMode, mode: PermissionMode): string {
  const req = PERMISSION_MODE_META[requested]?.label ?? requested;
  const cur = PERMISSION_MODE_META[mode]?.label ?? mode;
  return `Couldn't switch to ${req}: the session refused. Still in ${cur}.`;
}

export function ModeChangeRefusedNoticePanel({
  notice,
  onDismiss,
}: {
  notice: ModeChangeRefusedNotice | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [notice, onDismiss]);

  if (!notice) return null;

  return (
    <div
      data-pane-name="mode-change-refused-notice"
      data-testid="mode-change-refused-notice"
      role="status"
      className="border-y border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-100"
    >
      <div className="mx-auto flex max-w-[var(--chat-col)] items-center gap-2">
        <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <span className="font-medium">{modeChangeRefusedText(notice.requested, notice.mode)}</span>
        {notice.reason && (
          <span
            data-testid="mode-change-refused-reason"
            className="hidden min-w-0 truncate text-[var(--muted)] sm:inline"
            title={notice.reason}
          >
            {notice.reason}
          </span>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="ml-auto shrink-0 rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

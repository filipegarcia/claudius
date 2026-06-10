"use client";

import { useEffect } from "react";
import { Cpu, X } from "lucide-react";

/**
 * Transient toast shown when the user switches model via the `/model` slash
 * command typed in the chat (as opposed to the SessionCard picker). Mirrors
 * the Claude Code TUI's help text:
 *
 *   "Switch between Claude models. Your pick becomes the default for new
 *    sessions."
 *
 * Auto-dismisses after a few seconds; the user can also dismiss manually.
 */
export type ModelChatCommandNotice = {
  /** Stable across re-renders of the same notice; bumped per switch. */
  uuid: string;
  /** Full model id emitted by the SDK (e.g. "claude-fable-5"). */
  model: string;
};

const AUTO_DISMISS_MS = 8_000;

/** Trim "claude-" prefix and 8-digit date suffixes for compact display. */
function shortModel(m: string): string {
  return m.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

export function ModelChatCommandNoticePanel({
  notice,
  onDismiss,
}: {
  notice: ModelChatCommandNotice | null;
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
      data-pane-name="model-chat-command-notice"
      data-model={notice.model}
      className="border-y border-[var(--accent)]/30 bg-[var(--accent)]/8 px-4 py-1.5 text-xs text-[var(--foreground)]"
    >
      <div className="mx-auto flex max-w-[var(--chat-col)] items-center gap-2">
        <Cpu className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
        <span className="font-medium">Switched to {shortModel(notice.model)}</span>
        <span className="hidden truncate text-[var(--muted)] sm:inline">
          · Your pick becomes the default for new sessions
        </span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss model switch notice"
          className="ml-auto shrink-0 rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

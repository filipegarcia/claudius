"use client";

import { Pin, X } from "lucide-react";
import type { Message } from "@/lib/shared/community";

type Props = {
  message: Message;
  isAdmin: boolean;
  onUnpin?: () => void;
  /**
   * When provided, the pinned author's nickname renders as a button
   * that opens a DM with them. Parent passes `undefined` when the
   * pinned message is the user's own (DMing yourself is a no-op).
   */
  onSelectNick?: () => void;
};

/**
 * Sticky strip at the top of a room when something is pinned.
 * Compact, single-line preview that doesn't steal too much vertical
 * space from the message log. Admins get an X to unpin.
 */
export function PinnedBanner({ message, isAdmin, onUnpin, onSelectNick }: Props) {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel-2)] px-4 py-2 text-xs">
      <Pin className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
      {onSelectNick ? (
        <button
          type="button"
          onClick={onSelectNick}
          title={`Direct message ${message.nick}`}
          className="rounded font-mono text-[var(--muted)] underline-offset-2 hover:text-[var(--foreground)] hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
        >
          {message.nick}
        </button>
      ) : (
        <span className="font-mono text-[var(--muted)]">{message.nick}</span>
      )}
      <span className="truncate text-[var(--foreground)]">{message.body}</span>
      {isAdmin && onUnpin && (
        <button
          type="button"
          onClick={onUnpin}
          title="Unpin"
          className="ml-auto rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

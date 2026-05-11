"use client";

import { Pin, X } from "lucide-react";
import type { Message } from "@/lib/shared/community";

type Props = {
  message: Message;
  isAdmin: boolean;
  onUnpin?: () => void;
};

/**
 * Sticky strip at the top of a room when something is pinned.
 * Compact, single-line preview that doesn't steal too much vertical
 * space from the message log. Admins get an X to unpin.
 */
export function PinnedBanner({ message, isAdmin, onUnpin }: Props) {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel-2)] px-4 py-2 text-xs">
      <Pin className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
      <span className="font-mono text-[var(--muted)]">{message.nick}</span>
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

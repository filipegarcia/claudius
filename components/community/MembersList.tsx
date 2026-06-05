"use client";

import { Users } from "lucide-react";
import { cn } from "@/lib/utils/cn";

type Props = {
  /** Currently-connected nicks for the room (server snapshot + deltas). */
  members: string[];
  /** Caller's own nick — highlighted in the list and not DM-able. */
  myNick: string | null;
  /**
   * Open a DM thread with the clicked nick. When omitted (or when the
   * row is self), the nick renders as plain text. Reuses the same
   * setter the channel-message clickable nicks use.
   */
  onSelectNick?: (nick: string) => void;
};

/**
 * IRC-style names list — the right sidebar in the community chat.
 *
 * Sources its data from `useCommunity().members`, which is hydrated by
 * a server-pushed `presence` snapshot on stream open and updated
 * incrementally via `member_joined` / `member_left` events.
 *
 * Sort order is alphabetical (case-insensitive), with the caller's own
 * nick floated to the top. Anonymous subscribers (older clients that
 * didn't pass `?nick=` on the SSE handshake) never appear here — the
 * server drops them from `activeNicks`.
 *
 * Click a nick to open a DM with that user. Clicking your own nick is
 * a no-op (the parent's `handleSelectNick` guards against self-DMs).
 */
export function MembersList({ members, myNick, onSelectNick }: Props) {
  const myLc = myNick?.toLowerCase() ?? null;
  const sorted = [...members].sort((a, b) => {
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    if (myLc !== null) {
      if (al === myLc && bl !== myLc) return -1;
      if (bl === myLc && al !== myLc) return 1;
    }
    return al.localeCompare(bl);
  });

  return (
    <aside
      className="flex w-48 shrink-0 flex-col border-l border-[var(--border)] bg-[var(--panel)]"
      data-testid="community-members-list"
    >
      <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2 text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
        <span className="flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5" />
          Members
        </span>
        <span
          className="font-mono text-[10px] text-[var(--muted)]"
          data-testid="community-members-count"
        >
          {sorted.length}
        </span>
      </div>
      {sorted.length === 0 ? (
        <p className="px-3 py-2 text-[10px] text-[var(--muted)]">
          No one connected.
        </p>
      ) : (
        <ul className="scroll-thin flex-1 overflow-y-auto px-1 py-1">
          {sorted.map((nick) => {
            const isSelf = myLc !== null && nick.toLowerCase() === myLc;
            const interactive = !isSelf && onSelectNick !== undefined;
            return (
              <li key={nick.toLowerCase()}>
                {interactive ? (
                  <button
                    type="button"
                    onClick={() => onSelectNick?.(nick)}
                    title={`Direct message ${nick}`}
                    data-testid={`community-member-${nick}`}
                    className="flex w-full items-center gap-1.5 truncate rounded px-2 py-1 text-left font-mono text-xs text-[var(--foreground)] hover:bg-[var(--panel-2)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
                    <span className="truncate">{nick}</span>
                  </button>
                ) : (
                  <div
                    className={cn(
                      "flex items-center gap-1.5 truncate px-2 py-1 font-mono text-xs",
                      isSelf
                        ? "text-[var(--accent)]"
                        : "text-[var(--foreground)]",
                    )}
                    data-testid={`community-member-${nick}`}
                    title={isSelf ? "You" : nick}
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
                    <span className="truncate">
                      {nick}
                      {isSelf && (
                        <span className="ml-1 text-[10px] text-[var(--muted)]">
                          (you)
                        </span>
                      )}
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

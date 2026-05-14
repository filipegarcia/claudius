"use client";

import { Hash } from "lucide-react";
import type { Room } from "@/lib/shared/community";
import { cn } from "@/lib/utils/cn";

type Props = {
  rooms: Room[];
  /**
   * Currently selected room slug. `null` when the main column is
   * showing something other than a room (e.g. a DM thread) — no row
   * shows the selected style in that case.
   */
  currentSlug: string | null;
  onSelect: (slug: string) => void;
  /** Per-room unread counts. Missing or 0 means no badge. */
  unreadByRoom?: Record<string, number>;
};

/**
 * Left rail: a vertical list of rooms. Selected room has the accent
 * border + slightly heavier surface. Echoes the SideNav active state.
 *
 * Rooms with unread messages get a small accent pill on the right,
 * mirroring the workspace switcher's per-tile badge. Landing on a room
 * clears its pill but leaves the others — see use-community-notifications.
 */
export function RoomList({ rooms, currentSlug, onSelect, unreadByRoom }: Props) {
  return (
    <nav className="flex flex-col gap-0.5 p-2">
      {rooms.map((r) => {
        const active = r.slug === currentSlug;
        const unread = unreadByRoom?.[r.slug] ?? 0;
        return (
          <button
            key={r.slug}
            type="button"
            onClick={() => onSelect(r.slug)}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition",
              active
                ? "bg-[var(--panel-2)] text-[var(--foreground)] ring-1 ring-[var(--border)]"
                : "text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]",
            )}
            title={r.description ?? r.name}
          >
            <Hash className="h-4 w-4 shrink-0" />
            <span className="truncate font-mono text-[13px]">{r.slug}</span>
            {unread > 0 && (
              <span
                aria-label={`${unread} unread`}
                data-testid={`community-room-unread-${r.slug}`}
                className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-medium leading-none text-white"
              >
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

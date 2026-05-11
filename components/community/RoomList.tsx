"use client";

import { Hash } from "lucide-react";
import type { Room } from "@/lib/shared/community";
import { cn } from "@/lib/utils/cn";

type Props = {
  rooms: Room[];
  currentSlug: string;
  onSelect: (slug: string) => void;
};

/**
 * Left rail: a vertical list of rooms. Selected room has the accent
 * border + slightly heavier surface. Echoes the SideNav active state.
 */
export function RoomList({ rooms, currentSlug, onSelect }: Props) {
  return (
    <nav className="flex flex-col gap-0.5 p-2">
      {rooms.map((r) => {
        const active = r.slug === currentSlug;
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
          </button>
        );
      })}
    </nav>
  );
}

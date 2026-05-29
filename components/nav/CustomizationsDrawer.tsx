"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { WandSparkles, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { Workspace } from "@/lib/server/workspaces-store";

/**
 * Single rail tile that stands in for every customization workspace. The
 * actual customization tiles used to live in the WorkspaceSwitcher main list
 * and bloated the rail once the user had more than a couple. This drawer
 * collapses them into one wand tile + a flyout panel.
 *
 * Conventions inherited from {@link WorkspaceSwitcher}:
 * - Active-tile indicator is an 8px-wide accent bar flush with the aside's
 *   left edge (the aside has an 8px gutter on each side of a 40px tile).
 * - Active tile also gets `ring-2 ring-[var(--accent)]` with offset so it's
 *   unmistakable on themes where the rail blends into the chat background.
 */
export function CustomizationsDrawer({
  customizations,
  activeId,
  onSelect,
  onOpen,
  unreadCounts,
}: {
  customizations: Workspace[];
  activeId: string | null;
  onSelect: (id: string) => void | Promise<void>;
  /**
   * Called when the popover transitions closed → open. The parent uses it
   * to refetch `/api/workspaces` so newly-bootstrapped customizations
   * (and removals) show up immediately rather than only after the next
   * full reload. Fired synchronously with the open-state flip — errors
   * inside the promise are swallowed so the panel still renders.
   */
  onOpen?: () => void | Promise<void>;
  /**
   * Per-customization unread counts (keyed by workspaceId). The trigger
   * tile renders a badge summing across all customizations, and the
   * popover rows render per-tile badges. Without this prop, customization
   * workspaces have no notification indicator anywhere — they're hidden
   * from the main rail and the wand tile was previously badge-less, so
   * any unread there was effectively invisible.
   */
  unreadCounts?: Record<string, number>;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const active = customizations.find((c) => c.id === activeId) ?? null;
  const hasActive = active !== null;
  // Sum unread across every customization. The wand tile is the ONLY rail
  // affordance for customization workspaces, so this badge is the sole
  // place a user notices that a customization is asking for attention.
  const totalCustomizationUnread = customizations.reduce(
    (acc, c) => acc + (unreadCounts?.[c.id] ?? 0),
    0,
  );

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

  const sorted = [...customizations].sort((a, b) => {
    if (a.id === activeId) return -1;
    if (b.id === activeId) return 1;
    return (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0);
  });

  const titleAttr = hasActive
    ? `Customization: ${stripPrefix(active.name)} (active) — click for list`
    : customizations.length > 0
      ? `${customizations.length} customization${customizations.length === 1 ? "" : "s"} — click for list`
      : "Customizations — click to manage";

  return (
    <div className="relative">
      {hasActive && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-[-8px] top-1/2 h-8 w-1 -translate-y-1/2 rounded-r bg-[var(--accent)]"
        />
      )}
      <button
        ref={triggerRef}
        onClick={() => {
          setOpen((o) => {
            const next = !o;
            // Fire refresh on the closed → open transition only. Skip when
            // closing so we don't pay for a network round-trip the user
            // won't see. The promise is intentionally unawaited — the
            // popover renders the current list synchronously and React
            // re-renders it once the parent's state lands.
            if (next && onOpen) {
              void Promise.resolve(onOpen()).catch(() => {
                // Refresh failed (offline, server restart) — keep showing
                // the stale list rather than blowing up the rail. The
                // drawer's own data still functions.
              });
            }
            return next;
          });
        }}
        title={
          totalCustomizationUnread > 0
            ? `${titleAttr} — ${totalCustomizationUnread} unread`
            : titleAttr
        }
        className={cn(
          "relative flex h-10 w-10 items-center justify-center rounded-lg transition",
          hasActive
            ? "bg-[var(--accent)]/15 text-[var(--accent)] ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--background)]"
            : "text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]",
        )}
      >
        <WandSparkles className="h-4 w-4" />
        {totalCustomizationUnread > 0 && (
          <span
            aria-label={`${totalCustomizationUnread} unread notification${totalCustomizationUnread === 1 ? "" : "s"}`}
            data-testid="customizations-drawer-badge"
            className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[9px] font-medium leading-none text-white shadow ring-1 ring-[var(--background)]"
          >
            {totalCustomizationUnread > 99 ? "99+" : totalCustomizationUnread}
          </span>
        )}
      </button>
      {open && (
        <div
          ref={panelRef}
          className="absolute left-[calc(100%+12px)] top-0 z-50 w-64 rounded-md border border-[var(--border)] bg-[var(--panel)] py-1 shadow-lg"
        >
          <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
            Customizations
          </div>
          {sorted.length === 0 ? (
            <div className="px-3 py-3 text-xs text-[var(--muted)]">
              You don&apos;t have any customizations yet.
            </div>
          ) : (
            <ul className="max-h-72 overflow-auto">
              {sorted.map((c) => {
                const isActive = c.id === activeId;
                const unread = unreadCounts?.[c.id] ?? 0;
                return (
                  <li key={c.id}>
                    <button
                      onClick={() => {
                        setOpen(false);
                        if (!isActive) void onSelect(c.id);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--panel-2)]",
                        isActive && "bg-[var(--panel-2)]/60",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "inline-flex h-2 w-2 shrink-0 rounded-full",
                          isActive ? "bg-[var(--accent)]" : "bg-[var(--border)]",
                        )}
                      />
                      <span className="truncate">{stripPrefix(c.name)}</span>
                      {unread > 0 && (
                        <span
                          aria-label={`${unread} unread notification${unread === 1 ? "" : "s"}`}
                          className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[9px] font-medium leading-none text-white"
                        >
                          {unread > 99 ? "99+" : unread}
                        </span>
                      )}
                      {isActive && unread === 0 && (
                        <span className="ml-auto text-[10px] font-medium uppercase tracking-wide text-[var(--accent)]">
                          active
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="my-1 h-px bg-[var(--border)]" />
          <Link
            href="/customize"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
          >
            <Settings2 className="h-3.5 w-3.5" />
            Manage all
          </Link>
        </div>
      )}
    </div>
  );
}

function stripPrefix(name: string): string {
  return name.replace(/^Customize · /, "");
}

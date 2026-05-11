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
}: {
  customizations: Workspace[];
  activeId: string | null;
  onSelect: (id: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const active = customizations.find((c) => c.id === activeId) ?? null;
  const hasActive = active !== null;

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
        onClick={() => setOpen((o) => !o)}
        title={titleAttr}
        className={cn(
          "relative flex h-10 w-10 items-center justify-center rounded-lg transition",
          hasActive
            ? "bg-[var(--accent)]/15 text-[var(--accent)] ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--background)]"
            : "text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]",
        )}
      >
        <WandSparkles className="h-4 w-4" />
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
                      {isActive && (
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

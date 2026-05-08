"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils/cn";

type Props = {
  /** Stable key used to persist the collapse state in localStorage. */
  storageKey: string;
  label: string;
  /** Optional small badge after the label (e.g. count). */
  badge?: React.ReactNode;
  /**
   * Optional element rendered at the right edge of the header row, OUTSIDE
   * the collapse-toggle button (so it can be its own clickable target — e.g.
   * a `+` to add an item without toggling the section).
   */
  action?: React.ReactNode;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
};

export function CollapsibleSection({ storageKey, label, badge, action, defaultCollapsed = false, children }: Props) {
  const fullKey = `claudius.activity.${storageKey}.collapsed`;
  const [collapsed, setCollapsed] = useState<boolean>(defaultCollapsed);

  // Hydrate from localStorage after mount (avoid SSR mismatch).
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(fullKey);
      if (raw === "1") setCollapsed(true);
      else if (raw === "0") setCollapsed(false);
    } catch {
      // ignore
    }
  }, [fullKey]);

  function toggle() {
    setCollapsed((c) => {
      const next = !c;
      try {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(fullKey, next ? "1" : "0");
        }
      } catch {
        // ignore
      }
      return next;
    });
  }

  return (
    <div className="mb-3">
      <div className="flex items-center gap-1 pb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">
        <button
          type="button"
          onClick={toggle}
          className="flex flex-1 items-center gap-1 px-1 hover:text-[var(--foreground)]"
        >
          {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          <span>{label}</span>
          {badge != null && <span className="ml-1 normal-case tracking-normal">{badge}</span>}
        </button>
        {action && <div className="flex shrink-0 items-center pr-1">{action}</div>}
      </div>
      <div className={cn(collapsed && "hidden")}>{children}</div>
    </div>
  );
}

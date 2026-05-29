"use client";

import { useCallback, useSyncExternalStore } from "react";
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
  // Source-of-truth is localStorage, read through useSyncExternalStore so
  // the value is always live (cross-tab toggles propagate via the
  // `storage` event and same-tab toggles propagate via a custom
  // `claudius.activity.changed` event). Server snapshot returns
  // `defaultCollapsed` so the initial markup matches the pre-hydration
  // client paint — no SSR mismatch. This replaces a former
  // `useEffect(setCollapsed(...))` that tripped
  // react-hooks/set-state-in-effect.
  const subscribe = useCallback((cb: () => void) => {
    if (typeof window === "undefined") return () => {};
    const onStorage = (e: StorageEvent) => {
      if (e.key === fullKey) cb();
    };
    const onCustom = () => cb();
    window.addEventListener("storage", onStorage);
    window.addEventListener("claudius.activity.changed", onCustom);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("claudius.activity.changed", onCustom);
    };
  }, [fullKey]);
  const getSnapshot = useCallback(() => {
    if (typeof window === "undefined") return defaultCollapsed;
    try {
      const raw = window.localStorage.getItem(fullKey);
      if (raw === "1") return true;
      if (raw === "0") return false;
    } catch {
      // ignore
    }
    return defaultCollapsed;
  }, [fullKey, defaultCollapsed]);
  const collapsed = useSyncExternalStore(subscribe, getSnapshot, () => defaultCollapsed);

  function toggle() {
    const next = !collapsed;
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(fullKey, next ? "1" : "0");
        // Tell useSyncExternalStore subscribers in this tab to re-read —
        // the native `storage` event only fires for OTHER tabs.
        window.dispatchEvent(new Event("claudius.activity.changed"));
      }
    } catch {
      // ignore
    }
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

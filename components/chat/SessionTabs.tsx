"use client";

import { Plus, X } from "lucide-react";
import type { SessionInfo } from "@/lib/client/types";
import { cn } from "@/lib/utils/cn";

export type TabStatus = "running" | "idle" | "starting" | "error" | "background";

type Tab = {
  id: string;
  /** Optional human-readable label; falls back to short id. */
  label?: string;
  status: TabStatus;
};

type Props = {
  tabs: Tab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
};

export function SessionTabs({ tabs, activeId, onSelect, onClose, onNew }: Props) {
  if (tabs.length === 0) return null;
  return (
    <div className="flex h-8 shrink-0 items-stretch gap-px overflow-x-auto border-b border-[var(--border)] bg-[var(--panel)] scroll-thin">
      {tabs.map((t) => {
        const active = t.id === activeId;
        return (
          <div
            key={t.id}
            className={cn(
              "group flex items-center gap-1.5 border-r border-[var(--border)] px-2 text-[11px]",
              active
                ? "bg-[var(--background)] text-[var(--foreground)]"
                : "bg-[var(--panel)]/40 text-[var(--muted)] hover:bg-[var(--panel-2)]/60",
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(t.id)}
              onAuxClick={(e) => {
                if (e.button === 1) onClose(t.id); // middle-click closes
              }}
              className="flex min-w-0 items-center gap-1.5"
              title={`${t.label ?? t.id}\n${t.status}`}
            >
              <StatusDot status={t.status} />
              <span className="max-w-[180px] truncate font-mono">
                {t.label ?? t.id.slice(0, 8)}
              </span>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
              title="Close tab"
              className={cn(
                "flex h-4 w-4 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]",
                !active && "opacity-0 group-hover:opacity-100",
              )}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onNew}
        title="New session tab"
        className="flex w-8 shrink-0 items-center justify-center text-[var(--muted)] hover:bg-[var(--panel-2)]/60 hover:text-[var(--foreground)]"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function StatusDot({ status }: { status: TabStatus }) {
  const tone =
    status === "running"
      ? "bg-[var(--accent)] animate-pulse"
      : status === "starting"
        ? "bg-amber-400"
        : status === "error"
          ? "bg-red-500"
          : status === "idle"
            ? "bg-emerald-400"
            : "bg-[var(--muted)]/60"; // background
  return <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone)} aria-hidden />;
}

/** Helper: derive the right TabStatus for the *active* tab from useSession state. */
export function activeTabStatus(opts: {
  ready: boolean;
  pending: boolean;
  hasError: boolean;
}): TabStatus {
  if (opts.hasError) return "error";
  if (!opts.ready) return "starting";
  if (opts.pending) return "running";
  return "idle";
}

/** Helper: pick a label for a session — short id is the v1 fallback. */
export function tabLabelFor(id: string, sessions: SessionInfo[], titleOverride?: string | null): string {
  if (titleOverride && titleOverride.trim()) return titleOverride.trim();
  // Future: cwd basename, persisted title, etc.
  void sessions;
  return id.slice(0, 8);
}

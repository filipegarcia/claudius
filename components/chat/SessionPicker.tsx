"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { SessionInfo } from "@/lib/client/types";

type Props = {
  current: string | null;
  sessions: SessionInfo[];
  onSwitch: (id: string) => void;
  onCreateNew: () => void;
  onRefresh: () => void;
};

/**
 * StatusLine chip that opens the session switcher dropdown. Renders a terse
 * `Session <8-char-id>` label — the human-readable session title now lives
 * exclusively on the RecapBanner (which also owns rename), so this stays out
 * of the way of long titles in a crowded header.
 */
export function SessionPicker({
  current,
  sessions,
  onSwitch,
  onCreateNew,
  onRefresh,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    onRefresh();
    function onClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onEsc);
    };
    // onRefresh is stable from useSession; safe to include.
  }, [open, onRefresh]);

  const label = current ? `Session ${current.slice(0, 8)}` : "—";

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "group flex items-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-xs",
          "hover:border-[var(--border)] hover:bg-[var(--panel-2)]",
          open && "border-[var(--border)] bg-[var(--panel-2)]",
        )}
        title={current ? `Session ${current}` : "Switch session"}
        data-testid="session-picker-button"
      >
        <span className="font-mono" data-testid="session-picker-label">
          {label}
        </span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-80 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)] shadow-2xl">
          <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2 text-[10px] uppercase tracking-wide text-[var(--muted)]">
            <span>Sessions ({sessions.length})</span>
            <button
              onClick={() => onRefresh()}
              className="flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--panel-2)]"
              title="Refresh"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto scroll-thin">
            {sessions.length === 0 && (
              <div className="px-3 py-3 text-xs text-[var(--muted)]">No sessions yet.</div>
            )}
            {sessions.map((s) => {
              const active = s.id === current;
              return (
                <button
                  key={s.id}
                  onClick={() => {
                    if (!active) onSwitch(s.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-start gap-2 px-3 py-2 text-left text-xs",
                    "hover:bg-[var(--panel-2)]",
                    active && "bg-[var(--panel-2)]",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[var(--foreground)]">
                      {s.title?.trim() || (
                        <span className="text-[var(--muted)] italic">Untitled</span>
                      )}
                    </div>
                    <div className="truncate text-[var(--muted)]">
                      <span className="font-mono">{s.id.slice(0, 8)}</span>
                      {s.cwd ? ` · ${cwdBasename(s.cwd)}` : ""}
                      {s.model ? ` · ${s.model}` : ""}
                    </div>
                  </div>
                  {active && <span className="mt-0.5 text-[10px] text-[var(--accent)]">●</span>}
                </button>
              );
            })}
          </div>
          <div className="border-t border-[var(--border)]">
            <button
              onClick={() => {
                onCreateNew();
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--panel-2)]"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>New session</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function cwdBasename(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Pencil, Plus, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { SessionInfo } from "@/lib/client/types";

type Props = {
  current: string | null;
  /** Persisted title; null when none. Falls back to `Session <prefix>`. */
  title?: string | null;
  /** Inline rename action — returns ok/error so the chip can flash on failure. */
  onRename?: (newTitle: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  sessions: SessionInfo[];
  onSwitch: (id: string) => void;
  onCreateNew: () => void;
  onRefresh: () => void;
};

export function SessionPicker({
  current,
  title,
  onRename,
  sessions,
  onSwitch,
  onCreateNew,
  onRefresh,
}: Props) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const fallback = current ? `Session ${current.slice(0, 8)}` : "—";
  const displayLabel = title && title.trim() ? title : fallback;
  const idShort = current ? current.slice(0, 8) : null;

  function startEdit() {
    if (!current || !onRename) return;
    setDraft(title ?? "");
    setSaveErr(null);
    setEditing(true);
    setOpen(false);
  }

  async function commitEdit() {
    if (!onRename) {
      setEditing(false);
      return;
    }
    const value = draft.trim();
    if (!value) {
      setEditing(false);
      return;
    }
    if (value === (title ?? "")) {
      setEditing(false);
      return;
    }
    const r = await onRename(value);
    if (!r.ok) {
      setSaveErr(r.error);
      // Keep editing so the user can retry / fix.
      return;
    }
    setEditing(false);
    setSaveErr(null);
  }

  if (editing) {
    return (
      <div ref={ref} className="relative" data-testid="session-picker-edit">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commitEdit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
              setSaveErr(null);
            }
          }}
          onBlur={() => void commitEdit()}
          placeholder={fallback}
          maxLength={120}
          aria-label="Session title"
          data-testid="session-title-input"
          className={cn(
            "rounded-md border border-[var(--accent)]/60 bg-[var(--panel-2)] px-1.5 py-0.5 text-xs",
            "outline-none focus:border-[var(--accent)]",
            saveErr && "border-red-500/60",
          )}
          style={{ minWidth: "12rem" }}
        />
        {saveErr && (
          <span className="ml-2 text-[10px] text-red-300" data-testid="session-title-error">
            {saveErr}
          </span>
        )}
      </div>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        onDoubleClick={(e) => {
          if (!current || !onRename) return;
          e.preventDefault();
          startEdit();
        }}
        className={cn(
          "group flex items-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-xs",
          "hover:border-[var(--border)] hover:bg-[var(--panel-2)]",
          open && "border-[var(--border)] bg-[var(--panel-2)]",
        )}
        title={current ? `Session ${current}\nDouble-click to rename` : "Switch session"}
        data-testid="session-picker-button"
      >
        <span className="font-mono" data-testid="session-picker-label">
          {displayLabel}
        </span>
        {idShort && title && title.trim() && (
          <span className="font-mono text-[10px] opacity-50" data-testid="session-picker-short-id">
            {idShort}
          </span>
        )}
        {current && onRename && (
          <span
            role="button"
            tabIndex={0}
            aria-label="Rename session"
            onClick={(e) => {
              e.stopPropagation();
              startEdit();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                startEdit();
              }
            }}
            className="rounded p-0.5 text-[var(--muted)] opacity-0 transition group-hover:opacity-100 hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
            data-testid="session-rename-button"
          >
            <Pencil className="h-3 w-3" />
          </span>
        )}
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
                    <div className="font-mono text-[var(--foreground)]">{s.id.slice(0, 8)}</div>
                    <div className="truncate text-[var(--muted)]">
                      {s.cwd ? cwdBasename(s.cwd) : "—"}
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

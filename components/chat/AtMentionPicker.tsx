"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { File, Folder } from "lucide-react";

export type FsEntry = { relPath: string; absPath: string; type: "file" | "dir" };

type Props = {
  query: string;
  cwd: string | null;
  onSelect: (relPath: string) => void;
  onClose: () => void;
};

export function AtMentionPicker({ query, cwd, onSelect, onClose }: Props) {
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [hi, setHi] = useState(0);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ q: query, limit: "50" });
    if (cwd) params.set("cwd", cwd);
    fetch(`/api/fs/list?${params}`)
      .then((r) => r.json())
      .then((d: { entries?: FsEntry[] }) => {
        if (!cancelled) setEntries(d.entries ?? []);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, cwd]);

  useEffect(() => {
    setHi(0);
  }, [entries.length]);

  const visible = useMemo(() => entries.slice(0, 30), [entries]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (visible.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHi((h) => (h + 1) % visible.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHi((h) => (h - 1 + visible.length) % visible.length);
      } else if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        onSelect(visible[hi].relPath);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [hi, visible, onClose, onSelect]);

  useEffect(() => {
    itemRefs.current[hi]?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  if (visible.length === 0 && !loading) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-72 overflow-auto rounded-xl border border-[var(--border)] bg-[var(--panel)] p-1 shadow-2xl scroll-thin">
      <div className="flex items-center justify-between px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">
        <span>@-mention · Tab to insert</span>
        <span>{loading ? "loading…" : `${entries.length} match${entries.length === 1 ? "" : "es"}`}</span>
      </div>
      {visible.map((e, i) => {
        const Icon = e.type === "dir" ? Folder : File;
        return (
          <button
            key={e.relPath}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            onMouseEnter={() => setHi(i)}
            onMouseDown={(ev) => {
              ev.preventDefault();
              onSelect(e.relPath);
            }}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs ${
              i === hi ? "bg-[var(--panel-2)]" : ""
            }`}
          >
            <Icon className="h-3 w-3 shrink-0 text-[var(--muted)]" />
            <span className="truncate font-mono">{e.relPath}</span>
          </button>
        );
      })}
    </div>
  );
}

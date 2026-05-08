"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export type Entry = {
  name: string;
  relPath: string;
  kind: "file" | "dir";
  sizeBytes?: number;
  modifiedMs?: number;
};

type Props = {
  workspaceId: string;
  onPick?: (e: Entry) => void;
};

export function FileTree({ workspaceId, onPick }: Props) {
  const [root, setRoot] = useState<Entry[]>([]);
  const [expanded, setExpanded] = useState<Record<string, Entry[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async (path: string): Promise<Entry[]> => {
    const res = await fetch(
      `/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}&depth=1`,
    );
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(e.error ?? `HTTP ${res.status}`);
    }
    const d = (await res.json()) as { entries: Entry[] };
    return d.entries;
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    load("")
      .then((entries) => {
        if (!cancelled) setRoot(entries);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const toggle = useCallback(
    async (e: Entry) => {
      const key = e.relPath;
      if (expanded[key]) {
        setExpanded((p) => {
          const n = { ...p };
          delete n[key];
          return n;
        });
        return;
      }
      try {
        const children = await load(key);
        setExpanded((p) => ({ ...p, [key]: children }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [expanded, load],
  );

  if (loading) return <div className="px-3 py-3 text-xs text-[var(--muted)]">Loading…</div>;
  if (error)
    return (
      <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>
    );

  return (
    <ul className="text-xs">
      {root.map((e) => (
        <Row
          key={e.relPath}
          entry={e}
          depth={0}
          expanded={expanded}
          toggle={toggle}
          selected={selected}
          setSelected={(rel) => {
            setSelected(rel);
            const ent = findEntry(rel, root, expanded);
            if (ent && onPick) onPick(ent);
          }}
        />
      ))}
    </ul>
  );
}

function Row({
  entry,
  depth,
  expanded,
  toggle,
  selected,
  setSelected,
}: {
  entry: Entry;
  depth: number;
  expanded: Record<string, Entry[]>;
  toggle: (e: Entry) => Promise<void>;
  selected: string | null;
  setSelected: (rel: string) => void;
}) {
  const isOpen = entry.kind === "dir" && expanded[entry.relPath];
  return (
    <>
      <li>
        <button
          onClick={() => {
            if (entry.kind === "dir") void toggle(entry);
            else setSelected(entry.relPath);
          }}
          className={cn(
            "flex w-full items-center gap-1 rounded-md px-2 py-0.5 text-left",
            "hover:bg-[var(--panel-2)]",
            selected === entry.relPath && "bg-[var(--panel-2)]",
          )}
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          {entry.kind === "dir" ? (
            isOpen ? (
              <ChevronDown className="h-3 w-3 shrink-0 text-[var(--muted)]" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 text-[var(--muted)]" />
            )
          ) : (
            <span className="w-3" />
          )}
          {entry.kind === "dir" ? (
            <Folder className="h-3 w-3 shrink-0 text-[var(--accent)]" />
          ) : (
            <File className="h-3 w-3 shrink-0 text-[var(--muted)]" />
          )}
          <span className="truncate font-mono">{entry.name}</span>
          {entry.kind === "file" && typeof entry.sizeBytes === "number" && (
            <span className="ml-auto text-[10px] text-[var(--muted)]">{fmtSize(entry.sizeBytes)}</span>
          )}
        </button>
      </li>
      {isOpen &&
        expanded[entry.relPath].map((child) => (
          <Row
            key={child.relPath}
            entry={child}
            depth={depth + 1}
            expanded={expanded}
            toggle={toggle}
            selected={selected}
            setSelected={setSelected}
          />
        ))}
    </>
  );
}

function findEntry(rel: string, root: Entry[], expanded: Record<string, Entry[]>): Entry | null {
  for (const e of root) {
    if (e.relPath === rel) return e;
    if (expanded[e.relPath]) {
      const r = findEntry(rel, expanded[e.relPath], expanded);
      if (r) return r;
    }
  }
  return null;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

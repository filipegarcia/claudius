"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { FilePathContextMenu } from "./FilePathContextMenu";

export type Entry = {
  name: string;
  relPath: string;
  kind: "file" | "dir";
  sizeBytes?: number;
  modifiedMs?: number;
};

type Props = {
  workspaceId: string;
  /**
   * Root selector — `primary` (default) for the workspace cwd, or
   * `extra:<n>` for a Files-browser additional directory. Threaded into
   * every fetch the tree issues so its rows stay bounded to the chosen
   * root server-side.
   */
  root?: string;
  onPick?: (e: Entry) => void;
  /**
   * Path (relative to the chosen root) to highlight, and — on first mount —
   * auto-expand its ancestor folders so a deep-linked nested file is visible.
   */
  selectedPath?: string | null;
  /**
   * When non-empty, the tree switches to search mode: a flat list of every
   * file (at any depth) whose root-relative path matches the query, fetched
   * from the server (`?search=`). Empty string = normal lazy tree.
   */
  query?: string;
};

export function FileTree({ workspaceId, root, onPick, selectedPath, query }: Props) {
  // `root` (prop) is the selector — `rootEntries` is the top-level listing
  // for that selector. Two different things; the rename keeps the prop name
  // matching the API param.
  const [rootEntries, setRootEntries] = useState<Entry[]>([]);
  const [expanded, setExpanded] = useState<Record<string, Entry[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(selectedPath ?? null);
  const [searchResults, setSearchResults] = useState<Entry[] | null>(null);
  const [searchTruncated, setSearchTruncated] = useState(false);
  // Right-click "Reveal in Finder" menu state. `path` is the row's
  // workspace-relative path; (x, y) are viewport coordinates fed straight
  // into position: fixed. Single-menu invariant — opening on one row
  // closes whichever was previously open.
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const q = (query ?? "").trim();

  // Clear stale results when the query empties (so leaving search mode doesn't
  // flash the old list). While typing one non-empty query into another we keep
  // the previous results visible until the new ones land — feels snappier than
  // blanking to "Searching…" on every keystroke. Render-phase "store previous
  // props" pattern, so no setState-in-effect.
  const [lastQuery, setLastQuery] = useState(q);
  if (lastQuery !== q) {
    setLastQuery(q);
    if (!q) {
      setSearchResults(null);
      setSearchTruncated(false);
    }
  }

  // Debounced server-side search. All setState lives in the timeout/promise
  // callbacks (never the effect body) to stay clear of set-state-in-effect.
  useEffect(() => {
    if (!q) return;
    let cancelled = false;
    const t = setTimeout(() => {
      const rootParam = root ? `&root=${encodeURIComponent(root)}` : "";
      fetch(`/api/workspaces/${workspaceId}/files?search=${encodeURIComponent(q)}${rootParam}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d: { entries?: Entry[]; truncated?: boolean }) => {
          if (cancelled) return;
          setSearchResults(Array.isArray(d.entries) ? d.entries : []);
          setSearchTruncated(Boolean(d.truncated));
        })
        .catch(() => {
          if (!cancelled) {
            setSearchResults([]);
            setSearchTruncated(false);
          }
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, workspaceId, root]);

  // Mirror externally-driven selection (deep-link, or the parent opening a
  // file) into the highlight. "Store previous props" pattern so the update
  // runs in render, not an effect (avoids react-hooks/set-state-in-effect).
  const [lastSelectedProp, setLastSelectedProp] = useState(selectedPath ?? null);
  if ((selectedPath ?? null) !== lastSelectedProp) {
    setLastSelectedProp(selectedPath ?? null);
    if (selectedPath) setSelected(selectedPath);
  }

  // One-shot: expand the ancestor folders of the initially deep-linked file so
  // it's revealed in the tree. Later navigation expands via user clicks.
  const didExpandRef = useRef(false);

  const load = useCallback(async (path: string): Promise<Entry[]> => {
    const rootParam = root ? `&root=${encodeURIComponent(root)}` : "";
    const res = await fetch(
      `/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}&depth=1${rootParam}`,
    );
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(e.error ?? `HTTP ${res.status}`);
    }
    const d = (await res.json()) as { entries: Entry[] };
    return d.entries;
  }, [workspaceId, root]);

  // Flip loading on whenever `load` identity changes (workspaceId
  // switches) — "store previous props" pattern so the setState happens
  // in render rather than inside the fetch effect, satisfying
  // react-hooks/set-state-in-effect.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [lastLoad, setLastLoad] = useState(() => load);
  if (lastLoad !== load) {
    setLastLoad(() => load);
    setLoading(true);
    setError(null);
  }

  useEffect(() => {
    let cancelled = false;
    load("")
      .then((entries) => {
        if (!cancelled) setRootEntries(entries);
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

  // Auto-expand the ancestor folders of the deep-linked file (once). Walk the
  // path segment by segment, loading + expanding each directory so the file
  // becomes visible in the tree. Best-effort: a missing/renamed dir just stops
  // the walk. Directory keys carry a trailing slash to match `Entry.relPath`.
  useEffect(() => {
    if (didExpandRef.current || !selectedPath) return;
    const segs = selectedPath.split("/").filter(Boolean);
    if (segs.length <= 1) {
      didExpandRef.current = true;
      return;
    }
    didExpandRef.current = true;
    let cancelled = false;
    void (async () => {
      let prefix = "";
      for (let i = 0; i < segs.length - 1; i++) {
        prefix = prefix ? `${prefix}/${segs[i]}` : segs[i];
        const dirKey = `${prefix}/`;
        try {
          const children = await load(prefix);
          if (cancelled) return;
          setExpanded((p) => (p[dirKey] ? p : { ...p, [dirKey]: children }));
        } catch {
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPath, load]);

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

  // Search mode: flat list of matches (full relPath shown so the containing
  // folder is visible). Takes precedence over the lazy tree / its loading state.
  if (q) {
    if (searchResults === null)
      return <div className="px-3 py-3 text-xs text-[var(--muted)]">Searching…</div>;
    if (searchResults.length === 0)
      return <div className="px-3 py-3 text-xs text-[var(--muted)]">No files match.</div>;
    return (
      <>
        <ul className="text-xs">
          {searchResults.map((e) => (
            <li key={e.relPath}>
              <button
                onClick={() => {
                  setSelected(e.relPath);
                  if (onPick) onPick(e);
                }}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  setMenu({ path: e.relPath, x: ev.clientX, y: ev.clientY });
                }}
                title={e.relPath}
                className={cn(
                  "flex w-full min-w-0 items-center gap-1 rounded-md px-2 py-0.5 text-left",
                  "hover:bg-[var(--panel-2)]",
                  selected === e.relPath && "bg-[var(--panel-2)]",
                )}
              >
                <File className="h-3 w-3 shrink-0 text-[var(--muted)]" />
                <span className="min-w-0 flex-1 truncate font-mono">{e.relPath}</span>
              </button>
            </li>
          ))}
          {searchTruncated && (
            <li className="px-3 py-1 text-[10px] italic text-[var(--muted)]">
              Showing first {searchResults.length} matches…
            </li>
          )}
        </ul>
        {menu && (
          <FilePathContextMenu
            workspaceId={workspaceId}
            root={root}
            relPath={menu.path}
            x={menu.x}
            y={menu.y}
            onClose={() => setMenu(null)}
          />
        )}
      </>
    );
  }

  if (loading) return <div className="px-3 py-3 text-xs text-[var(--muted)]">Loading…</div>;
  if (error)
    return (
      <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>
    );

  return (
    <>
      <ul className="text-xs">
        {rootEntries.map((e) => (
          <Row
            key={e.relPath}
            entry={e}
            depth={0}
            expanded={expanded}
            toggle={toggle}
            selected={selected}
            setSelected={(rel) => {
              setSelected(rel);
              const ent = findEntry(rel, rootEntries, expanded);
              if (ent && onPick) onPick(ent);
            }}
            onContextOpen={(rel, x, y) => setMenu({ path: rel, x, y })}
          />
        ))}
      </ul>
      {menu && (
        <FilePathContextMenu
          workspaceId={workspaceId}
          relPath={menu.path}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

function Row({
  entry,
  depth,
  expanded,
  toggle,
  selected,
  setSelected,
  onContextOpen,
}: {
  entry: Entry;
  depth: number;
  expanded: Record<string, Entry[]>;
  toggle: (e: Entry) => Promise<void>;
  selected: string | null;
  setSelected: (rel: string) => void;
  /** Right-click handler — opens the "Reveal in Finder" popover at (x,y). */
  onContextOpen: (relPath: string, x: number, y: number) => void;
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
          onContextMenu={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            onContextOpen(entry.relPath, ev.clientX, ev.clientY);
          }}
          title={entry.name}
          className={cn(
            "flex w-full min-w-0 items-center gap-1 rounded-md px-2 py-0.5 text-left",
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
            <span className="w-3 shrink-0" />
          )}
          {entry.kind === "dir" ? (
            <Folder className="h-3 w-3 shrink-0 text-[var(--accent)]" />
          ) : (
            <File className="h-3 w-3 shrink-0 text-[var(--muted)]" />
          )}
          <span className="min-w-0 flex-1 truncate font-mono">{entry.name}</span>
          {entry.kind === "file" && typeof entry.sizeBytes === "number" && (
            <span className="shrink-0 whitespace-nowrap pl-1 text-[10px] tabular-nums text-[var(--muted)]">
              {fmtSize(entry.sizeBytes)}
            </span>
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
            onContextOpen={onContextOpen}
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

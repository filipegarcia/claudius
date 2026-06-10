"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FolderSearch, Loader2, Search, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export type ContentMatch = {
  relPath: string;
  line: number;
  col: number;
  colEnd: number;
  text: string;
  truncated: boolean;
};

type Props = {
  workspaceId: string;
  /** Root selector (`primary` or `extra:<n>`) the folder lives under. */
  rootId: string;
  /** Folder path relative to the chosen root — the scope of the grep. */
  folderPath: string;
  /** Display label for the folder (usually the basename, or "root"). */
  folderLabel: string;
  /** Close the panel and return to the editor / placeholder. */
  onClose: () => void;
  /**
   * Open a hit. The page-level handler is responsible for loading the file
   * into the editor; we only forward the (path, line) pair.
   */
  onPick: (match: { relPath: string; line: number }) => void;
};

/**
 * Folder-scoped grep panel. Replaces the editor pane while active. The
 * server endpoint (`?contentSearch=`) does the recursive walk with binary
 * + size guards — we just debounce the query, group results by file, and
 * render them.
 *
 * Why not inline the input on the file tree side? The tree column is 320px
 * wide; a content-search needs the full pane height to show snippets and
 * remain useful on a tall list. Replacing the editor pane (which is empty
 * when no file is open anyway) keeps the layout balanced.
 */
export function FindInFolder({
  workspaceId,
  rootId,
  folderPath,
  folderLabel,
  onClose,
  onPick,
}: Props) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matches, setMatches] = useState<ContentMatch[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [scanned, setScanned] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Reset result state synchronously in render whenever the query becomes
  // empty — "store previous props" pattern so the setState doesn't sit
  // inside the fetch effect (react-hooks/set-state-in-effect).
  const trimmedQuery = query.trim();
  const [lastTrimmedQuery, setLastTrimmedQuery] = useState(trimmedQuery);
  if (lastTrimmedQuery !== trimmedQuery) {
    setLastTrimmedQuery(trimmedQuery);
    if (!trimmedQuery) {
      setMatches(null);
      setTruncated(false);
      setScanned(0);
      setError(null);
      setLoading(false);
    }
  }

  // Debounce server-side content search. All setState lives inside the
  // timeout / promise callbacks so the effect body itself is just a guard.
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    let cancelled = false;
    const t = setTimeout(() => {
      if (cancelled) return;
      setLoading(true);
      const rootQ = rootId === "primary" ? "" : `&root=${encodeURIComponent(rootId)}`;
      const caseQ = caseSensitive ? "&case=1" : "";
      const pathQ = folderPath ? `&path=${encodeURIComponent(folderPath)}` : "";
      fetch(
        `/api/workspaces/${workspaceId}/files?contentSearch=${encodeURIComponent(q)}${pathQ}${rootQ}${caseQ}`,
      )
        .then(async (r) => {
          if (!r.ok) {
            const j = (await r.json().catch(() => ({}))) as { error?: string };
            throw new Error(j.error ?? `HTTP ${r.status}`);
          }
          return r.json();
        })
        .then((d: { matches?: ContentMatch[]; truncated?: boolean; scanned?: number }) => {
          if (cancelled) return;
          setMatches(Array.isArray(d.matches) ? d.matches : []);
          setTruncated(Boolean(d.truncated));
          setScanned(typeof d.scanned === "number" ? d.scanned : 0);
          setError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
          setMatches([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, caseSensitive, workspaceId, rootId, folderPath]);

  // Group matches by file so users can scan results file-by-file. Keep the
  // server's sort order (already path + line ascending) — just bucket.
  const grouped = useMemo(() => {
    const out: Array<{ relPath: string; hits: ContentMatch[] }> = [];
    if (!matches) return out;
    for (const m of matches) {
      const last = out[out.length - 1];
      if (last && last.relPath === m.relPath) last.hits.push(m);
      else out.push({ relPath: m.relPath, hits: [m] });
    }
    return out;
  }, [matches]);

  const totalMatches = matches?.length ?? 0;
  const folderDisplay = folderPath ? folderPath.replace(/\/$/, "") : folderLabel;

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="files-find-in-folder">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--panel-2)]/40 px-3 text-xs">
        <FolderSearch className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
        <span className="font-medium">Find in folder</span>
        <span className="truncate font-mono text-[var(--muted)]" title={folderDisplay}>
          {folderDisplay}
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Close (Esc)"
          className="ml-auto flex h-6 w-6 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 text-xs">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder={`Search in ${folderLabel}…`}
            aria-label="Find in folder"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] py-1 pl-8 pr-7 font-mono text-xs focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              title="Clear"
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-[var(--muted)] hover:text-[var(--foreground)]"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setCaseSensitive((c) => !c)}
          aria-pressed={caseSensitive}
          title={caseSensitive ? "Case sensitive (on)" : "Case sensitive (off)"}
          className={cn(
            "rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--muted)] hover:text-[var(--foreground)]",
            caseSensitive && "bg-[var(--panel-2)] text-[var(--foreground)]",
          )}
        >
          Aa
        </button>
        <span className="min-w-[110px] text-right tabular-nums text-[10px] text-[var(--muted)]">
          {loading ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              searching…
            </span>
          ) : !query.trim() ? (
            ""
          ) : totalMatches === 0 ? (
            "No matches"
          ) : (
            <>
              {totalMatches} match{totalMatches === 1 ? "" : "es"} · {grouped.length} file
              {grouped.length === 1 ? "" : "s"}
            </>
          )}
        </span>
      </div>
      {error && (
        <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-1 text-[11px] text-red-300">
          {error}
        </div>
      )}
      <div className="flex-1 overflow-y-auto scroll-thin">
        {!query.trim() ? (
          <div className="flex h-full items-center justify-center px-4 py-10 text-center text-xs text-[var(--muted)]">
            Type to search inside <span className="ml-1 font-mono">{folderDisplay}</span>.
          </div>
        ) : grouped.length === 0 && !loading ? (
          <div className="flex h-full items-center justify-center px-4 py-10 text-center text-xs text-[var(--muted)]">
            No matches in this folder.
          </div>
        ) : (
          <ul className="py-1 text-xs">
            {grouped.map((g) => {
              const open = !collapsed[g.relPath];
              return (
                <li key={g.relPath} className="border-b border-[var(--border)] last:border-b-0">
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsed((c) => ({ ...c, [g.relPath]: !c[g.relPath] }))
                    }
                    title={g.relPath}
                    className="flex w-full items-center gap-1 px-3 py-1 text-left hover:bg-[var(--panel-2)]"
                  >
                    {open ? (
                      <ChevronDown className="h-3 w-3 shrink-0 text-[var(--muted)]" />
                    ) : (
                      <ChevronRight className="h-3 w-3 shrink-0 text-[var(--muted)]" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono">{g.relPath}</span>
                    <span className="shrink-0 tabular-nums text-[10px] text-[var(--muted)]">
                      {g.hits.length}
                    </span>
                  </button>
                  {open && (
                    <ul>
                      {g.hits.map((h, i) => (
                        <li key={`${h.line}:${h.col}:${i}`}>
                          <button
                            type="button"
                            onClick={() => onPick({ relPath: h.relPath, line: h.line })}
                            className="flex w-full items-baseline gap-2 px-6 py-0.5 text-left hover:bg-[var(--panel-2)]"
                          >
                            <span className="w-12 shrink-0 text-right tabular-nums text-[10px] text-[var(--muted)]">
                              {h.line}
                            </span>
                            <span className="min-w-0 flex-1 truncate font-mono">
                              <MatchedLine text={h.text} col={h.col} colEnd={h.colEnd} />
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
            {(truncated || (scanned > 0 && totalMatches === 0)) && (
              <li className="px-3 py-2 text-[10px] italic text-[var(--muted)]">
                {truncated
                  ? `Showing first ${totalMatches} matches across ${scanned} files — refine the query for more.`
                  : `Scanned ${scanned} files.`}
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Render a snippet with the match span highlighted. `col` / `colEnd` are
 * 1-based and refer to character offsets within `text`. We clip defensively
 * because a malformed (col=0 / col>text.length) entry would otherwise
 * crash the row.
 */
function MatchedLine({ text, col, colEnd }: { text: string; col: number; colEnd: number }) {
  const start = Math.max(0, Math.min(text.length, col - 1));
  const end = Math.max(start, Math.min(text.length, colEnd - 1));
  if (end <= start) return <>{text}</>;
  return (
    <>
      {text.slice(0, start)}
      <mark className="rounded-sm bg-[var(--accent)]/30 px-px text-[var(--foreground)]">
        {text.slice(start, end)}
      </mark>
      {text.slice(end)}
    </>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export type SearchHit = {
  messageUuid: string;
  role: "user" | "assistant" | "system";
  snippet: string;
  score: number;
};

type Props = {
  sessionId: string | null;
  onClose: () => void;
  onPick: (hit: SearchHit) => void;
};

export function TranscriptSearch({ sessionId, onClose, onPick }: Props) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Clear results when the query empties or the session is missing —
  // "store previous props" pattern so the setState calls run during
  // render rather than inside a useEffect body, satisfying
  // react-hooks/set-state-in-effect.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const searchKey = sessionId && q.trim() ? `${sessionId}:${q}` : "";
  const [lastSearchKey, setLastSearchKey] = useState(searchKey);
  if (lastSearchKey !== searchKey) {
    setLastSearchKey(searchKey);
    if (!searchKey) {
      setHits([]);
      setError(null);
    }
  }

  // Debounced search. setState only happens inside Promise callbacks; the
  // effect body just schedules the fetch + sets up an AbortController.
  useEffect(() => {
    if (!sessionId || !q.trim()) return;
    const controller = new AbortController();
    const t = setTimeout(() => {
      fetch(
        `/api/sessions/${sessionId}/search?q=${encodeURIComponent(q)}&limit=50`,
        { signal: controller.signal },
      )
        .then(async (res) => {
          const d = (await res.json().catch(() => ({}))) as {
            hits?: SearchHit[];
            error?: string;
          };
          if (!res.ok) {
            setError(d.error ?? `HTTP ${res.status}`);
            setHits([]);
            return;
          }
          setHits(d.hits ?? []);
          setError(null);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      controller.abort();
      clearTimeout(t);
    };
  }, [q, sessionId]);

  // Flip `loading` true at the same time we kick a fresh search — runs
  // during render via the "store previous props" pattern so it stays
  // out of the effect body.
  const [loadingKey, setLoadingKey] = useState(searchKey);
  if (loadingKey !== searchKey) {
    setLoadingKey(searchKey);
    if (searchKey) setLoading(true);
  }

  return (
    <div className="border-b border-[var(--border)] bg-[var(--panel)]/95 px-3 py-2">
      <div className="mx-auto flex max-w-[var(--chat-col)] items-center gap-2">
        <Search className="h-3.5 w-3.5 text-[var(--muted)]" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter" && hits[0]) onPick(hits[0]);
          }}
          placeholder="Search transcript…"
          className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs focus:outline-none"
        />
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--muted)]" />}
        <span className="text-[10px] text-[var(--muted)]">
          {hits.length ? `${hits.length} match${hits.length === 1 ? "" : "es"}` : ""}
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Close (Esc)"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {error && (
        <div className="mx-auto mt-1 max-w-[var(--chat-col)] rounded-md border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] text-red-300">
          {error}
        </div>
      )}
      {hits.length > 0 && (
        <ul className="mx-auto mt-2 max-h-60 max-w-[var(--chat-col)] overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--panel)] scroll-thin">
          {hits.map((h) => (
            <li key={h.messageUuid + ":" + h.score}>
              <button
                type="button"
                onClick={() => onPick(h)}
                className={cn(
                  "flex w-full items-start gap-2 border-b border-[var(--border)] px-2 py-1.5 text-left text-[11px] last:border-b-0",
                  "hover:bg-[var(--panel-2)]",
                )}
              >
                <span
                  className={cn(
                    "shrink-0 rounded px-1.5 py-px text-[9px] uppercase tracking-wide",
                    h.role === "user"
                      ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                      : "bg-[var(--panel-2)] text-[var(--muted)]",
                  )}
                >
                  {h.role}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[var(--foreground)]/90">
                  {h.snippet}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

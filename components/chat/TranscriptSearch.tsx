"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CaseSensitive, ChevronDown, ChevronUp, Loader2, Search, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import {
  findInElement,
  scrollRangeIntoView,
  supportsHighlightApi,
} from "@/lib/client/find-in-transcript";

/**
 * Browser-style find bar for the open transcript (Cmd/Ctrl+F).
 *
 * Works like the native find-in-page: every occurrence of the query in the
 * rendered transcript is painted via the CSS Custom Highlight API (no DOM
 * mutation, so React never notices), the current one is painted stronger and
 * scrolled into view, and the bar shows "N of M matches". Enter / Shift+Enter
 * and Cmd+G / Cmd+Shift+G step through matches.
 *
 * The transcript is paginated (older pages load on scroll), so on each query
 * change the parent is asked to `onEnsureLoaded` — it consults the server
 * search for the oldest matching message and paginates until it's rendered,
 * after which the DOM scan covers every hit.
 */

const HL_ALL = "transcript-find";
const HL_CURRENT = "transcript-find-current";
/** Scroll container that owns the rendered transcript (set in MessageList). */
const TRANSCRIPT_ROOT_SELECTOR = "[data-transcript-root]";
/** Ancestor observed for mutations — exists even before the transcript root does. */
const PANE_SELECTOR = '[data-pane-name="message-list"]';

// Native find bars remember the last query across open/close; so do we.
let lastQuery = "";
let lastMatchCase = false;

type Props = {
  sessionId: string | null;
  onClose: () => void;
  /** Bumped by the parent on each Cmd/Ctrl+F so an already-open bar re-focuses + selects. */
  focusNonce?: number;
  /** True while older transcript pages exist that aren't rendered yet. */
  hasMoreAbove?: boolean;
  /** Paginate older pages until every message matching `q` is rendered. */
  onEnsureLoaded?: (q: string) => Promise<void>;
};

function paint(ranges: Range[], current: number) {
  if (!supportsHighlightApi()) return;
  const all = new Highlight(...ranges);
  CSS.highlights.set(HL_ALL, all);
  const cur = current >= 0 && ranges[current] ? new Highlight(ranges[current]) : new Highlight();
  cur.priority = 1;
  CSS.highlights.set(HL_CURRENT, cur);
}

function clearPaint() {
  if (!supportsHighlightApi()) return;
  CSS.highlights.delete(HL_ALL);
  CSS.highlights.delete(HL_CURRENT);
}

export function TranscriptSearch({
  sessionId,
  onClose,
  focusNonce = 0,
  hasMoreAbove = false,
  onEnsureLoaded,
}: Props) {
  const [q, setQ] = useState(lastQuery);
  const [matchCase, setMatchCase] = useState(lastMatchCase);
  const [pos, setPos] = useState<{ count: number; current: number }>({ count: 0, current: -1 });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const rangesRef = useRef<Range[]>([]);
  const currentRef = useRef(-1);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusNonce]);

  // Scan the rendered transcript and repaint. `reason` decides which match
  // becomes current: a fresh query picks the first match at/below the
  // viewport top (what the native bar does); a mutation rescan (streaming
  // text, older page prepended) keeps the current match by document position
  // so the "N of M" counter doesn't jump around under the reader.
  const runScan = useCallback(
    (reason: "query" | "mutation") => {
      const root = document.querySelector<HTMLElement>(TRANSCRIPT_ROOT_SELECTOR);
      const prevCurrent = rangesRef.current[currentRef.current] ?? null;
      const ranges = root && q ? findInElement(root, q, { matchCase }) : [];
      rangesRef.current = ranges;
      let idx = -1;
      if (ranges.length > 0 && root) {
        if (reason === "query") {
          const top = root.getBoundingClientRect().top;
          idx = ranges.findIndex((r) => r.getBoundingClientRect().bottom >= top);
          if (idx < 0) idx = 0;
        } else if (prevCurrent && prevCurrent.startContainer.isConnected) {
          idx = ranges.findIndex(
            (r) => r.compareBoundaryPoints(Range.START_TO_START, prevCurrent) >= 0,
          );
          if (idx < 0) idx = ranges.length - 1;
        } else {
          idx = Math.min(Math.max(currentRef.current, 0), ranges.length - 1);
        }
      }
      currentRef.current = idx;
      paint(ranges, idx);
      setPos({ count: ranges.length, current: idx });
      if (reason === "query" && idx >= 0 && root) scrollRangeIntoView(root, ranges[idx]!);
    },
    [q, matchCase],
  );

  // Query / case change → short debounce so typing stays fluid on big transcripts.
  useEffect(() => {
    const t = setTimeout(() => runScan("query"), 60);
    return () => clearTimeout(t);
  }, [runScan]);

  // Transcript mutates (streaming tokens, older page prepended, block
  // expanded) → rescan. Observe the pane rather than the transcript root so
  // the observer survives the root not existing yet (splash screen), but
  // ignore our own counter text updates.
  useEffect(() => {
    const pane = document.querySelector(PANE_SELECTOR);
    if (!pane) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    // Debounce with a max wait: a pure trailing debounce would never fire
    // while tokens stream continuously, leaving stale (collapsed) ranges
    // painted. Rescan at most every 150ms after the churn settles, but at
    // least every 500ms while it doesn't.
    let pendingSince = 0;
    const flush = () => {
      t = null;
      pendingSince = 0;
      runScan("mutation");
    };
    const obs = new MutationObserver((records) => {
      const bar = barRef.current;
      if (bar && records.every((r) => bar.contains(r.target))) return;
      const now = performance.now();
      if (!pendingSince) pendingSince = now;
      if (t) clearTimeout(t);
      t = setTimeout(flush, Math.max(0, Math.min(150, pendingSince + 500 - now)));
    });
    obs.observe(pane, { childList: true, subtree: true, characterData: true });
    return () => {
      obs.disconnect();
      if (t) clearTimeout(t);
    };
  }, [runScan]);

  // Make sure older, not-yet-rendered messages that match are paginated in.
  // Debounced separately (longer) since it hits the server. Tracks which
  // query it already ensured so the `hasMoreAbove` dep flipping after a
  // partial load doesn't refetch for the same text.
  const ensuredForRef = useRef<string | null>(null);
  useEffect(() => {
    const needle = q.trim();
    if (!needle || !hasMoreAbove || !onEnsureLoaded || !sessionId) return;
    if (ensuredForRef.current === needle) return;
    let cancelled = false;
    const t = setTimeout(() => {
      ensuredForRef.current = needle;
      setLoadingOlder(true);
      onEnsureLoaded(needle)
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setLoadingOlder(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, hasMoreAbove, onEnsureLoaded, sessionId]);

  // Clear the paint when the bar goes away.
  useEffect(() => clearPaint, []);

  const step = useCallback((delta: 1 | -1) => {
    const ranges = rangesRef.current;
    if (ranges.length === 0) return;
    const idx = (currentRef.current + delta + ranges.length) % ranges.length;
    currentRef.current = idx;
    paint(ranges, idx);
    setPos({ count: ranges.length, current: idx });
    const root = document.querySelector<HTMLElement>(TRANSCRIPT_ROOT_SELECTOR);
    if (root) scrollRangeIntoView(root, ranges[idx]!);
  }, []);

  // Cmd/Ctrl+G (+Shift) steps matches from anywhere while the bar is open,
  // mirroring the browser binding. Enter / Shift+Enter work from the input.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "g" || e.key === "G")) {
        e.preventDefault();
        step(e.shiftKey ? -1 : 1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  const hasQuery = q.length > 0;
  const iconBtn =
    "flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--muted)]";

  return (
    <div
      ref={barRef}
      data-testid="transcript-find"
      className="border-b border-[var(--border)] bg-[var(--panel)]/95 px-3 py-2"
    >
      <div className="mx-auto flex max-w-[var(--chat-col)] items-center gap-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
        <input
          ref={inputRef}
          data-testid="transcript-find-input"
          value={q}
          onChange={(e) => {
            lastQuery = e.target.value;
            setQ(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "Enter") {
              e.preventDefault();
              step(e.shiftKey ? -1 : 1);
            }
          }}
          placeholder="Find in transcript…"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs focus:outline-none"
        />
        {loadingOlder && (
          <Loader2
            className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--muted)]"
            aria-label="Loading older messages"
          />
        )}
        <span
          data-testid="transcript-find-count"
          aria-live="polite"
          className={cn(
            "shrink-0 whitespace-nowrap text-[10px] tabular-nums",
            hasQuery && pos.count === 0 ? "text-red-400" : "text-[var(--muted)]",
          )}
        >
          {!hasQuery
            ? ""
            : pos.count === 0
              ? loadingOlder
                ? "Searching…"
                : "No matches"
              : `${pos.current + 1} of ${pos.count} match${pos.count === 1 ? "" : "es"}`}
        </span>
        <button
          type="button"
          onClick={() => step(-1)}
          disabled={pos.count === 0}
          title="Previous match (Shift+Enter)"
          aria-label="Previous match"
          data-testid="transcript-find-prev"
          className={iconBtn}
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => step(1)}
          disabled={pos.count === 0}
          title="Next match (Enter)"
          aria-label="Next match"
          data-testid="transcript-find-next"
          className={iconBtn}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => {
            lastMatchCase = !matchCase;
            setMatchCase(!matchCase);
          }}
          aria-pressed={matchCase}
          title="Match case"
          aria-label="Match case"
          data-testid="transcript-find-match-case"
          className={cn(
            iconBtn,
            matchCase && "bg-[var(--accent)]/15 text-[var(--accent)] hover:text-[var(--accent)]",
          )}
        >
          <CaseSensitive className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close find bar"
          className={iconBtn}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

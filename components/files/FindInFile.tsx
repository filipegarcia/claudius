"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CaseSensitive, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";

type Props = {
  /** Current text being searched (the editor's draft buffer). */
  value: string;
  /** Close the toolbar (parent unmounts us). */
  onClose: () => void;
  /**
   * DOM id of the underlying <textarea> inside HighlightedEditor. We query
   * it directly rather than threading a ref through react-simple-code-editor
   * (which doesn't forward one). Only one editor is mounted at a time so the
   * id is unambiguous.
   */
  textareaId: string;
  /**
   * CSS selector for the scrollable container wrapping the editor (its
   * `.shiki-host` div). We compute scrollTop ourselves to centre the active
   * match — the textarea's own scroll behaviour is unreliable when the
   * container, not the textarea, owns the scrollbar.
   */
  scrollContainerSelector: string;
};

/**
 * Single-file "find" toolbar. Lives at the top of the editor pane; the
 * parent renders it conditionally when Cmd+F is pressed (or the toolbar
 * button is clicked).
 *
 * Navigation is selection-based: every "next/prev" sets the textarea's
 * `selectionStart/selectionEnd` to the match's character offsets and
 * scrolls the host div so the match line is roughly centred. The native
 * selection highlight is the only visible per-match indicator — no
 * <mark> injection into shiki's highlighted HTML (which would fight the
 * highlighter and is fragile for marginal benefit).
 */
export function FindInFile({ value, onClose, textareaId, scrollContainerSelector }: Props) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Find every match offset in `value`. Recomputed only when the inputs
  // change — buffer edits while open re-run this; toggling case too.
  const matches = useMemo(() => {
    if (!query) return [] as Array<{ start: number; end: number }>;
    const hay = caseSensitive ? value : value.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    if (!needle) return [];
    const out: Array<{ start: number; end: number }> = [];
    let from = 0;
    while (true) {
      const i = hay.indexOf(needle, from);
      if (i === -1) break;
      out.push({ start: i, end: i + needle.length });
      // Step at least one char so an empty/overlapping needle can't loop.
      from = i + Math.max(1, needle.length);
      if (out.length >= 5000) break; // hard cap — protects against pathological queries on huge files
    }
    return out;
  }, [value, query, caseSensitive]);

  // Clamp the active match if the buffer shrinks / query changes. Render-
  // phase "store previous props" pattern so the setState happens in render
  // rather than an effect, satisfying react-hooks/set-state-in-effect.
  const [lastMatchCount, setLastMatchCount] = useState(matches.length);
  if (lastMatchCount !== matches.length) {
    setLastMatchCount(matches.length);
    if (matches.length === 0 || activeIdx >= matches.length) {
      setActiveIdx(0);
    }
  }

  /**
   * Move the current match into view inside the scroll container. We can't
   * rely on `textarea.setSelectionRange` to scroll — the scrollbar lives on
   * the outer .shiki-host, not the textarea, so we compute the pixel offset
   * ourselves from the editor's known line height (20px) + padding (16px).
   *
   * Crucially we do NOT call `textarea.focus()` here. That would steal focus
   * from the find input on every keystroke (this fires from a `value`/`query`-
   * deps effect), and the next typed char would land in the file. Chromium
   * paints an unfocused textarea's selection in a muted color, which is
   * enough to convey the current-match position alongside the scroll and
   * "N / M" counter. The user can press Enter inside the find input or
   * click the next/prev arrows without ever leaving the toolbar.
   */
  const reveal = useCallback(
    (idx: number) => {
      const m = matches[idx];
      if (!m) return;
      const ta = document.getElementById(textareaId);
      if (!(ta instanceof HTMLTextAreaElement)) return;
      ta.setSelectionRange(m.start, m.end);
      const container = document.querySelector(scrollContainerSelector);
      if (!(container instanceof HTMLElement)) return;
      const lineHeight = 20;
      const padding = 16;
      const lineIdx = value.slice(0, m.start).split("\n").length - 1;
      const top = padding + lineIdx * lineHeight;
      // Centre vertically with a small floor — easier on the eye than
      // pinning to the very top.
      const target = Math.max(0, top - container.clientHeight / 2);
      container.scrollTop = target;
    },
    [matches, scrollContainerSelector, textareaId, value],
  );

  // Whenever the active index changes (or first results land), re-reveal.
  useEffect(() => {
    if (matches.length > 0) reveal(activeIdx);
  }, [activeIdx, matches.length, reveal]);

  // Focus the input on mount so Cmd+F → start typing works.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const next = useCallback(() => {
    if (matches.length === 0) return;
    setActiveIdx((i) => (i + 1) % matches.length);
  }, [matches.length]);
  const prev = useCallback(() => {
    if (matches.length === 0) return;
    setActiveIdx((i) => (i - 1 + matches.length) % matches.length);
  }, [matches.length]);

  // Global Escape — keeps the editor usable for typing without trapping
  // Esc inside the input only. Cmd+G / Cmd+Shift+G as legacy "find next"
  // shortcuts are intentionally NOT bound; Enter/Shift+Enter cover it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      data-testid="files-find-in-file"
      className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--panel-2)]/60 px-3 text-xs"
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIdx(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) prev();
            else next();
          }
        }}
        placeholder="Find in file"
        aria-label="Find in file"
        className="w-64 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-0.5 font-mono text-xs focus:outline-none"
      />
      <button
        type="button"
        onClick={() => setCaseSensitive((c) => !c)}
        title={caseSensitive ? "Case sensitive (on)" : "Case sensitive (off)"}
        aria-pressed={caseSensitive}
        className={cn(
          "flex h-5 w-5 items-center justify-center rounded text-[var(--muted)] hover:text-[var(--foreground)]",
          caseSensitive && "bg-[var(--panel)] text-[var(--foreground)]",
        )}
      >
        <CaseSensitive className="h-3.5 w-3.5" />
      </button>
      <span className="tabular-nums text-[var(--muted)]">
        {query === "" ? "" : matches.length === 0 ? "No results" : `${activeIdx + 1} / ${matches.length}`}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={prev}
          disabled={matches.length === 0}
          title="Previous match (Shift+Enter)"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)] disabled:opacity-40"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={next}
          disabled={matches.length === 0}
          title="Next match (Enter)"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)] disabled:opacity-40"
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onClose}
          title="Close find (Esc)"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

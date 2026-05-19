"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, RotateCcw, Save } from "lucide-react";
import { cn } from "@/lib/utils/cn";

type FilePayload = {
  relPath: string;
  content: string;
  sizeBytes: number;
  modifiedMs: number;
};

type Props = {
  wsId: string;
  /** Path relative to workspace root, as it appears in the changes list. */
  relPath: string;
  /**
   * Unified-diff text used to decorate added lines with a green stripe (and,
   * in split mode, removed lines on the left side with red). The decoration
   * goes "stale" the moment the user starts typing — we don't run a JS-side
   * diff on every keystroke. After a successful save the parent re-pulls
   * the diff and the stripes refresh.
   *
   * Pass an empty string (or omit) to render without highlighting.
   */
  diff?: string;
  /**
   * Fires after a successful save so the parent can re-pull git status
   * (the new worktree content will produce a different diff).
   */
  onSaved?: () => void;
  /**
   * Render side-by-side (old on left, current on right) instead of the
   * default unified editor. Requires `mode` so we know whether the "old"
   * side should be loaded from HEAD or from the index.
   *
   * Untracked files have no meaningful "old" version (no HEAD blob, no
   * index entry) — the parent should keep `split` false in that case.
   */
  split?: boolean;
  /**
   * Diff base. Controls which git ref the side-by-side view loads as the
   * "old" pane:
   *   - "staged"   → HEAD  (left pane shows the committed version)
   *   - "worktree" → index (left pane shows the staged-but-uncommitted version)
   *   - "untracked" → no old version; split mode is a no-op
   */
  mode?: "staged" | "worktree" | "untracked";
};

// Editor geometry — pinned so the absolute-positioned overlay layers
// (stripes + line-number gutter) align pixel-perfectly with the textarea's
// rendered text. Changing one of these requires changing all three.
const FONT_SIZE_PX = 12;
const LINE_HEIGHT_PX = 18;
const PADDING_TOP_PX = 12;
const PADDING_BOTTOM_PX = 12;
const PADDING_RIGHT_PX = 12;
const GUTTER_WIDTH_PX = 56;
// Extra px between the gutter and the start of the editable text. Visual
// breathing room — also keeps the caret from sitting right against the
// line-number column.
const GUTTER_TO_TEXT_PX = 4;
// IntelliJ-style minimap marker column at the right edge — replaces the
// native textarea scrollbar with a strip that shows added-line markers
// + a viewport indicator. Click anywhere on it to scroll to that
// position. Width is sized to fit the markers comfortably and roughly
// match the native scrollbar footprint it replaces.
const MINIMAP_WIDTH_PX = 14;

/**
 * Extract the 1-based line numbers in the new file that the unified diff
 * marks as additions. Walks each hunk header to anchor `rightLine`, then
 * advances on `+` and ` ` lines (skipping `-` lines, which aren't in the
 * new file).
 *
 * Untracked files come through as "every line is added" because the diff
 * is `/dev/null → file` and every body line starts with `+`.
 */
export function addedLineNumbers(diff: string): Set<number> {
  const out = new Set<number>();
  if (!diff) return out;
  let rightLine = 0;
  for (const raw of diff.split("\n")) {
    // Skip git's metadata preamble — these never affect line numbering.
    if (
      raw.startsWith("diff --git ") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("rename ") ||
      raw.startsWith("similarity ") ||
      raw.startsWith("Binary files ")
    ) {
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      rightLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+")) {
      out.add(rightLine);
      rightLine++;
      continue;
    }
    if (raw.startsWith(" ")) {
      rightLine++;
      continue;
    }
    // `-` lines: they were in the old file, not the new — don't advance
    // rightLine, don't record. The `\ No newline at end of file` marker
    // also lands here and is correctly ignored.
  }
  return out;
}

/**
 * Mirror of `addedLineNumbers` for the OLD-file side: 1-based line numbers
 * that the diff marks as deletions. Used by the side-by-side view to
 * paint red stripes on the left ("here's what used to be there").
 *
 * `+` lines are skipped (they aren't in the old file); `-` and ` ` lines
 * advance `leftLine`; only `-` lines are recorded.
 */
export function removedLineNumbers(diff: string): Set<number> {
  const out = new Set<number>();
  if (!diff) return out;
  let leftLine = 0;
  for (const raw of diff.split("\n")) {
    if (
      raw.startsWith("diff --git ") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("rename ") ||
      raw.startsWith("similarity ") ||
      raw.startsWith("Binary files ")
    ) {
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      leftLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("-")) {
      out.add(leftLine);
      leftLine++;
      continue;
    }
    if (raw.startsWith(" ")) {
      leftLine++;
      continue;
    }
    // `+` lines: in the new file, not the old — skip.
  }
  return out;
}

/**
 * Inline worktree-file editor surfaced on the right pane of /git. Two
 * rendering modes:
 *
 *   - Unified (split=false): a single editable panel with green stripes
 *     for added lines + minimap. The editor IS the diff view.
 *   - Side-by-side (split=true): two panels — the "old" version (HEAD or
 *     index, read-only) on the left, the current worktree file (editable)
 *     on the right. Scrolling is synced between the two via a lifted
 *     `scrollTop` state. The left side gets red stripes for removed lines;
 *     the right keeps the green-stripe + minimap treatment.
 *
 * The layered render (stripes + gutter + textarea + minimap) is extracted
 * into `CodePanel` so both panes share it. The parent owns scroll state
 * so split-mode sync is "set state from either side, both render with
 * the same value."
 */
export function FileEditor({ wsId, relPath, diff, onSaved, split = false, mode }: Props) {
  const [original, setOriginal] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  // Old content for the split view's left pane. Sentinel `null` = not yet
  // loaded (or no fetch attempted because split is off / mode unsupported).
  const [oldContent, setOldContent] = useState<string | null>(null);
  const [oldLoading, setOldLoading] = useState(false);

  // Lifted scrollTop — drives both the overlay layers AND the imperative
  // sync between the two panels in split mode. In single mode there's
  // only one panel reading it.
  const [scrollTop, setScrollTop] = useState(0);
  /**
   * Viewport metrics for the minimap indicator. `scrollHeight` is the full
   * scrollable content height; `clientHeight` is the visible area.
   * Sentinel `scrollHeight: 0` means "not yet measured."
   */
  const [viewport, setViewport] = useState<{ scrollHeight: number; clientHeight: number }>({
    scrollHeight: 0,
    clientHeight: 0,
  });
  const rightTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const dirty = original != null && draft !== original;
  const addedLines = useMemo(() => addedLineNumbers(diff ?? ""), [diff]);
  const removedLines = useMemo(() => removedLineNumbers(diff ?? ""), [diff]);

  // Counting newlines avoids the +1 trap of split("\n").length for a
  // trailing-newline file. Both end up the same; what matters is that line
  // N renders at the Y offset the textarea uses for it.
  const draftLineCount = useMemo(() => countLines(draft), [draft]);
  const oldLineCount = useMemo(() => countLines(oldContent ?? ""), [oldContent]);

  /**
   * Pull current scroll/size off the editable textarea (right pane). The
   * minimap reads from this; in split mode the left panel just mirrors
   * `scrollTop`.
   */
  const syncMetrics = useCallback(() => {
    const ta = rightTextareaRef.current;
    if (!ta) return;
    setScrollTop(ta.scrollTop);
    setViewport({ scrollHeight: ta.scrollHeight, clientHeight: ta.clientHeight });
  }, []);

  /**
   * Reset draft / scroll only when the actual file changes (wsId or
   * relPath). Deliberately EXCLUDES `mode` and `split` from the key:
   * those are display-only toggles, and we don't want flipping the
   * layout to silently drop unsaved edits. Mode/split changes will
   * still re-fire the old-content fetch effect below — which is what
   * actually needs to react to them.
   *
   * "store previous props" pattern keeps these setStates render-phase
   * so the setState-in-effect lint rule is happy.
   */
  const fileKey = `${wsId}|${relPath}`;
  const [lastFileKey, setLastFileKey] = useState(fileKey);
  if (lastFileKey !== fileKey) {
    setLastFileKey(fileKey);
    setLoading(true);
    setError(null);
    setOriginal(null);
    setDraft("");
    setOldContent(null);
    setOldLoading(split && mode !== "untracked");
    setScrollTop(0);
  }

  /**
   * Independently reset only the OLD-content slot when the user toggles
   * Split or flips between Staged/Unstaged — those changes don't touch
   * the worktree file but DO require a fresh `git show` against the new
   * ref. Kept separate from `fileKey` so the draft survives.
   */
  const splitKey = `${split ? "split" : "unified"}|${mode ?? "?"}`;
  const [lastSplitKey, setLastSplitKey] = useState(splitKey);
  if (lastSplitKey !== splitKey) {
    setLastSplitKey(splitKey);
    setOldContent(null);
    setOldLoading(split && mode !== "untracked");
  }

  /**
   * Pull the worktree (current) file content. AbortController guards
   * against the file-switch race.
   */
  useEffect(() => {
    const ac = new AbortController();
    fetch(`/api/workspaces/${wsId}/files?path=${encodeURIComponent(relPath)}`, {
      signal: ac.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        return (await res.json()) as FilePayload;
      })
      .then((d) => {
        setOriginal(d.content);
        setDraft(d.content);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [wsId, relPath]);

  /**
   * Pull the OLD (left-pane) content for split mode. Skipped when split is
   * off or the file is untracked. The git ref is "HEAD" for staged diffs
   * (so the left pane shows the committed version) and "" / "index" for
   * unstaged diffs (left pane shows the staged version).
   */
  useEffect(() => {
    if (!split || mode === "untracked" || !mode) {
      // Not in split mode — nothing to load. The state was already cleared
      // by the file-key reset block above.
      return;
    }
    const ref = mode === "staged" ? "HEAD" : "";
    const ac = new AbortController();
    fetch(
      `/api/workspaces/${wsId}/git/show?path=${encodeURIComponent(relPath)}&ref=${encodeURIComponent(ref)}`,
      { signal: ac.signal },
    )
      .then(async (res) => {
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        return (await res.json()) as { content: string };
      })
      .then((d) => setOldContent(d.content ?? ""))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // The "file doesn't exist at this ref" case is handled server-side
        // (`gitShow` returns empty content for it), so reaching this catch
        // means a real failure: 5xx, network drop, etc. We still set the
        // left pane to empty so it visually degrades to "no old version,"
        // but we log so the user has a breadcrumb when they wonder why
        // the left pane is mysteriously blank.
        console.warn("FileEditor: failed to load old content", err);
        setOldContent("");
      })
      .finally(() => {
        if (!ac.signal.aborted) setOldLoading(false);
      });
    return () => ac.abort();
  }, [wsId, relPath, split, mode]);

  /**
   * Re-measure after content (draft) or loading state changes — editing
   * grows/shrinks scrollHeight and the minimap indicator needs the fresh
   * number. useLayoutEffect so the measurement happens before paint.
   */
  useLayoutEffect(() => {
    syncMetrics();
  }, [draftLineCount, loading, syncMetrics]);

  const onSave = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${wsId}/files?path=${encodeURIComponent(relPath)}`,
        { method: "PUT", body: draft },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setOriginal(draft);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1200);
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [wsId, relPath, draft, dirty, saving, onSaved]);

  const onDiscard = useCallback(() => {
    if (!dirty) return;
    setDraft(original ?? "");
  }, [dirty, original]);

  /**
   * Cmd/Ctrl+S to save + Tab → 2 spaces. Bound at each textarea (not
   * window) so we don't trap globally; the commit message box keeps the
   * browser default.
   */
  const onRightKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void onSave();
        return;
      }
      if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const ta = e.currentTarget;
        const { selectionStart, selectionEnd } = ta;
        const next = draft.slice(0, selectionStart) + "  " + draft.slice(selectionEnd);
        setDraft(next);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = selectionStart + 2;
        });
      }
    },
    [draft, onSave],
  );

  return (
    <div data-testid="git-file-editor" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--panel-2)]/30 px-3 text-[11px]">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-mono",
            dirty
              ? "bg-amber-500/20 text-amber-200"
              : "bg-[var(--panel-2)] text-[var(--muted)]",
          )}
        >
          {dirty ? "modified" : "saved"}
        </span>
        {savedFlash && (
          <span
            aria-live="polite"
            className="rounded bg-emerald-500/20 px-1.5 py-0.5 font-mono text-emerald-200"
          >
            ✓ written
          </span>
        )}
        {addedLines.size > 0 && (
          <span
            className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-emerald-300"
            title="Lines added since the diff base (HEAD or index, depending on the mode tab)"
          >
            +{addedLines.size}
          </span>
        )}
        {split && removedLines.size > 0 && (
          <span
            className="rounded bg-red-500/15 px-1.5 py-0.5 font-mono text-red-300"
            title="Lines removed since the diff base"
          >
            −{removedLines.size}
          </span>
        )}
        <span className="text-[var(--muted)]">
          Edit directly · save with{" "}
          <kbd className="rounded bg-[var(--panel-2)] px-1 font-mono">⌘S</kbd>
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onDiscard}
            disabled={!dirty || saving}
            title="Revert in-editor changes (does not touch the file)"
            data-testid="git-file-editor-discard"
            className="flex h-6 items-center gap-1 rounded px-1.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40"
          >
            <RotateCcw className="h-3 w-3" />
            <span className="text-[11px]">Discard edits</span>
          </button>
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={!dirty || saving || loading}
            title="Save (⌘S)"
            data-testid="git-file-editor-save"
            className="flex h-6 items-center gap-1 rounded bg-[var(--accent)]/20 px-1.5 text-[var(--foreground)] hover:bg-[var(--accent)]/30 disabled:opacity-40"
          >
            {saving ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Save className="h-3 w-3" />
            )}
            <span className="text-[11px]">{saving ? "Saving…" : "Save"}</span>
          </button>
        </div>
      </div>
      {error && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-red-500/30 bg-red-500/10 px-3 py-1 text-[11px] text-red-300">
          <AlertTriangle className="h-3 w-3" />
          <span className="truncate font-mono">{error}</span>
        </div>
      )}
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-[var(--muted)]">
          Loading file…
        </div>
      ) : split && mode !== "untracked" ? (
        <div className="flex min-h-0 flex-1">
          {/* Left pane — OLD content, read-only, red stripes on removed
              lines. While oldContent is loading we show a thin shimmer so
              the user knows the diff base is on its way. */}
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-6 shrink-0 items-center gap-2 border-b border-[var(--border)]/60 bg-[var(--panel)]/40 px-3 font-mono text-[10px] text-[var(--muted)]">
              {mode === "staged" ? "HEAD" : "index"} · read-only
              {oldLoading && (
                <Loader2 className="ml-auto h-3 w-3 animate-spin" />
              )}
            </div>
            <CodePanel
              content={oldContent ?? ""}
              highlightedLines={removedLines}
              highlightVariant="removed"
              lineCount={oldLineCount}
              scrollTop={scrollTop}
              onScroll={setScrollTop}
              showMinimap={false}
            />
          </div>
          {/* Visual divider between the two panes. */}
          <div className="w-px shrink-0 bg-[var(--border)]" />
          {/* Right pane — current worktree content, editable, green
              stripes + minimap. */}
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-6 shrink-0 items-center gap-2 border-b border-[var(--border)]/60 bg-[var(--panel)]/40 px-3 font-mono text-[10px] text-[var(--muted)]">
              working tree · editable
            </div>
            <CodePanel
              content={draft}
              onContentChange={setDraft}
              highlightedLines={addedLines}
              highlightVariant="added"
              lineCount={draftLineCount}
              scrollTop={scrollTop}
              onScroll={(top, metrics) => {
                setScrollTop(top);
                if (metrics) setViewport(metrics);
              }}
              showMinimap
              minimapMarkers={addedLines}
              minimapViewport={viewport}
              textareaRef={rightTextareaRef}
              onKeyDown={onRightKeyDown}
            />
          </div>
        </div>
      ) : (
        // Unified mode — single editable panel.
        <CodePanel
          content={draft}
          onContentChange={setDraft}
          highlightedLines={addedLines}
          highlightVariant="added"
          lineCount={draftLineCount}
          scrollTop={scrollTop}
          onScroll={(top, metrics) => {
            setScrollTop(top);
            if (metrics) setViewport(metrics);
          }}
          showMinimap
          minimapMarkers={addedLines}
          minimapViewport={viewport}
          textareaRef={rightTextareaRef}
          onKeyDown={onRightKeyDown}
        />
      )}
    </div>
  );
}

// ---------- CodePanel ----------

type CodePanelProps = {
  content: string;
  /** Omit to render read-only. */
  onContentChange?: (s: string) => void;
  highlightedLines: Set<number>;
  highlightVariant: "added" | "removed";
  lineCount: number;
  /** Controlled scrollTop. The panel imperatively syncs its textarea to this. */
  scrollTop: number;
  /**
   * Called on every native scroll. `metrics` is only included for the
   * "primary" panel (the one that owns minimap viewport reads). Secondary
   * panels (the left side of split mode) just bubble scrollTop.
   */
  onScroll: (
    top: number,
    metrics?: { scrollHeight: number; clientHeight: number },
  ) => void;
  showMinimap: boolean;
  minimapMarkers?: Set<number>;
  minimapViewport?: { scrollHeight: number; clientHeight: number };
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
};

/**
 * Reusable layered code panel: stripes (back) + line-number gutter +
 * textarea + (optional) minimap. Used twice in split mode and once in
 * unified mode. The parent owns scrollTop so panels can be scroll-synced.
 *
 * ALIGNMENT NOTE: stripes assume each line of text starts at exactly
 * `PADDING_TOP_PX + (n-1) * LINE_HEIGHT_PX` from the wrapper top. That
 * holds only if the textarea has:
 *   - explicit padding-top (set to PADDING_TOP_PX)
 *   - zero border (`border-0` — user-agent default would shift first
 *     line of text 1px below the first stripe)
 *   - explicit pixel line-height (LINE_HEIGHT_PX)
 *   - box-sizing: border-box (Tailwind global preset)
 * If any of those change, the stripes drift visibly.
 */
function CodePanel({
  content,
  onContentChange,
  highlightedLines,
  highlightVariant,
  lineCount,
  scrollTop,
  onScroll,
  showMinimap,
  minimapMarkers,
  minimapViewport,
  textareaRef,
  onKeyDown,
}: CodePanelProps) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const taRef = textareaRef ?? localRef;
  const readOnly = onContentChange == null;
  const stripeClass =
    highlightVariant === "added" ? "bg-emerald-500/15" : "bg-red-500/15";
  const markerClass =
    highlightVariant === "added" ? "bg-emerald-500/70" : "bg-red-500/70";

  /**
   * Imperatively sync the textarea's scrollTop to the controlled prop.
   * Guarded against bounce-back: if the textarea is already at this
   * scrollTop, we skip the assignment so no spurious onScroll fires.
   */
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (ta.scrollTop !== scrollTop) {
      ta.scrollTop = scrollTop;
    }
  }, [scrollTop, taRef]);

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--background)]">
      {/* Stripes layer — pointer-events: none so clicks fall through to the
          textarea. The inner div translates with scrollTop to follow the
          text as the user scrolls. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden"
        style={{
          paddingLeft: GUTTER_WIDTH_PX,
          paddingTop: PADDING_TOP_PX,
        }}
      >
        <div
          style={{
            transform: `translateY(${-scrollTop}px)`,
            position: "relative",
          }}
        >
          {Array.from(highlightedLines).map((n) => (
            <div
              key={n}
              className={cn("absolute left-0 right-0", stripeClass)}
              style={{
                top: (n - 1) * LINE_HEIGHT_PX,
                height: LINE_HEIGHT_PX,
              }}
            />
          ))}
        </div>
      </div>

      {/* Line-number gutter. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 overflow-hidden border-r border-[var(--border)]/60 bg-[var(--panel)]/40 text-[var(--muted)]"
        style={{
          width: GUTTER_WIDTH_PX,
          paddingTop: PADDING_TOP_PX,
          paddingBottom: PADDING_BOTTOM_PX,
          fontSize: FONT_SIZE_PX - 1,
        }}
      >
        <div style={{ transform: `translateY(${-scrollTop}px)` }}>
          {Array.from({ length: lineCount }, (_, i) => (
            <div
              key={i}
              className="text-right"
              style={{
                lineHeight: `${LINE_HEIGHT_PX}px`,
                height: LINE_HEIGHT_PX,
                paddingRight: GUTTER_TO_TEXT_PX + 4,
              }}
            >
              {i + 1}
            </div>
          ))}
        </div>
      </div>

      {/* Editable / read-only textarea. */}
      <textarea
        ref={taRef}
        value={content}
        onChange={(e) => onContentChange?.(e.target.value)}
        onScroll={(e) => {
          const ta = e.currentTarget;
          onScroll(ta.scrollTop, {
            scrollHeight: ta.scrollHeight,
            clientHeight: ta.clientHeight,
          });
        }}
        onKeyDown={onKeyDown}
        readOnly={readOnly}
        wrap="off"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        data-testid={readOnly ? "git-file-editor-readonly" : "git-file-editor-textarea"}
        style={{
          fontSize: FONT_SIZE_PX,
          lineHeight: `${LINE_HEIGHT_PX}px`,
          paddingLeft: GUTTER_WIDTH_PX + GUTTER_TO_TEXT_PX,
          paddingTop: PADDING_TOP_PX,
          paddingRight: PADDING_RIGHT_PX + (showMinimap ? MINIMAP_WIDTH_PX : 0),
          paddingBottom: PADDING_BOTTOM_PX,
          tabSize: 2,
          backgroundColor: "transparent",
        }}
        className="scroll-none relative h-full w-full resize-none overflow-auto border-0 font-mono text-[var(--foreground)] outline-none caret-[var(--foreground)]"
      />

      {/* Optional minimap at the right edge. Only the "primary" panel
          (current worktree, editable) gets one; the read-only old pane
          in split mode skips it because the right minimap already
          covers the file's diff density. */}
      {showMinimap && (
        <div
          role="presentation"
          aria-label="Diff marker minimap"
          data-testid="git-file-editor-minimap"
          onClick={(e) => {
            const ta = taRef.current;
            if (!ta) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = Math.max(
              0,
              Math.min(1, (e.clientY - rect.top) / rect.height),
            );
            const maxScroll = Math.max(0, ta.scrollHeight - ta.clientHeight);
            const next = Math.max(
              0,
              Math.min(maxScroll, ratio * ta.scrollHeight - ta.clientHeight / 2),
            );
            ta.scrollTop = next;
            onScroll(next, {
              scrollHeight: ta.scrollHeight,
              clientHeight: ta.clientHeight,
            });
          }}
          className="absolute inset-y-0 right-0 cursor-pointer border-l border-[var(--border)]/40 bg-[var(--panel)]/40"
          style={{ width: MINIMAP_WIDTH_PX }}
        >
          {Array.from(minimapMarkers ?? []).map((n) => {
            const topPct = ((n - 1) / Math.max(1, lineCount)) * 100;
            const heightPct = (1 / Math.max(1, lineCount)) * 100;
            return (
              <div
                key={n}
                className={cn("absolute left-[2px] right-[2px] rounded-[1px]", markerClass)}
                style={{
                  top: `${topPct}%`,
                  height: `${heightPct}%`,
                  minHeight: 2,
                }}
                title={`Line ${n} — click to jump`}
              />
            );
          })}
          {minimapViewport &&
            minimapViewport.scrollHeight > 0 &&
            minimapViewport.scrollHeight > minimapViewport.clientHeight && (
              <div
                aria-hidden
                className="absolute left-0 right-0 bg-[var(--foreground)]/15"
                style={{
                  top: `${(scrollTop / minimapViewport.scrollHeight) * 100}%`,
                  height: `${Math.max(
                    4,
                    (minimapViewport.clientHeight / minimapViewport.scrollHeight) * 100,
                  )}%`,
                }}
              />
            )}
        </div>
      )}
    </div>
  );
}

/** Cheap line counter — one pass over the string, no allocation. */
function countLines(s: string): number {
  if (!s) return 1;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

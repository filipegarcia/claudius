"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, File, Folder } from "lucide-react";
import { isImeComposing } from "@/lib/client/key-match";
import { isHeldRepeat } from "@/lib/client/composer-keys";
import { shouldResetHighlight } from "@/lib/shared/picker-highlight";
import {
  type Agent,
  type PickerItem,
  atMenuKeyAction,
  filterAgents,
  heldEnterOutcome,
  itemToken,
  normalizeFileMentionQuery,
  parseAtMentionQuery,
} from "./at-mention";

export type FsEntry = { relPath: string; absPath: string; type: "file" | "dir" };

/**
 * CC 2.1.301 — the error row text for a non-OK `/api/fs/list` answer, or
 * `null` to stay quiet. Only a failed search (403 unreadable folder, 5xx)
 * is shown; a 400 (e.g. "unknown cwd" from `resolveTrustedCwd`, no session
 * cwd yet) just closes the picker like an empty result, as it always did.
 */
export function fsListErrorText(status: number, body: { error?: string }): string | null {
  if (status !== 403 && status < 500) return null;
  return body.error ?? `Search failed (HTTP ${status})`;
}

type Props = {
  query: string;
  cwd: string | null;
  sessionId: string | null;
  onSelect: (tokenBody: string) => void;
  onClose: () => void;
  /**
   * CC 2.1.331 — called with the query the menu has no rows for (searched,
   * nothing matched), or null while it has rows or is still searching. The
   * composer lets Enter send a prompt ending in an unmatched `@word`. Pass a
   * stable function (a state setter).
   */
  onNoRows?: (query: string | null) => void;
  /**
   * CC 2.1.331 — a plain Enter with nothing to pick: pressed while the menu
   * has no rows, or pressed during the search and replayed once it answered
   * with none. The composer runs its own Enter (send, or continue a list).
   * Handled here rather than left to the composer's `onNoRows` gate, which
   * updates a render later and would turn that Enter into a newline.
   */
  onUnmatchedEnter?: () => void;
};

export function AtMentionPicker({ query, cwd, sessionId, onSelect, onClose, onNoRows, onUnmatchedEnter }: Props) {
  // `@` is already stripped by PromptInput's refreshPickerState, so an
  // agent mention shows up here as e.g. "agent-rev".
  const { agentMode, filter: agentFilter } = parseAtMentionQuery(query);

  const [entries, setEntries] = useState<FsEntry[]>([]);
  // `fileLoading` tracks ONLY the filesystem fetch. The displayed `loading`
  // (below) is derived per-branch so the agent branch never reuses this flag
  // — that's what would trap the spinner on the null-session / zero-match
  // cases the guard relies on.
  const [fileLoading, setFileLoading] = useState(true);
  // CC 2.1.301 — the file search failed (unreadable folder, server error).
  // Shown in the picker instead of silently closing it as if nothing matched;
  // a 400 / network failure stays quiet (see `fsListErrorText`).
  const [fileError, setFileError] = useState<string | null>(null);
  // CC 2.1.331 — the server's walk stopped before covering the whole
  // workspace, so a file that exists may not be listed. Said in the menu
  // instead of closing it as if nothing matched.
  const [truncated, setTruncated] = useState(false);
  const [hi, setHi] = useState(0);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // CC 2.1.331 — the token a plain Enter was held for while its search ran
  // (see `heldEnterOutcome`), or null.
  const heldEnterRef = useRef<string | null>(null);

  // Agent list, fetched once per session and cached (mirrors useSdkCommands):
  // each call to the agents endpoint is an SDK control round-trip, so we never
  // refetch per keystroke — client-side substring filtering instead.
  const [agentState, setAgentState] = useState<{ for: string | null; agents: Agent[] | null }>({
    for: null,
    agents: null,
  });

  // Reset fileLoading on query/cwd change before the fetch effect runs — keeps
  // the setState out of the effect body so we don't trip the
  // react-hooks/set-state-in-effect rule.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [lastInputs, setLastInputs] = useState({ query, cwd });
  if (lastInputs.query !== query || lastInputs.cwd !== cwd) {
    setLastInputs({ query, cwd });
    setFileLoading(true);
  }

  useEffect(() => {
    // In agent mode the filesystem results are ignored — don't fire a
    // /api/fs/list round-trip per keystroke.
    if (agentMode) return;
    const controller = new AbortController();
    // CC 2.1.275/2.1.278 — strip a leading `./` so `@./src` matches relPaths
    // (which carry no `./`) instead of substring-missing.
    const params = new URLSearchParams({ q: normalizeFileMentionQuery(query), limit: "50" });
    if (cwd) params.set("cwd", cwd);
    fetch(`/api/fs/list?${params}`, { signal: controller.signal })
      .then(async (r) => {
        const d = (await r.json().catch(() => ({}))) as {
          entries?: FsEntry[];
          error?: string;
          truncated?: boolean;
        };
        // The swallowed json() error may be the abort — don't apply stale results.
        if (controller.signal.aborted) return;
        setEntries(r.ok ? (d.entries ?? []) : []);
        setFileError(r.ok ? null : fsListErrorText(r.status, d));
        setTruncated(r.ok && d.truncated === true);
      })
      .catch((err: unknown) => {
        // Network failure / abort — stays quiet (picker closes), as before.
        if (err instanceof DOMException && err.name === "AbortError") return;
        setEntries([]);
        setFileError(null);
        setTruncated(false);
      })
      .finally(() => {
        if (!controller.signal.aborted) setFileLoading(false);
      });
    return () => controller.abort();
  }, [query, cwd, agentMode]);

  // Fetch the session's agent list once per session id. Tagged with the
  // session so a stale session's list never shows; setState lives in an async
  // .then (not the effect body), so this is lint-clean.
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    let cancelled = false;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/agents`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { agents?: Agent[] } | null) => {
        if (cancelled) return;
        setAgentState({ for: sessionId, agents: d && Array.isArray(d.agents) ? d.agents : [] });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (!cancelled) setAgentState({ for: sessionId, agents: [] });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [sessionId]);

  // Only trust the cache when it was fetched for the current session.
  const cachedAgents = agentState.for === sessionId ? agentState.agents : null;
  const agentCacheReady = cachedAgents != null;

  // Displayed loading flag, derived per branch:
  //   - agent mode with no session (GoalBanner) → false, so the empty-guard
  //     fires and the picker no-ops rather than spinning forever.
  //   - agent mode → true only until the cache for this session lands.
  //   - file mode → the filesystem fetch flag.
  const loading = agentMode ? sessionId != null && !agentCacheReady : fileLoading;

  const visible = useMemo<PickerItem[]>(() => {
    if (agentMode) return filterAgents(cachedAgents ?? [], agentFilter);
    return entries
      .slice(0, 30)
      .map<PickerItem>((e) => ({ kind: "file", relPath: e.relPath, type: e.type }));
  }, [agentMode, agentFilter, cachedAgents, entries]);

  // Reset highlight to top when the visible result set size changes —
  // same "store previous props" pattern as above to avoid an effect.
  // CC 2.1.331 — and when the query changes: the list is capped at 30 rows and
  // usually full, so a length-only reset kept a stale slot highlighted.
  const shape = { filter: query, count: visible.length };
  const [lastShape, setLastShape] = useState(shape);
  if (shouldResetHighlight(lastShape, shape)) {
    setLastShape(shape);
    setHi(0);
  }

  // CC 2.1.331 — tell the composer when this token has nothing to pick, so
  // Enter sends `thanks @claude` instead of inserting a newline.
  const noRows = !loading && visible.length === 0;
  useEffect(() => {
    onNoRows?.(noRows ? query : null);
    // Closing the menu clears the report, so a later token with the same text
    // starts out holding Enter until its own search answers.
    return () => onNoRows?.(null);
  }, [noRows, query, onNoRows]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isImeComposing(e)) return; // CC 2.1.329: the IME owns a composing key
      // CC 2.1.331 — while the search for the token as typed now is still
      // running, the rows on screen are the previous query's: a quick Tab or
      // Enter inserted the wrong file. Hold the key until the results land.
      // With nothing to pick, Enter goes on to the composer, which sends.
      if (e.key === "Tab" || e.key === "Enter") {
        const action = atMenuKeyAction({ loading, rows: visible.length });
        const plainEnter =
          e.key === "Enter" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !isHeldRepeat(e);
        if (action === "hold") {
          e.preventDefault();
          e.stopPropagation();
          // Kept, not lost: replayed if the search finds nothing to pick.
          if (plainEnter && onUnmatchedEnter) heldEnterRef.current = query;
          return;
        }
        if (action === "pass" && plainEnter && onUnmatchedEnter) {
          e.preventDefault();
          e.stopPropagation();
          onUnmatchedEnter();
          return;
        }
      }
      if (visible.length === 0) return;
      // Cmd/Ctrl+↑/↓ is the composer's prompt-history recall chord — let it
      // pass through to PromptInput rather than moving this picker's highlight.
      if ((e.metaKey || e.ctrlKey) && (e.key === "ArrowUp" || e.key === "ArrowDown")) return;
      // CC 2.1.330 — a held Enter/Tab's auto-repeat never picks: swallow it.
      if (isHeldRepeat(e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setHi((h) => (h + 1) % visible.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setHi((h) => (h - 1 + visible.length) % visible.length);
      } else if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        // stopPropagation is load-bearing: this fires on `window` in the
        // CAPTURE phase, ahead of PromptInput's own onKeyDown (bubble phase
        // on the textarea). `onSelect` below clears `atQuery` synchronously
        // enough that, left to propagate, the *same* keydown still reaches
        // onKeyDown with `atQuery` already null — tripping the Enter-submits
        // fallback (or the Tab-indent fallback) on the very keystroke meant
        // to just insert the mention. Bug found while wiring up
        // EmojiShortcodePicker (CC 2.1.217 parity), fixed here too since it's
        // the same picker contract.
        e.stopPropagation();
        onSelect(itemToken(visible[hi]));
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [hi, visible, loading, query, onClose, onSelect, onUnmatchedEnter]);

  // CC 2.1.331 — settle an Enter held during the search: send once it answers
  // with nothing to pick, drop it if files turned up or the token changed.
  useEffect(() => {
    const heldFor = heldEnterRef.current;
    if (heldFor == null) return;
    const outcome = heldEnterOutcome({ heldFor, query, loading, rows: visible.length });
    if (outcome === "wait") return;
    heldEnterRef.current = null;
    if (outcome === "send") onUnmatchedEnter?.();
  }, [query, loading, visible.length, onUnmatchedEnter]);

  useEffect(() => {
    itemRefs.current[hi]?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const showFileError = !agentMode && !loading && fileError != null;
  // CC 2.1.331 — the note replaces the "No files found" close, so it shows
  // only when nothing matched. The depth limit alone flags most real repos as
  // partial, so showing it above a list of rows would show it on every query.
  const showTruncated = !agentMode && !loading && !showFileError && truncated && visible.length === 0;
  if (visible.length === 0 && !loading && !showFileError && !showTruncated) return null;

  const countLabel = loading
    ? "loading…"
    : `${visible.length} ${agentMode ? "agent" : "file"}${visible.length === 1 ? "" : "s"}`;

  return (
    <div className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-72 overflow-auto rounded-xl border border-[var(--border)] bg-[var(--panel)] p-1 shadow-2xl scroll-thin">
      <div className="flex items-center justify-between px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">
        <span>@-mention · Tab to insert</span>
        <span>{countLabel}</span>
      </div>
      {showFileError && (
        <div data-testid="at-mention-search-error" role="alert" className="px-2 py-1 text-xs text-red-300">
          {fileError}
        </div>
      )}
      {visible.map((item, i) => {
        const key = item.kind === "agent" ? `agent:${item.name}` : `file:${item.relPath}`;
        const Icon = item.kind === "agent" ? Bot : item.type === "dir" ? Folder : File;
        const label = item.kind === "agent" ? item.name : item.relPath;
        const aside = item.kind === "agent" ? (item.model ?? item.description) : undefined;
        return (
          <button
            key={key}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            onMouseEnter={() => setHi(i)}
            onMouseDown={(ev) => {
              ev.preventDefault();
              onSelect(itemToken(item));
            }}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs ${
              i === hi ? "bg-[var(--panel-2)]" : ""
            }`}
          >
            {/* CC 2.1.290 — ❯ marks the selected row without relying on color. */}
            <span
              aria-hidden
              data-testid={i === hi ? "picker-selected-pointer" : undefined}
              className="w-2.5 shrink-0 text-center text-[11px] text-[var(--accent)]"
            >
              {i === hi ? "❯" : ""}
            </span>
            <Icon className="h-3 w-3 shrink-0 text-[var(--muted)]" />
            <span className="truncate font-mono">{label}</span>
            {aside && (
              <span className="ml-auto truncate pl-2 text-[10px] text-[var(--muted)]">{aside}</span>
            )}
          </button>
        );
      })}
      {showTruncated && (
        <div data-testid="at-mention-search-truncated" className="px-2 py-1 text-[11px] text-[var(--muted)]">
          This workspace is too large to search every file — some matches may be missing.
        </div>
      )}
    </div>
  );
}

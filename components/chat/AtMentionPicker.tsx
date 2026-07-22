"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, File, Folder } from "lucide-react";
import {
  type Agent,
  type PickerItem,
  filterAgents,
  itemToken,
  parseAtMentionQuery,
} from "./at-mention";

export type FsEntry = { relPath: string; absPath: string; type: "file" | "dir" };

type Props = {
  query: string;
  cwd: string | null;
  sessionId: string | null;
  onSelect: (tokenBody: string) => void;
  onClose: () => void;
};

export function AtMentionPicker({ query, cwd, sessionId, onSelect, onClose }: Props) {
  // `@` is already stripped by PromptInput's refreshPickerState, so an
  // agent mention shows up here as e.g. "agent-rev".
  const { agentMode, filter: agentFilter } = parseAtMentionQuery(query);

  const [entries, setEntries] = useState<FsEntry[]>([]);
  // `fileLoading` tracks ONLY the filesystem fetch. The displayed `loading`
  // (below) is derived per-branch so the agent branch never reuses this flag
  // — that's what would trap the spinner on the null-session / zero-match
  // cases the guard relies on.
  const [fileLoading, setFileLoading] = useState(true);
  const [hi, setHi] = useState(0);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

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
    const params = new URLSearchParams({ q: query, limit: "50" });
    if (cwd) params.set("cwd", cwd);
    fetch(`/api/fs/list?${params}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((d: { entries?: FsEntry[] }) => {
        setEntries(d.entries ?? []);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setEntries([]);
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
  const [lastVisibleLen, setLastVisibleLen] = useState(visible.length);
  if (lastVisibleLen !== visible.length) {
    setLastVisibleLen(visible.length);
    setHi(0);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (visible.length === 0) return;
      // Cmd/Ctrl+↑/↓ is the composer's prompt-history recall chord — let it
      // pass through to PromptInput rather than moving this picker's highlight.
      if ((e.metaKey || e.ctrlKey) && (e.key === "ArrowUp" || e.key === "ArrowDown")) return;
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
  }, [hi, visible, onClose, onSelect]);

  useEffect(() => {
    itemRefs.current[hi]?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  if (visible.length === 0 && !loading) return null;

  const countLabel = loading
    ? "loading…"
    : `${visible.length} ${agentMode ? "agent" : "file"}${visible.length === 1 ? "" : "s"}`;

  return (
    <div className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-72 overflow-auto rounded-xl border border-[var(--border)] bg-[var(--panel)] p-1 shadow-2xl scroll-thin">
      <div className="flex items-center justify-between px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">
        <span>@-mention · Tab to insert</span>
        <span>{countLabel}</span>
      </div>
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
            <Icon className="h-3 w-3 shrink-0 text-[var(--muted)]" />
            <span className="truncate font-mono">{label}</span>
            {aside && (
              <span className="ml-auto truncate pl-2 text-[10px] text-[var(--muted)]">{aside}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

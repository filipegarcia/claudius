"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { AssistantMessage } from "./AssistantMessage";
import { UserMessage } from "./UserMessage";
import { SystemPill } from "./SystemPill";
import { ClaudiusMark } from "@/components/brand/ClaudiusMark";
import { isRealUserDisplayMessage } from "@/lib/client/sdk-message-filters";
import type { DisplayMessage, SystemEntry, TaskInfo } from "@/lib/client/types";

type Props = {
  messages: DisplayMessage[];
  systemEntries: SystemEntry[];
  pending: boolean;
  onRewind?: (uuid: string) => void;
  rewindingUuid?: string | null;
  tasks?: Record<string, TaskInfo>;
  subagentMessages?: Record<string, DisplayMessage[]>;
  /** True until the initial SSE replay window finishes. */
  replaying?: boolean;
  /** True if older history exists above what's currently loaded. */
  hasMoreAbove?: boolean;
  /** True while a loadOlder() request is in flight. */
  loadingOlder?: boolean;
  /** Fetch the page of messages older than the current head and prepend. */
  onLoadOlder?: () => void;
  /** When set, scroll that message into view and briefly pulse it. */
  highlightUuid?: string | null;
  /**
   * Splash-screen example pills become clickable when this is provided —
   * clicking sends the example string straight to the prompt pipeline.
   */
  onPickExample?: (prompt: string) => void;
  /**
   * Live AskUserQuestion tool_use id — passed straight through to
   * `AssistantMessage` so the matching ToolCall row pulses its pill in
   * "live" mode. Null when no question is pending; historic ask rows still
   * get a non-pulsing "Reopen" pill.
   */
  pendingAskToolUseId?: string | null;
  /**
   * Click handler for the "Answer" / "Reopen" pill. Receives the clicked
   * row's tool_use id + raw input so the parent can either re-show the live
   * modal or resurrect a historic one.
   */
  onReopenAsk?: (args: { toolUseId: string; input: Record<string, unknown> }) => void;
};

const SPLASH_EXAMPLES = [
  "Check for security vulnerabilities in the latest git commit",
  "Improve test coverage",
  "Find TODO comments in the codebase",
  "Find performance bottlenecks and suggest fixes",
];

const NEAR_BOTTOM_PX = 80;

export function MessageList({
  messages,
  systemEntries,
  pending,
  onRewind,
  rewindingUuid,
  tasks,
  subagentMessages,
  replaying = false,
  hasMoreAbove = false,
  loadingOlder = false,
  onLoadOlder,
  highlightUuid = null,
  onPickExample,
  pendingAskToolUseId = null,
  onReopenAsk,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const isNearBottomRef = useRef(true);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [unread, setUnread] = useState(0);

  // For scroll-anchor preservation on prepend.
  const prevHeadUuidRef = useRef<string>("");
  const prevHeightRef = useRef<number>(0);
  const prevScrollTopRef = useRef<number>(0);

  // Detect "first uuid changed" → caller prepended older messages.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const newHead = messages[0]?.uuid ?? "";
    const oldHead = prevHeadUuidRef.current;
    if (oldHead && newHead && oldHead !== newHead) {
      // Find the prior head in the new list — its position is how far we
      // need to shift scrollTop down so the user's view doesn't jump.
      const newHeight = el.scrollHeight;
      const delta = newHeight - prevHeightRef.current;
      if (delta > 0) {
        el.scrollTop = prevScrollTopRef.current + delta;
      }
    }
    prevHeadUuidRef.current = newHead;
    prevHeightRef.current = el.scrollHeight;
    prevScrollTopRef.current = el.scrollTop;
  }, [messages]);

  // Uuid of the most recent user message in the transcript — re-derived on
  // every render so the activation-anchor effect below fires when it
  // changes for ANY reason (initial replay, snapshot fallback inject, the
  // user typing a new prompt). A simple boolean "armed" flag wasn't enough:
  // the session_snapshot fallback prepends a user message AFTER the first
  // replay_done has already armed and disarmed the effect.
  //
  // `isRealUserDisplayMessage` matches the server's `extractUserPromptText`
  // predicate (shared in `lib/shared/user-prompt.ts`) so the pin and the
  // server's `latestUserPromptSnapshot` agree on what counts as a real
  // prompt — synthetic `<task-notification>` injections, empty bubbles,
  // and tool_result wrappers are skipped even if they slip past the
  // intake reducer.
  const lastUserUuid = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && isRealUserDisplayMessage(m)) return m.uuid;
    }
    return "";
  }, [messages]);

  // Activation anchor: jump to the bottom of the chat whenever the last
  // user message changes. The CSS `position: sticky` on the last user
  // message (see render below) keeps the question pinned at the top of
  // the viewport for free, so scrolling to the BOTTOM gives the best of
  // both worlds — your question stays visible above, and the freshest
  // assistant content (or the streaming tail) lands in view below.
  //
  // We re-key on `lastUserUuid` instead of a boolean armedRef so the
  // snapshot-fallback inject (which prepends a user message AFTER
  // replay_done has already fired) gets the same anchor pass.
  const lastAnchoredUserUuidRef = useRef<string>("");
  useEffect(() => {
    if (replaying) return;
    const el = scrollRef.current;
    if (!el) return;
    if (lastAnchoredUserUuidRef.current === lastUserUuid) return;
    lastAnchoredUserUuidRef.current = lastUserUuid;
    el.scrollTop = el.scrollHeight;
    isNearBottomRef.current = true;
    setIsNearBottom(true);
    setUnread(0);
  }, [replaying, lastUserUuid]);

  // Reset anchor + prepend-tracking state when the session is swapped out
  // (messages empties because `resetState()` ran). Without the explicit
  // clear, the previous session's `lastAnchoredUserUuidRef` would suppress
  // the anchor on the first user message of the new session if the two
  // happen to share the same uuid (unlikely, but cheap insurance).
  // Using the "store previous props" pattern so the `setUnread` reset
  // runs during render — keeps it out of a useEffect body to satisfy
  // react-hooks/set-state-in-effect. The ref clears stay in a layout
  // effect because writing refs during render is itself disallowed.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [wasEmpty, setWasEmpty] = useState(messages.length === 0);
  const isEmpty = messages.length === 0;
  if (wasEmpty !== isEmpty) {
    setWasEmpty(isEmpty);
    if (isEmpty) {
      setUnread(0);
    }
  }
  useLayoutEffect(() => {
    if (isEmpty) {
      lastAnchoredUserUuidRef.current = "";
      prevHeadUuidRef.current = "";
    }
  }, [isEmpty]);

  // Track scroll position for "near bottom" gating.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = distFromBottom <= NEAR_BOTTOM_PX;
    isNearBottomRef.current = near;
    setIsNearBottom(near);
    if (near) setUnread(0);
  }, []);

  // Auto-scroll on new messages — only if user is already near the bottom.
  // Don't smooth-scroll during the initial replay (avoids the
  // "smooth-chasing" flicker).
  const lastTailUuidRef = useRef<string>("");
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const tail = messages[messages.length - 1]?.uuid ?? "";
    const grew = tail !== lastTailUuidRef.current;
    lastTailUuidRef.current = tail;
    if (!grew) return;
    if (replaying) {
      // jump (no smooth) during the buffered replay
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (isNearBottomRef.current) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    } else {
      setUnread((n) => n + 1);
    }
  }, [messages, replaying]);

  // Scroll a highlighted message into view when the prop changes (search → jump).
  useEffect(() => {
    if (!highlightUuid) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-message-uuid="${CSS.escape(highlightUuid)}"]`,
    );
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightUuid, messages.length]);

  // IntersectionObserver: when the top sentinel scrolls into view, fetch older.
  useEffect(() => {
    if (!hasMoreAbove || !onLoadOlder) return;
    const root = scrollRef.current;
    const sentinel = topSentinelRef.current;
    if (!root || !sentinel) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) onLoadOlder();
        }
      },
      { root, rootMargin: "200px 0px 0px 0px", threshold: 0 },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [hasMoreAbove, onLoadOlder]);

  const grouped = useMemo(() => groupSystemEntries(systemEntries), [systemEntries]);
  const turns = useMemo(() => groupTurns(messages), [messages]);

  const jumpToBottom = useCallback(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    setUnread(0);
  }, []);

  // Splash branch: empty transcript AND nothing older to fetch. We allow
  // `replaying` here because for a brand-new session replay_done arrives
  // empty (no flash); for a resumed session messages will populate before
  // replay finishes and we'll fall through to the scroll branch.
  if (messages.length === 0 && !hasMoreAbove) {
    const top = grouped.get("") ?? [];
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
        <ClaudiusMark color="var(--foreground)" size={120} className="mb-5 opacity-90" />
        <h1 className="mb-2 text-3xl font-semibold tracking-tight">Claudius</h1>
        <p className="mb-6 max-w-md text-sm text-[var(--muted)]">
          A web interface for Claude Code. Type a prompt to start a session.
        </p>
        <div className="grid grid-cols-1 gap-2 text-left text-sm sm:grid-cols-2">
          {SPLASH_EXAMPLES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={onPickExample ? () => onPickExample(s) : undefined}
              disabled={!onPickExample}
              title={onPickExample ? "Send as prompt" : undefined}
              className={cn(
                "rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 px-3 py-2 text-left text-[var(--muted)] transition",
                onPickExample
                  ? "cursor-pointer hover:border-[var(--accent)]/60 hover:bg-[var(--panel-2)]/60 hover:text-[var(--foreground)]"
                  : "cursor-default",
              )}
            >
              {s}
            </button>
          ))}
        </div>
        {top.length > 0 && (
          <div className="mt-6 w-full max-w-md text-left">
            {top.map((e) => (
              <SystemPill key={e.uuid} entry={e} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative flex flex-1 min-h-0 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto scroll-thin"
      >
        <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
          {/* Top sentinel: when it scrolls into view, the parent loads older. */}
          {hasMoreAbove && (
            <div ref={topSentinelRef} className="flex items-center justify-center py-2 text-[10px] text-[var(--muted)]">
              {loadingOlder ? "Loading older messages…" : "Scroll up for older messages"}
            </div>
          )}
          {!hasMoreAbove && messages.length > 20 && (
            <div className="flex items-center justify-center py-2 text-[10px] text-[var(--muted)]/60">
              Beginning of conversation
            </div>
          )}
          {(grouped.get("") ?? []).map((e) => (
            <SystemPill key={e.uuid} entry={e} />
          ))}
          {turns.map((turn, ti) => {
            const isLastTurn = ti === turns.length - 1;
            return (
              <section key={turn.items[0]!.uuid} className="space-y-4">
                {turn.items.map((m) => {
                  // Pin only the last turn's user message at the top of the
                  // scroll viewport. `position: sticky` is scoped to this
                  // <section>, so scrolling above the current turn naturally
                  // releases the pin — older user messages render inline.
                  //
                  // Cap the pinned area at ~33vh with internal scroll so a
                  // long prompt can never block the viewport: short messages
                  // still pin cleanly, long ones expose their own scrollbar
                  // and let assistant content below remain reachable.
                  const isPinnedUser = isLastTurn && m.role === "user";
                  return (
                    <div
                      key={m.uuid}
                      data-message-uuid={m.uuid}
                      className={cn(
                        "space-y-2 rounded-md transition-colors",
                        highlightUuid === m.uuid && "bg-[var(--accent)]/15 ring-1 ring-[var(--accent)]/40",
                        isPinnedUser &&
                          "sticky top-0 z-10 -mx-4 max-h-[20vh] overflow-y-auto scroll-thin border-b border-[var(--border)] bg-[var(--background)]/90 px-4 py-2 shadow-[0_2px_4px_rgba(0,0,0,0.04)] backdrop-blur",
                      )}
                    >
                      {m.role === "user" ? (
                        <UserMessage
                          message={m}
                          onRewind={onRewind}
                          rewinding={rewindingUuid === m.uuid}
                        />
                      ) : (
                        <AssistantMessage
                          message={m}
                          tasks={tasks}
                          subagentMessages={subagentMessages}
                          pendingAskToolUseId={pendingAskToolUseId}
                          onReopenAsk={onReopenAsk}
                        />
                      )}
                      {(grouped.get(m.uuid) ?? []).map((e) => (
                        <SystemPill key={e.uuid} entry={e} />
                      ))}
                    </div>
                  );
                })}
                {isLastTurn && pending && (
                  <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
                    <span className="font-medium text-[var(--foreground)]/80">Claude is working…</span>
                  </div>
                )}
              </section>
            );
          })}
          {turns.length === 0 && pending && (
            <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
              <span className="font-medium text-[var(--foreground)]/80">Claude is working…</span>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      {!isNearBottom && unread > 0 && (
        <button
          type="button"
          onClick={jumpToBottom}
          className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-white shadow-lg hover:opacity-90"
        >
          <ChevronDown className="h-3 w-3" /> {unread} new
        </button>
      )}
    </div>
  );
}

function groupSystemEntries(entries: SystemEntry[]): Map<string, SystemEntry[]> {
  const map = new Map<string, SystemEntry[]>();
  for (const e of entries) {
    const arr = map.get(e.afterMessageUuid) ?? [];
    arr.push(e);
    map.set(e.afterMessageUuid, arr);
  }
  return map;
}

type Turn = {
  /** The user message that opens this turn, or null if the transcript starts
   *  with non-user messages (rare — e.g. resumed session prelude). */
  lead: DisplayMessage | null;
  /** All messages belonging to the turn, in order. */
  items: DisplayMessage[];
};

/**
 * Slice the message list into "turns" — each turn begins at a user message
 * and includes every following non-user message until the next user message.
 * This lets us scope `position: sticky` per-turn so only the most recent
 * user message gets pinned at the top of the scroll viewport.
 */
function groupTurns(messages: DisplayMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const m of messages) {
    if (m.role === "user" || !current) {
      current = { lead: m.role === "user" ? m : null, items: [m] };
      turns.push(current);
    } else {
      current.items.push(m);
    }
  }
  return turns;
}

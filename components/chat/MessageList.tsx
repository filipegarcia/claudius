"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { AssistantMessage } from "./AssistantMessage";
import { UserMessage } from "./UserMessage";
import { SystemPill } from "./SystemPill";
import { ClaudiusMark } from "@/components/brand/ClaudiusMark";
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

  // Keep a ref to the latest messages so the activation-anchor effect can
  // read them without re-firing on every message append.
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // One-shot activation anchor: when the initial replay finishes, scroll the
  // LAST user message to the top of the chat viewport. This way, returning
  // to a session (tab switch / refresh) always lands with your last question
  // as the first thing you see, instead of dumping you at the bottom of the
  // reply. Falls back to a bottom-anchor jump if the transcript has no user
  // message yet (e.g. resumed session with only system/assistant prelude).
  const armedRef = useRef(false);
  useEffect(() => {
    if (replaying || armedRef.current) return;
    armedRef.current = true;
    const el = scrollRef.current;
    if (!el) return;
    let pinned = false;
    const msgs = messagesRef.current;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.role !== "user") continue;
      const userEl = el.querySelector<HTMLElement>(
        `[data-message-uuid="${CSS.escape(m.uuid)}"]`,
      );
      if (userEl) {
        // Use scrollTop math instead of scrollIntoView so the sticky wrapper
        // (which has its own padding/border) doesn't fight the alignment.
        const delta = userEl.getBoundingClientRect().top - el.getBoundingClientRect().top;
        el.scrollTop += delta;
        pinned = true;
      }
      break;
    }
    if (!pinned) {
      el.scrollTop = el.scrollHeight;
    }
    // Recompute "near bottom" from the new position — short transcripts may
    // not need any scroll at all, in which case we ARE near the bottom.
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = distFromBottom <= NEAR_BOTTOM_PX;
    isNearBottomRef.current = near;
    setIsNearBottom(near);
    setUnread(0);
  }, [replaying]);

  // Reset the arm when sessionId changes (head reset to "").
  useEffect(() => {
    if (messages.length === 0) {
      armedRef.current = false;
      prevHeadUuidRef.current = "";
      setUnread((n) => (n === 0 ? n : 0));
    }
  }, [messages.length]);

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
                  const isPinnedUser = isLastTurn && m.role === "user";
                  return (
                    <div
                      key={m.uuid}
                      data-message-uuid={m.uuid}
                      className={cn(
                        "space-y-2 rounded-md transition-colors",
                        highlightUuid === m.uuid && "bg-[var(--accent)]/15 ring-1 ring-[var(--accent)]/40",
                        isPinnedUser &&
                          "sticky top-0 z-10 -mx-4 border-b border-[var(--border)] bg-[var(--background)]/90 px-4 py-2 shadow-[0_2px_4px_rgba(0,0,0,0.04)] backdrop-blur",
                      )}
                    >
                      {m.role === "user" ? (
                        <UserMessage
                          message={m}
                          onRewind={onRewind}
                          rewinding={rewindingUuid === m.uuid}
                        />
                      ) : (
                        <AssistantMessage message={m} tasks={tasks} subagentMessages={subagentMessages} />
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

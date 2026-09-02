"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { AssistantMessage } from "./AssistantMessage";
import { UserMessage } from "./UserMessage";
import { AskUserQuestionPrompt } from "./AskUserQuestionPrompt";
import type { AskAnswer, AskUserQuestionEvent } from "@/lib/shared/events";
import { SystemPill, type SystemPillLevers } from "./SystemPill";
import { SpinnerTip } from "./SpinnerTip";
import type { Tip } from "@/lib/shared/tips";
import { SplashScreen } from "./SplashScreen";
import { isRealUserDisplayMessage } from "@/lib/client/sdk-message-filters";
import { nextPinGate } from "@/lib/client/scroll-gate";
import type { DisplayMessage, SystemEntry, TaskInfo, ToolProgressInfo } from "@/lib/client/types";
import type { ApiRetryState } from "@/lib/client/api-retry";
import {
  DEFAULT_VERBOSE,
  filterMessagesByVerbose,
  isSystemEntryHiddenAtLevel,
  type VerboseLevel,
} from "@/lib/shared/verbose";
import { useWorkspaces } from "@/lib/client/useWorkspaces";
import { FileLinkProvider, type FileLinkBase } from "@/lib/client/file-link-context";

type Props = {
  messages: DisplayMessage[];
  systemEntries: SystemEntry[];
  pending: boolean;
  onRewind?: (uuid: string) => void;
  rewindingUuid?: string | null;
  /** Active session id — enables the per-message "Restore files" affordance. */
  sessionId?: string;
  tasks?: Record<string, TaskInfo>;
  subagentMessages?: Record<string, DisplayMessage[]>;
  /**
   * Live `tool_progress` state (`session.toolProgress`), keyed by
   * tool_use_id. Forwarded to `AssistantMessage` → `TaskBlock` so a Task
   * card can show a subagent's rate-limit-retry state (SDK 0.3.214).
   */
  toolProgress?: Record<string, ToolProgressInfo>;
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
   * Run a slash command (with leading slash) from a spinner tip's clickable
   * affordance — wired to the chat page's `handleSend`. Omit to render tip
   * commands as plain text.
   */
  onRunCommand?: (command: string) => void;
  /**
   * Server-driven spinner tips (the `tips` SSE event). Passed straight to the
   * working-row {@link SpinnerTip}; when empty it falls back to its built-in
   * defaults.
   */
  tips?: Tip[];
  /**
   * Live retry state (`session.apiRetry`) — when set, the working-row
   * {@link SpinnerTip} shows the retry attempt/reason instead of rotating
   * tips. See `lib/client/api-retry.ts`.
   */
  apiRetry?: ApiRetryState | null;
  /**
   * Uuids of user messages that originated from a clicked suggestion chip.
   * Matching user bubbles get an "auto-suggested" badge.
   */
  suggestedUuids?: Set<string>;
  /**
   * Uuids of user messages submitted as the session goal. Matching user
   * bubbles get a "Goal" badge.
   */
  goalUuids?: Set<string>;
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
  /**
   * The live AskUserQuestion request, if one is pending. When set, its form
   * renders inline as the last item in the transcript (right under the model's
   * preceding text) instead of a fixed modal overlay. Null when nothing's
   * pending.
   */
  pendingAsk?: AskUserQuestionEvent | null;
  /** Session label chip shown in the inline ask header. */
  askSessionLabel?: string | null;
  /** Submit handler for the inline ask form (POSTs answers to the SDK). */
  onSubmitAsk?: (answers: AskAnswer[]) => void | Promise<void>;
  /** Cancel/decline handler for the inline ask form (sends empty answers). */
  onCancelAsk?: () => void | Promise<void>;
  /**
   * Chat verbosity level. Filters messages/blocks before render — see
   * `lib/shared/verbose.ts`. Empty assistant messages (all blocks filtered)
   * are dropped so the chat doesn't show an empty bubble. The right-side
   * activity rail is unaffected — it reads `toolHistory` separately, so
   * tool calls are still visible there at every verbose level.
   */
  verbose?: VerboseLevel;
  /**
   * Remediation-lever context forwarded to every {@link SystemPill}. Used by
   * the `allowed_warning` branch of the rate-limit pill to render one-click
   * "try /model sonnet" / "try /effort medium" chips when the active session
   * is on a model/effort the lever can actually burn down.
   */
  systemPillLevers?: SystemPillLevers;
};

export function MessageList({
  messages,
  systemEntries,
  pending,
  onRewind,
  rewindingUuid,
  sessionId,
  tasks,
  subagentMessages,
  toolProgress,
  replaying = false,
  hasMoreAbove = false,
  loadingOlder = false,
  onLoadOlder,
  highlightUuid = null,
  onPickExample,
  onRunCommand,
  tips,
  apiRetry,
  suggestedUuids,
  goalUuids,
  pendingAskToolUseId = null,
  onReopenAsk,
  pendingAsk = null,
  askSessionLabel = null,
  onSubmitAsk,
  onCancelAsk,
  verbose = DEFAULT_VERBOSE,
  systemPillLevers,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Last scrollTop we either observed in a scroll event or wrote ourselves.
  // `onScroll` compares against it to tell a REAL scroll-up from a bogus one.
  //
  // This replaces the old "ignore scroll events for 250ms after a pin" window.
  // That window was a proxy for "this event was caused by us, not the user",
  // and it never worked in both directions at once: suppressing the whole
  // window means a genuine mid-stream scroll-up is ignored and the reader gets
  // yanked back down (the bug edabbb6 fixed); suppressing only `near === true`
  // means a stale-geometry `near === false` permanently disarms the pin and the
  // reader stops following the bottom (the bug 134639e caused, reported as
  // "I get scrolled up when new messages arrive and have to scroll down
  // again"). The pin logic oscillated between those two for three commits.
  //
  // Direction is the signal the time window was only approximating. EVERY
  // user-initiated scroll-up — wheel, trackpad, touch drag, scrollbar drag,
  // PageUp/Home, find-in-page — decreases scrollTop. Our own pin, and content
  // growing beneath a stationary viewport, never do: scrollTop is unchanged or
  // larger. So we honour `near === false` only when the viewport actually moved
  // up, and no longer have to guess from timing who caused the event.
  const lastScrollTopRef = useRef(0);
  // Timestamp of the most recent load-older prepend. The always-pin handler
  // below skips the brief window after a prepend so pulling in history doesn't
  // immediately yank the reader back down to the newest message.
  const lastPrependAtRef = useRef(0);
  // Drives the "Jump to latest" affordance AND gates the auto-pin. True
  // whenever the view sits at the bottom; false while the user has scrolled up
  // into history. The ResizeObserver pin below reads the REF (its effect has
  // empty deps, so a state value would be stale) — without this gate, any new
  // message or streaming chunk yanks a reader who scrolled up back to the
  // bottom ("I'm reading a message, the model sends another, I get pushed up").
  const [isNearBottom, setIsNearBottom] = useState(true);
  const isNearBottomRef = useRef(true);

  // File-link coordinates for clickable project paths in tool-call headers and
  // inline-code spans. Resolved once here (a single useWorkspaces fetch) and
  // shared via context so every ToolCall / code span doesn't re-fetch the
  // workspace list itself.
  const { items: workspaceItems, activeId: activeWorkspaceId } = useWorkspaces();
  const fileLink = useMemo<FileLinkBase | null>(() => {
    if (!activeWorkspaceId) return null;
    const ws = workspaceItems.find((w) => w.id === activeWorkspaceId);
    if (!ws) return null;
    return { workspaceId: ws.id, cwd: ws.rootPath };
  }, [workspaceItems, activeWorkspaceId]);

  // For scroll-anchor preservation on prepend.
  const prevHeadUuidRef = useRef<string>("");
  const prevHeightRef = useRef<number>(0);
  // `offsetTop` of the head message as of the last run. Comparing the SAME
  // element's offsetTop before and after gives the height inserted ABOVE it,
  // which is what a prepend actually needs to compensate for. The old code
  // used total `scrollHeight` growth instead, which also includes the tail
  // growing from the live stream — an error term that has nothing to do with
  // the prepend.
  const prevHeadOffsetRef = useRef<number>(0);

  // Detect "first uuid changed" → caller prepended older messages.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const newHead = messages[0]?.uuid ?? "";
    const oldHead = prevHeadUuidRef.current;
    if (oldHead && newHead && oldHead !== newHead) {
      // The head message changed. That is USUALLY a load-older prepend, but it
      // is not only that: `resyncFromDisk` re-broadcasts JSONL records mid-turn
      // carrying their original (historical) `at`, and `sortMessagesByChronology`
      // puts those at the FRONT. Task-recovery and snapshot-fallback inserts
      // prepend too. So this branch fires during ordinary streaming, not just
      // when the reader pulls in history.
      //
      // Only a reader parked UP in history needs their visual position
      // preserved. A reader at the bottom should simply stay at the bottom, and
      // `pin()` already does that. Running the restore for them is what
      // produced the reported "I randomly get scrolled up": the arithmetic
      // landed above the true bottom, and the `lastPrependAtRef` stamp below
      // then suppressed the pin that would have corrected it — leaving the
      // reader stranded until the NEXT message happened to re-pin them.
      if (!isNearBottomRef.current) {
        // How much height was inserted above the message that used to be the
        // head. Measured from that element's own offsetTop rather than from
        // total scrollHeight growth, so concurrent growth at the TAIL (the
        // live stream) is not mistaken for content added above.
        const oldHeadEl = el.querySelector<HTMLElement>(
          `[data-message-uuid="${CSS.escape(oldHead)}"]`,
        );
        const addedAbove = oldHeadEl
          ? oldHeadEl.offsetTop - prevHeadOffsetRef.current
          : el.scrollHeight - prevHeightRef.current;
        if (addedAbove > 0) {
          // Read scrollTop LIVE. `prevScrollTopRef` was captured during the
          // React commit, before that frame's ResizeObserver pin wrote the
          // authoritative value, so it was systematically one growth-step
          // stale — and the restore inherited exactly that error.
          el.scrollTop = el.scrollTop + addedAbove;
          // Keep the direction baseline in step with the restore, so the scroll
          // event it emits isn't misread as the reader scrolling up.
          lastScrollTopRef.current = el.scrollTop;
        }
        // Stand the pin down briefly so the resize this prepend triggers
        // doesn't snap the history reader to the bottom.
        lastPrependAtRef.current = performance.now();
      }
    }
    prevHeadUuidRef.current = newHead;
    prevHeightRef.current = el.scrollHeight;
    const headEl = newHead
      ? el.querySelector<HTMLElement>(`[data-message-uuid="${CSS.escape(newHead)}"]`)
      : null;
    prevHeadOffsetRef.current = headEl?.offsetTop ?? 0;
  }, [messages]);

  // Uuid of the chronologically-latest user message — re-derived on every
  // render so the activation-anchor effect below fires when it changes for
  // ANY reason (initial replay, snapshot fallback inject, the user typing a
  // new prompt). A simple boolean "armed" flag wasn't enough: the
  // session_snapshot fallback can insert a user message AFTER the first
  // replay_done has already armed and disarmed the effect.
  //
  // Walk by `createdAt` timestamp instead of array position. The previous
  // "last-from-end" walk landed on whichever user bubble happened to sit
  // later in `messages`, which broke when the array fell out of
  // chronological order — e.g. the snapshot fallback prepending the
  // server's latest prompt to the front while the SSE replay window
  // separately delivered an OLDER prompt at a later index. Walking by
  // timestamp makes the pin agree with the server's "latest prompt" view
  // regardless of how the array got assembled. Fallback to the last
  // positional candidate covers the legacy `synthesizeOlder` edge cases
  // where `createdAt` may be absent.
  //
  // `isRealUserDisplayMessage` matches the server's `extractUserPromptText`
  // predicate (shared in `lib/shared/user-prompt.ts`) so the pin and the
  // server's `latestUserPromptSnapshot` agree on what counts as a real
  // prompt — synthetic `<task-notification>` injections, empty bubbles,
  // and tool_result wrappers are skipped even if they slip past the
  // intake reducer.
  const lastUserUuid = useMemo(() => {
    let bestUuid = "";
    let bestAt = -Infinity;
    let fallbackUuid = "";
    for (const m of messages) {
      if (!m || !isRealUserDisplayMessage(m)) continue;
      fallbackUuid = m.uuid;
      if (typeof m.createdAt === "number" && m.createdAt >= bestAt) {
        bestAt = m.createdAt;
        bestUuid = m.uuid;
      }
    }
    return bestUuid || fallbackUuid;
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
    lastScrollTopRef.current = el.scrollTop;
    // A fresh user prompt re-arms sticking — the user just acted, jump to
    // the bottom and resume following new content.
    isNearBottomRef.current = true;
    setIsNearBottom(true);
  }, [replaying, lastUserUuid]);

  // Reset anchor + prepend-tracking state when the session is swapped out
  // (messages empties because `resetState()` ran). Without the explicit
  // clear, the previous session's `lastAnchoredUserUuidRef` would suppress
  // the anchor on the first user message of the new session if the two
  // happen to share the same uuid (unlikely, but cheap insurance).
  const isEmpty = messages.length === 0;
  // Empty transcript with nothing older to fetch → render the splash instead of
  // the scroll container (see the early return below). Hoisted here so the
  // scroll/pin effects can depend on it and re-attach when the scroller mounts.
  const showSplash = isEmpty && !hasMoreAbove;
  useLayoutEffect(() => {
    if (isEmpty) {
      lastAnchoredUserUuidRef.current = "";
      prevHeadUuidRef.current = "";
    }
  }, [isEmpty]);

  // Track scroll position purely to toggle the "Jump to latest" button. Pinning
  // doesn't read this — we always snap to the bottom (see below).
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const prevScrollTop = lastScrollTopRef.current;
    lastScrollTopRef.current = top;
    // `null` means "content moved, the reader didn't" — leave the gate alone
    // and let `pin()` catch up. See lib/client/scroll-gate.ts for why direction
    // rather than timing decides this.
    const next = nextPinGate({
      scrollTop: top,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      prevScrollTop,
    });
    if (next === null) return;
    isNearBottomRef.current = next;
    setIsNearBottom(next);
  }, []);

  // Stay at the bottom WHILE THE READER IS THERE. A ResizeObserver fires on
  // every height change — a reply streaming in (the tail message grows under
  // one uuid), a brand-new message, late reflow (font load, image decode), AND
  // the viewport shrinking when the composer autosizes as you type or the
  // window resizes. On any of those we snap to the newest content. Observing
  // BOTH the content wrapper and the scroll container is what makes the typing
  // case work — the composer growing changes the container's box, not the
  // content's. Instant pin (no smooth) avoids smooth-chasing jank mid-stream.
  //
  // Two carve-outs:
  //   1. The reader scrolled up into history (isNearBottomRef false) — pinning
  //      would yank them off the message they're reading the instant the model
  //      emits anything. Honour their position; the "Jump to latest" button is
  //      their way back down.
  //   2. A load-older prepend also fires a resize, but snapping there would make
  //      scrolling back through history impossible — skip the brief window after
  //      a prepend (lastPrependAtRef).
  //
  // Re-run when `showSplash` flips: on a session that starts empty the render
  // returns <SplashScreen> (no scroll container), so scrollRef/contentRef are
  // null on first mount and a `[]`-deps effect would attach the observer to
  // nothing and never retry. Keying on `showSplash` re-runs this the moment the
  // scroll branch mounts, so pinning actually works for fresh sessions (the bug
  // behind the "reader pushed up / never follows the bottom" e2e failure).
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const pin = () => {
      if (!isNearBottomRef.current) return;
      if (performance.now() - lastPrependAtRef.current < 350) return;
      el.scrollTop = el.scrollHeight;
      // Record what we wrote so the echo of this write compares equal rather
      // than looking like an upward move to `onScroll`.
      lastScrollTopRef.current = el.scrollTop;
      // setState bails out when already true, so repeated chunks don't re-render.
      setIsNearBottom(true);
    };
    const ro = new ResizeObserver(pin);
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showSplash]);

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

  // System pills (init, hooks, status, rate-limit, …) render on their own
  // anchored path, untouched by the message/block filters above. Drop the
  // kinds the current level suppresses (today: the transient "Status:
  // requesting" ticker at compact / ultra-compact) before grouping, so all
  // three SystemPill render sites below inherit the filter from one place.
  const grouped = useMemo(
    () =>
      groupSystemEntries(
        systemEntries.filter((e) => !isSystemEntryHiddenAtLevel(e.kind, verbose)),
      ),
    [systemEntries, verbose],
  );
  // Verbose-filtered view of the message list. Anchor/scroll logic above
  // intentionally operates on the UNFILTERED `messages` array so a user
  // toggling the level doesn't shift the chronological-latest-user-message
  // anchor — the user's prompt always lives in the unfiltered timeline.
  // Filtering happens here purely for the rendered turns.
  const visibleMessages = useMemo(
    () => filterMessagesByVerbose(messages, verbose),
    [messages, verbose],
  );
  const turns = useMemo(() => groupTurns(visibleMessages), [visibleMessages]);

  const jumpToBottom = useCallback(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    // Re-arm sticking so subsequent content keeps following the bottom. The
    // smooth animation dispatches a run of intermediate scroll events that are
    // still far from the bottom; because they move the viewport DOWN, the
    // direction check in `onScroll` no longer reads them as a scroll-up and
    // the gate we just armed survives the animation.
    isNearBottomRef.current = true;
    setIsNearBottom(true);
    const el = scrollRef.current;
    if (el) lastScrollTopRef.current = el.scrollTop;
  }, []);

  // Click-a-prompt-to-rewind-the-view: scroll the clicked user message's turn
  // to the top of the viewport so everything the assistant said in reply
  // becomes readable from the start. We anchor on the enclosing <section>
  // (the whole turn), NOT the message element — the latest user message is
  // `position: sticky` at top:0, so its own rect already reads as "at the
  // top" and scrolling to it would no-op. The section's top is the real
  // anchor, and for non-pinned messages the section's lead IS that user
  // message, so the same computation works uniformly.
  const jumpToMessageTop = useCallback((uuid: string) => {
    const root = scrollRef.current;
    if (!root) return;
    const msgEl = root.querySelector<HTMLElement>(
      `[data-message-uuid="${CSS.escape(uuid)}"]`,
    );
    if (!msgEl) return;
    const target: Element = msgEl.closest("section") ?? msgEl;
    const delta = target.getBoundingClientRect().top - root.getBoundingClientRect().top;
    root.scrollTo({ top: root.scrollTop + delta, behavior: "smooth" });
  }, []);

  // Splash branch: empty transcript AND nothing older to fetch. We allow
  // `replaying` here because for a brand-new session replay_done arrives
  // empty (no flash); for a resumed session messages will populate before
  // replay finishes and we'll fall through to the scroll branch.
  if (showSplash) {
    const top = grouped.get("") ?? [];
    return (
      <SplashScreen
        onPickExample={onPickExample}
        activeWorkspaceId={activeWorkspaceId}
        belowChips={
          top.length > 0 ? (
            <div className="mt-6 w-full max-w-md text-left">
              {top.map((e) => (
                <SystemPill key={e.uuid} entry={e} levers={systemPillLevers} />
              ))}
            </div>
          ) : null
        }
      />
    );
  }

  return (
    <FileLinkProvider value={fileLink}>
    <div className="relative flex flex-1 min-h-0 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto scroll-thin"
        // Disable the browser's "preserve visual position when content shifts"
        // anchoring. Without this, late reflow after our pin-to-bottom drags
        // scrollTop forward and fires scroll events the handler mis-reads as
        // "user scrolled up", stranding the view mid-list. We drive pinning
        // ourselves (ResizeObserver pin + the direction check in onScroll).
        style={{ overflowAnchor: "none" }}
      >
        <div
          ref={contentRef}
          className="mx-auto w-full max-w-[var(--chat-col)] space-y-4 px-2 py-6 sm:px-4"
        >
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
            <SystemPill key={e.uuid} entry={e} levers={systemPillLevers} />
          ))}
          {turns.map((turn, ti) => {
            const isLastTurn = ti === turns.length - 1;
            return (
              <section key={turn.items[0]!.uuid} className="space-y-4">
                {turn.items.map((m) => {
                  // Pin the chronologically-latest user message at the top
                  // of the scroll viewport. `position: sticky` is scoped to
                  // its <section>, so scrolling past that turn naturally
                  // releases the pin — older user messages render inline.
                  //
                  // Match by uuid against `lastUserUuid` rather than
                  // "positional last turn led by a user." The two diverge
                  // when `messages` is non-chronological — most commonly
                  // when the session_snapshot fallback prepends the
                  // server's latest prompt to the front while the SSE
                  // replay window also contains an older prompt at a later
                  // index. Picking by uuid keeps the pin on the actual
                  // latest prompt regardless of array shape.
                  //
                  // Cap the pinned area at ~33vh with internal scroll so a
                  // long prompt can never block the viewport: short messages
                  // still pin cleanly, long ones expose their own scrollbar
                  // and let assistant content below remain reachable.
                  const isPinnedUser = m.uuid === lastUserUuid;
                  return (
                    <div
                      key={m.uuid}
                      data-message-uuid={m.uuid}
                      data-message-role={m.role}
                      className={cn(
                        "space-y-2 rounded-md transition-colors",
                        highlightUuid === m.uuid && "bg-[var(--accent)]/15 ring-1 ring-[var(--accent)]/40",
                        isPinnedUser &&
                          // Mirror the scroll-container padding (px-2 on
                          // narrow viewports, px-4 from sm up). The negative
                          // margin pulls the pinned bar flush to the
                          // scrollbar edges so the bottom border spans the
                          // full chat width regardless of breakpoint.
                          "sticky top-0 z-10 -mx-2 max-h-[20vh] overflow-y-auto scroll-thin border-b border-[var(--border)] bg-[var(--background)]/90 px-2 py-2 shadow-[0_2px_4px_rgba(0,0,0,0.04)] backdrop-blur sm:-mx-4 sm:px-4",
                      )}
                    >
                      {m.role === "user" ? (
                        <UserMessage
                          message={m}
                          onRewind={onRewind}
                          rewinding={rewindingUuid === m.uuid}
                          sessionId={sessionId}
                          onJumpTo={() => jumpToMessageTop(m.uuid)}
                          suggested={!!suggestedUuids?.has(m.uuid)}
                          fromGoal={!!goalUuids?.has(m.uuid)}
                          verbose={verbose}
                        />
                      ) : (
                        <AssistantMessage
                          message={m}
                          tasks={tasks}
                          subagentMessages={subagentMessages}
                          pendingAskToolUseId={pendingAskToolUseId}
                          onReopenAsk={onReopenAsk}
                          verbose={verbose}
                          toolProgress={toolProgress}
                        />
                      )}
                      {(grouped.get(m.uuid) ?? []).map((e) => (
                        <SystemPill key={e.uuid} entry={e} levers={systemPillLevers} />
                      ))}
                    </div>
                  );
                })}
                {/* Suppress the "Claude is working…" spinner while a question
                    is pending. The turn stays `pending` (the agent is blocked in
                    canUseTool), but it's WAITING for the user, not working —
                    showing the spinner is misleading and, worse, splits the
                    AskUserQuestion tool-call row from the inline form below it. */}
                {isLastTurn && pending && !pendingAsk && (
                  <WorkingRow onRunCommand={onRunCommand} tips={tips} apiRetry={apiRetry} />
                )}
              </section>
            );
          })}
          {turns.length === 0 && pending && !pendingAsk && (
            <WorkingRow onRunCommand={onRunCommand} tips={tips} apiRetry={apiRetry} />
          )}
          {/* Live question, embedded in the transcript flow so the reader can
              see everything the model said before answering. The agent is
              blocked in `canUseTool` awaiting this, so it's genuinely the last
              thing in the conversation. Historic/resolved asks still reopen as
              a modal (handled by the parent) — this is the live one only. */}
          {pendingAsk && onSubmitAsk && (
            <div data-testid="ask-user-question-inline" className="pt-2">
              <AskUserQuestionPrompt
                inline
                request={pendingAsk}
                sessionLabel={askSessionLabel}
                onSubmit={onSubmitAsk}
                onCancel={onCancelAsk ?? (() => onSubmitAsk([]))}
              />
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      {!isNearBottom && (
        // Doubles as the pending-question cue: the inline ask form is the last
        // item in the transcript, so when it's scrolled out of view this is the
        // one always-visible signal that a question is waiting (the modal's old
        // job). Clicking jumps to the bottom, which lands on the form.
        <button
          type="button"
          onClick={jumpToBottom}
          data-testid="jump-to-latest"
          aria-label={pendingAsk ? "Jump to pending question" : "Jump to latest"}
          className={cn(
            "absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full px-3 py-1 text-[11px] font-medium text-white shadow-lg hover:opacity-90",
            pendingAsk
              ? "border border-[var(--accent)] bg-[var(--accent)]"
              : "border border-[var(--border)] bg-[var(--accent)]",
          )}
        >
          {pendingAsk ? (
            <>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
              Answer question
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" /> Jump to latest
            </>
          )}
        </button>
      )}
    </div>
    </FileLinkProvider>
  );
}

/**
 * The "Claude is working…" indicator shown at the tail of the active turn —
 * the browser analog of the CLI spinner. Carries a rotating {@link SpinnerTip}
 * underneath so idle wait time surfaces a Claudius feature the user may not
 * have found. Single definition, rendered from both the last-turn and the
 * no-turns-yet branches.
 */
function WorkingRow({
  onRunCommand,
  tips,
  apiRetry,
}: {
  onRunCommand?: (command: string) => void;
  tips?: Tip[];
  apiRetry?: ApiRetryState | null;
}) {
  return (
    <div className="flex flex-col gap-1 text-xs text-[var(--muted)]">
      <div className="flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
        <span className="font-medium text-[var(--foreground)]/80">Claude is working…</span>
      </div>
      <SpinnerTip onRunCommand={onRunCommand} tips={tips} apiRetry={apiRetry} />
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

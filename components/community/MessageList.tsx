"use client";

import { useEffect, useRef } from "react";
import type { Message as ChatMessage } from "@/lib/shared/community";
import { Message } from "./Message";

type Props = {
  messages: ChatMessage[];
  nick: string | null;
  isAdmin: boolean;
  pinnedId: string | null;
  onDelete: (id: string) => void;
  onPin: (id: string) => void;
  onBan: (nick: string) => void;
  /**
   * Whether the room is known to have older messages the client
   * hasn't pulled yet. Drives the "Load older messages" button at
   * the top of the list. Defaults to `false` so callers that don't
   * care about pagination get the legacy "no button" behaviour.
   */
  hasMore?: boolean;
  /** True while a load-older fetch is in flight. */
  loadingOlder?: boolean;
  /** Pull the next 50 older messages. No-op when !hasMore. */
  onLoadOlder?: () => void;
};

/**
 * Scrollable message column. The view tracks the bottom of the list by
 * default. The user can scroll up to read history and we hold position;
 * once they scroll back near the bottom we resume tracking.
 *
 * Two non-obvious pieces:
 *   1. `overflow-anchor: none` on the container disables the browser's
 *      "preserve visual position when content shifts" anchoring. Without
 *      that, font reflow / late layout after our pin-to-bottom drags
 *      `scrollTop` forward, which fires `scroll` events that the
 *      handler below mis-reads as "user scrolled up" — and we stop
 *      pinning, leaving the view stranded mid-list.
 *   2. The "track the bottom" mechanism is a `ResizeObserver` on the
 *      content wrapper, not a `useLayoutEffect` on `messages`. The SSE
 *      replay populates messages in one render, but the *real* final
 *      content height settles a few frames later (fonts, etc.). The
 *      observer fires on every height change so we re-pin until the
 *      page is settled.
 */
export function MessageList({
  messages,
  nick,
  isAdmin,
  pinnedId,
  onDelete,
  onPin,
  onBan,
  hasMore,
  loadingOlder,
  onLoadOlder,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // User's scroll intent — "bottom" means "keep me pinned to the latest
  // message," "reading" means "I scrolled up, don't yank me back." Updated
  // only on `scroll` events, which fire on user input but NOT on content
  // height changes — so font reflow doesn't accidentally flip the intent.
  const intentRef = useRef<"bottom" | "reading">("bottom");

  useEffect(() => {
    const el = containerRef.current;
    const content = contentRef.current;
    if (!el || !content) return;

    // Timestamp of the last programmatic pin. Scroll events that fire
    // within a short window after a pin are not the user — they're the
    // browser dispatching the side-effect of our own scrollTop write,
    // sometimes with a stale scrollHeight (content has grown another
    // step between the pin and the event). Using the scrollHeight at
    // that moment to decide intent is the bug we're working around.
    let lastPinAt = 0;

    const pinIfBottom = () => {
      if (intentRef.current === "bottom") {
        lastPinAt = performance.now();
        el.scrollTop = el.scrollHeight;
      }
    };

    const onScroll = () => {
      // Ignore scroll events that are the direct consequence of our pin.
      // 250ms covers the slowest expected reflow-and-fire delay; user
      // scrolls within that window after we just pinned to the bottom
      // would be rare and harmless to miss (intent stays "bottom").
      if (performance.now() - lastPinAt < 250) return;
      const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
      intentRef.current = distance < 80 ? "bottom" : "reading";
    };
    el.addEventListener("scroll", onScroll);

    // ResizeObserver fires once on observe() with the current size, then
    // again on every subsequent height change. That covers the initial
    // empty → populated render, new messages appended, and async reflow
    // (font load, image decode, etc.).
    const ro = new ResizeObserver(pinIfBottom);
    ro.observe(content);

    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      data-testid="community-message-list"
      className="scroll-thin flex-1 overflow-y-auto px-4 py-3"
      style={{ overflowAnchor: "none" }}
    >
      <div ref={contentRef}>
        {/* Load-older button. Shown when the room is known to have
            history the client hasn't pulled yet; clicking it fetches
            the next 50 older messages via the backfill endpoint and
            prepends them. Hidden once the backfill returns < 50 rows
            (i.e. we've hit the start of the room). */}
        {onLoadOlder && hasMore && (
          <div className="mb-3 flex justify-center">
            <button
              type="button"
              onClick={onLoadOlder}
              disabled={loadingOlder}
              data-testid="community-load-older"
              className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-1 text-xs text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-50"
            >
              {loadingOlder ? "Loading…" : "Load older messages"}
            </button>
          </div>
        )}
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
            No messages yet. Say hi.
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {messages.map((m) => (
              <li key={m.id}>
                <Message
                  message={m}
                  isOwn={!!nick && m.nick === nick}
                  isAdmin={isAdmin}
                  isPinned={pinnedId === m.id}
                  onDelete={isAdmin ? () => onDelete(m.id) : undefined}
                  onPin={isAdmin ? () => onPin(m.id) : undefined}
                  onBan={isAdmin ? () => onBan(m.nick) : undefined}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
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
};

/**
 * Scrollable message column. Auto-scrolls to the bottom on new messages
 * unless the user has manually scrolled up — at which point we hold
 * position so they can read history without being yanked.
 */
export function MessageList({
  messages,
  nick,
  isAdmin,
  pinnedId,
  onDelete,
  onPin,
  onBan,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // Track whether the user has scrolled away from the bottom.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
      stickToBottomRef.current = distance < 80;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // After every render that grew the list, scroll to bottom if we were
  // pinned there. useLayoutEffect avoids the flash of unscrolled state.
  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  return (
    <div
      ref={containerRef}
      className="scroll-thin flex-1 overflow-y-auto px-4 py-3"
    >
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
  );
}

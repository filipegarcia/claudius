"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Send } from "lucide-react";
import type { DM } from "@/lib/shared/community";
import type { UseDMs } from "@/lib/client/use-dms";
import { cn } from "@/lib/utils/cn";

type Props = {
  dms: UseDMs;
  /** Peer nick this thread is with. */
  peer: string;
  /** Close the thread, returning the main area to the room view. */
  onClose: () => void;
};

/**
 * DM thread view — header (peer nick + back arrow), scrolling message
 * list, composer. Mirrors the shape of the channel main column but
 * with DMs instead of room messages and no admin moderation controls
 * (DMs are private moderation territory — the recipient handles their
 * own thread).
 *
 * Auto-loads the first page on mount via useDMs' loadOlder effect.
 * Scroll-up keeps the "Load older messages" button at the top.
 * Bottom-pinning + ResizeObserver pattern matches MessageList — when
 * the user is near the bottom, we follow new arrivals; if they
 * scrolled up to read history, we hold position.
 */
export function DMThread({ dms, peer, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const intentRef = useRef<"bottom" | "reading">("bottom");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    let lastPinAt = 0;
    const pinIfBottom = () => {
      if (intentRef.current === "bottom") {
        lastPinAt = performance.now();
        el.scrollTop = el.scrollHeight;
      }
    };
    const onScroll = () => {
      if (performance.now() - lastPinAt < 250) return;
      const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
      intentRef.current = distance < 80 ? "bottom" : "reading";
    };
    el.addEventListener("scroll", onScroll);
    const ro = new ResizeObserver(pinIfBottom);
    ro.observe(content);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setSendErr(null);
    const r = await dms.sendDm(peer, body);
    setSending(false);
    if (r.ok) setDraft("");
    else setSendErr(r.error);
  };

  return (
    <main
      className="flex min-w-0 flex-1 flex-col"
      data-testid="community-dm-thread"
    >
      <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            title="Back to channels"
            className="rounded p-1 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
            data-testid="community-dm-back"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <span className="font-mono text-sm text-[var(--foreground)]">
            @{peer}
          </span>
          <span className="text-xs text-[var(--muted)]">
            direct message
          </span>
        </div>
        <span className="font-mono text-xs text-[var(--muted)]">
          {dms.nick ? `you: ${dms.nick}` : "no nickname"}
        </span>
      </header>

      <div
        ref={containerRef}
        className="scroll-thin flex-1 overflow-y-auto px-4 py-3"
        style={{ overflowAnchor: "none" }}
      >
        <div ref={contentRef}>
          {dms.hasMore && (
            <div className="mb-3 flex justify-center">
              <button
                type="button"
                onClick={() => void dms.loadOlder()}
                disabled={dms.loadingOlder}
                data-testid="community-dm-load-older"
                className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-1 text-xs text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-50"
              >
                {dms.loadingOlder ? "Loading…" : "Load older messages"}
              </button>
            </div>
          )}
          {dms.messages.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
              No messages yet. Say hi to @{peer}.
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {dms.messages.map((m) => (
                <li key={m.id}>
                  <DMRow message={m} isOwn={!!dms.nick && m.fromNick === dms.nick} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="border-t border-[var(--border)] px-3 py-2">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !sending) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={`Message @${peer}…`}
            rows={1}
            disabled={!dms.configured}
            className="scroll-thin flex-1 resize-none rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] disabled:opacity-50"
            data-testid="community-dm-composer"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || !draft.trim() || !dms.configured}
            className="rounded-md bg-[var(--accent)] p-1.5 text-[var(--background)] hover:brightness-110 disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
        {sendErr && (
          <p className="mt-1 text-[10px] text-[var(--accent)]">{sendErr}</p>
        )}
      </div>
    </main>
  );
}

function DMRow({ message, isOwn }: { message: DM; isOwn: boolean }) {
  // `!= null` (not `!== null`) so an older chat-server that doesn't
  // emit the field on the wire is treated as "live" rather than
  // rendering every DM as a deletion placeholder.
  const isDeleted = message.deletedAt != null;
  return (
    <div
      className={cn(
        "flex w-full",
        isOwn && !isDeleted ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "max-w-[78%] rounded-2xl border border-[var(--border)] px-3 py-2",
          isDeleted
            ? "border-dashed bg-transparent"
            : isOwn
              ? "bg-[var(--panel-2)]"
              : "bg-[var(--panel)]",
        )}
      >
        <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-[var(--muted)]">
          <span
            className={cn(
              "font-mono font-medium",
              isDeleted ? "text-[var(--muted)] line-through" : "text-[var(--foreground)]",
            )}
          >
            {message.fromNick}
          </span>
          <span className="font-mono">{formatTime(message.createdAt)}</span>
        </div>
        {isDeleted ? (
          <div className="text-sm italic text-[var(--muted)]">deleted</div>
        ) : (
          <div className="whitespace-pre-wrap break-words text-sm leading-6">
            {message.body}
          </div>
        )}
      </div>
    </div>
  );
}

function formatTime(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 60_000) return "now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

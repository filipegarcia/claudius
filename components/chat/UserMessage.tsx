"use client";

import { useState } from "react";
import { Sparkles, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { AttachedImage, DisplayMessage } from "@/lib/client/types";
import { formatMessageTime } from "@/lib/client/format-message-time";
import { ImageLightbox } from "./ImageLightbox";

type Props = {
  message: DisplayMessage;
  onRewind?: (uuid: string) => void;
  rewinding?: boolean;
  /**
   * Scroll this message's turn to the top of the viewport so the user can
   * re-read the assistant reply that came after it. Clicking the bubble is
   * the affordance; provided by MessageList which owns the scroll container.
   */
  onJumpTo?: () => void;
  /**
   * True when this message originated from a clicked "Suggested follow-up"
   * chip rather than typed input. Renders a small badge so the provenance is
   * visible (and it's DB-backed, so it survives reloads).
   */
  suggested?: boolean;
};

export function UserMessage({ message, onRewind, rewinding, onJumpTo, suggested }: Props) {
  const text = message.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("");
  const images = message.images ?? [];
  const stamp = formatMessageTime(message.createdAt);
  // Clicking the bubble scrolls back to where the user typed it. Bail when a
  // text selection is active so "select prompt text → copy" isn't hijacked
  // into a scroll.
  const handleJump = () => {
    if ((window.getSelection()?.toString() ?? "").length > 0) return;
    onJumpTo?.();
  };
  return (
    <div className="group flex justify-end">
      <div
        className={cn(
          "max-w-[80%] rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2",
          onJumpTo && "cursor-pointer transition-colors hover:border-[var(--accent)]/40",
        )}
        onClick={onJumpTo ? handleJump : undefined}
        title={onJumpTo ? "Scroll to this message" : undefined}
      >
        {suggested && (
          <div
            className="mb-1 flex items-center justify-end gap-1 text-[10px] uppercase tracking-wide text-[var(--muted)]"
            title="Sent from a suggested follow-up"
          >
            <Sparkles className="h-3 w-3" /> Suggested
          </div>
        )}
        <InlineUserText text={text} images={images} />
        {(stamp || onRewind) && (
          <div className="mt-1 flex items-center justify-end gap-3">
            {stamp && (
              <span
                className="font-mono text-[10px] text-[var(--muted)] opacity-0 transition group-hover:opacity-100"
                title={stamp.full}
                aria-label={`Sent ${stamp.full}`}
              >
                {stamp.short}
              </span>
            )}
            {onRewind && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRewind(message.uuid);
                }}
                disabled={rewinding}
                className="flex items-center gap-1 text-[10px] text-[var(--muted)] opacity-0 transition group-hover:opacity-100 hover:text-[var(--foreground)] disabled:opacity-40"
                title="Fork session at this message"
              >
                <Undo2 className="h-3 w-3" />
                {rewinding ? "Forking…" : "Rewind here"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const TOKEN_RE = /\[Image #(\d+)\]/g;

/**
 * Splits the user text on `[Image #N]` markers and inlines a small thumbnail
 * at each token's position. Tokens whose ordinal isn't in `images` (e.g. the
 * user typed `[Image #99]` literally) render as plain text.
 */
function InlineUserText({ text, images }: { text: string; images: AttachedImage[] }) {
  const [lightbox, setLightbox] = useState<AttachedImage | null>(null);
  const byOrdinal = new Map<number, AttachedImage>();
  for (const img of images) byOrdinal.set(img.ordinal, img);

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    const ord = Number(m[1]);
    const img = byOrdinal.get(ord);
    if (!img) continue;
    if (idx > cursor) {
      nodes.push(
        <span key={key++} className="whitespace-pre-wrap">
          {text.slice(cursor, idx)}
        </span>,
      );
    }
    nodes.push(
      <span
        key={key++}
        className="mx-1 inline-flex flex-col items-center align-middle"
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setLightbox(img);
          }}
          title={`Click to zoom · Image #${ord}`}
          className="block overflow-hidden rounded-md border border-[var(--border)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`data:${img.mediaType};base64,${img.data}`}
            alt={`Image #${ord}`}
            className="h-12 w-12 object-cover transition hover:brightness-110"
          />
        </button>
        <span className="mt-0.5 font-mono text-[9px] text-[var(--muted)]">#{ord}</span>
      </span>,
    );
    cursor = idx + m[0].length;
  }
  if (cursor < text.length) {
    nodes.push(
      <span key={key++} className="whitespace-pre-wrap">
        {text.slice(cursor)}
      </span>,
    );
  }
  const content =
    nodes.length === 0 ? (
      <div className="whitespace-pre-wrap text-sm leading-6">{text}</div>
    ) : (
      <div className="text-sm leading-6">{nodes}</div>
    );
  return (
    <>
      {content}
      {lightbox && (
        <ImageLightbox
          src={`data:${lightbox.mediaType};base64,${lightbox.data}`}
          label={`Image #${lightbox.ordinal}`}
          onClose={() => setLightbox(null)}
        />
      )}
    </>
  );
}

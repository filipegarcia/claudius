"use client";

import { useState } from "react";
import { Undo2 } from "lucide-react";
import type { AttachedImage, DisplayMessage } from "@/lib/client/types";
import { formatMessageTime } from "@/lib/client/format-message-time";
import { ImageLightbox } from "./ImageLightbox";

type Props = {
  message: DisplayMessage;
  onRewind?: (uuid: string) => void;
  rewinding?: boolean;
};

export function UserMessage({ message, onRewind, rewinding }: Props) {
  const text = message.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("");
  const images = message.images ?? [];
  const stamp = formatMessageTime(message.createdAt);
  return (
    <div className="group flex justify-end">
      <div className="max-w-[80%] rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2">
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
                onClick={() => onRewind(message.uuid)}
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
          onClick={() => setLightbox(img)}
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

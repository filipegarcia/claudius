"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

type Props = {
  /** Image source — full `data:` URL is fine, or a regular URL. */
  src: string;
  /** Optional alt text / ordinal label shown in the corner. */
  label?: string;
  onClose: () => void;
};

/**
 * Click-to-zoom lightbox for thumbnails. Used by the composer's attached-image
 * chip and by inline images in sent user messages. Click anywhere outside the
 * image (or press Escape) to close. The image scales up to 92vw × 86vh and
 * preserves aspect ratio with `object-contain` so screenshots remain readable.
 *
 * Kept intentionally tiny — no zoom slider, no pan. The composer thumbnails are
 * tiny, so the first thing the user needs is "make it big enough to read";
 * advanced viewing isn't worth the surface area yet.
 *
 * Rendered through a portal to `document.body` so the `position: fixed`
 * backdrop escapes any ancestor containing block. The pinned last-user-message
 * wrapper in `MessageList` uses `backdrop-blur`, which creates a containing
 * block per CSS spec and would otherwise trap the lightbox inside the pinned
 * row (rendering it clipped / behind layout). Portaling out of that subtree is
 * what makes the message-thumbnail click actually zoom — and it future-proofs
 * every other call site at once.
 */
export function ImageLightbox({ src, label, onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // SSR guard — `document` is undefined during Next.js server rendering, and
  // the lightbox only ever mounts after a click so there's nothing to render
  // server-side anyway.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={label ? `Image preview ${label}` : "Image preview"}
    >
      {label && (
        <span className="pointer-events-none absolute left-4 top-4 rounded-md bg-black/60 px-2 py-1 font-mono text-xs text-white/80">
          {label}
        </span>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="absolute right-4 top-4 rounded-full bg-black/60 p-1.5 text-white/80 hover:bg-black/80 hover:text-white"
        aria-label="Close"
      >
        <X className="h-5 w-5" />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={label ?? ""}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[86vh] max-w-[92vw] cursor-default rounded-lg object-contain shadow-2xl"
      />
    </div>,
    document.body,
  );
}

"use client";

import { useEffect, useRef } from "react";

/**
 * Drives the dynamic favicon + document.title for the total unread count.
 *
 * Implementation notes:
 *   • Renders to an offscreen 64×64 canvas (matches `app/icon.svg`'s viewBox).
 *   • The base icon image is loaded once and cached on the hook instance —
 *     each unread change just redraws the cached image + the badge overlay.
 *   • The badge is a filled circle in the top-right, with the count clamped
 *     to `99+`. Colour follows the same accent token the workspace tiles use.
 *   • A dedicated `<link rel="icon" id="claudius-favicon-badge">` element is
 *     created on first use so we don't fight Next.js's metadata-injected
 *     icon link. When count drops to zero we restore the original via
 *     removing our element (the static `app/icon.svg` link below it is
 *     already present in the head).
 */
export function useFaviconBadge(totalUnread: number, opts?: { titleBase?: string }) {
  const titleBase = opts?.titleBase ?? "Claudius";
  const baseImgRef = useRef<HTMLImageElement | null>(null);
  const linkRef = useRef<HTMLLinkElement | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;

    // Document title — cheap, always update.
    document.title = totalUnread > 0 ? `(${formatCount(totalUnread)}) ${titleBase}` : titleBase;

    // Favicon — only act when count or base image change. We keep our own
    // <link> so Next's metadata icon link stays untouched.
    let cancelled = false;

    const apply = (dataUrl: string | null) => {
      if (cancelled) return;
      if (!dataUrl) {
        if (linkRef.current) {
          linkRef.current.remove();
          linkRef.current = null;
        }
        return;
      }
      if (!linkRef.current) {
        const link = document.createElement("link");
        link.rel = "icon";
        link.id = "claudius-favicon-badge";
        // Append last so it wins precedence over Next's static <link rel="icon">.
        document.head.appendChild(link);
        linkRef.current = link;
      }
      linkRef.current.href = dataUrl;
    };

    if (totalUnread <= 0) {
      apply(null);
      return () => {
        cancelled = true;
      };
    }

    const draw = () => {
      const img = baseImgRef.current;
      if (!img) return;
      const size = 64;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, size, size);

      // Badge circle: top-right corner, accent fill, white text.
      const label = formatCount(totalUnread);
      const wide = label.length > 1;
      const radius = wide ? 18 : 16;
      const cx = size - radius - 2;
      const cy = radius + 2;
      ctx.fillStyle = "#ef4444"; // red-500 — universally readable across themes
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.font = `bold ${wide ? 20 : 24}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx, cy + 1);

      try {
        apply(canvas.toDataURL("image/png"));
      } catch {
        // toDataURL can throw on tainted canvases — we drew from same-origin SVG so
        // this is unexpected but defensive.
      }
    };

    if (baseImgRef.current) {
      draw();
    } else {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        baseImgRef.current = img;
        if (!cancelled) draw();
      };
      img.onerror = () => {
        // Couldn't load the base icon — fall back to no overlay, title still
        // reflects the count.
      };
      img.src = "/icon.svg";
    }

    return () => {
      cancelled = true;
    };
  }, [totalUnread, titleBase]);
}

function formatCount(n: number): string {
  if (n > 99) return "99+";
  return String(n);
}

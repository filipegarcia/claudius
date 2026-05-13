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
 *   • When the count is non-zero we ALSO temporarily neutralise Next.js's
 *     metadata-injected `<link rel="icon" type="image/svg+xml">` by parking
 *     its href and disabling it. Browsers prefer the SVG link (vector,
 *     scalable, more "appropriate") over our PNG even when both declare
 *     `sizes="any"` and ours comes later in the document — so without this
 *     step the user keeps seeing the un-badged SVG and the canvas overlay
 *     is invisible despite being correctly drawn. When count drops to 0
 *     we restore the SVG link so the unread-free favicon is unchanged.
 */
export function useFaviconBadge(totalUnread: number, opts?: { titleBase?: string }) {
  const titleBase = opts?.titleBase ?? "Claudius";
  const baseImgRef = useRef<HTMLImageElement | null>(null);
  const linkRef = useRef<HTMLLinkElement | null>(null);
  /** Next's static SVG favicon link — captured so we can park its href and restore. */
  const staticLinkRef = useRef<HTMLLinkElement | null>(null);
  const staticOriginalHrefRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;

    // Document title — cheap, always update.
    document.title = totalUnread > 0 ? `(${formatCount(totalUnread)}) ${titleBase}` : titleBase;

    // Find Next's metadata-injected static icon. It carries
    // `type="image/svg+xml"` and is the one browsers prefer over our
    // dynamic PNG when both are present. We capture a reference once so
    // we can swap its href on/off as the count toggles.
    if (!staticLinkRef.current) {
      const links = document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]');
      for (const l of links) {
        if (l.id === "claudius-favicon-badge") continue;
        if (l.type && l.type.includes("svg")) {
          staticLinkRef.current = l;
          staticOriginalHrefRef.current = l.getAttribute("href");
          break;
        }
      }
    }

    let cancelled = false;

    const apply = (dataUrl: string | null) => {
      if (cancelled) return;
      if (!dataUrl) {
        // Count went to zero. Remove our badge link and restore Next's
        // static SVG so the unread-free favicon is unchanged.
        if (linkRef.current) {
          linkRef.current.remove();
          linkRef.current = null;
        }
        if (staticLinkRef.current && staticOriginalHrefRef.current) {
          staticLinkRef.current.setAttribute("href", staticOriginalHrefRef.current);
        }
        return;
      }
      if (!linkRef.current) {
        const link = document.createElement("link");
        link.rel = "icon";
        link.id = "claudius-favicon-badge";
        // Match the `sizes` attribute Next.js's metadata-injected favicon
        // uses (`sizes="any"`) so we tie on that axis.
        link.setAttribute("sizes", "any");
        link.type = "image/png";
        document.head.appendChild(link);
        linkRef.current = link;
      }
      linkRef.current.href = dataUrl;
      // Park Next's static SVG: browsers prefer SVG (vector) over our PNG
      // regardless of document order or sizes, so unless we point Next's
      // link at the same dataUrl, the user keeps seeing the un-badged
      // icon. Pointing both <link> elements at the same data URL is the
      // simplest, least-disruptive nudge — no removal, no Next metadata
      // disagreement, no reflow.
      if (staticLinkRef.current) {
        staticLinkRef.current.setAttribute("href", dataUrl);
      }
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

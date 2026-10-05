"use client";

import { useMemo } from "react";
import { Overlay } from "./Overlay";
import { qrSvgTag } from "@/lib/client/qr";

/**
 * CC 2.1.271 (H12) — `/mobile` shows a QR code so a desktop-browser user can
 * scan it with their phone to reach the Claude mobile app page, instead of
 * only opening the page in the current (desktop) browser. The QR is generated
 * client-side from the same URL the `/mobile` button opens; the link stays as
 * a fallback for anyone without a second device.
 */
export function MobileQrOverlay({ url, onClose }: { url: string; onClose: () => void }) {
  // Trusted input: `qrSvgTag` output (a pure QR library) encoding a fixed,
  // app-controlled URL — no user content — so `dangerouslySetInnerHTML` here
  // can't inject anything.
  const svg = useMemo(() => qrSvgTag(url, 5), [url]);
  return (
    <Overlay title="Get the Claude mobile app" subtitle="/mobile" onClose={onClose} width={360}>
      <div className="flex flex-col items-center gap-3 px-4 py-5">
        <p className="text-center text-xs text-[var(--muted)]">
          Scan with your phone&apos;s camera to open the Claude mobile app page.
        </p>
        <div
          data-testid="mobile-qr"
          className="rounded-lg bg-white p-3 [&>svg]:h-44 [&>svg]:w-44"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="break-all text-center text-[11px] text-[var(--accent)] underline-offset-2 hover:underline"
        >
          {url}
        </a>
      </div>
    </Overlay>
  );
}

"use client";

import { Fragment } from "react";
import { linkifyUrls } from "@/lib/client/linkify-urls";

/**
 * Render a community message body with `http(s)://…` URLs turned into
 * anchors that open in a new tab. Everything else is rendered as plain
 * text so React's default escaping protects against HTML injection.
 *
 * Used by both the channel `<Message>` row and the DM thread row — the
 * two surfaces want identical inline behaviour (linkified URLs,
 * preserved whitespace) so a shared component keeps them in sync.
 */
export function MessageBody({ body }: { body: string }) {
  const segments = linkifyUrls(body);
  if (segments.length === 0) {
    return (
      <div className="whitespace-pre-wrap break-words text-sm leading-6" />
    );
  }
  return (
    <div className="whitespace-pre-wrap break-words text-sm leading-6">
      {segments.map((seg, i) =>
        seg.type === "url" ? (
          <a
            key={i}
            href={seg.href}
            target="_blank"
            // noopener prevents the opened tab from accessing window.opener,
            // noreferrer also strips the Referer header. Both are appropriate
            // for community-posted links — we don't want the destination to
            // know which Claudius instance / page sent the user.
            rel="noopener noreferrer"
            className="text-[var(--accent)] underline-offset-2 hover:underline"
          >
            {seg.href}
          </a>
        ) : (
          <Fragment key={i}>{seg.value}</Fragment>
        ),
      )}
    </div>
  );
}

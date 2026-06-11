"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, ImageIcon, Globe } from "lucide-react";
import { ImageLightbox } from "./ImageLightbox";
import { LazyPreview } from "./LazyPreview";
import type { PreviewType } from "@/lib/shared/file-types";

type Props = {
  /** Display name (file basename). */
  fileName: string;
  /** Workspace-relative path used for API calls. */
  relPath: string;
  /** Workspace ID used in API URLs. */
  workspaceId: string;
  /** "image" or "html". */
  type: PreviewType;
};

/**
 * Inline file preview rendered below a ToolCall header.
 *
 * - Images (PNG / GIF / SVG / WEBP / …): rendered via `<img>` pointing at the
 *   workspace files API's raw serve mode (`?serve=1`). Expanded by default.
 *   Click the thumbnail to open a full-screen lightbox.
 *
 * - HTML files: rendered inside a sandboxed `<iframe src>` pointing at the
 *   path-based preview route (`/api/workspaces/:id/files/preview/…`), which
 *   allows relative CSS / images inside the HTML to load correctly because
 *   the browser resolves them against a real URL (not `about:blank`).
 *   Collapsed by default because HTML renders can be tall.
 *
 * The component is always rendered *outside* the ToolCall's JSON expand gate
 * so it stays visible without having to open the detail panel.
 */
export function FilePreview({ fileName, relPath, workspaceId, type }: Props) {
  // Images default open; HTML default collapsed.
  const [open, setOpen] = useState(type === "image");
  const [lightbox, setLightbox] = useState(false);

  const imageSrc = `/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(relPath)}&serve=1`;
  // Path-based route so relative assets inside the HTML resolve correctly.
  const htmlPreviewSrc = `/api/workspaces/${workspaceId}/files/preview/${relPath}`;

  return (
    <div className="mx-3 mb-2 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--panel)]/60">
      {/* Collapse/expand toggle row */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-[var(--panel-2)]"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-[var(--muted)]" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-[var(--muted)]" />
        )}
        {type === "image" ? (
          <ImageIcon className="h-3 w-3 shrink-0 text-[var(--accent)]" />
        ) : (
          <Globe className="h-3 w-3 shrink-0 text-[var(--accent)]" />
        )}
        <span className="min-w-0 truncate font-mono text-[10px] text-[var(--muted)]">
          {fileName}
        </span>
        <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-[var(--muted)]">
          {type === "image" ? "preview" : open ? "html preview" : "render"}
        </span>
      </button>

      {open && (
        <LazyPreview className="border-t border-[var(--border)]">
          {type === "image" ? (
            <div className="flex justify-center p-2">
              <button
                type="button"
                onClick={() => setLightbox(true)}
                title="Click to zoom"
                className="block overflow-hidden rounded border border-[var(--border)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imageSrc}
                  alt={fileName}
                  className="max-h-[40vh] max-w-full rounded object-contain transition hover:brightness-110"
                />
              </button>
            </div>
          ) : (
            <div className="p-2">
              <iframe
                src={htmlPreviewSrc}
                sandbox="allow-scripts allow-same-origin"
                title={`Preview of ${fileName}`}
                className="w-full rounded border border-[var(--border)] bg-white"
                style={{ height: "300px" }}
              />
            </div>
          )}
        </LazyPreview>
      )}

      {lightbox && (
        <ImageLightbox
          src={imageSrc}
          label={fileName}
          onClose={() => setLightbox(false)}
        />
      )}
    </div>
  );
}

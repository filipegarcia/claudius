"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, ChevronRight, ExternalLink, Globe, ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { useFileLink } from "@/lib/client/file-link-context";
import { filesHref, looksLikeFilePath, stripLineSuffix, toWorkspaceRelative } from "@/lib/client/file-paths";
import { IMAGE_EXTS, HTML_EXTS } from "@/lib/shared/file-types";
import { CodeBlock } from "./CodeBlock";
import { ImageLightbox } from "./ImageLightbox";
import { LazyPreview } from "./LazyPreview";

const INLINE_CODE_CLASS = "rounded bg-[var(--panel-2)] px-1 py-0.5 font-mono text-[0.85em]";

/**
 * Inline single-backtick code. When the span looks like a project file path
 * and we have workspace context, render it as a link to the in-app Files
 * browser — displayed as the plain path, just clickable. Otherwise it's an
 * ordinary `<code>` chip (byte-identical to the previous behaviour).
 */
function InlineCode({ children, rest }: { children?: ReactNode; rest: Record<string, unknown> }) {
  const fileLink = useFileLink();
  const text = String(children ?? "");
  const rel =
    fileLink && looksLikeFilePath(text)
      ? toWorkspaceRelative(stripLineSuffix(text), fileLink.cwd)
      : null;
  if (rel && fileLink) {
    return (
      <Link
        href={filesHref(fileLink.workspaceId, rel)}
        title="Open in Files"
        className={cn(INLINE_CODE_CLASS, "text-[var(--accent)] underline-offset-2 hover:underline")}
      >
        {children}
      </Link>
    );
  }
  return (
    <code className={INLINE_CODE_CLASS} {...rest}>
      {children}
    </code>
  );
}

const LINK_CLASS = "text-[var(--accent)] underline-offset-2 hover:underline";

/**
 * Markdown anchor renderer. Two branches:
 *
 *  1. The href looks like a project file path AND resolves inside the active
 *     workspace → route through `/<workspaceId>/files?path=…`, same-tab, as a
 *     normal Next route. Critically, this catches `[…](site/og.png)` (and
 *     `[![](path)](path)` linked-image shapes) that would otherwise resolve
 *     RELATIVE to the current `/<workspaceId>/…` URL and, with `target="_blank"`,
 *     open in a fresh Claudius window where the path matches no route — the
 *     classic "I clicked the image and got a 404 inside a new Claudius window"
 *     bug, since Electron's window-open handler treats same-origin URLs as
 *     `internal-allow` and re-loads the whole app for them.
 *
 *  2. Anything else (real http(s) URLs, anchors, mailto:, paths outside the
 *     workspace, no workspace context) → external `<a target="_blank">`,
 *     matching the previous behaviour. Electron's link-target handler then
 *     decides external-browser vs. in-app viewer based on the user setting.
 */
function MarkdownLink({
  href,
  children,
}: {
  href: string | undefined;
  children?: ReactNode;
}) {
  const fileLink = useFileLink();
  const raw = typeof href === "string" ? href.trim() : "";
  const stripped = raw ? stripLineSuffix(raw) : "";
  const rel =
    fileLink && stripped && looksLikeFilePath(stripped)
      ? toWorkspaceRelative(stripped, fileLink.cwd)
      : null;
  if (rel && fileLink) {
    return (
      <Link href={filesHref(fileLink.workspaceId, rel)} className={LINK_CLASS}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
      {children}
    </a>
  );
}

/**
 * Card-style file preview renderer for Markdown `![alt](src)` nodes.
 *
 * Handles two file kinds detected from the extension:
 *  - **Image** (png, svg, gif, webp, …): expanded by default, click-to-zoom lightbox.
 *  - **HTML** (html, htm): collapsed by default, lazy-fetched sandboxed iframe.
 *
 * Local workspace paths are rewritten to the files API (`?serve=1` for images,
 * plain text endpoint for HTML). External URLs render as-is with the same card.
 */
function MarkdownFilePreview({ src, alt }: { src?: string; alt?: string }) {
  const fileLink = useFileLink();
  const raw = typeof src === "string" ? src.trim() : "";
  const stripped = raw ? stripLineSuffix(raw) : "";
  const ext = stripped.split(".").pop()?.toLowerCase() ?? "";
  const isImage = IMAGE_EXTS.has(ext);
  const isHtml = HTML_EXTS.has(ext);

  // Images expand by default; HTML collapses (renders can be tall).
  const [open, setOpen] = useState(isImage);
  const [lightbox, setLightbox] = useState(false);

  // Resolve workspace-relative paths.
  const rel =
    fileLink && stripped && looksLikeFilePath(stripped)
      ? toWorkspaceRelative(stripped, fileLink.cwd)
      : null;
  const isLocal = !!(rel && fileLink && (isImage || isHtml));

  // Image: binary serve endpoint. HTML: path-based preview route so relative
  // assets (CSS, images) inside the file resolve correctly via browser URL logic.
  const imageSrc =
    isLocal && isImage
      ? `/api/workspaces/${fileLink!.workspaceId}/files?path=${encodeURIComponent(rel!)}&serve=1`
      : raw;
  const htmlPreviewSrc =
    isLocal && isHtml
      ? `/api/workspaces/${fileLink!.workspaceId}/files/preview/${rel}`
      : null;

  if (!stripped) return null;

  const fileName = (rel || stripped).split("/").pop() || alt || stripped;
  const filesUrl = isLocal ? filesHref(fileLink!.workspaceId, rel!) : null;
  const FileIcon = isHtml ? Globe : ImageIcon;

  return (
    <span className="my-2 block overflow-hidden rounded-md border border-[var(--border)] bg-[var(--panel)]/60">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <span className="flex w-full items-center gap-2 px-2 py-1 text-[11px]">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex shrink-0 items-center text-[var(--muted)] hover:text-[var(--foreground)]"
          title={open ? "Collapse preview" : "Expand preview"}
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
        <FileIcon className="h-3 w-3 shrink-0 text-[var(--accent)]" />
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--muted)]">
          {fileName}
        </span>
        {filesUrl && (
          <Link
            href={filesUrl}
            onClick={(e) => e.stopPropagation()}
            className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--accent)] hover:bg-[var(--panel-2)] hover:underline"
          >
            <ExternalLink className="h-2.5 w-2.5" />
            Open file
          </Link>
        )}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
        >
          {open ? "Collapse" : "Preview"}
        </button>
      </span>

      {/* ── Body ───────────────────────────────────────────────────── */}
      {open && (
        <LazyPreview as="span" className="block border-t border-[var(--border)] p-2">
          {isHtml ? (
            htmlPreviewSrc ? (
              <iframe
                src={htmlPreviewSrc}
                sandbox="allow-scripts allow-same-origin"
                title={`Preview of ${fileName}`}
                className="h-[300px] w-full rounded border border-[var(--border)] bg-white"
              />
            ) : (
              <span className="block px-1 py-1 text-[11px] text-[var(--muted)]">
                HTML preview only available for local workspace files.
              </span>
            )
          ) : (
            <button
              type="button"
              title="Click to zoom"
              onClick={() => setLightbox(true)}
              className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageSrc}
                alt={alt ?? fileName}
                className="max-h-[45vh] max-w-full cursor-zoom-in rounded object-contain transition hover:brightness-110"
              />
            </button>
          )}
        </LazyPreview>
      )}

      {lightbox && (
        <ImageLightbox src={imageSrc} label={alt || fileName} onClose={() => setLightbox(false)} />
      )}
    </span>
  );
}

const components: Components = {
  code(props) {
    const { className, children, ...rest } = props;
    const match = /language-([\w+-]+)/.exec(className || "");
    const inline = !(props as { node?: { tagName?: string } }).node || !String(children).includes("\n");
    if (!match && inline) {
      return <InlineCode rest={rest}>{children}</InlineCode>;
    }
    const code = String(children).replace(/\n$/, "");
    return <CodeBlock code={code} lang={match?.[1]} />;
  },
  pre({ children }) {
    return <>{children}</>;
  },
  a({ href, children }) {
    return <MarkdownLink href={href}>{children}</MarkdownLink>;
  },
  img({ src, alt }) {
    return <MarkdownFilePreview src={typeof src === "string" ? src : undefined} alt={alt} />;
  },
  ul({ children }) {
    return <ul className="my-2 list-disc pl-5">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="my-2 list-decimal pl-5">{children}</ol>;
  },
  // Headings and the table use em-relative sizes (rather than Tailwind's
  // fixed text-xs/text-base/text-lg/text-xl) so they scale with the parent
  // `text-[length:var(--chat-text)]` on the chat surface — otherwise the
  // user's Settings → Chat size slider grows the body text but leaves these
  // children at a fixed pixel size, which reads as "boxes that didn't
  // update". The ratios preserve the original look at the default chat-text
  // (14px / text-sm): 12/14, 16/14, 18/14, 20/14.
  h1: ({ children }) => <h1 className="my-3 text-[1.43em] font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="my-3 text-[1.29em] font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="my-2 text-[1.14em] font-semibold">{children}</h3>,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded border border-[var(--border)] scroll-thin">
      <table className="w-full border-collapse text-[0.86em]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-left">{children}</th>,
  td: ({ children }) => <td className="border-b border-[var(--border)] px-2 py-1">{children}</td>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-[var(--accent)]/60 pl-3 text-[var(--muted)]">
      {children}
    </blockquote>
  ),
};

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  );
}

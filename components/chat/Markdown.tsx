"use client";

import { Component, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { ChevronDown, ChevronRight, ExternalLink, Globe, ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { useFileLink } from "@/lib/client/file-link-context";
import { filesHref, isLocalFileRef, looksLikeFilePath, normalizeLocalPath, stripLineSuffix, toWorkspaceRelative } from "@/lib/client/file-paths";
import { IMAGE_EXTS, HTML_EXTS } from "@/lib/shared/file-types";
import { isMarkdownTooDeep } from "@/lib/shared/markdown-nesting";
import { CodeBlock } from "./CodeBlock";
import { ImageLightbox } from "./ImageLightbox";
import { LazyPreview } from "./LazyPreview";

const INLINE_CODE_CLASS = "rounded bg-[var(--panel-2)] px-1 py-0.5 font-mono text-[0.85em]";

/**
 * CC 2.1.282 (F3) — the prose-width cap. `--prose-max-width` is set on the
 * chat area from the `maxProseWidth` setting (see `useProseMaxWidth`); unset it
 * computes to `none`, so default rendering is unchanged. `me-auto` keeps a
 * capped block aligned to its own writing direction (RTL blocks sit on the
 * right). Applied to prose blocks only — tables and code keep full width.
 */
const PROSE_CAP = "max-w-[var(--prose-max-width)] me-auto";

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
        // CC 2.1.216 (F2) — inline code/paths are LTR; pin direction so a
        // code span inside an RTL (Arabic/Hebrew/Persian) sentence keeps its
        // punctuation order (the `dir` attribute also applies the UA's
        // `unicode-bidi: isolate`, which is what stops the reordering).
        dir="ltr"
        className={cn(INLINE_CODE_CLASS, "text-[var(--accent)] underline-offset-2 hover:underline")}
      >
        {children}
      </Link>
    );
  }
  return (
    <code dir="ltr" className={INLINE_CODE_CLASS} {...rest}>
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
  // CC 2.1.296 — a `file://` / `C:\…` href that does NOT resolve inside the
  // workspace is never handed to the OS: Electron's window-open handler
  // would pass it to `shell.openExternal`, which launches the file. Render
  // the link text plainly instead (react-markdown used to strip these hrefs
  // to "" anyway — see `chatUrlTransform`).
  if (isLocalFileRef(raw)) {
    return (
      <span data-testid="markdown-local-link-outside" title={`${normalizeLocalPath(raw)} — outside this workspace, not linked`}>
        {children}
      </span>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
      {children}
    </a>
  );
}

/**
 * CC 2.1.296 ([VSCode] "chat links written as a full Windows path, such as
 * C:\repo\file.ts or file:///C:/repo/file.ts, not opening the file") —
 * react-markdown's default transform reads `C:` and `file:` as unsafe
 * protocols and empties the href, so `MarkdownLink` never saw the path.
 * Keep those two local-file forms on `<a href>` only — `MarkdownLink` then
 * routes in-workspace ones to the Files browser and renders the rest as plain
 * text. Every other URL (incl. `javascript:`) still goes through the default
 * sanitiser, and image `src`s are untouched.
 */
const chatUrlTransform: UrlTransform = (url, key, node) =>
  key === "href" && node.tagName === "a" && isLocalFileRef(url) ? url : defaultUrlTransform(url);

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

  // Absolute image path that is NOT under the workspace (typically a
  // screenshot the agent wrote to /tmp). The browser would otherwise request
  // `http://host/tmp/x.png` and 404; route it through the temp-dir image
  // endpoint instead, which decides server-side whether the location is
  // allowed.
  const isAbsOutsideImage =
    !rel && isImage && stripped.startsWith("/") && looksLikeFilePath(stripped);

  // Image: binary serve endpoint. HTML: path-based preview route so relative
  // assets (CSS, images) inside the file resolve correctly via browser URL logic.
  const imageSrc =
    isLocal && isImage
      ? `/api/workspaces/${fileLink!.workspaceId}/files?path=${encodeURIComponent(rel!)}&serve=1`
      : isAbsOutsideImage
        ? `/api/local-image?path=${encodeURIComponent(stripped)}`
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

/**
 * The `code` renderer needs to know whether the surrounding `Markdown` call
 * allows the `!`-mode Execute button (see `CodeBlock`'s `allowExecute` doc
 * comment) — built per-render via `componentsFor` rather than as a single
 * module-level object, so each `<Markdown>` call site controls it.
 */
function makeCodeComponent(allowExecute: boolean): Components["code"] {
  return function CodeRenderer(props) {
    const { className, children, ...rest } = props;
    const match = /language-([\w+-]+)/.exec(className || "");
    const inline = !(props as { node?: { tagName?: string } }).node || !String(children).includes("\n");
    if (!match && inline) {
      return <InlineCode rest={rest}>{children}</InlineCode>;
    }
    const code = String(children).replace(/\n$/, "");
    return <CodeBlock code={code} lang={match?.[1]} allowExecute={allowExecute} />;
  };
}

const baseComponents: Omit<Components, "code"> = {
  pre({ children }) {
    return <>{children}</>;
  },
  a({ href, children }) {
    return <MarkdownLink href={href}>{children}</MarkdownLink>;
  },
  img({ src, alt }) {
    return <MarkdownFilePreview src={typeof src === "string" ? src : undefined} alt={alt} />;
  },
  // CC 2.1.216 (F2) — `dir="auto"` lets each block pick its own direction from
  // its first strong character, and `ps-5`/`ps-…` (logical start-padding) keeps
  // the list marker padded on the correct side in RTL (plain `pl-5` would leave
  // an RTL marker flush against the unpadded right edge).
  // CC 2.1.282 (F3) — `PROSE_CAP` caps each prose block's width to the
  // `--prose-max-width` setting (unset → `none`, i.e. the full chat column).
  // `me-auto` (logical margin-inline-end) keeps a capped block aligned to its
  // own direction, so an RTL block (F2) sits on the right rather than being
  // left-placed by the LTR parent. Tables and code blocks deliberately skip
  // the cap and keep full width.
  p({ children }) {
    return (
      <p dir="auto" className={PROSE_CAP}>
        {children}
      </p>
    );
  },
  ul({ children }) {
    return (
      <ul dir="auto" className={cn("my-2 list-disc ps-5", PROSE_CAP)}>
        {children}
      </ul>
    );
  },
  ol({ children, start, type }) {
    // CC 2.1.274/2.1.281 — honor the list's `start` (and `type`) so a list that
    // begins at `3.` renders 3./4./5. (not renumbered to 1./2./3.), and a list
    // resuming after a code block keeps its number. Dropping `start` (the old
    // behavior) silently rewrote the user's own typed numbers.
    return (
      <ol dir="auto" start={start} type={type} className={cn("my-2 list-decimal ps-5", PROSE_CAP)}>
        {children}
      </ol>
    );
  },
  // Headings and the table use em-relative sizes (rather than Tailwind's
  // fixed text-xs/text-base/text-lg/text-xl) so they scale with the parent
  // `text-[length:var(--chat-text)]` on the chat surface — otherwise the
  // user's Settings → Chat size slider grows the body text but leaves these
  // children at a fixed pixel size, which reads as "boxes that didn't
  // update". The ratios preserve the original look at the default chat-text
  // (14px / text-sm): 12/14, 16/14, 18/14, 20/14.
  h1: ({ children }) => <h1 dir="auto" className={cn("my-3 text-[1.43em] font-semibold", PROSE_CAP)}>{children}</h1>,
  h2: ({ children }) => <h2 dir="auto" className={cn("my-3 text-[1.29em] font-semibold", PROSE_CAP)}>{children}</h2>,
  h3: ({ children }) => <h3 dir="auto" className={cn("my-2 text-[1.14em] font-semibold", PROSE_CAP)}>{children}</h3>,
  // CC 2.1.216 (F2) + 2.1.282 (F3) — h4–h6 had no renderer, so they missed
  // both dir="auto" and the prose cap; give them the same treatment (sized at
  // the body text, matching Markdown's default de-emphasis of deep headings).
  h4: ({ children }) => <h4 dir="auto" className={cn("my-2 font-semibold", PROSE_CAP)}>{children}</h4>,
  h5: ({ children }) => <h5 dir="auto" className={cn("my-2 font-semibold", PROSE_CAP)}>{children}</h5>,
  h6: ({ children }) => <h6 dir="auto" className={cn("my-2 font-semibold text-[var(--muted)]", PROSE_CAP)}>{children}</h6>,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded border border-[var(--border)] scroll-thin">
      <table className="w-full border-collapse text-[0.86em]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th dir="auto" className="border-b border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-start">{children}</th>,
  td: ({ children }) => <td dir="auto" className="border-b border-[var(--border)] px-2 py-1">{children}</td>,
  blockquote: ({ children }) => (
    <blockquote dir="auto" className={cn("my-2 border-s-2 border-[var(--accent)]/60 ps-3 text-[var(--muted)]", PROSE_CAP)}>
      {children}
    </blockquote>
  ),
};

/**
 * The text a bubble shows when it can't go through `react-markdown`: the raw
 * markdown, line breaks kept, plus a one-line note saying why it isn't
 * formatted. Nothing is dropped — only the formatting.
 */
function PlainMarkdownFallback({ text, note }: { text: string; note: string }) {
  return (
    <div data-testid="markdown-plain-fallback" className={PROSE_CAP}>
      <div dir="auto" className="whitespace-pre-wrap break-words">
        {text}
      </div>
      <div className="mt-1 text-[0.79em] italic text-[var(--muted)]">{note}</div>
    </div>
  );
}

type BoundaryProps = { text: string; children: ReactNode };
type BoundaryState = { failed: boolean; text: string };

/**
 * CC 2.1.290 parity — the depth pre-scan in `Markdown` catches the known
 * crash (deeply nested lists/quotes), and this boundary catches anything else
 * that throws inside `react-markdown`. Without it a single bad bubble
 * unmounts the whole chat up to `app/global-error.tsx`. It resets when the
 * text changes, so a streaming reply that briefly fails to parse formats
 * again on the next delta.
 */
class MarkdownErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false, text: this.props.text };

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.text === state.text ? null : { failed: false, text: props.text };
  }

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <PlainMarkdownFallback text={this.props.text} note="Shown as plain text: this message couldn't be formatted." />;
    }
    return this.props.children;
  }
}

export function Markdown({
  children,
  breaks,
  allowExecute = true,
}: {
  children: string;
  /**
   * Whether a fenced `!`-mode shell block may render CodeBlock's Execute
   * button. Defaults to `true`, matching every pre-existing call site
   * (`AssistantMessage`, `ToolCall`, `TaskBlock`, `PlanOverlay`,
   * `TranscriptViewer`'s assistant branch) — the button was designed for
   * model-proposed commands. Pass `false` for text whose author isn't the
   * model: `UserMessage.tsx` (the local user's own prompt, or a peer
   * session's text delivered via `SendMessage`) and `TranscriptViewer.tsx`'s
   * historic user-turn view both do. See `CodeBlock`'s `allowExecute` doc
   * comment for the concrete failure scenario this closes.
   */
  allowExecute?: boolean;
  /**
   * Render single newlines as hard line breaks (via `remark-breaks`) instead
   * of the CommonMark default of collapsing them into a space within a
   * paragraph. Assistant replies are model-generated markdown that already
   * uses blank lines between paragraphs, so the default suits them. User
   * prompts (Claude Code 2.1.234 parity — `UserMessage.tsx`) are plain text
   * the user typed expecting every line break preserved, exactly like the
   * `whitespace-pre-wrap` rendering this replaced — set `breaks` there so a
   * multi-line prompt without blank lines doesn't get visually squashed into
   * one paragraph.
   */
  breaks?: boolean;
}) {
  // Memoized on `allowExecute` (not recreated every render) so ReactMarkdown
  // sees a stable `components.code` identity across re-renders with the same
  // flag — matches the pre-existing single-static-object behavior for every
  // caller that doesn't touch `allowExecute` at all (the default `true`
  // resolves to one memoized object per component instance, same as before).
  const componentsForRender = useMemo<Components>(
    () => ({ ...baseComponents, code: makeCodeComponent(allowExecute) }),
    [allowExecute],
  );
  // CC 2.1.290 — a linear pre-scan, memoized on the text because a streaming
  // bubble re-renders on every delta. Past the cap, the parser would overflow
  // the stack (quotes) or stall the tab (lists), so render plain text instead.
  const tooDeep = useMemo(() => isMarkdownTooDeep(children), [children]);
  if (tooDeep) {
    return (
      <PlainMarkdownFallback
        text={children}
        note="Shown as plain text: this message nests lists or quotes too deeply to format."
      />
    );
  }
  return (
    <MarkdownErrorBoundary text={children}>
      <ReactMarkdown
        remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
        components={componentsForRender}
        urlTransform={chatUrlTransform}
      >
        {children}
      </ReactMarkdown>
    </MarkdownErrorBoundary>
  );
}

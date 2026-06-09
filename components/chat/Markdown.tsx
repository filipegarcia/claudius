"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils/cn";
import { useFileLink } from "@/lib/client/file-link-context";
import { filesHref, looksLikeFilePath, stripLineSuffix, toWorkspaceRelative } from "@/lib/client/file-paths";
import { CodeBlock } from "./CodeBlock";

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

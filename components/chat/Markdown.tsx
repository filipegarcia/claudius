"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";

const components: Components = {
  code(props) {
    const { className, children, ...rest } = props;
    const match = /language-([\w+-]+)/.exec(className || "");
    const inline = !(props as { node?: { tagName?: string } }).node || !String(children).includes("\n");
    if (!match && inline) {
      return (
        <code
          className="rounded bg-[var(--panel-2)] px-1 py-0.5 font-mono text-[0.85em]"
          {...rest}
        >
          {children}
        </code>
      );
    }
    const code = String(children).replace(/\n$/, "");
    return <CodeBlock code={code} lang={match?.[1]} />;
  },
  pre({ children }) {
    return <>{children}</>;
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className="text-[var(--accent)] underline-offset-2 hover:underline">
        {children}
      </a>
    );
  },
  ul({ children }) {
    return <ul className="my-2 list-disc pl-5">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="my-2 list-decimal pl-5">{children}</ol>;
  },
  h1: ({ children }) => <h1 className="my-3 text-xl font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="my-3 text-lg font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="my-2 text-base font-semibold">{children}</h3>,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded border border-[var(--border)] scroll-thin">
      <table className="w-full border-collapse text-xs">{children}</table>
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

"use client";

import { useMemo } from "react";
import { tokenizeJsonValue, type JsonTokenType } from "@/lib/shared/json-syntax";

type Props = {
  value: unknown;
  /** Lines beyond which the block folds behind a closed `<details>` toggle. Defaults to 12. */
  maxCollapsedLines?: number;
  className?: string;
};

const TOKEN_CLASS: Record<JsonTokenType, string> = {
  key: "text-sky-300",
  string: "text-emerald-300",
  number: "text-amber-300",
  boolean: "text-purple-300",
  null: "text-[var(--muted)]",
  punct: "text-[var(--foreground)]/80",
};

/**
 * Syntax-colored, real-line-break JSON rendering — CC 2.1.259/2.1.260
 * `/workflows` parity ("JSON outcomes are pretty-printed with syntax colors
 * and real line breaks, and long outcomes fold behind an expand toggle").
 * Replaces a plain `JSON.stringify(value, null, 2)` dump in a `<pre>`.
 *
 * Hand-rolled tokenizer (`lib/shared/json-syntax.ts`) rather than a
 * dependency — see the rejected-alternative note in
 * `.claudius/cc-parity/run-notes/2.1.260.md`.
 */
export function JsonBlock({ value, maxCollapsedLines = 12, className }: Props) {
  const tokens = useMemo(() => tokenizeJsonValue(value), [value]);
  const lineCount = useMemo(
    () => tokens.reduce((n, t) => n + (t.text.match(/\n/g)?.length ?? 0), 0) + 1,
    [tokens],
  );

  const pre = (
    <pre
      data-testid="json-block"
      className={
        className ??
        "max-h-72 overflow-auto rounded bg-[var(--panel-2)] p-2 font-mono text-[11px] whitespace-pre-wrap scroll-thin"
      }
    >
      {tokens.map((t, i) => (
        <span key={i} className={TOKEN_CLASS[t.type]}>
          {t.text}
        </span>
      ))}
    </pre>
  );

  if (lineCount <= maxCollapsedLines) return pre;

  return (
    <details data-testid="json-block-fold">
      <summary className="cursor-pointer text-[10px] text-[var(--muted)]">
        {lineCount} lines — click to expand
      </summary>
      <div className="mt-1">{pre}</div>
    </details>
  );
}

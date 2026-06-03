"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { highlight } from "@/lib/client/shiki";

type Props = {
  code: string;
  lang?: string;
};

export function CodeBlock({ code, lang }: Props) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    highlight(code, lang).then((h) => {
      if (!cancelled) setHtml(h);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }

  return (
    <div className="group relative my-2 overflow-hidden rounded-lg border border-[var(--border)] bg-[#0a0a0a]">
      <div className="flex h-7 items-center justify-between border-b border-[var(--border)] bg-[var(--panel-2)] px-2 text-[10px] uppercase tracking-wide text-[var(--muted)]">
        <span>{lang || "text"}</span>
        <button
          onClick={copy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--panel)]"
          title="Copy"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {/* Code body sized in em (0.86 ≈ 12/14 — the original text-xs vs. the
          chat surface's default text-sm body) so it scales with the user's
          Settings → Chat size slider. The header chrome above keeps its
          fixed pixel sizes — those are UI controls, not content. */}
      {html ? (
        <div
          className="shiki-host overflow-auto text-[0.86em] leading-[1.5] scroll-thin"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-auto p-3 text-[0.86em] leading-[1.5] scroll-thin">{code}</pre>
      )}
    </div>
  );
}

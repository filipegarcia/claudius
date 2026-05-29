"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils/cn";

type Props = {
  /** Unified-diff text from `git diff`. */
  diff: string;
  /** True when git reported `Binary files differ`. */
  binary: boolean;
  loading?: boolean;
  error?: string | null;
};

type Line =
  | { kind: "hunk"; text: string }
  | { kind: "add"; text: string; n: number }
  | { kind: "del"; text: string; n: number }
  | { kind: "ctx"; text: string; ln: number; rn: number }
  | { kind: "meta"; text: string };

/**
 * Parse a unified diff into rows tagged for rendering. We intentionally keep
 * the @@ hunk header as its own row (collapsed gutter, neutral colour) so
 * users can see file structure jumps.
 */
function parseUnifiedDiff(diff: string): Line[] {
  const out: Line[] = [];
  if (!diff) return out;
  let leftLine = 0;
  let rightLine = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ") || raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("new file") || raw.startsWith("deleted file") || raw.startsWith("rename ") || raw.startsWith("similarity ") || raw.startsWith("Binary files ")) {
      out.push({ kind: "meta", text: raw });
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      leftLine = Number(hunk[1]);
      rightLine = Number(hunk[2]);
      out.push({ kind: "hunk", text: raw });
      continue;
    }
    if (raw.startsWith("+")) {
      out.push({ kind: "add", text: raw.slice(1), n: rightLine });
      rightLine++;
      continue;
    }
    if (raw.startsWith("-")) {
      out.push({ kind: "del", text: raw.slice(1), n: leftLine });
      leftLine++;
      continue;
    }
    if (raw.startsWith(" ")) {
      out.push({ kind: "ctx", text: raw.slice(1), ln: leftLine, rn: rightLine });
      leftLine++;
      rightLine++;
      continue;
    }
    if (raw === "") continue;
    out.push({ kind: "meta", text: raw });
  }
  return out;
}

export function DiffViewer({ diff, binary, loading, error }: Props) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff]);

  if (loading) {
    return <div className="flex flex-1 items-center justify-center text-xs text-[var(--muted)]">Loading diff…</div>;
  }
  if (error) {
    return (
      <div className="m-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
        {error}
      </div>
    );
  }
  if (binary) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-[var(--muted)]">
        Binary file — diff not shown.
      </div>
    );
  }
  if (!diff || lines.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-[var(--muted)]">
        No textual changes.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-[var(--background)] font-mono text-[12px] leading-5 scroll-thin">
      <table className="min-w-full border-collapse">
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} className={rowClass(l)}>
              <td className="select-none border-r border-[var(--border)]/40 px-2 text-right text-[10px] text-[var(--muted)]">
                {gutterLeft(l)}
              </td>
              <td className="select-none border-r border-[var(--border)]/40 px-2 text-right text-[10px] text-[var(--muted)]">
                {gutterRight(l)}
              </td>
              <td className="select-none px-2 text-[var(--muted)]">{prefix(l)}</td>
              <td className="whitespace-pre px-2">{l.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function rowClass(l: Line): string {
  switch (l.kind) {
    case "add":
      return cn("bg-emerald-500/10 text-emerald-100");
    case "del":
      return cn("bg-red-500/10 text-red-100");
    case "hunk":
      return "bg-[var(--panel-2)]/60 text-[var(--muted)]";
    case "meta":
      return "text-[var(--muted)]";
    default:
      return "";
  }
}

function gutterLeft(l: Line): string {
  if (l.kind === "del") return String(l.n);
  if (l.kind === "ctx") return String(l.ln);
  return "";
}

function gutterRight(l: Line): string {
  if (l.kind === "add") return String(l.n);
  if (l.kind === "ctx") return String(l.rn);
  return "";
}

function prefix(l: Line): string {
  if (l.kind === "add") return "+";
  if (l.kind === "del") return "−";
  if (l.kind === "hunk") return "@";
  return " ";
}

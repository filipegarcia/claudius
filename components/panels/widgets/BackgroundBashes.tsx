"use client";

import { useEffect, useState } from "react";
import { Terminal } from "lucide-react";
import type { BackgroundBash } from "@/lib/client/types";
import { fmtElapsedSec } from "./format";

export function BackgroundBashes({
  items,
  onPick,
}: {
  items: BackgroundBash[];
  onPick?: (b: BackgroundBash) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!items.length) return null;
  return (
    <ul className="space-y-1">
      {items.map((b) => {
        const elapsed = Math.max(0, (now - b.startedAt) / 1000);
        return (
          <li key={b.toolUseId}>
            <button
              type="button"
              onClick={() => onPick?.(b)}
              disabled={!onPick}
              className={`block w-full rounded-md border px-2 py-1.5 text-left transition ${
                b.killed
                  ? "border-[var(--border)] bg-[var(--panel-2)]/40 text-[var(--muted)]"
                  : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15"
              } ${onPick ? "cursor-pointer" : "cursor-default"}`}
              title="Open output viewer"
            >
              <div className="flex items-center gap-1.5 text-[11px]">
                <Terminal className="h-3 w-3" />
                <span className="ml-auto font-mono text-[10px]">
                  {b.killed ? "killed" : fmtElapsedSec(elapsed)}
                </span>
              </div>
              <div className="mt-0.5 truncate font-mono text-[10px] opacity-90">{b.command}</div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

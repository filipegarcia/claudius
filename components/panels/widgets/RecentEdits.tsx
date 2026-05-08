"use client";

import { FileEdit } from "lucide-react";
import type { RecentEdit } from "@/lib/client/types";

export function RecentEdits({ items, max = 5 }: { items: RecentEdit[]; max?: number }) {
  if (!items.length) return null;
  const visible = items.slice(0, max);
  return (
    <ul className="space-y-0.5">
      {visible.map((r) => {
        const tone = r.isError
          ? "text-red-300"
          : r.done
            ? "text-[var(--foreground)]"
            : "text-sky-300";
        const fname = r.filePath.split("/").pop() ?? r.filePath;
        return (
          <li
            key={r.toolUseId}
            className={`flex items-baseline gap-1.5 rounded px-1.5 py-0.5 text-[11px] hover:bg-[var(--panel-2)]/50 ${tone}`}
            title={r.filePath}
          >
            <FileEdit className="h-3 w-3 shrink-0 opacity-70" />
            <span className="truncate font-mono">{fname}</span>
            <span className="ml-auto text-[9px] uppercase tracking-wide opacity-60">
              {r.toolName === "MultiEdit" ? "multi" : r.toolName.toLowerCase()}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

"use client";

import { File, FileText } from "lucide-react";
import type { AssetRow } from "@/lib/server/asset-list";
import { cn } from "@/lib/utils/cn";

type Props = {
  items: AssetRow[];
  cwd: string;
  onSelect: (a: AssetRow) => void;
};

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function FileGrid({ items, cwd, onSelect }: Props) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 px-4 py-12 text-center text-sm text-[var(--muted)]">
        No files yet — paste or drop images into a chat to see them here.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {items.map((a) => {
        const isImage = a.mediaType.startsWith("image/");
        const src = `/api/assets/${a.hash}?cwd=${encodeURIComponent(a.cwd ?? cwd)}`;
        return (
          <button
            key={a.hash + (a.cwd ?? "")}
            onClick={() => onSelect(a)}
            className={cn(
              "group relative flex aspect-square flex-col overflow-hidden rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40",
              "hover:border-[var(--accent)]/40",
            )}
          >
            {isImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src}
                alt={a.hash.slice(0, 8)}
                className="h-full w-full object-cover"
                loading="lazy"
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-[var(--muted)]">
                {a.mediaType === "application/pdf" ? (
                  <FileText className="h-8 w-8" />
                ) : (
                  <File className="h-8 w-8" />
                )}
                <span className="font-mono text-[10px]">{a.mediaType}</span>
              </div>
            )}
            <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/70 to-transparent px-2 py-1 text-[10px] text-white opacity-0 group-hover:opacity-100">
              <span className="truncate font-mono">{a.hash.slice(0, 8)}</span>
              <span>{fmtSize(a.sizeBytes)}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

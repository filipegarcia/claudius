"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Brain } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-2 rounded-lg border border-[var(--border)] bg-[var(--panel)]/50">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[var(--muted)]",
          "hover:bg-[var(--panel-2)]",
        )}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Brain className="h-3.5 w-3.5" />
        <span>Thinking</span>
      </button>
      {open && (
        <div className="border-t border-[var(--border)] px-3 py-2 font-mono text-xs whitespace-pre-wrap text-[var(--muted)]">
          {text}
        </div>
      )}
    </div>
  );
}

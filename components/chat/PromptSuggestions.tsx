"use client";

import { Sparkles } from "lucide-react";

type Props = {
  suggestions: string[];
  onPick: (s: string) => void;
};

export function PromptSuggestions({ suggestions, onPick }: Props) {
  if (suggestions.length === 0) return null;
  return (
    <div className="mx-auto w-full max-w-[var(--chat-col)] px-4 pb-2">
      <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">
        <Sparkles className="h-3 w-3" /> Suggested follow-ups
      </div>
      <div className="flex flex-wrap gap-1.5">
        {suggestions.map((s, i) => (
          <button
            key={i}
            onClick={() => onPick(s)}
            className="max-w-full truncate rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1 text-xs text-[var(--foreground)] hover:border-[var(--accent)]/60 hover:bg-[var(--panel)]"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

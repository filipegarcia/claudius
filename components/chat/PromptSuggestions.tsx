"use client";

import { Sparkles } from "lucide-react";

type Props = {
  suggestions: string[];
  onPick: (s: string) => void;
};

export function PromptSuggestions({ suggestions, onPick }: Props) {
  if (suggestions.length === 0) return null;
  return (
    // Anchor this section's own font-size to the chat surface's
    // `--chat-text` so the label + chips respond to the Settings → Chat
    // size slider. This bar lives OUTSIDE the AssistantMessage wrapper
    // that already applies `text-[length:var(--chat-text)]`, so without
    // this it would stay at the default 14px regardless. Children use em
    // ratios that match the original Tailwind sizes at the 14px default
    // (10/14 for the label, 12/14 for the chip).
    <div
      className="mx-auto w-full max-w-[var(--chat-col)] px-4 pb-2"
      style={{ fontSize: "var(--chat-text)" }}
    >
      <div className="mb-1 flex items-center gap-1 text-[0.71em] uppercase tracking-wide text-[var(--muted)]">
        <Sparkles className="h-3 w-3" /> Suggested follow-ups
      </div>
      <div className="flex flex-wrap gap-1.5">
        {suggestions.map((s, i) => (
          <button
            key={i}
            onClick={() => onPick(s)}
            className="max-w-full truncate rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1 text-[0.86em] text-[var(--foreground)] hover:border-[var(--accent)]/60 hover:bg-[var(--panel)]"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

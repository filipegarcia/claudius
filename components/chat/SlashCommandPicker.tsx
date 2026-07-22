"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Wrench, Cpu, Zap, ExternalLink } from "lucide-react";
import {
  CATEGORY_LABELS,
  mergeSuggestions,
  type SdkSlashCommandInfo,
  type SlashSuggestion,
} from "@/lib/shared/slash-commands";
import { cn } from "@/lib/utils/cn";

type Props = {
  value: string;
  sdkSlashCommands: string[];
  sdkSkills: string[];
  /** Rich SDK command metadata from supportedCommands(); enriches SDK-only entries. */
  sdkRichCommands?: SdkSlashCommandInfo[];
  onSelect: (cmd: string) => void;
  onClose: () => void;
};

const HANDLER_BADGE: Record<SlashSuggestion["handler"], { label: string; tone: string; icon: typeof Wrench }> = {
  native: { label: "app", tone: "text-emerald-300 bg-emerald-500/10", icon: Zap },
  sdk: { label: "sdk", tone: "text-sky-300 bg-sky-500/10", icon: Cpu },
  external: { label: "external", tone: "text-[var(--muted)] bg-[var(--panel-2)]", icon: ExternalLink },
};

function fuzzyScore(needle: string, hay: string): number {
  if (!needle) return 0;
  const i = hay.indexOf(needle);
  if (i === 0) return 100;
  if (i > 0) return 60 - i;
  // subsequence match
  let h = 0;
  let n = 0;
  let score = 0;
  while (h < hay.length && n < needle.length) {
    if (hay[h] === needle[n]) {
      score += 1;
      n += 1;
    }
    h += 1;
  }
  return n === needle.length ? score : -1;
}

export function SlashCommandPicker({ value, sdkSlashCommands, sdkSkills, sdkRichCommands, onSelect, onClose }: Props) {
  const all = useMemo(
    () => mergeSuggestions(sdkSlashCommands, sdkSkills, sdkRichCommands),
    [sdkSlashCommands, sdkSkills, sdkRichCommands],
  );
  const filter = value.startsWith("/") ? value.slice(1).trim().toLowerCase() : "";
  const filtered = useMemo(() => {
    if (!filter) return all;
    const scored: Array<{ cmd: SlashSuggestion; score: number }> = [];
    for (const cmd of all) {
      const haystack = [cmd.name, ...(cmd.aliases ?? []), cmd.description.toLowerCase()].join(" ");
      const score = Math.max(
        fuzzyScore(filter, cmd.name),
        ...((cmd.aliases ?? []).map((a) => fuzzyScore(filter, a))),
        fuzzyScore(filter, haystack) * 0.3,
      );
      if (score > 0) scored.push({ cmd, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.cmd);
  }, [filter, all]);

  const visible = filtered.slice(0, 16);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Reset the highlight to the top whenever the visible result set
  // resizes — "store previous props" pattern keeps the setState out of
  // a useEffect body.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [lastVisibleLen, setLastVisibleLen] = useState(visible.length);
  if (lastVisibleLen !== visible.length) {
    setLastVisibleLen(visible.length);
    setHi(0);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (visible.length === 0) return;
      // Cmd/Ctrl+↑/↓ is the composer's prompt-history recall chord — leave it
      // for PromptInput even while this picker is open (a recalled slash
      // command keeps the picker mounted). Plain arrows still move the highlight.
      if ((e.metaKey || e.ctrlKey) && (e.key === "ArrowUp" || e.key === "ArrowDown")) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setHi((h) => (h + 1) % visible.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setHi((h) => (h - 1 + visible.length) % visible.length);
      } else if (e.key === "Tab" || (e.key === "Enter" && filter !== "")) {
        e.preventDefault();
        // stopPropagation is load-bearing: without it, the same keydown can
        // still reach PromptInput's onKeyDown (bubble phase) after onSelect
        // has already flipped `pickerOpen` false, tripping the Tab-indent or
        // Enter-submit fallback on the very keystroke that was meant to just
        // insert the command. Same class of bug fixed in AtMentionPicker /
        // EmojiShortcodePicker — found while wiring up the latter (CC
        // 2.1.217 parity).
        e.stopPropagation();
        onSelect(visible[hi].name);
      } else if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [hi, visible, filter, onClose, onSelect]);

  useEffect(() => {
    itemRefs.current[hi]?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  if (visible.length === 0) return null;

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-96 overflow-auto rounded-xl border border-[var(--border)] bg-[var(--panel)] p-1 shadow-2xl scroll-thin"
    >
      <div className="px-2 pb-1 pt-1.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
        Slash commands · Tab to insert
      </div>
      {visible.map((c, i) => {
        // Group by category — show a header when the category differs from
        // the previous visible item. Pure lookup (no render-time mutation).
        const prevCat = i > 0 ? visible[i - 1].category : null;
        const showHeader = !filter && c.category !== prevCat;
        const badge = HANDLER_BADGE[c.handler];
        const Icon = badge.icon;
        return (
          <div key={c.id}>
            {showHeader && (
              <div className="mt-1 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]/80">
                {CATEGORY_LABELS[c.category]}
              </div>
            )}
            <button
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(c.name);
              }}
              className={cn(
                "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left",
                i === hi ? "bg-[var(--panel-2)]" : "",
              )}
            >
              <span className={cn("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px]", badge.tone)}>
                <Icon className="h-2.5 w-2.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-sm">
                    <span className="text-[var(--accent)]">/</span>
                    {c.name}
                  </span>
                  {c.argsHint && (
                    <span className="font-mono text-[10px] text-[var(--muted)]">{c.argsHint}</span>
                  )}
                </div>
                <div className="line-clamp-1 text-[11px] text-[var(--muted)]">{c.description}</div>
              </div>
            </button>
          </div>
        );
      })}
    </div>
  );
}

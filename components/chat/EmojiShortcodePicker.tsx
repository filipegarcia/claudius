"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { filterEmojiShortcodes } from "@/lib/shared/emoji-shortcodes";
import { cn } from "@/lib/utils/cn";

type Props = {
  /** The partial shortcode name typed so far, with the leading `:` already stripped by PromptInput. */
  query: string;
  onSelect: (name: string) => void;
  onClose: () => void;
};

/**
 * `:shortcode` suggestion dropdown — same shape/keyboard contract as
 * `SlashCommandPicker` / `AtMentionPicker`, but synchronous (the shortcode
 * table is a small static in-memory map, so there's no fetch/loading state).
 */
export function EmojiShortcodePicker({ query, onSelect, onClose }: Props) {
  const visible = useMemo(() => filterEmojiShortcodes(query), [query]);
  const [hi, setHi] = useState(0);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Reset the highlight to the top whenever the visible result set resizes —
  // "store previous props" pattern, keeps the setState out of a useEffect
  // body (same as SlashCommandPicker / AtMentionPicker).
  const [lastVisibleLen, setLastVisibleLen] = useState(visible.length);
  if (lastVisibleLen !== visible.length) {
    setLastVisibleLen(visible.length);
    setHi(0);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (visible.length === 0) return;
      // Cmd/Ctrl+↑/↓ is the composer's prompt-history recall chord — let it
      // pass through rather than moving this picker's highlight.
      if ((e.metaKey || e.ctrlKey) && (e.key === "ArrowUp" || e.key === "ArrowDown")) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setHi((h) => (h + 1) % visible.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setHi((h) => (h - 1 + visible.length) % visible.length);
      } else if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        // stopPropagation is load-bearing, not just tidy: this runs on the
        // window in the CAPTURE phase, ahead of PromptInput's own onKeyDown
        // (bubble phase on the textarea). onSelect below updates React state
        // synchronously enough that, without stopping propagation, the
        // *same* keydown still reaches onKeyDown with the now-cleared
        // emojiQuery — tripping its "picker closed" Enter-submits fallback
        // and firing a spurious send/newline on the very keystroke that
        // was supposed to just insert the emoji. See PromptInput.onKeyDown's
        // `emojiQuery == null` guard for the other half of this contract.
        e.stopPropagation();
        onSelect(visible[hi].name);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [hi, visible, onClose, onSelect]);

  useEffect(() => {
    itemRefs.current[hi]?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  // No matches (e.g. a false-positive trigger like a timestamp "10:30")
  // — stay invisible rather than showing an empty panel, matching
  // AtMentionPicker's guard.
  if (visible.length === 0) return null;

  return (
    <div
      data-testid="emoji-shortcode-picker"
      className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-72 overflow-auto rounded-xl border border-[var(--border)] bg-[var(--panel)] p-1 shadow-2xl scroll-thin"
    >
      <div className="flex items-center justify-between px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">
        <span>Emoji · Tab to insert</span>
        <span>
          {visible.length} match{visible.length === 1 ? "" : "es"}
        </span>
      </div>
      {visible.map((item, i) => (
        <button
          key={item.name}
          data-testid="emoji-shortcode-option"
          ref={(el) => {
            itemRefs.current[i] = el;
          }}
          onMouseEnter={() => setHi(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(item.name);
          }}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs",
            i === hi ? "bg-[var(--panel-2)]" : "",
          )}
        >
          <span className="text-base leading-none">{item.emoji}</span>
          <span className="truncate font-mono text-[var(--muted)]">:{item.name}:</span>
        </button>
      ))}
    </div>
  );
}

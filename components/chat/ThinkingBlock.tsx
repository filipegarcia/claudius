"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Brain, Lock } from "lucide-react";
import { cn } from "@/lib/utils/cn";

type Variant = "thinking" | "redacted";

export function ThinkingBlock({
  text,
  variant = "thinking",
  streaming = false,
  defaultOpen = false,
}: {
  text: string;
  variant?: Variant;
  /**
   * True while the parent assistant message is still being streamed by
   * the SDK. Drives the empty-body copy: during streaming the envelope
   * means "deltas are en route"; after `message_stop` the same empty
   * envelope means "Claude entered thinking mode but didn't expose a
   * readable trace." Both states should still surface so the user knows
   * the model thought (or attempted to) — the previous "always say
   * Streaming the reasoning…" copy was misleading after stream stopped,
   * and outright hiding the envelope erased the signal entirely.
   */
  streaming?: boolean;
  /**
   * Initial expand state, driven by the chat verbose level — `ultra-verbose`
   * passes `true`. Re-applied when it changes so toggling the level expands /
   * collapses existing blocks, while manual toggles in between are preserved.
   */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [prevDefaultOpen, setPrevDefaultOpen] = useState(defaultOpen);
  if (prevDefaultOpen !== defaultOpen) {
    setPrevDefaultOpen(defaultOpen);
    setOpen(defaultOpen);
  }
  const isRedacted = variant === "redacted";
  const hasBody = text.trim().length > 0;

  return (
    <div
      data-testid="thinking-block"
      data-thinking-variant={variant}
      data-thinking-empty={hasBody || isRedacted ? "false" : "true"}
      data-open={open ? "1" : "0"}
      className="my-2 rounded-lg border border-[var(--border)] bg-[var(--panel)]/50"
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[var(--muted)]",
          "hover:bg-[var(--panel-2)]",
        )}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {isRedacted ? <Lock className="h-3.5 w-3.5" /> : <Brain className="h-3.5 w-3.5" />}
        <span>
          {isRedacted
            ? "Thinking (encrypted)"
            : !hasBody && !streaming
              ? "Thinking (no trace)"
              : "Thinking"}
        </span>
      </button>
      {open && (
        <div className="border-t border-[var(--border)] px-3 py-2 font-mono text-xs whitespace-pre-wrap text-[var(--muted)]">
          {isRedacted ? (
            <span className="italic">
              Reasoning was redacted by the model and is not available to the
              client. The agent still uses it internally.
            </span>
          ) : hasBody ? (
            text
          ) : streaming ? (
            <span className="italic">Streaming the reasoning…</span>
          ) : (
            // Header already says "Thinking (no trace)" — keep the body
            // tight. One short line, no explanation paragraph.
            <span className="italic">No readable trace for this turn.</span>
          )}
        </div>
      )}
    </div>
  );
}

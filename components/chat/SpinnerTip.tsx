"use client";

import { useEffect, useState } from "react";
import { Lightbulb } from "lucide-react";
import { DEFAULT_TIPS, nextTipIndex, type Tip } from "@/lib/shared/tips";

type Props = {
  /**
   * Run a slash command (with leading slash) — wired to the chat page's
   * `handleSend`. When omitted, a tip's command renders as plain text instead
   * of a clickable affordance.
   */
  onRunCommand?: (command: string) => void;
  /**
   * Tips to rotate through — normally the server-driven catalog (the `tips`
   * SSE event). Falls back to {@link DEFAULT_TIPS} while empty/undefined so the
   * spinner is never blank before the server list arrives.
   */
  tips?: Tip[];
  /** Rotation cadence in ms. */
  intervalMs?: number;
};

/**
 * The browser-side analog of the Claude Code CLI spinner tip — a single
 * rotating "did you know" line under the "Claude is working…" row. Surfaces
 * Claudius features the user may not have found yet; each tip can carry a
 * clickable slash command.
 *
 * Kept to one fixed-height line on purpose: MessageList's near-bottom
 * autoscroll watches scroll height, and a tip that wrapped or grew/shrank
 * would fight it.
 */
export function SpinnerTip({ onRunCommand, tips, intervalMs = 9000 }: Props) {
  // Prefer the server-driven catalog; fall back to the built-in defaults while
  // it's empty (initial state before the `tips` event lands).
  const list = tips && tips.length > 0 ? tips : DEFAULT_TIPS;

  // Pick a random starting tip once (lazy initializer — never re-rolls on
  // re-render). Rotation from there is deterministic via `nextTipIndex`.
  const [index, setIndex] = useState(() =>
    list.length > 0 ? Math.floor(Math.random() * list.length) : 0,
  );

  useEffect(() => {
    if (list.length <= 1) return;
    const t = setInterval(() => {
      setIndex((i) => nextTipIndex(i, list.length));
    }, intervalMs);
    return () => clearInterval(t);
  }, [list.length, intervalMs]);

  if (list.length === 0) return null;
  const tip = list[index % list.length];

  return (
    <div
      data-testid="spinner-tip"
      className="flex min-w-0 items-center gap-1.5 pl-[1.375rem] text-[11px] text-[var(--muted)]"
    >
      <Lightbulb className="h-3 w-3 shrink-0 opacity-70" />
      {/* Text truncates; the command stays pinned and fully visible so the
          affordance never gets clipped by a long tip. */}
      <span className="min-w-0 truncate">
        <span className="font-medium opacity-80">Tip:</span> {tip.text}
      </span>
      {tip.command && onRunCommand && (
        <button
          type="button"
          data-testid="spinner-tip-command"
          onClick={() => onRunCommand(`/${tip.command}`)}
          className="shrink-0 font-mono text-[var(--accent)] hover:underline"
        >
          /{tip.command}
        </button>
      )}
    </div>
  );
}

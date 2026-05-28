"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  ExternalLink,
  Loader2,
  MessageSquareHeart,
  Send,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  X,
} from "lucide-react";
import type { FeedbackSurveyEvent } from "@/lib/shared/events";

/**
 * Claudius's take on the CLI's occasional session-quality survey. The server
 * decides *when* to nudge (see `lib/server/feedback-survey.ts`) and broadcasts
 * a `feedback_survey` event; this slim, non-blocking banner — styled like the
 * UpdaterBanner — lets the user thumbs up/down + leave a short note, or ignore
 * it. It auto-fades after a while (mirrors the CLI) and a localStorage cooldown
 * keeps it from re-nudging for a week once shown.
 *
 * Submitting forwards to Anthropic AND persists locally. When the Anthropic
 * forward can't land we *say so* and point at an alternate channel rather than
 * silently dropping the feedback (graceful fail).
 */

const COOLDOWN_KEY = "claudius.feedback.lastClosedAt";
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days between nudges per browser
const AUTO_DISMISS_MS = 30_000; // CLI-style fade if the user doesn't engage
const THANKS_LINGER_MS = 3_000;
/** Where to point users when the forward to Anthropic fails. */
const FALLBACK_URL = "https://github.com/anthropics/claude-code/issues";

type Rating = "up" | "down";
type Phase = "prompt" | "submitting" | "ok" | "fail";
type SubmitResult = { ok: boolean; stored: boolean; forwarded: boolean };

function inCooldown(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(COOLDOWN_KEY);
    if (!raw) return false;
    const last = Number(raw);
    return Number.isFinite(last) && Date.now() - last < COOLDOWN_MS;
  } catch {
    return false;
  }
}

function markCooldown(): void {
  try {
    window.localStorage.setItem(COOLDOWN_KEY, String(Date.now()));
  } catch {
    // localStorage may be unavailable (private mode); the in-process server
    // throttle still prevents spamming, so this is best-effort.
  }
}

export function FeedbackBanner({
  survey,
  onSubmit,
  onDismiss,
}: {
  survey: FeedbackSurveyEvent | null;
  onSubmit: (input: { rating?: Rating; comment: string }) => Promise<SubmitResult>;
  onDismiss: () => void;
}) {
  // The nudge the banner is currently showing. Tracked separately from the
  // `survey` prop so the banner stays mounted to show the result after the
  // hook state is cleared.
  const [active, setActive] = useState<FeedbackSurveyEvent | null>(null);
  // The last nudge we closed, so render-time adoption never re-opens it.
  const [closed, setClosed] = useState<FeedbackSurveyEvent | null>(null);
  const [phase, setPhase] = useState<Phase>("prompt");
  const [rating, setRating] = useState<Rating | null>(null);
  const [comment, setComment] = useState("");
  const [result, setResult] = useState<SubmitResult | null>(null);

  // Adopt a fresh nudge during render (the React-recommended "adjust state
  // when a prop changes" pattern — no effect, so no cascading-render warning).
  // Inside the localStorage cooldown we simply never adopt, leaving the banner
  // hidden so the user isn't pestered across reloads.
  if (survey && survey !== active && survey !== closed && !inCooldown()) {
    setActive(survey);
    setPhase("prompt");
    setRating(null);
    setComment("");
    setResult(null);
  } else if (!survey && active && (phase === "prompt" || phase === "submitting")) {
    // The hook cleared the nudge out from under us — almost always a session
    // switch (`resetState`). Drop the banner silently (no cooldown write, the
    // user didn't act). We leave a "thanks"/"fail" result alone so it can fade
    // on its own timer.
    setActive(null);
  }

  const close = useCallback(() => {
    markCooldown();
    setClosed(active);
    setActive(null);
    onDismiss();
  }, [active, onDismiss]);

  // Auto-fade while still prompting (the user never engaged).
  useEffect(() => {
    if (!active || phase !== "prompt") return;
    const t = setTimeout(close, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [active, phase, close]);

  // A successful "thanks" lingers briefly then fades on its own.
  useEffect(() => {
    if (phase !== "ok") return;
    const t = setTimeout(close, THANKS_LINGER_MS);
    return () => clearTimeout(t);
  }, [phase, close]);

  const submit = useCallback(async () => {
    setPhase("submitting");
    const res = await onSubmit({ rating: rating ?? undefined, comment: comment.trim() });
    setResult(res);
    setPhase(res.ok && res.forwarded ? "ok" : "fail");
  }, [onSubmit, rating, comment]);

  if (!active) return null;

  const canSend = phase === "prompt" && (rating !== null || comment.trim().length > 0);

  // ── Result: thanks ───────────────────────────────────────────────────────
  if (phase === "ok") {
    return (
      <div
        data-pane-name="feedback-banner"
        className="flex items-center gap-2 border-b border-emerald-500/40 bg-emerald-500/10 px-4 py-1.5 text-xs"
      >
        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
        <span className="font-medium">Thanks for the feedback!</span>
        <span className="hidden text-[var(--muted)] sm:inline">— sent to Anthropic.</span>
        <button
          onClick={close}
          aria-label="Dismiss"
          className="ml-auto rounded p-0.5 text-[var(--muted)] hover:bg-emerald-500/20 hover:text-[var(--foreground)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  // ── Result: graceful fail ─────────────────────────────────────────────────
  if (phase === "fail") {
    const savedLocally = result?.stored ?? false;
    return (
      <div
        data-pane-name="feedback-banner"
        className="flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs"
      >
        <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <span className="font-medium">
          {savedLocally ? "Saved — but couldn't reach Anthropic" : "Couldn't submit your feedback"}
        </span>
        <span className="hidden text-[var(--muted)] sm:inline">
          {savedLocally
            ? "kept a local copy. You can also share it directly:"
            : "you can still share it directly:"}
        </span>
        <a
          href={FALLBACK_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex shrink-0 items-center gap-1 rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 hover:bg-amber-500/25"
        >
          Open an issue <ExternalLink className="h-3 w-3" />
        </a>
        <button
          onClick={close}
          aria-label="Dismiss"
          className="ml-auto rounded p-0.5 text-[var(--muted)] hover:bg-amber-500/20 hover:text-[var(--foreground)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  // ── Prompt / submitting ───────────────────────────────────────────────────
  return (
    <div
      data-pane-name="feedback-banner"
      className="flex items-center gap-2 border-b border-[var(--accent)]/40 bg-[var(--accent)]/10 px-4 py-1.5 text-xs text-[var(--foreground)]"
    >
      <MessageSquareHeart className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
      <span className="font-medium">How&apos;s Claude doing?</span>

      <button
        onClick={() => setRating((r) => (r === "up" ? null : "up"))}
        disabled={phase === "submitting"}
        aria-label="Thumbs up"
        aria-pressed={rating === "up"}
        className={`flex shrink-0 items-center rounded border px-1.5 py-0.5 disabled:opacity-50 ${
          rating === "up"
            ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-300"
            : "border-[var(--accent)]/40 bg-[var(--accent)]/15 hover:bg-[var(--accent)]/25"
        }`}
      >
        <ThumbsUp className="h-3 w-3" />
      </button>
      <button
        onClick={() => setRating((r) => (r === "down" ? null : "down"))}
        disabled={phase === "submitting"}
        aria-label="Thumbs down"
        aria-pressed={rating === "down"}
        className={`flex shrink-0 items-center rounded border px-1.5 py-0.5 disabled:opacity-50 ${
          rating === "down"
            ? "border-red-500/60 bg-red-500/20 text-red-300"
            : "border-[var(--accent)]/40 bg-[var(--accent)]/15 hover:bg-[var(--accent)]/25"
        }`}
      >
        <ThumbsDown className="h-3 w-3" />
      </button>

      <input
        type="text"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && canSend) void submit();
          if (e.key === "Escape") close();
        }}
        disabled={phase === "submitting"}
        placeholder="Optional: tell us more…"
        maxLength={1000}
        className="min-w-0 flex-1 rounded border border-[var(--accent)]/30 bg-transparent px-2 py-0.5 text-xs outline-none placeholder:text-[var(--muted)] focus:border-[var(--accent)]/60 disabled:opacity-50"
      />

      <button
        onClick={() => void submit()}
        disabled={!canSend}
        className="flex shrink-0 items-center gap-1 rounded border border-[var(--accent)]/40 bg-[var(--accent)]/15 px-2 py-0.5 hover:bg-[var(--accent)]/25 disabled:opacity-50"
      >
        {phase === "submitting" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Send className="h-3 w-3" />
        )}
        Send
      </button>
      <button
        onClick={close}
        disabled={phase === "submitting"}
        aria-label="Dismiss"
        className="rounded p-0.5 text-[var(--muted)] hover:bg-[var(--accent)]/20 hover:text-[var(--foreground)] disabled:opacity-50"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

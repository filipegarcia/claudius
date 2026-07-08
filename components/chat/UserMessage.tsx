"use client";

import { useState } from "react";
import { Check, Copy, Sparkles, Target, Terminal, Undo2, Users } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { AttachedImage, DisplayMessage } from "@/lib/client/types";
import { formatMessageTime } from "@/lib/client/format-message-time";
import { ImageLightbox } from "./ImageLightbox";
import { RewindFilesButton } from "./RewindFilesButton";
import { parseUserTextWithBashIO } from "@/lib/shared/bash-io";
import { type VerboseLevel, DEFAULT_VERBOSE } from "@/lib/shared/verbose";

type Props = {
  message: DisplayMessage;
  onRewind?: (uuid: string) => void;
  rewinding?: boolean;
  /**
   * Active session id. When present, a "Restore files" affordance is shown
   * that rewinds the working tree to this message via the SDK's file
   * checkpointing (distinct from `onRewind`, which forks the conversation).
   */
  sessionId?: string;
  /**
   * Scroll this message's turn to the top of the viewport so the user can
   * re-read the assistant reply that came after it. Clicking the bubble is
   * the affordance; provided by MessageList which owns the scroll container.
   */
  onJumpTo?: () => void;
  /**
   * True when this message originated from a clicked "Suggested follow-up"
   * chip rather than typed input. Renders a small badge so the provenance is
   * visible (and it's DB-backed, so it survives reloads).
   */
  suggested?: boolean;
  /**
   * True when this message was submitted as the session goal (the header goal
   * input or `/goal <text>`). Renders a "Goal" badge; DB-backed so it survives
   * reloads.
   */
  fromGoal?: boolean;
  /** Current chat verbosity level — timestamps are always shown at ultra-verbose. */
  verbose?: VerboseLevel;
};

export function UserMessage({
  message,
  onRewind,
  rewinding,
  onJumpTo,
  sessionId,
  suggested,
  fromGoal,
  verbose = DEFAULT_VERBOSE,
}: Props) {
  const text = message.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("");
  const images = message.images ?? [];
  // `!`-mode bash IO blocks ride in the user-turn text (live broadcast or
  // JSONL replay). Splitting here lets us render each block as a terminal
  // strip and only feed the remaining plain text to InlineUserText. When
  // there are no bash blocks the segment shape collapses to a single
  // text segment and the render is byte-identical to the original path.
  const segments = parseUserTextWithBashIO(text);
  const hasBash = segments.some((s) => s.kind === "bash");
  // If the user-turn is *purely* bash IO (the live `!cmd` echo case), the
  // bubble shouldn't carry the "Goal" / "Suggested" badges or the rewind
  // affordance — there's nothing to rewind to. Hide them.
  const isPureBashEcho = hasBash && segments.every((s) => s.kind === "bash");
  const stamp = formatMessageTime(message.createdAt);
  const [copied, setCopied] = useState(false);
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — clipboard unavailable (e.g. insecure context)
    }
  };
  // Clicking the bubble scrolls back to where the user typed it. Bail when a
  // text selection is active so "select prompt text → copy" isn't hijacked
  // into a scroll.
  const handleJump = () => {
    if ((window.getSelection()?.toString() ?? "").length > 0) return;
    onJumpTo?.();
  };
  return (
    <div className="group flex justify-end">
      <div
        className={cn(
          "max-w-[80%] rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2",
          onJumpTo && "cursor-pointer transition-colors hover:border-[var(--accent)]/40",
        )}
        onClick={onJumpTo ? handleJump : undefined}
        title={onJumpTo ? "Scroll to this message" : undefined}
      >
        {fromGoal && !isPureBashEcho && (
          <div
            data-testid="user-message-goal-badge"
            className="mb-1 flex items-center justify-end gap-1 text-[10px] uppercase tracking-wide text-[var(--accent)]"
            title="Sent as the session goal"
          >
            <Target className="h-3 w-3" /> Goal
          </div>
        )}
        {suggested && !fromGoal && !isPureBashEcho && (
          <div
            className="mb-1 flex items-center justify-end gap-1 text-[10px] uppercase tracking-wide text-[var(--muted)]"
            title="Sent from a suggested follow-up"
          >
            <Sparkles className="h-3 w-3" /> Suggested
          </div>
        )}
        {message.peer && !isPureBashEcho && (
          <div
            data-testid="user-message-peer-badge"
            className="mb-1 flex items-center justify-end gap-1 text-[10px] uppercase tracking-wide text-[var(--muted)]"
            title={`Sent by peer session ${message.peer.from}`}
          >
            <Users className="h-3 w-3" /> From {message.peer.name ?? message.peer.from}
          </div>
        )}
        {hasBash ? (
          <div className="flex flex-col gap-2">
            {segments.map((seg, i) =>
              seg.kind === "bash" ? (
                <BashIOBlock key={i} command={seg.command} stdout={seg.stdout} stderr={seg.stderr} />
              ) : (
                <InlineUserText key={i} text={seg.text} images={images} />
              ),
            )}
          </div>
        ) : (
          <InlineUserText text={text} images={images} />
        )}
        {(stamp || onRewind || sessionId || (text && !isPureBashEcho)) && (
          <div className="mt-1 flex items-center justify-end gap-3">
            {text && !isPureBashEcho && (
              <button
                onClick={copy}
                className="flex items-center gap-1 text-[10px] text-[var(--muted)] opacity-0 transition group-hover:opacity-100 hover:text-[var(--foreground)]"
                title="Copy message"
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? "Copied" : "Copy"}
              </button>
            )}
            {stamp && (
              <span
                className={cn(
                  "font-mono text-[10px] text-[var(--muted)] transition",
                  verbose === "ultra-verbose" ? "opacity-60" : "opacity-0 group-hover:opacity-100",
                )}
                title={stamp.full}
                aria-label={`Sent ${stamp.full}`}
              >
                {verbose === "ultra-verbose" ? stamp.shortWithSeconds : stamp.short}
              </span>
            )}
            {sessionId && !isPureBashEcho && <RewindFilesButton sessionId={sessionId} messageUuid={message.uuid} />}
            {onRewind && !isPureBashEcho && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRewind(message.uuid);
                }}
                disabled={rewinding}
                className="flex items-center gap-1 text-[10px] text-[var(--muted)] opacity-0 transition group-hover:opacity-100 hover:text-[var(--foreground)] disabled:opacity-40"
                title="Fork session at this message"
              >
                <Undo2 className="h-3 w-3" />
                {rewinding ? "Forking…" : "Rewind here"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const TOKEN_RE = /\[Image #(\d+)\]/g;

/**
 * Splits the user text on `[Image #N]` markers and inlines a small thumbnail
 * at each token's position. Tokens whose ordinal isn't in `images` (e.g. the
 * user typed `[Image #99]` literally) render as plain text.
 */
function InlineUserText({ text, images }: { text: string; images: AttachedImage[] }) {
  const [lightbox, setLightbox] = useState<AttachedImage | null>(null);
  const byOrdinal = new Map<number, AttachedImage>();
  for (const img of images) byOrdinal.set(img.ordinal, img);

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    const ord = Number(m[1]);
    const img = byOrdinal.get(ord);
    if (!img) continue;
    if (idx > cursor) {
      nodes.push(
        <span key={key++} className="whitespace-pre-wrap">
          {text.slice(cursor, idx)}
        </span>,
      );
    }
    nodes.push(
      <span
        key={key++}
        className="mx-1 inline-flex flex-col items-center align-middle"
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setLightbox(img);
          }}
          title={`Click to zoom · Image #${ord}`}
          className="block overflow-hidden rounded-md border border-[var(--border)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`data:${img.mediaType};base64,${img.data}`}
            alt={`Image #${ord}`}
            className="h-12 w-12 object-cover transition hover:brightness-110"
          />
        </button>
        <span className="mt-0.5 font-mono text-[9px] text-[var(--muted)]">#{ord}</span>
      </span>,
    );
    cursor = idx + m[0].length;
  }
  if (cursor < text.length) {
    nodes.push(
      <span key={key++} className="whitespace-pre-wrap">
        {text.slice(cursor)}
      </span>,
    );
  }
  const content =
    nodes.length === 0 ? (
      <div className="whitespace-pre-wrap text-[length:var(--chat-text)] leading-6 2xl:leading-7">{text}</div>
    ) : (
      <div className="text-[length:var(--chat-text)] leading-6 2xl:leading-7">{nodes}</div>
    );
  return (
    <>
      {content}
      {lightbox && (
        <ImageLightbox
          src={`data:${lightbox.mediaType};base64,${lightbox.data}`}
          label={`Image #${lightbox.ordinal}`}
          onClose={() => setLightbox(null)}
        />
      )}
    </>
  );
}

/**
 * Terminal-look renderer for a single `<bash-input>/<bash-stdout>/<bash-stderr>`
 * triple. Matches the look of Claude Code's `!`-mode echo: a `$` gutter on
 * the command line and dimmed output below. Click the header to expand /
 * collapse the body — useful when the next prompt's prefix carries a
 * series of fat `ls -la` outputs the user wants to skim past.
 */
function BashIOBlock({
  command,
  stdout,
  stderr,
}: {
  command: string;
  stdout: string;
  stderr: string;
}) {
  const [open, setOpen] = useState(true);
  const hasOutput = stdout.length > 0 || stderr.length > 0;
  return (
    <div
      data-testid="user-bash-io"
      className="overflow-hidden rounded-lg border border-amber-500/30 bg-[#0a0a0a]/40 text-left"
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="flex w-full items-center gap-2 border-b border-amber-500/20 bg-amber-500/5 px-2 py-1 font-mono text-[12px] text-amber-300 hover:bg-amber-500/10"
        title={open ? "Collapse output" : "Expand output"}
      >
        <Terminal className="h-3 w-3 shrink-0 opacity-70" />
        <span className="select-text whitespace-pre-wrap text-left">$ {command}</span>
      </button>
      {open && hasOutput && (
        <div className="max-h-80 overflow-auto px-2 py-1.5 scroll-thin">
          {stdout && (
            <pre className="whitespace-pre-wrap font-mono text-[12px] text-[var(--foreground)]">
              {stdout}
            </pre>
          )}
          {stderr && (
            <pre className="whitespace-pre-wrap font-mono text-[12px] text-red-400">
              {stderr}
            </pre>
          )}
        </div>
      )}
      {open && !hasOutput && (
        <div className="px-2 py-1 font-mono text-[12px] italic text-[var(--muted)]">(no output)</div>
      )}
    </div>
  );
}

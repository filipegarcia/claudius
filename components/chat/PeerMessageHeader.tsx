"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { ArrowUpRight, ChevronDown, ChevronRight, Loader2, Users } from "lucide-react";
import type { DisplayMessage } from "@/lib/client/types";
import { useWorkspaces } from "@/lib/client/useWorkspaces";
import {
  canLookUpPeer,
  peerSourceQuery,
  peerSourceTarget,
  type PeerLookup,
  type PeerSourceInfo,
  type PeerSourceResponse,
} from "@/lib/shared/peer-source";

type Peer = NonNullable<DisplayMessage["peer"]>;

/**
 * Header row of a cross-session peer message (`SDKMessageOrigin.kind ===
 * "peer"`): the collapsed one-line preview + expand toggle, an
 * "open sender session" link, and a hover tooltip explaining what a peer
 * message is (users kept reading these as their own prompts).
 *
 * The sender is resolved lazily — on first hover/focus, or on click — via
 * `/api/sessions/peer-source`, and cached briefly per message.
 *
 * The tooltip is portaled to <body> with fixed positioning: the latest user
 * message renders inside a sticky, `overflow-y-auto` pin (MessageList), which
 * would clip an absolutely-positioned popover hanging below the row.
 */
export function PeerMessageHeader({
  peer,
  label,
  preview,
  body,
  createdAt,
  expanded,
  onToggle,
}: {
  peer: Peer;
  /** Display name (falls back to the raw `from` address). */
  label: string;
  /** The collapsed `Message from <name>: <first line>` text. */
  preview: string;
  /** Decoded message body — the fallback key for finding the sender. */
  body: string;
  /** Message timestamp, ms epoch — bounds the server's pid-recycle check. */
  createdAt?: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const tooltipId = useId();
  const router = useRouter();
  const { activeId: activeWorkspaceId, select } = useWorkspaces();
  const query: PeerLookup = { from: peer.from, pid: peer.pid, msgId: peer.msgId, body, at: createdAt };
  const linkable = canLookUpPeer(query);
  const lookup = usePeerSource(peerSourceQuery(query));
  const [opening, setOpening] = useState(false);
  const { anchorRef, pos: tipPos, show: showTip, hide: hideTip } = useHoverTip<HTMLDivElement>();

  const src = lookup.state === "found" ? lookup.source : null;
  const target = src ? peerSourceTarget(src, activeWorkspaceId) : null;

  const open = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (opening) return;
    setOpening(true);
    try {
      const found = await lookup.resolve();
      const t = found ? peerSourceTarget(found, activeWorkspaceId) : null;
      if (!t || !found) return;
      if (t.kind === "transcript") {
        router.push(t.href);
        return;
      }
      if (t.workspaceId !== activeWorkspaceId) {
        // Cross-workspace: the chat's cwd is server-side state, so this is a
        // full document load (same as the workspace switcher).
        await select(t.workspaceId, `/${t.workspaceId}?session=${encodeURIComponent(t.sessionId)}`);
        return;
      }
      // Same workspace: switch tabs in place. See NotificationsProvider's
      // `jumpTo` for why this isn't a router.push.
      window.dispatchEvent(
        new CustomEvent<{ sessionId: string }>("claudius:jump-to-session", {
          detail: { sessionId: t.sessionId },
        }),
      );
    } finally {
      setOpening(false);
    }
  };

  const project = src?.cwd ? basename(src.cwd) : null;
  const senderName = src?.name ?? label;
  let status: string;
  if (!linkable) status = "This message doesn't carry enough detail to trace its sender.";
  else if (lookup.state === "idle" || lookup.state === "loading") status = "Locating the sender session…";
  else if (lookup.state === "missing") status = "Couldn't find the sender session — it may have been deleted.";
  else if (lookup.state === "error") status = "Couldn't look up the sender session.";
  else if (src?.hostedHere) status = "Running in this Claudius. The ↗ button opens it.";
  else if (src?.live) status = "Running in another process (e.g. a terminal). The ↗ button opens a read-only transcript.";
  else if (target?.kind === "chat") status = "No longer running. The ↗ button reopens it in chat.";
  else status = "No longer running. The ↗ button opens its transcript.";

  return (
    <div
      ref={anchorRef}
      className="mb-1 flex items-center justify-end gap-1"
      // An empty title stops the bubble's own "Scroll to this message"
      // native tooltip from stacking on top of the explainer.
      title=""
      onMouseEnter={() => {
        if (linkable) void lookup.resolve();
        showTip();
      }}
      onMouseLeave={hideTip}
      onFocus={() => {
        if (linkable) void lookup.resolve();
        showTip();
      }}
      onBlur={(e) => {
        // Moving focus between the toggle and ↗ stays within the row.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hideTip();
      }}
    >
      <button
        type="button"
        data-testid="user-message-peer-badge"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        aria-expanded={expanded}
        aria-describedby={tipPos ? tooltipId : undefined}
        className="flex min-w-0 items-center justify-end gap-1 text-right text-[10px] uppercase tracking-wide text-[var(--muted)] hover:text-[var(--foreground)]"
      >
        <span className="min-w-0 truncate normal-case tracking-normal">{preview}</span>
        <Users className="h-3 w-3 shrink-0" />
        {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
      </button>
      {linkable && (
        <button
          type="button"
          data-testid="user-message-peer-open"
          onClick={open}
          disabled={opening || lookup.state === "missing"}
          aria-label={`Open ${senderName}'s session`}
          aria-describedby={tipPos ? tooltipId : undefined}
          className="flex shrink-0 items-center rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--accent)] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--muted)]"
        >
          {opening ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUpRight className="h-3 w-3" />}
        </button>
      )}
      {tipPos &&
        createPortal(
          <div
            id={tooltipId}
            role="tooltip"
            data-testid="user-message-peer-tooltip"
            style={tipPos}
            className="pointer-events-none fixed z-50 w-80 max-w-[calc(100vw-16px)] rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-left text-xs text-[var(--foreground)] shadow-lg"
          >
            <div className="mb-1 flex items-center gap-1.5 font-medium">
              <Users className="h-3.5 w-3.5 text-[var(--muted)]" /> Message from another session
            </div>
            <p className="text-[var(--muted)]">
              Another Claude Code session sent this with its SendMessage tool. You didn&apos;t type it. Sessions
              use these messages to coordinate, for example to avoid editing the same files. This session&apos;s
              agent receives it as a user turn.
            </p>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
              <dt className="text-[var(--muted)]">Sender</dt>
              <dd className="truncate font-mono">{senderName}</dd>
              {project && (
                <>
                  <dt className="text-[var(--muted)]">Project</dt>
                  <dd className="truncate font-mono">{project}</dd>
                </>
              )}
              {src && (
                <>
                  <dt className="text-[var(--muted)]">Session</dt>
                  <dd className="truncate font-mono">{src.sessionId.slice(0, 8)}</dd>
                </>
              )}
            </dl>
            <p className="mt-2 text-[var(--muted)]">{status}</p>
            <p className="mt-1 text-[10px] text-[var(--muted)]">
              Click the row to {expanded ? "collapse" : "expand"} the full message.
            </p>
          </div>,
          document.body,
        )}
    </div>
  );
}

type TipPos = { right: number; top?: number; bottom?: number };

/** Hover/focus delay before the explainer shows — avoids flashing while the pointer sweeps past. */
const TIP_DELAY_MS = 300;
const TIP_GAP_PX = 6;

/** Where the tip goes for an anchor rect, or null when the anchor is off-screen. */
function placeTip(r: DOMRect): TipPos | null {
  if (r.bottom < 0 || r.top > window.innerHeight) return null;
  const right = Math.max(8, window.innerWidth - r.right);
  return r.top < window.innerHeight / 2
    ? { right, top: r.bottom + TIP_GAP_PX }
    : { right, bottom: window.innerHeight - r.top + TIP_GAP_PX };
}

/**
 * Fixed-position hover tip anchored to an element. Opens below the anchor in
 * the top half of the viewport and above it in the bottom half, right-aligned
 * with the anchor (peer rows sit on the right of the chat). Follows the anchor
 * on scroll/resize — the chat auto-scrolls while the agent streams — and
 * closes once the anchor leaves the viewport.
 */
function useHoverTip<T extends HTMLElement>() {
  const anchorRef = useRef<T>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pos, setPos] = useState<TipPos | null>(null);

  const measure = useCallback(() => {
    const el = anchorRef.current;
    setPos(el ? placeTip(el.getBoundingClientRect()) : null);
  }, []);

  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(measure, TIP_DELAY_MS);
  };

  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setPos(null);
  };

  const open = pos !== null;
  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [open, measure]);

  useEffect(() => {
    const t = timer;
    return () => {
      if (t.current) clearTimeout(t.current);
    };
  }, []);

  return { anchorRef, pos, show, hide };
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

type LookupState =
  | { state: "idle" | "loading" | "missing" | "error"; source?: undefined }
  | { state: "found"; source: PeerSourceInfo };

/**
 * Short-lived cache keyed by the lookup query, shared across every
 * `PeerMessageHeader` so re-renders, remounts and repeated hovers don't
 * refetch. The TTL keeps "running / exited" from going stale while the page
 * stays open; failed requests are evicted immediately so a later hover retries.
 */
const SOURCE_TTL_MS = 60_000;
const sourceCache = new Map<string, { at: number; promise: Promise<PeerSourceInfo | null> }>();

function fetchPeerSource(qs: string): Promise<PeerSourceInfo | null> {
  const hit = sourceCache.get(qs);
  if (hit && Date.now() - hit.at < SOURCE_TTL_MS) return hit.promise;
  const promise = fetch(`/api/sessions/peer-source?${qs}`)
    .then(async (res) => {
      if (!res.ok) throw new Error(`peer-source: ${res.status}`);
      return ((await res.json()) as PeerSourceResponse).source;
    })
    .catch((err: unknown) => {
      sourceCache.delete(qs);
      throw err;
    });
  sourceCache.set(qs, { at: Date.now(), promise });
  return promise;
}

function usePeerSource(qs: string) {
  const [lookup, setLookup] = useState<LookupState>({ state: "idle" });

  const resolve = useCallback(async (): Promise<PeerSourceInfo | null> => {
    setLookup((prev) => (prev.state === "found" ? prev : { state: "loading" }));
    try {
      const source = await fetchPeerSource(qs);
      setLookup(source ? { state: "found", source } : { state: "missing" });
      return source;
    } catch {
      setLookup({ state: "error" });
      return null;
    }
  }, [qs]);

  return { ...lookup, resolve };
}

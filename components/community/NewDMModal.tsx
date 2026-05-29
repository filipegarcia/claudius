"use client";

import { useState } from "react";
import { MessageSquarePlus, X } from "lucide-react";
import { isValidNick } from "@/lib/shared/community";
import type { UseDMs } from "@/lib/client/use-dms";

type Props = {
  dms: UseDMs;
  /** Called after a successful send. Passes the peer nick so the
   * caller can open that thread immediately. */
  onSent: (peer: string) => void;
  onClose: () => void;
};

/**
 * Minimal modal for starting a new direct conversation. Two fields
 * (nick + first message) and a send button. Closes on success; the
 * caller (CommunityChat) then flips the main column to the freshly
 * opened thread.
 */
export function NewDMModal({ dms, onSent, onClose }: Props) {
  const [peer, setPeer] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    const trimmedPeer = peer.trim();
    const trimmedBody = body.trim();
    if (!isValidNick(trimmedPeer)) {
      setErr("invalid nickname (1-20 chars, [A-Za-z0-9_-], not reserved)");
      return;
    }
    if (!trimmedBody) {
      setErr("can't send an empty message");
      return;
    }
    if (
      dms.nick &&
      trimmedPeer.toLowerCase() === dms.nick.toLowerCase()
    ) {
      setErr("can't DM yourself");
      return;
    }
    setBusy(true);
    setErr(null);
    const r = await dms.sendDm(trimmedPeer, trimmedBody);
    setBusy(false);
    if (r.ok) {
      onSent(trimmedPeer);
    } else {
      setErr(r.error);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      data-testid="community-new-dm-modal"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <MessageSquarePlus className="h-4 w-4 text-[var(--accent)]" />
            New direct message
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <label className="block text-[11px] uppercase tracking-wider text-[var(--muted)]">
          To
        </label>
        <input
          value={peer}
          onChange={(e) => setPeer(e.target.value)}
          placeholder="nickname"
          autoFocus
          className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 font-mono text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
          data-testid="community-new-dm-peer"
        />
        <label className="mt-3 block text-[11px] uppercase tracking-wider text-[var(--muted)]">
          Message
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !busy) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Say hi…"
          rows={3}
          className="scroll-thin mt-1 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
          data-testid="community-new-dm-body"
        />
        {err && <p className="mt-1 text-[10px] text-[var(--accent)]">{err}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--border)] px-3 py-1 text-xs hover:bg-[var(--panel-2)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !peer.trim() || !body.trim()}
            className="rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-medium text-[var(--background)] hover:brightness-110 disabled:opacity-40"
            data-testid="community-new-dm-send"
          >
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

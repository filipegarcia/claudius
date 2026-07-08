"use client";

import { useState } from "react";
import Link from "next/link";
import { Clock, X } from "lucide-react";
import type { TokenExpiringNudgeEvent } from "@/lib/shared/events";
import { ACCOUNTS_URL } from "@/components/chat/AuthFailedPanel";

/**
 * One-shot proactive nudge mirroring the Claude Code TUI's "your login is
 * about to expire" warning (CC 2.1.203 parity). Fired by the server when the
 * active account profile's token falls within the warning window — see
 * `TOKEN_EXPIRY_WARNING_WINDOW_MS` in `lib/server/token-expiry.ts`.
 *
 * Amber (heads-up), not red (`AuthFailedPanel` is the reactive "this just
 * failed" sibling) — the credential still works, the point is to
 * re-authenticate *before* a background session gets interrupted by it
 * lapsing mid-turn. Same CTA target (`/usage#accounts`) as `AuthFailedPanel`
 * so both remediation paths land in one place.
 */
export function TokenExpiringPanel({
  nudge,
  onDismiss,
}: {
  nudge: TokenExpiringNudgeEvent | null;
  onDismiss: () => void;
}) {
  // `Date.now()` is impure during render (react-hooks/purity) — capture it
  // once via the lazy `useState` initializer (mirrors `CostChart`'s
  // `const [today] = useState(() => Date.now())`). The banner is a one-shot
  // nudge (no live countdown needed), so a single snapshot at mount is fine.
  const [mountedAt] = useState(() => Date.now());
  if (!nudge) return null;
  const hoursLeft = Math.max(1, Math.round((nudge.expiresAt - mountedAt) / 3_600_000));
  const etaLabel = hoursLeft <= 1 ? "within the hour" : `in about ${hoursLeft}h`;
  return (
    <div
      data-pane-name="token-expiring"
      className="border-y border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-100"
    >
      <div className="mx-auto flex max-w-[var(--chat-col)] items-center gap-2">
        <Clock className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <span className="min-w-0 flex-1">
          Your login expires {etaLabel} — re-authenticate now so a background
          session doesn&rsquo;t get interrupted.
        </span>
        <Link
          href={ACCOUNTS_URL}
          onClick={onDismiss}
          className="shrink-0 rounded-md border border-amber-500/40 bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium hover:bg-amber-500/30"
          title="Open the accounts section to re-authenticate"
        >
          Open accounts
        </Link>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded p-0.5 text-[var(--muted)] hover:bg-amber-500/20 hover:text-[var(--foreground)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

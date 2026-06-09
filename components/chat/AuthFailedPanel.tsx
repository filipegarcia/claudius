"use client";

import Link from "next/link";
import { KeyRound, X } from "lucide-react";
import type { AuthFailedNudgeEvent } from "@/lib/shared/events";

/**
 * Where the Accounts section lives in Claudius's settings UI. The hash
 * anchor is matched by `id="accounts"` on the AccountsSection in
 * `app/usage/page.tsx`, which renders unconditionally (its header doesn't
 * wait on the `/api/accounts` fetch), so a deep-link from here lands on
 * the section header even before the profile list has loaded.
 */
export const ACCOUNTS_URL = "/usage#accounts";

/**
 * One-shot banner mirroring the Claude Code TUI's "Please run /login" hint
 * for HTTP 401 / authentication failures. Fired by the server when an SDK
 * `authentication_failed` signal lands — either the structured enum tag
 * on the assistant envelope, the synthetic "API Error: 401 / Failed to
 * authenticate" body, or a thrown auth failure caught by the consume loop
 * (see `lib/server/auth-failed-detector.ts` + the
 * `noteAuthFailedObservation` gate in `Session`).
 *
 * Single-route remediation — unlike the long-context credits nudge there's
 * no model-side fallback to offer, just "fix your credential." The CTA
 * deep-links into `/usage#accounts` so the user can switch profile / add
 * a new OAuth token / paste a fresh API key in one click. Live-only on the
 * wire (skipped in the SSE replay loop) so a stale banner never re-pops on
 * reload; dismiss is client-state, the server's fire-once guard prevents
 * re-emission inside one session lifetime.
 */
export function AuthFailedPanel({
  nudge,
  onDismiss,
}: {
  nudge: AuthFailedNudgeEvent | null;
  onDismiss: () => void;
}) {
  if (!nudge) return null;
  return (
    <div
      data-pane-name="auth-failed"
      className="border-y border-red-500/40 bg-red-500/10 px-4 py-1.5 text-xs text-red-100"
    >
      <div className="mx-auto flex max-w-[var(--chat-col)] items-center gap-2">
        <KeyRound className="h-3.5 w-3.5 shrink-0 text-red-400" />
        <span className="min-w-0 flex-1">
          Failed to authenticate — Anthropic rejected the active credential
          (HTTP 401). Add a new one or switch profile to keep going.
        </span>
        <Link
          href={ACCOUNTS_URL}
          onClick={onDismiss}
          className="shrink-0 rounded-md border border-red-500/40 bg-red-500/20 px-2 py-0.5 text-[11px] font-medium hover:bg-red-500/30"
          title="Open the accounts section to fix your credential"
        >
          Open accounts
        </Link>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded p-0.5 text-[var(--muted)] hover:bg-red-500/20 hover:text-[var(--foreground)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

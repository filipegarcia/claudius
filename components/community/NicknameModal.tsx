"use client";

import { useState, type FormEvent } from "react";
import { isValidNick, NICK_RE } from "@/lib/shared/community";

type Props = {
  initial?: string;
  onSubmit: (nick: string) => void;
  onCancel?: () => void;
};

/**
 * Modal shown on first visit when no nickname is set in localStorage.
 * Server-side validation re-runs against the same rules, but doing it
 * client-side too gives instant feedback. No "create account" flow —
 * IRC-style: pick a name, you're in. Nick uniqueness isn't enforced;
 * impersonation is handled by `bans` if it becomes a problem.
 */
export function NicknameModal({ initial = "", onSubmit, onCancel }: Props) {
  const [value, setValue] = useState(initial);
  const [err, setErr] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!isValidNick(v)) {
      setErr("1–20 chars · letters, numbers, _ and - · not a reserved name");
      return;
    }
    onSubmit(v);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <form
        onSubmit={submit}
        className="w-[420px] max-w-[92vw] rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5 shadow-2xl"
      >
        <h2 className="text-base font-semibold text-[var(--foreground)]">
          Pick a nickname
        </h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          This is how you&apos;ll appear in the community chat. You can change
          it later from this page&apos;s settings.
        </p>
        <input
          autoFocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (err) setErr(null);
          }}
          pattern={NICK_RE.source}
          placeholder="e.g. ada-lovelace"
          maxLength={20}
          className="mt-4 w-full rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
          data-testid="community-nick-input"
        />
        {err && <p className="mt-1 text-xs text-[var(--accent)]">{err}</p>}
        <div className="mt-4 flex justify-end gap-2">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] hover:bg-[var(--panel-2)]"
            >
              Cancel
            </button>
          )}
          <button
            type="submit"
            className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-[var(--background)] hover:brightness-110"
          >
            Join
          </button>
        </div>
      </form>
    </div>
  );
}

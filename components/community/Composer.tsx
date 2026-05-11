"use client";

import { useCallback, useState, type KeyboardEvent } from "react";
import { Send } from "lucide-react";
import { MAX_BODY_LEN } from "@/lib/shared/community";

type Props = {
  nick: string | null;
  disabled?: boolean;
  onSend: (body: string) => Promise<{ ok: boolean; error?: string }>;
};

/**
 * Textarea composer. Enter sends, Shift+Enter inserts a newline.
 * Trailing/leading whitespace is trimmed before send; empty messages
 * are no-ops. Inline error surfaces below the textarea (e.g. "rate
 * limited", "nick banned") and clears on next keystroke.
 */
export function Composer({ nick, disabled, onSend }: Props) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const send = useCallback(async () => {
    const body = value.trim();
    if (!body || busy) return;
    setBusy(true);
    setErr(null);
    const res = await onSend(body);
    setBusy(false);
    if (res.ok) {
      setValue("");
    } else {
      setErr(res.error ?? "send failed");
    }
  }, [busy, onSend, value]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void send();
      }
    },
    [send],
  );

  const placeholder = !nick
    ? "Pick a nickname to chat…"
    : disabled
      ? "Disconnected…"
      : "Say something. Enter to send, Shift+Enter for newline.";

  return (
    <div className="border-t border-[var(--border)] bg-[var(--panel)] p-3">
      <div className="flex items-end gap-2 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-2">
        <textarea
          rows={1}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (err) setErr(null);
          }}
          onKeyDown={onKeyDown}
          maxLength={MAX_BODY_LEN}
          disabled={!nick || disabled || busy}
          placeholder={placeholder}
          className="max-h-40 flex-1 resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-[var(--muted)] disabled:cursor-not-allowed"
          data-testid="community-composer"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={!nick || disabled || busy || value.trim().length === 0}
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)] text-[var(--background)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          title="Send (Enter)"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-1 flex justify-between px-1 text-[10px] text-[var(--muted)]">
        <span>{err ?? ""}</span>
        <span>
          {value.length}/{MAX_BODY_LEN}
        </span>
      </div>
    </div>
  );
}

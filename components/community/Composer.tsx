"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
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
 *
 * Autosize: the textarea grows with its content up to MAX_HEIGHT_PX,
 * then scrolls. Mirrors the chat composer's behaviour so a multi-line
 * message stays visible while the user types instead of clipping to a
 * single row. Reset to one row after each successful send.
 */
export function Composer({ nick, disabled, onSend }: Props) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Cap matches the visual `max-h-40` (Tailwind 4 → 10rem → 160px).
  // Keep these two constants in sync if either changes.
  const MAX_HEIGHT_PX = 160;

  const autosize = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    // Reset first so shrink works when the user deletes lines.
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, MAX_HEIGHT_PX) + "px";
  }, []);

  // Re-run autosize whenever `value` changes — covers programmatic
  // resets (post-send) as well as paste / IME flows that don't always
  // hit our onChange path.
  useEffect(() => {
    autosize();
  }, [value, autosize]);

  // Focus the textarea as soon as it's usable. The composer is the
  // primary action on /community, so landing on the page should drop the
  // cursor here without an extra click. Also re-runs when `disabled`
  // flips false (the SSE finally connects) or when the user picks a
  // nickname.
  useEffect(() => {
    if (!nick || disabled) return;
    taRef.current?.focus();
  }, [nick, disabled]);

  const send = useCallback(async () => {
    const body = value.trim();
    if (!body || busy) return;
    // Snapshot the sent value so we only clear the textarea if the user
    // didn't start typing the next message during the in-flight round
    // trip — preserving their keystrokes is the whole reason we keep the
    // textarea enabled while `busy` is true.
    const sent = value;
    setBusy(true);
    setErr(null);
    const res = await onSend(body);
    setBusy(false);
    if (res.ok) {
      setValue((cur) => (cur === sent ? "" : cur));
    } else {
      setErr(res.error ?? "send failed");
    }
    // Send button click pulls focus off the textarea — pull it back so
    // the user can immediately type the next message. Harmless when the
    // send was triggered by Enter (focus was already there).
    taRef.current?.focus();
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
          ref={taRef}
          rows={1}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (err) setErr(null);
          }}
          onKeyDown={onKeyDown}
          maxLength={MAX_BODY_LEN}
          disabled={!nick || disabled}
          placeholder={placeholder}
          className="max-h-40 flex-1 resize-none overflow-y-auto bg-transparent text-sm leading-6 outline-none placeholder:text-[var(--muted)] disabled:cursor-not-allowed"
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

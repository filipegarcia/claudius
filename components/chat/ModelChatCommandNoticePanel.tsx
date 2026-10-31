"use client";

import { useEffect } from "react";
import { AlertTriangle, Cpu, X } from "lucide-react";
import {
  UNKNOWN_MODEL_WINDOW_DOCS_URL,
  UNKNOWN_MODEL_WINDOW_LINK_TEXT,
} from "@/lib/shared/model-recognition";

/**
 * Transient toast shown for a model switch the user didn't drive from the
 * SessionCard picker:
 *
 *   - `reason: "chat_command"` — the `/model` slash command typed in the
 *     chat. Mirrors the Claude Code TUI's help text: "Switch between Claude
 *     models. Your pick becomes the default for new sessions."
 *   - `reason: "auto"` (SDK 0.3.251) — the server observed an automatic
 *     `fallbackModel` swap mid-turn via the `PostModelSwitch` hook
 *     (`source: "auto"` in `lib/server/session.ts`). Previously this swap
 *     was silent — the user only noticed once responses started coming back
 *     from a different model.
 *
 * Auto-dismisses after a few seconds; the user can also dismiss manually.
 */
export type ModelChatCommandNotice = {
  /** Stable across re-renders of the same notice; bumped per switch. */
  uuid: string;
  /** Full model id emitted by the SDK (e.g. "claude-fable-5"). */
  model: string;
  reason: "chat_command" | "auto";
  /**
   * CC 2.1.316 parity — "Fixed /model <id> not warning when the model isn't
   * recognized by this version and auto-compact will assume a 200K context
   * window". The engine's warning, set by the server for a `/model <id>`
   * switch to an id it can't recognize — its wording except "Update
   * Claudius" (Claudius bundles the engine) and the docs URL, which renders
   * as the "set the window" link instead of wrapped raw text (see
   * `unknownModelWarningText`). Shown as an amber second line; the notice
   * then stays until dismissed instead of fading.
   */
  unrecognizedModelWarning?: string;
};

const AUTO_DISMISS_MS = 8_000;

/** Trim "claude-" prefix and 8-digit date suffixes for compact display. */
function shortModel(m: string): string {
  return m.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

export function ModelChatCommandNoticePanel({
  notice,
  onDismiss,
}: {
  notice: ModelChatCommandNotice | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!notice || notice.unrecognizedModelWarning) return;
    const t = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [notice, onDismiss]);

  if (!notice) return null;

  return (
    <div
      data-pane-name="model-chat-command-notice"
      data-model={notice.model}
      data-reason={notice.reason}
      className="border-y border-[var(--accent)]/30 bg-[var(--accent)]/8 px-4 py-1.5 text-xs text-[var(--foreground)]"
    >
      <div className="mx-auto flex max-w-[var(--chat-col)] items-center gap-2">
        <Cpu className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
        <span className="font-medium">Switched to {shortModel(notice.model)}</span>
        <span className="hidden truncate text-[var(--muted)] sm:inline">
          {notice.reason === "auto"
            ? "· Automatic fallback (rate limit)"
            : "· Your pick becomes the default for new sessions"}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss model switch notice"
          className="ml-auto shrink-0 rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {notice.unrecognizedModelWarning && (
        <div
          data-testid="model-unrecognized-warning"
          className="mx-auto mt-1 flex max-w-[var(--chat-col)] items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-200"
        >
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-400" />
          <UnrecognizedModelWarningText text={notice.unrecognizedModelWarning} />
        </div>
      )}
    </div>
  );
}

/**
 * The warning with its trailing "set the window" turned into a link to the
 * engine's docs anchor (a `target="_blank"` anchor like the other chat
 * notice links — the desktop shell routes it per the link-target setting,
 * like ChatSurface's `openExternalUrl`). Text
 * without that phrase still gets the link, appended.
 */
function UnrecognizedModelWarningText({ text }: { text: string }) {
  const at = text.lastIndexOf(UNKNOWN_MODEL_WINDOW_LINK_TEXT);
  const link = (label: string) => (
    <a
      href={UNKNOWN_MODEL_WINDOW_DOCS_URL}
      target="_blank"
      rel="noreferrer"
      data-testid="model-unrecognized-warning-docs"
      className="underline underline-offset-2 hover:opacity-80"
    >
      {label}
    </a>
  );
  return (
    <span className="min-w-0 break-words">
      {at >= 0 ? (
        <>
          {text.slice(0, at)}
          {link(UNKNOWN_MODEL_WINDOW_LINK_TEXT)}
          {text.slice(at + UNKNOWN_MODEL_WINDOW_LINK_TEXT.length)}
        </>
      ) : (
        <>
          {text} {link("Set the window")}
        </>
      )}
    </span>
  );
}

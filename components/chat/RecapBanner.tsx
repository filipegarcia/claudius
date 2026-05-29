"use client";

import { useEffect, useRef, useState } from "react";
import { Pencil, ScrollText, Target } from "lucide-react";
import { cn } from "@/lib/utils/cn";

type Props = {
  sessionId: string | null;
  /** SDK-derived session title (custom rename, AI auto-summary, or first prompt). */
  title: string | null;
  /** Inline rename action — returns ok/error so the row can flash on failure. */
  onRename?: (newTitle: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * When true, render as a row inside a shared session-header panel (with the
   * GoalBanner) rather than a standalone banner — drops its own bottom border
   * and background so the parent panel owns the framing.
   */
  embedded?: boolean;
  /**
   * Only meaningful when `embedded`: whether a goal row renders directly below
   * this title. When true (the default) the title uses tight bottom padding so
   * it sits flush above the goal row; when false (the goal prompt is hidden and
   * no goal is set) it restores normal bottom padding so the panel isn't
   * cramped.
   */
  goalRowBelow?: boolean;
  /**
   * Restore a dismissed goal prompt. When set, the title row exposes a
   * hover-revealed target button (the goal row collapses to just this title
   * when hidden, so this is the in-context way back — alongside Settings).
   * The parent only passes this when the goal is actually hidden.
   */
  onShowGoal?: () => void;
};

const PLACEHOLDER = "Untitled session";

/**
 * Sticky strip above the message list that names the session. Sourced from the
 * SDK's session metadata (`customTitle ?? summary`), surfaced via
 * `session_title` events. Until the SDK has enough activity to summarize, the
 * strip shows "Untitled session" as a muted placeholder so the rename
 * affordance is always reachable.
 *
 * Doubles as the rename surface (double-click the title or use the hover
 * pencil) so the title only appears in one place; the StatusLine session
 * picker stays terse with just the short id.
 *
 * Despite the name, this no longer captures `/recap` output. The SDK
 * intercepts `/recap` as a local command and never produces an assistant
 * response; richer Goal/Done/Next recaps would require sending a structured
 * prompt to Claude on demand. That layer is deferred — this strip is the
 * always-on baseline.
 */
export function RecapBanner({
  sessionId,
  title,
  onRename,
  embedded,
  goalRowBelow = true,
  onShowGoal,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // Render the row even before the SDK surfaces a title so the rename
  // affordance is reachable from second one of a fresh session. The
  // session-picker chip stays out of this — it only shows the short id.
  if (!sessionId) return null;

  const canRename = Boolean(onRename);
  const hasTitle = Boolean(title && title.trim());

  function startEdit() {
    if (!canRename) return;
    setDraft(title ?? "");
    setSaveErr(null);
    setEditing(true);
  }

  async function commitEdit() {
    if (!onRename) {
      setEditing(false);
      return;
    }
    const value = draft.trim();
    // No-op when the value is unchanged or empty (treat null/empty as
    // equivalent — both mean "no custom title").
    if (!value || value === (title ?? "")) {
      setEditing(false);
      setSaveErr(null);
      return;
    }
    const r = await onRename(value);
    if (!r.ok) {
      setSaveErr(r.error);
      // Keep editing so the user can retry / fix.
      return;
    }
    setEditing(false);
    setSaveErr(null);
  }

  return (
    <div
      data-testid="recap-banner"
      className={cn(!embedded && "border-b border-[var(--border)] bg-[var(--panel-2)]/40")}
    >
      <div
        className={cn(
          "group mx-auto flex w-full max-w-[var(--chat-col)] items-center gap-2 px-4 text-xs",
          // Tight bottom padding when embedded so the title sits directly
          // above the goal row as one block — but restore normal padding when
          // the goal row is hidden so the panel doesn't look cramped.
          embedded ? (goalRowBelow ? "pt-2 pb-0.5" : "py-2") : "py-1.5",
        )}
      >
        <ScrollText
          className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]"
          aria-hidden
        />
        {editing ? (
          <>
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(false);
                  setSaveErr(null);
                }
              }}
              onBlur={() => void commitEdit()}
              placeholder={PLACEHOLDER}
              maxLength={120}
              aria-label="Session title"
              data-testid="recap-title-input"
              className={cn(
                "min-w-0 flex-1 rounded-md border border-[var(--accent)]/60 bg-[var(--panel)] px-1.5 py-0.5 text-xs",
                "outline-none focus:border-[var(--accent)]",
                saveErr && "border-red-500/60",
              )}
            />
            {saveErr && (
              <span
                className="text-[10px] text-red-300"
                data-testid="recap-title-error"
              >
                {saveErr}
              </span>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={canRename ? startEdit : undefined}
              title={
                canRename
                  ? hasTitle
                    ? "Click to rename"
                    : "Click to name this session"
                  : undefined
              }
              data-testid="recap-banner-button"
              className={cn(
                "min-w-0 flex-1 truncate text-left",
                hasTitle ? "text-[var(--foreground)]/90" : "italic text-[var(--muted)]",
                canRename ? "cursor-text" : "cursor-default",
              )}
            >
              <span data-testid="recap-banner-title">
                {hasTitle ? title : PLACEHOLDER}
              </span>
            </button>
            {canRename && (
              <button
                type="button"
                aria-label={hasTitle ? "Rename session" : "Name this session"}
                onClick={startEdit}
                className={cn(
                  "rounded p-0.5 text-[var(--muted)] transition hover:bg-[var(--panel)] hover:text-[var(--foreground)] focus:opacity-100",
                  // Pencil is always visible for the placeholder state so users
                  // realize the row is interactive; otherwise it shows on hover.
                  hasTitle ? "opacity-0 group-hover:opacity-100" : "opacity-70",
                )}
                data-testid="recap-rename-button"
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
            {onShowGoal && (
              <button
                type="button"
                onClick={onShowGoal}
                aria-label="Set a session goal"
                title="Set a session goal"
                data-testid="recap-show-goal"
                className="rounded p-0.5 text-[var(--muted)] opacity-0 transition hover:bg-[var(--panel)] hover:text-[var(--accent)] focus:opacity-100 group-hover:opacity-100"
              >
                <Target className="h-3 w-3" />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import { Check, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { ClaudiusMark } from "@/components/brand/ClaudiusMark";
import { useSplashExamples } from "@/lib/client/useSplashExamples";
import { greetingFor } from "@/lib/client/greeting";

/**
 * The empty-state hero rendered when the chat transcript has no messages.
 * Pulled out of {@link MessageList} so the edit affordances (greeting
 * name + suggestion chips) can live next to the surface they edit
 * without bloating the list component.
 *
 * Per-workspace storage: chips and the display-name override both live
 * in the per-cwd SQLite `ui_state` table (workspace scoping is implicit
 * via the per-cwd DB file). Until the user has customized them, the
 * built-in defaults render — for the name, that means falling back to
 * the active account's label (or `~/.claude.json` displayName when only
 * one account is configured).
 */
type Props = {
  /** Click handler for a chip — usually `handleSend` on the chat page. When
   *  omitted (e.g. dev preview), chips render but aren't clickable. */
  onPickExample?: (prompt: string) => void;
  /** Active workspace id — keys the fetch so switching workspaces re-reads
   *  the per-cwd dashboard. */
  activeWorkspaceId: string | null;
  /** Extra slot rendered below the chips — used by MessageList to surface
   *  init-time SystemPills under the splash. */
  belowChips?: React.ReactNode;
};

export function SplashScreen({ onPickExample, activeWorkspaceId, belowChips }: Props) {
  const {
    examples,
    customized,
    defaults,
    limits,
    displayName,
    displayNameOverride,
    displayNameFallback,
    save,
    reset,
    saving,
  } = useSplashExamples(activeWorkspaceId);

  // Edit-mode state. `draft` / `nameDraft` are working copies; we commit
  // them to the server on "Save" and discard on "Cancel". Keeping the
  // edits local until save means partial edits don't trigger an SQLite
  // write on every keystroke. Snapshots happen in `startEdit`, NOT via
  // an effect — the splash shouldn't re-sync the working copy under the
  // user's keystrokes if another tab saved mid-edit.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(examples);
  const [nameDraft, setNameDraft] = useState<string>(displayNameOverride ?? "");

  // Greeting phrase is seeded by a ~10-minute bucket of epoch time —
  // stable across tab switches and rapid refreshes within the bucket,
  // rotating once it elapses. The trade-off space:
  //   - Per-render randomness ⇒ feels jittery if the user reloads.
  //   - Per-hour seed ⇒ rapid refreshes feel "stuck on the same line".
  //   - ~10 min ⇒ a coffee break or context switch surfaces a new
  //     greeting without thrashing under quick consecutive reloads.
  // Re-running on `displayName` change is intentional: when the fetched
  // name lands AFTER the first paint, the greeting transitions from
  // "Good evening" to "Good evening, Filipe" or "The return of Filipe"
  // without flipping unrelated to the name.
  const greeting = useMemo(() => {
    const now = new Date();
    const hour = now.getHours();
    const ROTATION_MS = 10 * 60 * 1000; // 10 minutes
    const seed = Math.floor(now.getTime() / ROTATION_MS);
    return greetingFor(displayName, { hour, seed });
  }, [displayName]);

  const startEdit = () => {
    setDraft(examples);
    setNameDraft(displayNameOverride ?? "");
    setEditing(true);
  };

  const cancelEdit = () => {
    setDraft(examples);
    setNameDraft(displayNameOverride ?? "");
    setEditing(false);
  };

  const commitEdit = async () => {
    // Filter blanks before save so a row the user emptied and forgot doesn't
    // make it into storage. The server re-sanitizes too, but matching the
    // visible state to the saved state avoids a confused "where did that row
    // go?" moment.
    const cleanedExamples = draft.map((s) => s.trim()).filter((s) => s.length > 0);
    // Empty / whitespace name → null clears the override (re-falls back
    // to the account label).
    const trimmedName = nameDraft.trim();
    await save({
      examples: cleanedExamples,
      displayName: trimmedName.length > 0 ? trimmedName : null,
    });
    setEditing(false);
  };

  const updateAt = (i: number, value: string) => {
    setDraft((prev) => prev.map((s, idx) => (idx === i ? value : s)));
  };

  const removeAt = (i: number) => {
    setDraft((prev) => prev.filter((_, idx) => idx !== i));
  };

  const addRow = () => {
    if (draft.length >= limits.maxCount) return;
    setDraft((prev) => [...prev, ""]);
  };

  const resetToDefaults = async () => {
    await reset();
    setDraft(defaults);
    setNameDraft("");
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
      <ClaudiusMark color="var(--foreground)" size={96} className="mb-4 opacity-80" />
      <h1
        className="mb-6 text-3xl font-semibold tracking-tight"
        data-testid="splash-greeting"
      >
        {greeting}
      </h1>

      {editing && (
        <div className="mb-3 flex w-full max-w-md items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 px-3 py-2 text-sm focus-within:border-[var(--accent)]/60">
          <label
            htmlFor="splash-name-input"
            className="shrink-0 text-[var(--muted)]"
          >
            Your name
          </label>
          <input
            id="splash-name-input"
            type="text"
            value={nameDraft}
            maxLength={limits.nameMaxLen}
            onChange={(e) => setNameDraft(e.target.value)}
            placeholder={displayNameFallback ?? "First name"}
            className="flex-1 bg-transparent px-1 py-1 text-[var(--foreground)] outline-none placeholder:text-[var(--muted)]"
            data-testid="splash-name-field"
          />
        </div>
      )}

      <div
        data-testid="splash-examples"
        className="grid w-full max-w-5xl grid-cols-1 gap-3 text-left text-sm sm:grid-cols-2"
      >
        {editing
          ? draft.map((value, i) => (
              <EditRow
                key={i}
                index={i}
                value={value}
                maxLen={limits.maxLen}
                onChange={(v) => updateAt(i, v)}
                onRemove={() => removeAt(i)}
              />
            ))
          : examples.map((s) => (
              <button
                key={s}
                type="button"
                onClick={onPickExample ? () => onPickExample(s) : undefined}
                disabled={!onPickExample}
                title={onPickExample ? "Send as prompt" : undefined}
                className={cn(
                  "rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 px-4 py-3 text-left text-[var(--muted)] transition",
                  onPickExample
                    ? "cursor-pointer hover:border-[var(--accent)]/60 hover:bg-[var(--panel-2)]/60 hover:text-[var(--foreground)]"
                    : "cursor-default",
                )}
              >
                {s}
              </button>
            ))}

        {editing && draft.length < limits.maxCount && (
          <button
            type="button"
            onClick={addRow}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-[var(--border)] bg-transparent px-4 py-3 text-[var(--muted)] transition hover:border-[var(--accent)]/60 hover:text-[var(--foreground)]"
          >
            <Plus className="h-3.5 w-3.5" />
            Add suggestion
          </button>
        )}
      </div>

      {/* Toolbar — edit/save/cancel/reset. Sits flush under the grid so it
          doesn't compete with the chips for attention until the user looks
          for it. */}
      <div className="mt-3 flex items-center gap-2 text-[11px] text-[var(--muted)]">
        {editing ? (
          <>
            <button
              type="button"
              onClick={commitEdit}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/60 px-2 py-1 transition hover:border-[var(--accent)]/60 hover:text-[var(--foreground)] disabled:opacity-50"
              data-testid="splash-save"
            >
              <Check className="h-3 w-3" />
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-transparent px-2 py-1 transition hover:text-[var(--foreground)] disabled:opacity-50"
            >
              <X className="h-3 w-3" />
              Cancel
            </button>
            {(customized || displayNameOverride) && (
              <button
                type="button"
                onClick={resetToDefaults}
                disabled={saving}
                className="inline-flex items-center gap-1 rounded-md border border-transparent px-2 py-1 transition hover:text-[var(--foreground)] disabled:opacity-50"
                title="Restore the built-in suggestions and clear your name override"
              >
                <RotateCcw className="h-3 w-3" />
                Reset to defaults
              </button>
            )}
            <span className="ml-1 opacity-60">
              {draft.length}/{limits.maxCount}
            </span>
          </>
        ) : (
          <button
            type="button"
            onClick={startEdit}
            title="Edit dashboard"
            aria-label="Edit dashboard"
            className="inline-flex items-center justify-center rounded-md border border-transparent p-1.5 transition hover:border-[var(--border)] hover:text-[var(--foreground)]"
            data-testid="splash-edit"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {belowChips}
    </div>
  );
}

/**
 * One editable row in edit mode — a text input with a trash button. Plain
 * controlled input; the parent owns the draft array. Click the new row's
 * placeholder area or tab from a sibling to begin typing — we don't
 * programmatically focus on add (keeping the React state machine out of
 * focus management dodges the ref-during-render lint rule cleanly).
 */
function EditRow({
  index,
  value,
  maxLen,
  onChange,
  onRemove,
}: {
  index: number;
  value: string;
  maxLen: number;
  onChange: (v: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 px-3 py-1.5 focus-within:border-[var(--accent)]/60">
      <input
        type="text"
        value={value}
        maxLength={maxLen}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`Suggestion ${index + 1}`}
        className="flex-1 bg-transparent px-1 py-1.5 text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted)]"
        data-testid={`splash-input-${index}`}
      />
      <button
        type="button"
        onClick={onRemove}
        title="Remove suggestion"
        className="rounded p-1 text-[var(--muted)] transition hover:bg-[var(--panel-2)]/60 hover:text-[var(--foreground)]"
        data-testid={`splash-remove-${index}`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, CheckSquare, Minus, Pencil, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { AskAnswer, AskUserQuestionEvent } from "@/lib/shared/events";

type Props = {
  request: AskUserQuestionEvent;
  onSubmit: (answers: AskAnswer[]) => void | Promise<void>;
  /**
   * Explicit cancel — sends empty answers and the SDK treats it as decline.
   * The X button in the header is the only path that calls this.
   */
  onCancel: () => void | Promise<void>;
  /**
   * Hide the modal locally without sending a reply, leaving the request
   * pending so the user can return to it. When provided, Esc and the
   * click-outside gesture call this instead of `onCancel` so the user can
   * never lose the question by mistake. Falls back to `onCancel` if not
   * provided (backwards-compatible).
   */
  onMinimize?: () => void;
  /**
   * Resolved label of the session this question belongs to (matches the
   * SessionTabs strip). Surfaced in the header so the user can tell which
   * tab fired the question while the overlay is covering the tab strip.
   * Optional — the dev preview pages pass nothing and the chip simply hides.
   */
  sessionLabel?: string | null;
  /**
   * Render as an in-flow transcript card instead of a fixed modal overlay.
   * Inline mode drops the backdrop, click-outside dismissal, and the global
   * keyboard listener (the composer stays focusable alongside it, so grabbing
   * window keydown — Escape especially — would hijack the user's typing).
   * The option buttons are native <button>s, so Enter/Space still activate a
   * focused option; only the arrow/digit list-nav shortcuts are dropped.
   */
  inline?: boolean;
};

/**
 * Per-question working state. We hold either:
 *   - `selectedLabels`: the picked option label(s) — for single-select this
 *     is at most one entry; for multi-select it can be many.
 *   - `custom`: free-text "Other" — set when the user picks the Other row,
 *     and pushed in addition to selectedLabels.
 */
type Working = {
  selectedLabels: string[];
  custom: string;
  showOther: boolean;
};

function emptyWorking(): Working {
  return { selectedLabels: [], custom: "", showOther: false };
}

export function AskUserQuestionPrompt({
  request,
  onSubmit,
  onCancel,
  onMinimize,
  sessionLabel,
  inline = false,
}: Props) {
  // Soft dismissal — Esc / click-outside / minimize button. Falls back to
  // `onCancel` for older call sites that don't pass `onMinimize`.
  const dismiss = onMinimize ?? onCancel;
  const [active, setActive] = useState(0);
  const [working, setWorking] = useState<Working[]>(() =>
    request.questions.map(() => emptyWorking()),
  );
  const [focusedOption, setFocusedOption] = useState(0);
  const otherInputRef = useRef<HTMLTextAreaElement>(null);

  const total = request.questions.length;
  const q = request.questions[active];
  const w = working[active] ?? emptyWorking();
  const focusedOptionPreview =
    q.options[focusedOption]?.preview ?? q.options[0]?.preview ?? "";

  // Right pane mode decides what fills the column next to the options list.
  // - "preview": one of the question's options has preview HTML — render it.
  // - "other": no previews, but the user picked "Other" — give them a roomy
  //   textarea on the right instead of a cramped input under the Other row.
  // - "empty": nothing to show; the options list expands to full width so we
  //   don't leave the right half visibly blank.
  const hasPreview = q.options.some((o) => !!o.preview);
  const rightMode: "preview" | "other" | "empty" = hasPreview
    ? "preview"
    : w.showOther
    ? "other"
    : "empty";

  // Reset focus into the option list when the active question changes.
  // "Store previous props" pattern — the React 19 way to reset state on
  // prop/state change without a setState-in-effect cascade.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [lastActive, setLastActive] = useState(active);
  if (lastActive !== active) {
    setLastActive(active);
    setFocusedOption(0);
  }

  // Focus the Other input when revealed.
  useEffect(() => {
    if (w.showOther) otherInputRef.current?.focus();
  }, [w.showOther]);

  function update(qIdx: number, fn: (cur: Working) => Working) {
    setWorking((prev) => prev.map((w, i) => (i === qIdx ? fn(w) : w)));
  }

  function pick(label: string) {
    update(active, (cur) => {
      if (q.multiSelect) {
        const has = cur.selectedLabels.includes(label);
        return {
          ...cur,
          selectedLabels: has
            ? cur.selectedLabels.filter((l) => l !== label)
            : [...cur.selectedLabels, label],
        };
      }
      return { ...cur, selectedLabels: [label], showOther: false };
    });
  }

  function pickOther() {
    update(active, (cur) => {
      // Re-click on the Other row toggles it off — and we wipe the custom
      // draft at the same time so an unchecked Other doesn't leak into the
      // submitted answer (`submit()` only reads `custom` when showOther is
      // true, but clearing is the safer signal and keeps the textarea
      // empty on next toggle-on).
      if (cur.showOther) return { ...cur, showOther: false, custom: "" };
      return {
        ...cur,
        showOther: true,
        // Single-select: picking Other clears the other selection so it
        // behaves like switching to a different radio choice. Multi-select:
        // leave existing picks intact — Other is just an additional answer.
        selectedLabels: q.multiSelect ? cur.selectedLabels : [],
      };
    });
  }

  function setCustom(text: string) {
    update(active, (cur) => ({ ...cur, custom: text }));
  }

  function isReady(idx: number): boolean {
    const cur = working[idx];
    if (!cur) return false;
    if (cur.showOther && cur.custom.trim()) return true;
    return cur.selectedLabels.length > 0;
  }

  const allReady = working.every((_, i) => isReady(i));
  const isLast = active === total - 1;

  async function submit() {
    if (!allReady) return;
    const answers: AskAnswer[] = working.map((cur, i) => {
      const question = request.questions[i];
      const out: AskAnswer = {};
      if (question.multiSelect) {
        out.selected = [...cur.selectedLabels];
      } else if (cur.selectedLabels[0]) {
        out.label = cur.selectedLabels[0];
      } else {
        out.label = null;
      }
      if (cur.showOther && cur.custom.trim()) out.custom = cur.custom.trim();
      return out;
    });
    await onSubmit(answers);
  }

  // Keyboard shortcuts. Modal-only: inline mode shares the window with a live
  // composer, and a global keydown listener would hijack the user's typing —
  // most dangerously Escape, which isn't focus-gated and would decline the
  // question mid-sentence. Native <button> Enter/Space still works inline.
  useEffect(() => {
    if (inline) return;
    function onKey(e: KeyboardEvent) {
      // Don't intercept while the user is typing into an input.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const inField = tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable;

      if (e.key === "Escape") {
        e.preventDefault();
        void dismiss();
        return;
      }
      if (inField) return;
      if (/^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        if (idx < q.options.length) {
          e.preventDefault();
          pick(q.options[idx].label);
          setFocusedOption(idx);
        }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedOption((cur) => Math.min(q.options.length - 1, cur + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedOption((cur) => Math.max(0, cur - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (isLast) {
          if (allReady) void submit();
        } else if (isReady(active)) {
          setActive((a) => Math.min(total - 1, a + 1));
        }
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        // Lighten the lock — let Tab cycle questions when the active one is ready.
        if (isReady(active)) {
          e.preventDefault();
          setActive((a) => (a + 1) % total);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, q, allReady, isLast, total, working, inline]);

  return (
    <div
      data-testid="ask-user-question"
      data-inline={inline ? "true" : "false"}
      className={cn(
        inline
          ? // In-flow transcript card: no backdrop, no fixed positioning, no
            // click-outside dismissal. Sits as the last item in the message
            // list right under the model's preceding text.
            "w-full"
          : "fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4",
      )}
      onClick={
        inline
          ? undefined
          : (e) => {
              // Click outside hides the modal. We prefer minimize (recoverable)
              // over cancel (sends empty answers) so an accidental click can't
              // throw away the question while the agent is still waiting.
              if (e.target === e.currentTarget) void dismiss();
            }
      }
    >
      <div
        className={cn(
          "flex w-full flex-col overflow-hidden rounded-2xl bg-[var(--panel)]",
          inline
            ? // Accent-tinted border + ring substitutes for the modal's
              // backdrop as the attention cue now that nothing dims the page.
              "max-h-[70vh] border border-[var(--accent)]/50 ring-1 ring-[var(--accent)]/20 shadow-lg"
            : "max-h-[85vh] max-w-4xl border border-[var(--border)] shadow-2xl",
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3 text-xs">
          <span className="rounded-md bg-[var(--accent)]/15 px-2 py-0.5 font-medium uppercase tracking-wide text-[var(--accent)]">
            Question
          </span>
          {sessionLabel && sessionLabel.trim() && (
            <span
              data-testid="ask-session-label"
              className="max-w-[16rem] truncate rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-[var(--foreground)]"
              title={`From session: ${sessionLabel}`}
            >
              {sessionLabel}
            </span>
          )}
          <span className="text-[var(--muted)]">
            {active + 1} of {total}
          </span>
          {q.multiSelect && (
            <span
              data-testid="ask-multiselect-badge"
              className="flex items-center gap-1 rounded-md border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-300"
              title="This question accepts multiple answers"
            >
              <CheckSquare className="h-3 w-3" />
              Multiple choice
            </span>
          )}
          {/* Per-question header chips for navigation between questions. */}
          {total > 1 && (
            <div className="ml-2 flex flex-1 items-center gap-1 overflow-x-auto scroll-thin">
              {request.questions.map((qq, i) => (
                <button
                  key={i}
                  onClick={() => setActive(i)}
                  className={cn(
                    "shrink-0 rounded-md border px-2 py-0.5 text-[10px]",
                    i === active
                      ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--foreground)]"
                      : isReady(i)
                      ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
                      : "border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted)] hover:bg-[var(--panel)]",
                  )}
                  data-testid={`ask-tab-${i}`}
                >
                  {isReady(i) && <Check className="mr-1 inline h-3 w-3" />}
                  {qq.header || `Q${i + 1}`}
                </button>
              ))}
            </div>
          )}
          {onMinimize && (
            <button
              onClick={() => onMinimize()}
              className="ml-auto rounded p-1 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
              title="Hide for now (Esc) — the question stays pending"
              aria-label="Minimize"
              data-testid="ask-minimize"
            >
              <Minus className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={() => void onCancel()}
            className={cn(
              "rounded p-1 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]",
              !onMinimize && "ml-auto",
            )}
            title="Cancel — declines the question"
            aria-label="Cancel"
            data-testid="ask-cancel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body — split layout: options on the left, preview/Other-textarea on the right
            when there's something to show. Otherwise the options list takes the full width
            so the right half isn't left visibly empty. */}
        <div className="flex min-h-0 flex-1">
          {/* Options column */}
          <div
            className={cn(
              "flex w-full min-w-0 shrink-0 flex-col overflow-y-auto scroll-thin",
              rightMode === "empty"
                ? "border-r-0"
                : "border-r border-[var(--border)] md:w-1/2 lg:w-2/5",
            )}
          >
            <div className="px-5 pb-3 pt-4">
              {q.header && (
                <p
                  data-testid="ask-question-header"
                  className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]"
                >
                  {q.header}
                </p>
              )}
              <p className="text-sm font-medium leading-snug">{q.question}</p>
              {q.multiSelect && (
                <p
                  className="mt-1 flex items-center gap-1.5 text-[11px] font-medium text-emerald-300"
                  data-testid="ask-multiselect-hint"
                >
                  <CheckSquare className="h-3 w-3" />
                  Select one or more
                  {w.selectedLabels.length > 0 && (
                    <span className="text-[var(--muted)]">
                      · {w.selectedLabels.length} selected
                    </span>
                  )}
                </p>
              )}
            </div>
            <ul className="flex-1 px-2 pb-2">
              {q.options.map((opt, i) => {
                const selected = w.selectedLabels.includes(opt.label);
                const focused = i === focusedOption;
                return (
                  <li key={opt.label}>
                    <button
                      onClick={() => {
                        pick(opt.label);
                        setFocusedOption(i);
                      }}
                      onMouseEnter={() => setFocusedOption(i)}
                      onFocus={() => setFocusedOption(i)}
                      className={cn(
                        "mb-1 flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left transition",
                        selected
                          ? "border-[var(--accent)] bg-[var(--accent)]/10"
                          : focused
                          ? "border-[var(--border)] bg-[var(--panel-2)]"
                          : "border-transparent hover:bg-[var(--panel-2)]/60",
                      )}
                      data-testid={`ask-option-${i}`}
                      data-selected={selected ? "true" : "false"}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border",
                          // Square = checkbox (multi), circle = radio (single).
                          // Choose one shape — don't ship both rounded-sm and
                          // rounded-full and rely on CSS source order.
                          q.multiSelect ? "rounded" : "rounded-full",
                          selected
                            ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                            : "border-[var(--border)]",
                        )}
                      >
                        {selected && <Check className="h-3 w-3" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{opt.label}</span>
                        {opt.description && (
                          <span className="mt-0.5 block text-[11px] leading-snug text-[var(--muted)]">
                            {opt.description}
                          </span>
                        )}
                      </span>
                      <kbd className="ml-2 mt-0.5 hidden shrink-0 rounded border border-[var(--border)] bg-[var(--panel-2)] px-1 font-mono text-[10px] text-[var(--muted)] sm:inline-block">
                        {i + 1}
                      </kbd>
                    </button>
                  </li>
                );
              })}
              {/* "Other" row — always available (the SDK prompt explicitly tells the
                  model NOT to include an Other option, leaving the form to provide it). */}
              <li>
                <button
                  onClick={pickOther}
                  className={cn(
                    "mb-1 flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left transition",
                    w.showOther
                      ? "border-[var(--accent)] bg-[var(--accent)]/10"
                      : "border-transparent hover:bg-[var(--panel-2)]/60",
                  )}
                  data-testid="ask-option-other"
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border",
                      q.multiSelect ? "rounded" : "rounded-full",
                      w.showOther
                        ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                        : "border-[var(--border)]",
                    )}
                  >
                    {w.showOther && <Check className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">Other</span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-[var(--muted)]">
                      Provide your own answer
                    </span>
                  </span>
                </button>
                {/* Inline (left-column) Other input is only used when the right pane is
                    occupied by a preview. Otherwise the textarea lives in the right pane,
                    which gives the user real room to write. On small screens (no md:) the
                    right pane is hidden, so we still need an inline fallback there. */}
                {w.showOther && (
                  <div
                    className={cn(
                      "mb-2 px-3",
                      // Hide on md+ when right pane will host the textarea instead.
                      rightMode === "other" && "md:hidden",
                    )}
                  >
                    <textarea
                      data-testid="ask-other-input-inline"
                      value={w.custom}
                      onChange={(e) => setCustom(e.target.value)}
                      onKeyDown={(e) => {
                        // Cmd/Ctrl+Enter advances or submits; plain Enter is a newline.
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          if (isLast) {
                            if (allReady) void submit();
                          } else if (isReady(active)) {
                            setActive((a) => Math.min(total - 1, a + 1));
                          }
                        }
                      }}
                      placeholder="Type your answer…"
                      rows={2}
                      className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
                    />
                  </div>
                )}
              </li>
            </ul>
          </div>

          {/* Right pane — preview when the model supplied one, otherwise the roomy
              textarea for "Other". Hidden entirely when neither applies (the options
              column has already expanded to fill the space). */}
          {rightMode === "preview" && (
            <PreviewPane html={focusedOptionPreview} label={q.options[focusedOption]?.label ?? ""} />
          )}
          {rightMode === "other" && (
            <OtherPane
              value={w.custom}
              onChange={setCustom}
              textareaRef={otherInputRef}
              onSubmitShortcut={() => {
                if (isLast) {
                  if (allReady) void submit();
                } else if (isReady(active)) {
                  setActive((a) => Math.min(total - 1, a + 1));
                }
              }}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 border-t border-[var(--border)] bg-[var(--panel-2)]/40 px-4 py-2 text-xs">
          <span className="text-[var(--muted)]">
            {inline ? (
              // No global keyboard listener in inline mode — advertise only
              // what actually works (clicking, and the split-Other shortcut),
              // and reflect readiness so the hint doesn't say "pick an option"
              // once one is already selected.
              w.showOther ? (
                isLast ? (
                  "⌘/Ctrl+Enter submit"
                ) : (
                  "⌘/Ctrl+Enter next"
                )
              ) : allReady ? (
                isLast ? (
                  "Ready — press Submit"
                ) : (
                  "Ready — press Next"
                )
              ) : isReady(active) ? (
                "Pick the remaining answers"
              ) : (
                "Pick an option to answer"
              )
            ) : (
              <>
                {q.multiSelect ? "↑/↓ navigate · 1–4 toggle" : "↑/↓ navigate · 1–4 select"} ·{" "}
                {w.showOther
                  ? isLast
                    ? "⌘/Ctrl+Enter submit"
                    : "⌘/Ctrl+Enter next"
                  : isLast
                  ? "Enter submit"
                  : "Enter next"}{" "}
                · Esc {onMinimize ? "hide" : "cancel"}
              </>
            )}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {active > 0 && (
              <button
                onClick={() => setActive((a) => Math.max(0, a - 1))}
                className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-1 hover:bg-[var(--panel-2)]"
                data-testid="ask-prev"
              >
                Back
              </button>
            )}
            {!isLast ? (
              <button
                disabled={!isReady(active)}
                onClick={() => setActive((a) => Math.min(total - 1, a + 1))}
                className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1 text-white hover:opacity-90 disabled:opacity-40"
                data-testid="ask-next"
              >
                Next <ArrowRight className="h-3 w-3" />
              </button>
            ) : (
              <button
                disabled={!allReady}
                onClick={() => void submit()}
                className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1 text-white hover:opacity-90 disabled:opacity-40"
                data-testid="ask-submit"
              >
                Submit
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function OtherPane({
  value,
  onChange,
  textareaRef,
  onSubmitShortcut,
}: {
  value: string;
  onChange: (v: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onSubmitShortcut: () => void;
}) {
  return (
    <div className="hidden min-w-0 flex-1 flex-col p-4 md:flex">
      <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wide text-[var(--muted)]">
        <Pencil className="h-3 w-3" />
        Your answer
      </div>
      <textarea
        ref={textareaRef}
        data-testid="ask-other-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter is the submit/advance shortcut. Plain Enter inserts
          // a newline so the user can write paragraphs without surprises.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSubmitShortcut();
          }
        }}
        placeholder="Type your answer… (⌘/Ctrl+Enter to continue)"
        className="min-h-0 w-full flex-1 resize-none rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm leading-relaxed outline-none focus:border-[var(--accent)]"
      />
    </div>
  );
}

/**
 * Cheap sniff: HTML if there's a `<` followed by a tag-name character or
 * a closing slash. Anything else (ASCII boxes, plain prose, markdown the
 * CLI emitted because it didn't get our previewFormat='html' override) is
 * treated as text and rendered in a <pre> so newlines and leading spaces
 * survive — otherwise the browser collapses them and ASCII mockups
 * become unreadable.
 */
function looksLikeHtml(s: string): boolean {
  return /<\s*\/?[a-zA-Z][^>]*>/.test(s);
}

function PreviewPane({ html, label }: { html: string; label: string }) {
  // Memoize so React doesn't re-set innerHTML on every parent render.
  const content = useMemo(() => html ?? "", [html]);
  const isHtml = useMemo(() => looksLikeHtml(content), [content]);
  return (
    <div className="hidden min-w-0 flex-1 flex-col overflow-y-auto p-4 scroll-thin md:flex">
      {label && (
        <div className="mb-2 text-[10px] uppercase tracking-wide text-[var(--muted)]">
          Preview · {label}
        </div>
      )}
      {!content ? (
        <div className="text-[11px] italic text-[var(--muted)]">No preview for this option.</div>
      ) : isHtml ? (
        // Model-authored HTML mockups (cards, tables, code, comment threads)
        // assume a light "document" background with dark/secondary text — the
        // browser default. On Claudius's dark theme that makes any
        // unbackgrounded dark or muted text unreadable (e.g. a comments column
        // rendering author+date in grey). Give the preview its own fixed light
        // canvas so foreign HTML stays legible regardless of the active theme
        // or whatever inline colors the model picked — short of `!important`,
        // CSS can't override the model's inline `color`, so the only reliable
        // fix is the background it sits on. The visual break from the
        // surrounding chrome is intentional: it reads as "a render of
        // something the model authored," the same convention email/markdown
        // previews use. (The old `prose prose-invert` classes were dead — no
        // typography plugin — and would invert wrongly here anyway.)
        <div
          className="rounded-md border border-[var(--border)] bg-[#ffffff] p-3 text-sm text-[#1a1a1a] [color-scheme:light]"
          // The model itself emits this HTML — same trust level as anything
          // else in the assistant message stream. Be deliberate about that.
          dangerouslySetInnerHTML={{ __html: content }}
        />
      ) : (
        // Plain text / CLI-emitted markdown — preserve whitespace and use a
        // monospace face so ASCII art and box-drawing chars render the same
        // way the TUI shows them.
        <pre className="whitespace-pre overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 p-3 font-mono text-[12px] leading-relaxed text-[var(--foreground)]">
          {content}
        </pre>
      )}
    </div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { AskAnswer, AskUserQuestionEvent } from "@/lib/shared/events";

type Props = {
  request: AskUserQuestionEvent;
  onSubmit: (answers: AskAnswer[]) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
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

export function AskUserQuestionPrompt({ request, onSubmit, onCancel }: Props) {
  const [active, setActive] = useState(0);
  const [working, setWorking] = useState<Working[]>(() =>
    request.questions.map(() => emptyWorking()),
  );
  const [focusedOption, setFocusedOption] = useState(0);
  const otherInputRef = useRef<HTMLInputElement>(null);

  const total = request.questions.length;
  const q = request.questions[active];
  const w = working[active] ?? emptyWorking();
  const focusedOptionPreview =
    q.options[focusedOption]?.preview ?? q.options[0]?.preview ?? "";

  // Reset focus into the option list when the active question changes.
  useEffect(() => {
    setFocusedOption(0);
  }, [active]);

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
    update(active, (cur) => ({ ...cur, showOther: true, selectedLabels: q.multiSelect ? cur.selectedLabels : [] }));
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

  // Keyboard shortcuts.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't intercept while the user is typing into an input.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const inField = tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable;

      if (e.key === "Escape") {
        e.preventDefault();
        void onCancel();
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
  }, [active, q, allReady, isLast, total, working]);

  return (
    <div
      data-testid="ask-user-question"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        // Click outside the form cancels — same gesture as the permission modal.
        if (e.target === e.currentTarget) void onCancel();
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3 text-xs">
          <span className="rounded-md bg-[var(--accent)]/15 px-2 py-0.5 font-medium uppercase tracking-wide text-[var(--accent)]">
            Question
          </span>
          <span className="text-[var(--muted)]">
            {active + 1} of {total}
          </span>
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
          <button
            onClick={() => void onCancel()}
            className="ml-auto rounded p-1 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
            title="Cancel (Esc)"
            aria-label="Cancel"
            data-testid="ask-cancel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body — split layout: options on the left, preview on the right when present */}
        <div className="flex min-h-0 flex-1">
          {/* Options column */}
          <div className="flex w-full min-w-0 shrink-0 flex-col overflow-y-auto border-r border-[var(--border)] scroll-thin md:w-1/2 lg:w-2/5">
            <div className="px-5 pb-3 pt-4">
              <p className="text-sm font-medium leading-snug">{q.question}</p>
              {q.multiSelect && (
                <p className="mt-1 text-[11px] text-[var(--muted)]">Select one or more</p>
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
                          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border",
                          selected
                            ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                            : "border-[var(--border)]",
                          q.multiSelect ? "rounded-sm" : "rounded-full",
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
                      "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border",
                      w.showOther
                        ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                        : "border-[var(--border)]",
                      q.multiSelect ? "rounded-sm" : "rounded-full",
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
                {w.showOther && (
                  <div className="mb-2 px-3">
                    <input
                      ref={otherInputRef}
                      data-testid="ask-other-input"
                      value={w.custom}
                      onChange={(e) => setCustom(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (isLast) {
                            if (allReady) void submit();
                          } else if (isReady(active)) {
                            setActive((a) => Math.min(total - 1, a + 1));
                          }
                        }
                      }}
                      placeholder="Type your answer…"
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
                    />
                  </div>
                )}
              </li>
            </ul>
          </div>

          {/* Preview column — shown when any option in this question has a preview */}
          {q.options.some((o) => !!o.preview) && (
            <PreviewPane html={focusedOptionPreview} label={q.options[focusedOption]?.label ?? ""} />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 border-t border-[var(--border)] bg-[var(--panel-2)]/40 px-4 py-2 text-xs">
          <span className="text-[var(--muted)]">
            {q.multiSelect ? "↑/↓ navigate · 1–4 toggle" : "↑/↓ navigate · 1–4 select"} ·{" "}
            {isLast ? "Enter submit" : "Enter next"} · Esc cancel
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

function PreviewPane({ html, label }: { html: string; label: string }) {
  // Memoize so React doesn't re-set innerHTML on every parent render.
  const safeHtml = useMemo(() => html ?? "", [html]);
  return (
    <div className="hidden min-w-0 flex-1 flex-col overflow-y-auto p-4 scroll-thin md:flex">
      {label && (
        <div className="mb-2 text-[10px] uppercase tracking-wide text-[var(--muted)]">
          Preview · {label}
        </div>
      )}
      {safeHtml ? (
        <div
          className="prose prose-invert max-w-none text-sm"
          // The model itself emits this HTML — same trust level as anything
          // else in the assistant message stream. Be deliberate about that.
          dangerouslySetInnerHTML={{ __html: safeHtml }}
        />
      ) : (
        <div className="text-[11px] italic text-[var(--muted)]">No preview for this option.</div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, Wrench, ChevronRight, RotateCcw, Maximize2 } from "lucide-react";
import { CHAT_SIZE_BOUNDS, useChatSize } from "@/lib/client/chat-size";
import { cn } from "@/lib/utils/cn";

/**
 * Settings card that lets the user override the chat reading column width
 * and base text size, with a live preview that reflects the choices.
 *
 * Persistence and DOM application are instant — see `useChatSize`. This
 * component is purely the UI: two sliders, a reset-to-auto button, and a
 * hand-built mock chat below.
 *
 * Both the controls card and the preview band intentionally span the full
 * scroll-container width (no inner `max-w-4xl` cap) — on big displays the
 * preview is a wide strip and a centered-narrow controls card above it
 * reads as misaligned. The caller MUST render this OUTSIDE the centered
 * `max-w-4xl` wrapper in `app/settings/page.tsx`; we deliberately don't
 * re-cap internally.
 */
export function ChatSizeSection() {
  const { size, setColRem, setTextPx, reset } = useChatSize();

  // Resolve the currently-applied values for the slider thumbs and labels.
  // `null` (auto) renders as a midpoint that the user can drag from without
  // losing context — but we tag the field with "auto" so the user knows the
  // stylesheet is in control until they actually move it.
  const colAuto = size.colRem == null;
  const textAuto = size.textPx == null;
  const colValue = size.colRem ?? 60;
  const textValue = size.textPx ?? 17;

  // Measure the preview pane so the "Fit" button can set the column to the
  // exact available width. Using the preview pane (not `window.innerWidth`)
  // gives the right answer regardless of sidenav width / activity panel
  // state — the user's mental model is "fill that empty space," and that
  // space is the pane.
  const previewPaneRef = useRef<HTMLDivElement>(null);
  const onFit = () => {
    const pane = previewPaneRef.current;
    if (!pane) return;
    // Floor to avoid a 1px subpixel overshoot that would trigger horizontal
    // scroll. `setColRem` re-clamps to `colMaxRem` so very wide viewports
    // land at the slider ceiling instead of overshooting.
    setColRem(Math.floor(pane.clientWidth / 16));
  };

  // Track viewport width in rem so the column slider's max == the user's
  // screen. Dragging to the right end fills the screen exactly. Listens to
  // resize so window-resizes / display-mode changes re-cap the slider live.
  // SSR fallback (96) matches the responsive clamp's static ceiling so the
  // first paint shows a reasonable slider before the effect runs.
  const [viewportRem, setViewportRem] = useState(96);
  useEffect(() => {
    const update = () => setViewportRem(Math.floor(window.innerWidth / 16));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const colSliderMax = Math.max(
    CHAT_SIZE_BOUNDS.colMinRem + 1,
    Math.min(viewportRem, CHAT_SIZE_BOUNDS.colMaxRem),
  );
  // Only label the max as "screen" when the viewport is the binding constraint
  // — on a hypothetical >400rem display the hard ceiling kicks in first, and
  // calling that "screen" would be wrong.
  const colMaxLabel =
    viewportRem <= CHAT_SIZE_BOUNDS.colMaxRem
      ? `${colSliderMax} rem · screen`
      : `${colSliderMax} rem`;

  return (
    <>
      {/* Controls — full scroll-container width so the card visually
          matches the preview band below it. */}
      <div className="px-2 sm:px-4">
        <section
          className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4"
          data-testid="settings-chat-size"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium">Chat size</h2>
              <p className="mt-0.5 text-[11px] text-[var(--muted)]">
                Reading-column width and base text size for the chat surface. Unset = automatic,
                which scales fluidly with viewport (the default).
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={onFit}
                className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-[11px] text-[var(--muted)] hover:text-[var(--foreground)]"
                title="Set the column to the full width of the preview pane"
              >
                <Maximize2 className="h-3 w-3" />
                Fit
              </button>
              <button
                type="button"
                onClick={reset}
                disabled={colAuto && textAuto}
                className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-[11px] text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40"
                title="Restore the responsive default"
              >
                <RotateCcw className="h-3 w-3" />
                Auto
              </button>
            </div>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <SliderField
              label="Column width"
              unit="rem"
              min={CHAT_SIZE_BOUNDS.colMinRem}
              max={colSliderMax}
              step={1}
              value={colValue}
              auto={colAuto}
              onChange={(n) => setColRem(n)}
              /* Pixel hint matches a 16px root — same conversion the stylesheet uses. */
              hint={`~${Math.round(colValue * 16)} px`}
              maxLabel={colMaxLabel}
            />
            <SliderField
              label="Body text"
              unit="px"
              min={CHAT_SIZE_BOUNDS.textMinPx}
              max={CHAT_SIZE_BOUNDS.textMaxPx}
              step={1}
              value={textValue}
              auto={textAuto}
              onChange={(n) => setTextPx(n)}
              hint={textValue === 16 ? "default" : ""}
            />
          </div>
        </section>
      </div>

      {/* Preview band — full scroll-container width, matched to the
          controls card above so the eye reads them as one unit. */}
      <div className="mt-4 px-2 sm:px-4">
        <div className="mb-2 flex items-center gap-2 px-2 text-[10px] uppercase tracking-wide text-[var(--muted)]">
          Live preview
          <span className="font-mono text-[10px] normal-case tracking-normal text-[var(--muted)]/70">
            scroll →
          </span>
        </div>
        <div
          ref={previewPaneRef}
          className="overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--background)]/60 scroll-thin"
        >
          {/* The literal column width is what makes the slider tangible — when
              the user drags past the preview pane's own width the row scrolls
              horizontally, which is the desired feedback. */}
          <div
            className="mx-auto space-y-4 px-4 py-6"
            style={{ width: "var(--chat-col)" }}
          >
            <PreviewUserBubble />
            <PreviewAssistant />
            <PreviewToolCall name="Edit" arg="app/globals.css" />
            <PreviewToolCall name="Bash" arg="bun run lint app/globals.css" />
            <PreviewAssistantTail />
          </div>
        </div>
      </div>
    </>
  );
}

function SliderField({
  label,
  unit,
  min,
  max,
  step,
  value,
  auto,
  onChange,
  hint,
  maxLabel,
}: {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  auto: boolean;
  onChange: (n: number) => void;
  hint?: string;
  /** Override for the right-side label under the slider — used by the column
   *  field to show the viewport-driven cap ("236 rem · screen"). */
  maxLabel?: string;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[10px] uppercase tracking-wide text-[var(--muted)]">
        <span>{label}</span>
        <span className="font-mono normal-case tracking-normal">
          <span className={cn("text-[var(--foreground)]", auto && "opacity-60")}>
            {value}
            <span className="ml-0.5 opacity-60">{unit}</span>
          </span>
          {auto ? (
            <span className="ml-2 rounded bg-[var(--panel-2)] px-1 text-[9px] uppercase tracking-wide text-[var(--muted)]">
              auto
            </span>
          ) : (
            hint && (
              <span className="ml-2 text-[9px] text-[var(--muted)]">{hint}</span>
            )
          )}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--accent)]"
        aria-label={`${label} ${value}${unit}`}
      />
      <div className="mt-0.5 flex justify-between font-mono text-[9px] text-[var(--muted)]/60">
        <span>
          {min}
          {unit}
        </span>
        <span>
          {maxLabel ?? `${max}${unit}`}
        </span>
      </div>
    </label>
  );
}

/*
 * The preview snippets below are hand-built (per the dev/chat-* precedent)
 * rather than reusing `UserMessage`/`AssistantMessage`/`ToolCall` directly.
 * Mounting the real components here would pull in `useFileLink` /
 * `useEditor` contexts and SSE-shaped message types just to render static
 * markup — not worth the surface area. The styling is kept close enough to
 * the real surface that the user can judge text size and column width
 * faithfully.
 */

function PreviewUserBubble() {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2">
        <div className="text-[length:var(--chat-text)] leading-6 2xl:leading-7">
          Can you walk me through how the chat reading column is sized on big screens?
        </div>
      </div>
    </div>
  );
}

function PreviewAssistant() {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-[var(--muted)]">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
        Claude
      </div>
      <div className="space-y-1 text-[length:var(--chat-text)] leading-7 2xl:leading-8">
        <p>
          The column width and base text size are driven by two CSS variables —{" "}
          <code className="rounded bg-[var(--panel-2)] px-1 font-mono text-[0.9em]">--chat-col</code>{" "}
          and <code className="rounded bg-[var(--panel-2)] px-1 font-mono text-[0.9em]">--chat-text</code> — which scale
          fluidly with viewport above 1536&nbsp;px. Anything you set here in Settings overrides the
          stylesheet rule for every chat.
        </p>
        <p>
          Let me check the current rule and confirm the override path lands on the right element:
        </p>
      </div>
    </div>
  );
}

function PreviewAssistantTail() {
  return (
    <div className="space-y-1 text-[length:var(--chat-text)] leading-7 2xl:leading-8">
      <p>
        Confirmed — the inline style on{" "}
        <code className="rounded bg-[var(--panel-2)] px-1 font-mono text-[0.9em]">&lt;html&gt;</code>{" "}
        beats the <code className="rounded bg-[var(--panel-2)] px-1 font-mono text-[0.9em]">@media</code> rule at every
        viewport, and removing the inline style restores the responsive default.
      </p>
    </div>
  );
}

function PreviewToolCall({ name, arg }: { name: string; arg: string }) {
  return (
    <div className="my-2 rounded-lg border border-[var(--border)] bg-[var(--panel)]/40">
      <div className="flex w-full items-center gap-2 pr-3 text-xs">
        <div className="flex items-center gap-2 py-1.5 pl-3">
          <ChevronRight className="h-3.5 w-3.5" />
          {name === "Edit" || name === "Bash" ? (
            <Wrench className="h-3.5 w-3.5 text-[var(--accent)]" />
          ) : (
            <Sparkles className="h-3.5 w-3.5 text-[var(--accent)]" />
          )}
          <span className="font-mono">{name}</span>
          <span className="font-mono text-[var(--muted)]">{arg}</span>
        </div>
        <span className="ml-auto inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
      </div>
    </div>
  );
}

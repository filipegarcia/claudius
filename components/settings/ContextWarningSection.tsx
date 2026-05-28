"use client";

import { Gauge } from "lucide-react";
import {
  CONTEXT_WARNING_PRESETS,
  useContextWarningPct,
} from "@/lib/client/useContextWarning";
import { cn } from "@/lib/utils/cn";

/**
 * Browser-only pref for the chat-side context-window warning banner. When
 * the active session's transcript grows past this share of the model's
 * context window, the chat surfaces a warning with a one-click Compact
 * button (mirroring the CLI's nudge toward `/compact`).
 *
 * Distinct from Claude Code's `autoCompactEnabled` / `autoCompactWindow`
 * (the SDK-side automatic compaction surfaced in the catalog below) — this
 * knob only controls when the *manual* warning appears. Lives alongside the
 * other browser-local sections rather than inside settings.json.
 */
export function ContextWarningSection() {
  const { value, setValue } = useContextWarningPct();

  const presetMatch = CONTEXT_WARNING_PRESETS.find((p) => p.value === value);
  const activeDescription =
    presetMatch?.description ??
    (value >= 100
      ? "The context warning is hidden."
      : `Custom: warn once the context window is ${value}% full or more.`);

  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4">
      <div className="flex items-start gap-2">
        <Gauge className="mt-px h-3.5 w-3.5 text-amber-400" />
        <div>
          <h2 className="text-sm font-medium">Context-window warning</h2>
          <p className="mt-0.5 text-[11px] text-[var(--muted)]">
            Controls when the &ldquo;Context window is filling up&rdquo; banner
            appears in chat, with a one-click Compact button. Separate from
            Claude Code&rsquo;s automatic compaction. Stored per browser.
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {CONTEXT_WARNING_PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => setValue(p.value)}
            title={p.description}
            data-testid="context-warning-preset"
            data-active={p.value === value}
            className={cn(
              "rounded-md border px-3 py-1.5 text-xs",
              p.value === value
                ? "border-[var(--accent)] bg-[var(--panel-2)]"
                : "border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel-2)]",
            )}
          >
            <span className="font-medium">{p.label}</span>
            <span className="ml-1.5 font-mono text-[10px] text-[var(--muted)]">
              {p.value >= 100 ? "off" : `≥ ${p.value}%`}
            </span>
          </button>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <label className="text-[11px] text-[var(--muted)]" htmlFor="context-warning-threshold-input">
          Custom threshold
        </label>
        <input
          id="context-warning-threshold-input"
          type="number"
          min={0}
          max={100}
          step={1}
          value={value}
          onChange={(e) => {
            // Empty string is intentionally treated as "reset to default"
            // via the clamp in setValue (NaN → DEFAULT_PCT).
            const n = e.target.value === "" ? Number.NaN : Number.parseInt(e.target.value, 10);
            setValue(n);
          }}
          className="w-20 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 font-mono text-xs tabular-nums focus:outline-none"
        />
        <span className="font-mono text-[11px] text-[var(--muted)]">% of context window</span>
      </div>

      <p className="mt-2 text-[11px] italic text-[var(--muted)]">{activeDescription}</p>
    </section>
  );
}

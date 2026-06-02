"use client";

import { AlertTriangle } from "lucide-react";
import {
  RATE_LIMIT_WARNING_PRESETS,
  useRateLimitWarningPct,
} from "@/lib/client/useRateLimitWarning";
import { cn } from "@/lib/utils/cn";

/**
 * Browser-only pref for the chat-side rate-limit pill. The hard-stop
 * (`status: "rejected"`) pill is always shown — this setting only
 * affects when *warning*-class events ("Approaching 5-hour limit",
 * "You've used 60% of your weekly limit") materialise.
 *
 * Lives alongside the other browser-local settings sections
 * (`ShortcutsSection`, `UpdaterSettingsSection`) rather than inside
 * Claude Code's settings.json — it's a Claudius UI knob, not a CLI
 * config value.
 */
export function RateLimitWarningSection() {
  const { value, setValue } = useRateLimitWarningPct();

  // Find the preset closest to the current value. We treat the stored
  // number as the source of truth and just highlight the matching chip
  // (or none, for custom values entered via the input).
  const presetMatch = RATE_LIMIT_WARNING_PRESETS.find((p) => p.value === value);
  const activeDescription =
    presetMatch?.description ??
    `Custom: warn at ${value}% utilization or above. Rejection always shown.`;

  return (
    // Anchor target for deep links from the in-chat rate-limit pill — the
    // "change the threshold" affordance navigates to /settings#rate-limit-warning
    // so the browser scrolls this section into view on load.
    <section
      id="rate-limit-warning"
      className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-px h-3.5 w-3.5 text-amber-400" />
        <div>
          <h2 className="text-sm font-medium">Rate-limit warnings</h2>
          <p className="mt-0.5 text-[11px] text-[var(--muted)]">
            Controls when the &ldquo;Approaching&rdquo; pill appears in chat.
            Rejection events (you&rsquo;ve actually hit the wall) always show
            regardless. Stored per browser.
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {RATE_LIMIT_WARNING_PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => setValue(p.value)}
            title={p.description}
            data-testid="rate-limit-warning-preset"
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
              {p.value === 0 ? "0%" : p.value === 100 ? "rejection only" : `≥ ${p.value}%`}
            </span>
          </button>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <label className="text-[11px] text-[var(--muted)]" htmlFor="rate-limit-threshold-input">
          Custom threshold
        </label>
        <input
          id="rate-limit-threshold-input"
          type="number"
          min={0}
          max={100}
          step={1}
          value={value}
          onChange={(e) => {
            // Empty string is intentionally treated as "reset to default"
            // via the clamp in setValue (NaN → DEFAULT_PCT). Lets users
            // clear the input without leaving the field in a weird state.
            const n = e.target.value === "" ? Number.NaN : Number.parseInt(e.target.value, 10);
            setValue(n);
          }}
          className="w-20 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 font-mono text-xs tabular-nums focus:outline-none"
        />
        <span className="font-mono text-[11px] text-[var(--muted)]">% utilization</span>
      </div>

      <p className="mt-2 text-[11px] italic text-[var(--muted)]">
        {activeDescription} The SDK doesn&rsquo;t always attach a percentage
        to its warning events; events without one are hidden unless you
        choose &ldquo;Always&rdquo;.
      </p>
    </section>
  );
}

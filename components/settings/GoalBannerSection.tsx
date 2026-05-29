"use client";

import { Target } from "lucide-react";
import { useGoalBannerHidden } from "@/lib/client/useGoalBannerHidden";

/**
 * Browser-only pref for the empty "Set a session goal" prompt in the chat
 * session header. Users who don't use the goal feature can dismiss the prompt
 * (the × on the banner, or the hover affordance on the collapsed title row) —
 * this is the durable place to bring it back. Hiding only affects the empty
 * prompt; an active goal still shows, and `/goal` always works. Lives alongside
 * the other browser-local sections rather than inside settings.json.
 */
export function GoalBannerSection() {
  const { hidden, setHidden } = useGoalBannerHidden();

  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4">
      <div className="flex items-start gap-2">
        <Target className="mt-px h-3.5 w-3.5 text-[var(--accent)]" />
        <div>
          <h2 className="text-sm font-medium">Session goal prompt</h2>
          <p className="mt-0.5 text-[11px] text-[var(--muted)]">
            The &ldquo;Set a session goal&rdquo; row in the chat header. Hiding
            it only suppresses the empty prompt — an active goal still shows, and
            the <code className="font-mono">/goal</code> command always works.
            Stored per browser.
          </p>
        </div>
      </div>

      <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 p-2">
        <input
          type="checkbox"
          checked={!hidden}
          onChange={(e) => setHidden(!e.target.checked)}
          data-testid="goal-banner-show-toggle"
          className="mt-0.5 h-3.5 w-3.5"
        />
        <div className="flex-1">
          <div className="text-xs font-medium">Show the session goal prompt</div>
          <div className="text-[11px] text-[var(--muted)]">
            On by default. Turn off to hide the empty &ldquo;Set a session
            goal&rdquo; row (same as dismissing it with the × on the banner).
          </div>
        </div>
      </label>
    </section>
  );
}

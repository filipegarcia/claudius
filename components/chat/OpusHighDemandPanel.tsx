"use client";

import { AlertTriangle } from "lucide-react";

/**
 * Inline banner rendered under an assistant message that IS the Anthropic
 * backend's Opus-4 high-demand notice — the CLI strings
 *   "We are experiencing high demand for Opus 4."
 *   "To continue immediately, use /model to switch to ... and continue coding."
 * Faithful to the TUI, the banner is static text: it tells the user what to
 * do (the assistant prose already names a fallback target above), and the
 * existing `/model` slash-command + ModelPicker handle the actual switch.
 *
 * Distinct from `OpusOverloadNudgePanel` (feature 10), which fires off a
 * server-side 529 streak counter and includes a "Switch to Sonnet" button.
 * This one fires off the backend's own prose — no streak required, no SSE.
 *
 * Lives on the message (not as a separate system pill) so it renders on every
 * transcript path — live stream, resumed-session replay, and paginated
 * scrollback — each of which builds the bubble through a different code path.
 */
export function OpusHighDemandPanel() {
  return (
    <div className="my-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-5 text-amber-200">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5" />
        <span className="font-medium">Opus 4 is experiencing high demand</span>
      </div>
      <div className="mt-1 opacity-90">
        To continue immediately, use{" "}
        <code className="rounded bg-amber-500/15 px-1 font-mono text-[11px]">/model</code>{" "}
        to switch to another model and keep coding.
      </div>
    </div>
  );
}

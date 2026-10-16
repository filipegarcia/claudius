/**
 * CC 2.1.301 ("Fixed the permission prompt for a plugin or skill hook's `ask`
 * decision not showing which plugin or skill the hook comes from").
 *
 * When a PreToolUse hook answers `ask`, the engine hands `canUseTool` the
 * hook's own reason text as `decisionReason`, tagged
 * `decisionReasonType: "hook"`. Claudius used to drop both, so the prompt said
 * nothing about a hook at all. This marks the ask as a hook's and pulls the
 * reason (when the hook gave one) out for display only — it never feeds a
 * permission decision.
 *
 * The engine's `decision_reason_hook_source` (`plugin:<name>` / `skill:<name>`)
 * is not forwarded by the SDK's JS layer as of 0.3.301, so the plugin/skill
 * name itself can't be shown yet; the reason is the part Claudius can mirror.
 *
 * The SDK documents `decisionReason` as possibly carrying ANSI escapes, so
 * they are stripped, and the text is capped so a runaway hook can't push the
 * Allow/Deny buttons off the card.
 */

export const HOOK_ASK_REASON_MAX = 600;

// CSI sequences (colors, cursor moves) and OSC sequences (titles, links).
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** What the permission prompt shows about a hook-raised ask. */
export type HookAsk = {
  /** The hook's reason, cleaned for display; absent when it gave none. */
  reason?: string;
};

/**
 * `{ reason? }` when this ask was raised by a hook, else `undefined`. A hook
 * may answer `ask` without a reason; the ask was still a hook's, so the
 * prompt still says so — the object is present and only `reason` is absent.
 */
export function hookAsk(decisionReason: unknown, decisionReasonType: unknown): HookAsk | undefined {
  if (decisionReasonType !== "hook") return undefined;
  const clean = typeof decisionReason === "string" ? stripAnsi(decisionReason).trim() : "";
  if (!clean) return {};
  return {
    reason: clean.length > HOOK_ASK_REASON_MAX ? `${clean.slice(0, HOOK_ASK_REASON_MAX - 1)}…` : clean,
  };
}

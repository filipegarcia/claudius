/**
 * CC 2.1.301 ("Fixed the permission prompt for a plugin or skill hook's `ask`
 * decision not showing which plugin or skill the hook comes from").
 *
 * When a PreToolUse hook answers `ask`, the engine hands `canUseTool` the
 * hook's own reason text as `decisionReason`, tagged
 * `decisionReasonType: "hook"`. Claudius used to drop both, so the prompt said
 * nothing about a hook at all. This pulls the reason out for display only —
 * it never feeds a permission decision.
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

/** The hook's reason when this ask was raised by a hook, else `undefined`. */
export function hookAskReason(decisionReason: unknown, decisionReasonType: unknown): string | undefined {
  if (decisionReasonType !== "hook" || typeof decisionReason !== "string") return undefined;
  const clean = stripAnsi(decisionReason).trim();
  if (!clean) return undefined;
  return clean.length > HOOK_ASK_REASON_MAX ? `${clean.slice(0, HOOK_ASK_REASON_MAX - 1)}…` : clean;
}

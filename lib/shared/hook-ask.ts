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

/**
 * The engine's explanation for a safety-check ask, cleaned for display, else
 * `undefined`.
 *
 * CC 2.1.329 — "[VSCode] Fixed the permission prompt for Bash, Edit, Write
 * and other built-in tools not showing why a safety check asks". When one of
 * the engine's safety checks escalates a call (a sensitive path, a command
 * it can't parse, a dangerous `rm`), `canUseTool` gets the check's warning as
 * `decisionReason`, tagged `decisionReasonType: "safetyCheck"`. For a compound
 * Bash command the tag is `"subcommandResults"` and the text is the nested
 * check's warning (the SDK types say to treat it like a `safetyCheck`
 * reason). Claudius dropped it, so the card never said why it was asking.
 * Same cleaning as a hook's reason: ANSI stripped, length capped. Display
 * only — it never feeds a permission decision.
 */
export function safetyAskReason(decisionReason: unknown, decisionReasonType: unknown): string | undefined {
  if (decisionReasonType !== "safetyCheck" && decisionReasonType !== "subcommandResults") return undefined;
  const clean = typeof decisionReason === "string" ? stripAnsi(decisionReason).trim() : "";
  if (!clean) return undefined;
  return clean.length > HOOK_ASK_REASON_MAX ? `${clean.slice(0, HOOK_ASK_REASON_MAX - 1)}…` : clean;
}

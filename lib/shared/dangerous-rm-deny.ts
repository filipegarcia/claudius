/**
 * CC 2.1.309 parity — "Changed the dangerous rm and rmdir prompt in bypass
 * permissions mode in the Desktop app and VS Code to deny the command at once
 * with a rewrite hint, so unattended sessions keep going."
 *
 * The engine raises a dangerous `rm` / `rmdir` (a target that can expand to
 * `/`, the home or working directory, a critical system path, an unresolvable
 * glob…) as a safety-check ask that even Bypass permissions can't auto-allow.
 * The SDK forwards it to the host's `canUseTool` with
 * `decisionReasonType: "safetyCheck"` (or `"subcommandResults"` for a compound
 * command, where `decisionReason` carries the nested check's text) — the
 * typings say that field exists so hosts can "make policy (e.g. auto-deny
 * safetyCheck)". Desktop and VS Code are such hosts; so is Claudius, whose
 * `canUseTool` used to park an Allow/Deny card even in bypass mode, stalling a
 * session the user had set up to run unattended.
 *
 * This decides when Claudius denies at once instead, and words the denial so
 * the model can rewrite the command and carry on.
 */
import { stripAnsi } from "./hook-ask";

/** Matches the engine's dangerous-rm safety-check wording (rm and rmdir). */
const DANGEROUS_RM = /\bdangerous rm(?:dir)? operations?\b/i;

/**
 * Appended to the engine's own reason; the model reads it as the tool error.
 * Deliberately generic: the engine's reason carries any case-specific advice
 * (e.g. "use a literal path: $X is set in this command from …", where a
 * `${X:?}` guard would *not* help), so this doesn't suggest a guard.
 */
export const DANGEROUS_RM_REWRITE_HINT =
  "Denied automatically because this session runs in Bypass permissions mode, so it can keep going without a person to approve. " +
  "Rewrite the command so it removes only literal paths inside the project, or leave the removal for the user to run.";

const REASON_MAX = 600;

export interface DangerousRmAsk {
  permissionMode: string;
  decisionReason?: unknown;
  decisionReasonType?: unknown;
  /** Set when a user `permissions.ask` rule forced the prompt — never auto-deny. */
  matchedAskRule?: unknown;
}

/**
 * The deny message to answer with, or `null` to show the normal prompt.
 * Only fires in `bypassPermissions`, only for the engine's dangerous-rm safety
 * checks, and never when a user ask rule forced the prompt (the SDK docs: such
 * asks mean the user wants a human to decide).
 */
export function bypassDangerousRmDenial(ask: DangerousRmAsk): string | null {
  if (ask.permissionMode !== "bypassPermissions") return null;
  if (ask.matchedAskRule) return null;
  if (ask.decisionReasonType !== "safetyCheck" && ask.decisionReasonType !== "subcommandResults") {
    return null;
  }
  if (typeof ask.decisionReason !== "string") return null;
  const reason = stripAnsi(ask.decisionReason).trim();
  if (!DANGEROUS_RM.test(reason)) return null;
  const chars = Array.from(reason);
  const shown = chars.length > REASON_MAX ? `${chars.slice(0, REASON_MAX - 1).join("")}…` : reason;
  return `${shown}\n\n${DANGEROUS_RM_REWRITE_HINT}`;
}

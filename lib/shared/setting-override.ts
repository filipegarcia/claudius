/**
 * CC 2.1.327 parity — "Added a note in /config when other settings override a
 * row".
 *
 * /settings edits one scope at a time (User / Project / Local) but loads all
 * three. For a single-value key, a higher-precedence file that also sets it
 * wins (user < project < local), so the value on a lower tab doesn't take
 * effect. `settingOverriddenBy` finds that file so the row can say so.
 *
 * Deliberately narrow — saying "another file wins" when it doesn't is worse
 * than saying nothing:
 *  - Only scalar values (string, number, boolean) count. Objects and arrays
 *    (`permissions.*`, `env`, `hooks`, `enabledPlugins`, `claudeMdExcludes`, …)
 *    merge across scopes instead of replacing.
 *  - Keys whose value Claudius takes from the user file regardless of the
 *    others are skipped (`USER_SCOPE_WINS_SETTING_KEYS`), as are keys only
 *    managed settings can set (`MANAGED_ONLY_SETTING_KEYS`).
 *  - Managed (policy) settings aren't read by Claudius, so they're out of
 *    scope here.
 */

export type SettingScope = "user" | "project" | "local";

/** Lowest to highest precedence. */
const PRECEDENCE: readonly SettingScope[] = ["user", "project", "local"];

const SCOPE_LABELS: Record<SettingScope, string> = { user: "User", project: "Project", local: "Local" };

/** Merged across scopes (object / list values) — never "overridden". */
const MERGED_SETTING_KEYS: ReadonlySet<string> = new Set(["permissions", "env", "hooks", "enabledPlugins"]);

/**
 * Keys where the user-scope value wins in Claudius, so a project or local
 * value doesn't override it:
 *  - `lib/server/session.ts` (search "Forward Settings-level flags") passes
 *    these from `~/.claude/settings.json` at the SDK's flag layer, above every
 *    settings file. Keep this group in sync with that block.
 *  - The rest are read by Claudius from the user file only (see e.g.
 *    `lib/client/useSpellcheckEnabled.ts`, `useClockOptions.ts`,
 *    `useMaxEffortLevel.ts`, `useDisableAutoMode.ts`, and `queueDispatchMode` /
 *    `promptSuggestionEnabled` / `spinnerTipsEnabled` / `sessionRecapEnabled` /
 *    `feedbackSurveyRate` — every `readSettings("user", …)` in `session.ts`).
 */
export const USER_SCOPE_WINS_SETTING_KEYS: ReadonlySet<string> = new Set([
  // session.ts flag layer
  "includeCoAuthoredBy",
  "advisorModel",
  "workflowSizeGuideline",
  "crossSessionInbound",
  // read from the user file only
  "promptSuggestionEnabled",
  "queueDispatchMode",
  "spinnerTipsEnabled",
  "spellcheckEnabled",
  "emojiCompletionEnabled",
  "showMessageTimestamps",
  "timeFormat",
  "timeZone",
  "maxProseWidth",
  "prefersReducedMotion",
  "autoContinueAtUsageLimit",
  "disableAutoMode",
  "maxEffortLevel",
  "sessionRecapEnabled",
  "feedbackSurveyRate",
]);

/**
 * Keys the engine honors only from managed (policy) settings, so no
 * user/project/local file "takes precedence" — none of them applies.
 */
const MANAGED_ONLY_SETTING_KEYS: ReadonlySet<string> = new Set(["forceLoginGatewayUrl"]);

export type SettingOverride = { scope: SettingScope; path: string };

type ScopeSettings = { scope: SettingScope; path: string; settings: object };

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/**
 * The highest-precedence scope above `scope` that sets `key` to a scalar, or
 * null when nothing overrides it. An empty string counts: some keys give it
 * meaning (e.g. `attributionProject: ""` names no Project).
 */
export function settingOverriddenBy(
  key: string,
  scope: SettingScope,
  scopes: readonly ScopeSettings[],
): SettingOverride | null {
  if (MERGED_SETTING_KEYS.has(key) || USER_SCOPE_WINS_SETTING_KEYS.has(key) || MANAGED_ONLY_SETTING_KEYS.has(key)) {
    return null;
  }
  const from = PRECEDENCE.indexOf(scope);
  for (let i = PRECEDENCE.length - 1; i > from; i--) {
    const higher = scopes.find((s) => s.scope === PRECEDENCE[i]);
    if (higher && isScalar((higher.settings as Record<string, unknown>)[key])) {
      return { scope: higher.scope, path: higher.path };
    }
  }
  return null;
}

/**
 * The row's note, e.g. "Project (.claude/settings.json) takes precedence".
 * Avoids the word "overridden": the row badge already uses it to mean "set
 * in this file". Project and local paths are shown from `.claude/` on.
 */
export function settingOverrideNote(o: SettingOverride): string {
  const at = Math.max(o.path.lastIndexOf("/.claude/"), o.path.lastIndexOf("\\.claude\\"));
  const file = at >= 0 ? o.path.slice(at + 1) : o.path;
  return `${SCOPE_LABELS[o.scope]} (${file}) takes precedence`;
}

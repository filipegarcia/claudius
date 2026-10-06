/**
 * CC 2.1.282 (H13) — project/local `settings.json` can set OpenTelemetry
 * export/content env vars, but the engine IGNORES them at those scopes (only
 * user/managed settings are honored, to stop a cloned repo from redirecting a
 * developer's telemetry). Claudius's project-scope env editor can still write
 * them, so the doctor flags them as ineffective.
 *
 * Pure so the key-matching is unit-testable.
 */

/**
 * The telemetry env keys the engine ignores in project/local settings: the
 * master `CLAUDE_CODE_ENABLE_TELEMETRY` toggle and any `OTEL_*` export/content
 * variable. Returns the matching keys from `env` (preserving their spelling),
 * or `[]` for none.
 */
export function ignoredTelemetryEnvKeys(env: Record<string, string> | undefined | null): string[] {
  if (!env || typeof env !== "object") return [];
  return Object.keys(env).filter(
    (k) => /^otel_/i.test(k) || k.toUpperCase() === "CLAUDE_CODE_ENABLE_TELEMETRY",
  );
}

/**
 * CC 2.1.290 — "Changed `CLAUDE_CODE_DISABLE_ATTACHMENTS` so a repository's
 * `.claude/settings.json` or `.claude/settings.local.json` can no longer set
 * it; shell, user and managed settings still can." Same shape as the
 * telemetry keys above: Claudius's project-scope env editor can still write
 * it, so the doctor flags it as ineffective. Returns the matching keys from
 * `env` (preserving their spelling), or `[]` for none.
 */
export function ignoredAttachmentsEnvKeys(env: Record<string, string> | undefined | null): string[] {
  if (!env || typeof env !== "object") return [];
  return Object.keys(env).filter((k) => k.toUpperCase() === "CLAUDE_CODE_DISABLE_ATTACHMENTS");
}

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

/**
 * CC 2.1.328 — "Added a notice in `/status` and `claude doctor` when an
 * OpenTelemetry exporter has no endpoint and its data would likely be lost".
 *
 * A port of the engine's rule (2.1.332 bundle), copy included. With
 * `CLAUDE_CODE_ENABLE_TELEMETRY` on, a signal (metrics, logs, and traces —
 * traces only with the enhanced-telemetry beta) whose `OTEL_<SIGNAL>_EXPORTER`
 * list names `otlp` but has neither `OTEL_EXPORTER_OTLP_ENDPOINT` nor
 * `OTEL_EXPORTER_OTLP_<SIGNAL>_ENDPOINT`:
 *  - with no protocol either, telemetry can't start;
 *  - with a protocol, while another signal has its own endpoint, its data
 *    goes to localhost and is lost unless a collector runs there.
 * `ENABLE_BETA_TRACING_DETAILED` turns the notice off, as in the engine.
 * Returns at most one notice, or `[]`.
 */
export function otelEndpointNotices(env: Record<string, string | undefined>): string[] {
  const on = (v: string | undefined) => ["1", "true", "yes", "on"].includes((v ?? "").toLowerCase().trim());
  if (!on(env.CLAUDE_CODE_ENABLE_TELEMETRY) || env.ENABLE_BETA_TRACING_DETAILED) return [];
  const SIG = { metrics: "METRICS", logs: "LOGS", traces: "TRACES" } as const;
  type Signal = keyof typeof SIG;
  const list = (items: string[]) => new Intl.ListFormat("en").format(items);
  const tracesBeta = on(env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA ?? env.ENABLE_ENHANCED_TELEMETRY_BETA);
  const ownEndpoint = (s: Signal) => !!env[`OTEL_EXPORTER_OTLP_${SIG[s]}_ENDPOINT`];
  const fix = (sigs: Signal[]) =>
    `Set OTEL_EXPORTER_OTLP_ENDPOINT or ${list(sigs.map((s) => `OTEL_EXPORTER_OTLP_${SIG[s]}_ENDPOINT`))}, ` +
    `or take otlp out of ${list(sigs.map((s) => `OTEL_${SIG[s]}_EXPORTER`))}. Then restart Claude Code.`;

  const otlp = (["metrics", "logs", "traces"] as const).filter(
    (s) =>
      (s !== "traces" || tracesBeta) &&
      (env[`OTEL_${SIG[s]}_EXPORTER`] ?? "").split(",").some((e) => e.trim() === "otlp"),
  );
  const noEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT ? [] : otlp.filter((s) => !ownEndpoint(s));
  const noProtocol = env.OTEL_EXPORTER_OTLP_PROTOCOL
    ? []
    : noEndpoint.filter((s) => !env[`OTEL_EXPORTER_OTLP_${SIG[s]}_PROTOCOL`]);
  if (noProtocol.length > 0) {
    const outcome = noProtocol[0] === "traces" ? "metrics and traces aren't sent" : "telemetry can't start";
    return [`OpenTelemetry: No endpoint or protocol is set for ${list(noProtocol)}, so ${outcome}. ${fix(noProtocol)}`];
  }
  if (noEndpoint.length > 0 && otlp.some(ownEndpoint)) {
    return [
      `OpenTelemetry: No endpoint is set for ${list(noEndpoint)}, so they go to localhost, where they're lost unless a collector is running. ${fix(noEndpoint)}`,
    ];
  }
  return [];
}

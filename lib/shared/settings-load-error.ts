/**
 * CC 2.1.295 parity — "Added a warning to claude plugin install, enable,
 * disable and marketplace add when the settings file they write to does not
 * load".
 *
 * Claudius writes `enabledPlugins` / `extraKnownMarketplaces` /
 * `pluginConfigs` itself. `readSettings` refuses to treat a malformed
 * settings.json as `{}` (that would overwrite the user's file with a near-empty
 * one), so a plugin write to a broken scope fails. These helpers turn that
 * failure into a message the Plugins page can show — without leaking file
 * content.
 */

/**
 * Reduce a `JSON.parse` error message to something safe to send to the
 * browser. Recent V8 echoes a slice of the *source* into the message
 * (`Unexpected token 'h', "hello secret" is not valid JSON`), and settings
 * files hold `env` values and `apiKeyHelper` commands — so the quoted
 * fragment is dropped, keeping only the reason and position.
 *
 * Deliberately regex-light (indexOf + linear replaces): the input is derived
 * from file content, so no backtracking-prone patterns.
 */
export function sanitizeJsonParseReason(message: string): string {
  let reason = message;
  const SUFFIX = '" is not valid JSON';
  const echo = reason.indexOf(', "');
  if (echo >= 0 && reason.endsWith(SUFFIX)) reason = reason.slice(0, echo);
  // Any other quoted fragment that slipped through is source text too.
  reason = reason.replace(/"[^"]*"/g, '"…"');
  reason = reason.replace(/\s+/g, " ").trim();
  if (reason.length > 160) reason = `${reason.slice(0, 159)}…`;
  return reason || "invalid JSON";
}

/**
 * The error returned when a plugin/marketplace write targets a settings file
 * that doesn't parse. Names the file and states that it was left untouched —
 * which `readSettings` guarantees by throwing before any write happens.
 */
export function pluginSettingsWriteBlockedMessage(path: string, reason: string): string {
  return `${path} doesn't load (${reason}) — fix it before Claudius can change plugins there. The file was not changed.`;
}

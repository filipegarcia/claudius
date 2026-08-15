/**
 * CC 2.1.221 parity — Claude Code added plugin-config validation that
 * *warns* when a marketplace or plugin name is rejected (invalid characters,
 * an owner-wildcard used where a single repo is required, etc.) instead of
 * silently dropping it. See the SDK settings schema: marketplace names run
 * "Same validation as PluginMarketplaceSchema plus reserved-name rejection",
 * and the owner-wildcard form `owner/*` only means "every repo under this
 * owner" inside the managed policy lists (`strictKnownMarketplaces` /
 * `blockedMarketplaces`) — "Everywhere else … the value must name a single
 * repository — a wildcard is taken literally and fails to clone."
 *
 * Claudius has no CLI startup phase to hook, and the plugins page writes
 * marketplace refs / install refs straight into `settings.json` (bypassing
 * the CLI's `/plugin marketplace add` validation). So this mirrors the
 * upstream warning inline on the `/plugins` page as the user types. Kept
 * pure (no React) so it's unit-testable without a DOM.
 */

export type PluginLintWarning = { message: string };

/**
 * Plugin and marketplace *names* are identifiers: they must start with an
 * alphanumeric and may then contain letters, digits, `.`, `-`, or `_`. This
 * matches the manifest-name shape the SDK enforces (and mirrors the MCP
 * server-name charset `[a-zA-Z0-9_-]`, widened by `.` which plugin ids use).
 */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Lints an install reference typed into the "Install a plugin" form. Accepts
 * a bare `<name>` or the fully-qualified `<name>@<marketplace>` form (an
 * optional trailing `@<version>` segment is tolerated, not validated).
 * Returns a warning when the plugin or marketplace name would be rejected,
 * or `null` when the ref looks well-formed.
 */
export function lintPluginRef(ref: string): PluginLintWarning | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  if (/\s/.test(trimmed)) {
    return { message: "A plugin reference can't contain spaces." };
  }

  const parts = trimmed.split("@");
  const name = parts[0];
  const marketplace = parts.length >= 2 ? parts[1] : undefined;

  if (!name) {
    return { message: "Missing plugin name before “@”." };
  }
  if (!NAME_RE.test(name)) {
    return {
      message: `“${name}” isn't a valid plugin name — use letters, digits, “.”, “-”, or “_” (starting with a letter or digit).`,
    };
  }
  if (marketplace !== undefined) {
    if (!marketplace) {
      return { message: "Missing marketplace name after “@”." };
    }
    if (!NAME_RE.test(marketplace)) {
      return {
        message: `“${marketplace}” isn't a valid marketplace name — use letters, digits, “.”, “-”, or “_”.`,
      };
    }
  }
  return null;
}

/**
 * Lints a marketplace reference typed into the Marketplaces lists. The only
 * shape we can flag without false positives (refs may be `owner/repo`, git
 * URLs, or local paths) is the owner-wildcard `owner/*`, which is a valid
 * matcher *only* in the managed policy lists — pass `allowWildcard: true`
 * for the Blocked list. Everywhere else it's taken literally and fails to
 * clone. Whitespace is always rejected.
 */
export function lintMarketplaceRef(
  ref: string,
  opts?: { allowWildcard?: boolean },
): PluginLintWarning | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  if (/\s/.test(trimmed)) {
    return { message: "A marketplace reference can't contain spaces." };
  }
  if (!opts?.allowWildcard && /\/\*$/.test(trimmed)) {
    return {
      message:
        "The “owner/*” wildcard only matches inside blocked/strict policy lists — here it's taken literally and fails to clone. Name a single owner/repo instead.",
    };
  }
  return null;
}

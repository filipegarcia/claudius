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

  // `<ref> --marketplace <source>` (Claude Code 2.1.275): the CLI offers to
  // register the marketplace before installing when it isn't already known.
  // This is the one legitimate two-token ref, so split it off before the
  // whitespace check below — otherwise a correctly-typed flag would get
  // flagged as "can't contain spaces". The name half still gets the normal
  // NAME_RE check; the source half (a git URL, npm package, or local path)
  // isn't validated here for the same reason `lintMarketplaceRef` doesn't
  // validate marketplace sources beyond the wildcard case.
  const withMarketplaceFlag = trimmed.match(/^(\S+)\s+--marketplace(?:\s+(\S+))?$/);
  if (withMarketplaceFlag) {
    const [, refPart, source] = withMarketplaceFlag;
    const name = refPart.split("@")[0] ?? "";
    if (!NAME_RE.test(name)) {
      return {
        message: `“${name}” isn't a valid plugin name — use letters, digits, “.”, “-”, or “_” (starting with a letter or digit).`,
      };
    }
    if (!source) {
      return { message: "Missing a marketplace source after “--marketplace”." };
    }
    return null;
  }

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

/**
 * Names the bundled CLI reserves for Anthropic's own marketplaces (2.1.294
 * bundle: the official set, the community/directory names, and `healthcare`).
 * Compared case-insensitively. A marketplace may only be registered under one
 * of these when its source is a GitHub repo in the `anthropics/` org.
 */
const RESERVED_MARKETPLACE_NAMES: ReadonlySet<string> = new Set([
  "claude-code-marketplace",
  "claude-code-plugins",
  "claude-plugins-official",
  "anthropic-marketplace",
  "anthropic-plugins",
  "agent-skills",
  "anthropic-agent-skills",
  "life-sciences",
  "knowledge-work-plugins",
  "claude-for-legal",
  "claude-for-financial-services",
  "financial-services-plugins",
  "first-party-plugins",
  "claude-tag-plugins",
  "healthcare",
  "claude-community",
  "claude-plugins-community",
  "anthropic-plugin-directory",
  "claude-plugin-directory",
]);

/**
 * Install-routing suffixes: `<plugin>@npm` (and the reserved `@pip`, `@uv`,
 * `@cargo`, `@github`, `@gh`) route to a package registry instead of a
 * marketplace, so a marketplace under one of these names can never be
 * installed from — refused regardless of source (case-insensitive).
 */
const ROUTING_SUFFIX_NAMES: Readonly<Record<string, string>> = {
  npm: "plugins installed from an npm registry (<package>@npm)",
  pip: "plugins installed from a Python package index",
  uv: "plugins installed from a Python package index through uv",
  cargo: "plugins installed from a Rust crate registry",
  github: "plugins installed straight from a GitHub repository (<owner>/<repo>@github)",
  gh: "plugins installed straight from a GitHub repository",
};

/** True when `source` is a GitHub `anthropics/<repo>` source. */
function isAnthropicsGithubSource(source: unknown): boolean {
  if (!source || typeof source !== "object") return false;
  const s = source as { source?: unknown; repo?: unknown };
  return (
    s.source === "github" &&
    typeof s.repo === "string" &&
    /^anthropics\/[^/\s:]+$/i.test(s.repo.trim())
  );
}

/**
 * CC 2.1.295 parity — "Fixed claude plugin marketplace add reporting success
 * for a marketplace whose name no plugin can be installed under; such an add
 * is now refused". Plugins are installed as `<plugin>@<marketplace>`, so a
 * marketplace name with spaces, `@`, `/`, or a leading `.`/`-` can never be
 * the target of an install ref, nor can one named after an install-routing
 * suffix (`npm`, `gh`, …). The CLI also refuses Anthropic's reserved
 * marketplace names unless the source is a GitHub repo under `anthropics/`.
 *
 * `source` is the source the name will be registered with (pass the one being
 * typed so the reserved-name warning clears for an `anthropics/…` repo; when
 * it's absent the reserved check assumes a non-Anthropic source). Only the
 * ADD path calls this — existing entries keep working untouched.
 */
export function lintMarketplaceName(name: string, source?: unknown): PluginLintWarning | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (!NAME_RE.test(trimmed) || trimmed.includes("..")) {
    return {
      message: `“${trimmed}” can't be used as a marketplace name — plugins are installed as <plugin>@<marketplace>, so use letters, digits, “.”, “-”, or “_” (starting with a letter or digit).`,
    };
  }
  const lower = trimmed.toLowerCase();
  if (Object.hasOwn(ROUTING_SUFFIX_NAMES, lower)) {
    return {
      message: `“${trimmed}” is reserved for ${ROUTING_SUFFIX_NAMES[lower]} — use another name.`,
    };
  }
  if (RESERVED_MARKETPLACE_NAMES.has(lower) && !isAnthropicsGithubSource(source)) {
    return { message: `“${trimmed}” is reserved for Anthropic's official marketplace.` };
  }
  return null;
}

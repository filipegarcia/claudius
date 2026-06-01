import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Reader for the Claude Code global config at `~/.claude.json`.
 *
 * This file is maintained by the `claude` CLI itself — populated when
 * the user runs `claude /login` (and refreshed on every token-refresh
 * round-trip thereafter). It carries the canonical OAuth account info
 * the SDK reads to answer `accountInfo()` without a network call.
 *
 * We use it as a fallback source for the Account section in the
 * account-switcher — same data the SDK reads, so if an inference-only
 * token can't authorize against /api/oauth/profile, we can still show
 * the email/org by reading the file the SDK already trusts.
 *
 * Honors a `CLAUDIUS_CLAUDE_CONFIG_PATH` env override for tests.
 */

export type ClaudeGlobalOauthAccount = {
  accountUuid?: string;
  emailAddress?: string;
  displayName?: string;
  organizationUuid?: string;
  organizationName?: string;
  hasExtraUsageEnabled?: boolean;
  billingType?: string;
  accountCreatedAt?: string;
  subscriptionCreatedAt?: string;
};

function configPath(): string {
  const override = process.env.CLAUDIUS_CLAUDE_CONFIG_PATH;
  if (override && override.length > 0) return override;
  return join(homedir(), ".claude.json");
}

/**
 * Read `oauthAccount` from the Claude Code global config. Returns null
 * when the file is missing, unreadable, malformed, or doesn't carry an
 * oauthAccount block — any of which is a "don't surface this fallback"
 * signal for callers, not an error worth bubbling up.
 *
 * Cached for `CACHE_TTL_MS` to keep the per-request reads cheap; we
 * also don't expect the file to change often during a Claudius
 * session.
 */
let cached: { value: ClaudeGlobalOauthAccount | null; at: number } | null = null;
const CACHE_TTL_MS = 30_000;

export async function readClaudeGlobalOauthAccount(
  opts: { skipCache?: boolean } = {},
): Promise<ClaudeGlobalOauthAccount | null> {
  if (!opts.skipCache && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }
  try {
    const raw = await fs.readFile(configPath(), "utf8");
    const parsed = JSON.parse(raw) as { oauthAccount?: ClaudeGlobalOauthAccount };
    const acct = parsed.oauthAccount;
    if (!acct || typeof acct !== "object") {
      cached = { value: null, at: Date.now() };
      return null;
    }
    // Whitelist the fields we know the file carries — anything else
    // is ignored so a schema drift on the CLI side can't poison our
    // typed downstream consumers.
    const out: ClaudeGlobalOauthAccount = {};
    if (typeof acct.accountUuid === "string") out.accountUuid = acct.accountUuid;
    if (typeof acct.emailAddress === "string") out.emailAddress = acct.emailAddress;
    if (typeof acct.displayName === "string") out.displayName = acct.displayName;
    if (typeof acct.organizationUuid === "string") out.organizationUuid = acct.organizationUuid;
    if (typeof acct.organizationName === "string") out.organizationName = acct.organizationName;
    if (typeof acct.billingType === "string") out.billingType = acct.billingType;
    if (typeof acct.accountCreatedAt === "string") out.accountCreatedAt = acct.accountCreatedAt;
    if (typeof acct.subscriptionCreatedAt === "string") {
      out.subscriptionCreatedAt = acct.subscriptionCreatedAt;
    }
    if (typeof acct.hasExtraUsageEnabled === "boolean") {
      out.hasExtraUsageEnabled = acct.hasExtraUsageEnabled;
    }
    cached = { value: out, at: Date.now() };
    return out;
  } catch {
    cached = { value: null, at: Date.now() };
    return null;
  }
}

/** Test helper — wipes the in-memory cache. */
export function __resetClaudeGlobalConfigCache(): void {
  cached = null;
}

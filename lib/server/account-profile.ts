import {
  readAccountsRaw,
  updateAccountMetadata,
  type AccountProfile,
} from "./accounts-store";
import { readClaudeGlobalOauthAccount } from "./claude-global-config";

/**
 * Resolve account-profile metadata (email / org / subscription /
 * rate-limit tier) for an account-switcher profile, by calling
 * Anthropic's OAuth profile endpoint with the stored access token.
 *
 * Endpoint: `https://api.anthropic.com/api/oauth/profile`
 * Auth:     `Authorization: Bearer <accessToken>`
 *
 * This is the same endpoint Claude Code itself uses to populate its
 * status output (see
 * `claude-code-leak-main/src/services/oauth/getOauthProfile.ts`).
 *
 * Two reasons this lives server-side:
 *   1) The browser must never see the raw access token.
 *   2) The Anthropic endpoint isn't CORS-friendly anyway.
 *
 * Results are cached per profile id for `CACHE_TTL_MS` to keep the
 * Account page snappy and avoid hammering the profile API on every
 * navigation.
 */

/**
 * Plain shape exposed to the UI. Mirrors the `AccountInfo` fields the
 * Usage page already renders so the rewire is a one-liner there.
 */
export type AccountProfileInfo = {
  /** Used in the API-provider row. */
  provider: "firstParty";
  /** Account-switcher profile id this info was resolved from. */
  profileId: string;
  /** Profile label the user gave it ("Personal Max", etc.). */
  profileLabel: string;
  /** "oauth-token" | "api-key" — drives badges in the UI. */
  profileKind: AccountProfile["kind"];
  email?: string;
  displayName?: string;
  organizationUuid?: string;
  /** "max" | "pro" | "team" | "enterprise" — display label, capitalized. */
  subscriptionType?: string;
  rateLimitTier?: string;
  /** True if the lookup itself failed (network / 401 / etc.). */
  errored?: boolean;
  error?: string;
};

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = { info: AccountProfileInfo; fetchedAt: number };
const cache = new Map<string, CacheEntry>();

/**
 * Resolve the profile info for the given account id. Returns null when
 * the id doesn't exist (so the caller can fall back to per-session
 * info). For api-key profiles we don't have a comparable cheap endpoint
 * — return what we can derive from the stored profile metadata.
 */
export async function getProfileInfoForAccount(
  profileId: string,
  opts: { skipCache?: boolean } = {},
): Promise<AccountProfileInfo | null> {
  const cur = await readAccountsRaw();
  const profile = cur.profiles.find((p) => p.id === profileId);
  if (!profile) return null;

  if (!opts.skipCache) {
    const cached = cache.get(profileId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.info;
    }
  }

  // Build the fallback view from whatever we already have on hand
  // BEFORE attempting the live profile-endpoint round-trip. We layer
  // two cheap sources here:
  //   (1) the metadata we stored on the profile itself (captured from
  //       the token-exchange response at sign-in time, when present)
  //   (2) the SDK's global ~/.claude.json oauthAccount block, which
  //       Claude Code itself populated when the user first signed in.
  //       This is the SAME data the SDK reads to answer accountInfo()
  //       — using it here is what makes the email/org show up for
  //       profiles that were added BEFORE this fix (no token-exchange
  //       metadata) but whose underlying account matches the user's
  //       /login'd identity.
  //
  // Matching policy: when we know this profile's accountUuid, we only
  // adopt the global config's email/etc. if its accountUuid matches —
  // otherwise we'd surface the wrong identity for a second account.
  // When the profile has no accountUuid (legacy / paste-token), we
  // adopt the global config as a best-guess fallback so the section
  // isn't empty, and flag it with a `fromGlobalConfig` hint so the UI
  // can tone down the certainty.
  const globalAcct = await readClaudeGlobalOauthAccount().catch(() => null);
  let useGlobal = false;
  let globalGuess = false;
  if (globalAcct) {
    if (profile.accountUuid && globalAcct.accountUuid) {
      useGlobal = profile.accountUuid === globalAcct.accountUuid;
    } else if (!profile.accountUuid) {
      // Best-guess for legacy profiles. Better than showing "—".
      useGlobal = true;
      globalGuess = true;
    }
  }
  const fromCached: AccountProfileInfo = {
    provider: "firstParty",
    profileId: profile.id,
    profileLabel: profile.label,
    profileKind: profile.kind,
    email: profile.emailAddress ?? (useGlobal ? globalAcct?.emailAddress : undefined),
    displayName: useGlobal ? globalAcct?.displayName : undefined,
    organizationUuid:
      profile.organizationUuid ?? (useGlobal ? globalAcct?.organizationUuid : undefined),
    subscriptionType: profile.subscriptionType,
    // When the fallback came from the global config without an
    // accountUuid match, we surface a soft note instead of presenting
    // it as authoritative.
    ...(globalGuess
      ? { error: "shown from local Claude Code config — verify identity" }
      : {}),
  };

  // API-key profiles: no cheap lookup. Return whatever we have stored
  // (typically nothing) so the UI still renders the kind badge + label.
  if (profile.kind === "api-key") {
    cache.set(profileId, { info: fromCached, fetchedAt: Date.now() });
    return fromCached;
  }

  // OAuth-token: try a live round-trip to Anthropic's profile endpoint.
  // Inference-only tokens (the long-lived ones `setup-token` mints) may
  // not be authorized for this endpoint — that's expected. On any
  // error we fall back to the cached metadata from the token-exchange
  // response, so the section stays populated through 529s, network
  // hiccups, and scope refusals.
  try {
    const res = await fetch(PROFILE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${profile.secret}`,
        // The CLI sends Content-Type even on GETs (see
        // getOauthProfile.ts); mirroring keeps us closest to the
        // reference behavior.
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      // Build a "fallback + warning" response. We DO NOT cache it —
      // 5xx is transient, 4xx may be scope-limited and will stay that
      // way for the life of the token, but in both cases the cached
      // metadata is the right thing to keep displaying.
      const note =
        res.status === 401
          ? "token rejected (re-add this account)"
          : res.status === 403
            ? "scope-limited (inference-only token — using cached info)"
            : res.status >= 500
              ? `Anthropic temporarily unavailable (HTTP ${res.status})`
              : `profile endpoint HTTP ${res.status}`;
      return {
        ...fromCached,
        // Surface as `errored` only when we also have no cached data
        // to fall back on. With cached data the error becomes a soft
        // "stale" note in the UI rather than a scary red banner.
        errored: !(fromCached.email || fromCached.subscriptionType),
        error: note,
      };
    }
    const data = (await res.json()) as {
      account?: { uuid?: string; email?: string; display_name?: string };
      organization?: {
        uuid?: string;
        organization_type?: string;
        rate_limit_tier?: string;
      };
    };
    const orgType = data.organization?.organization_type;
    const subscriptionType =
      orgType === "claude_max"
        ? "Claude Max"
        : orgType === "claude_pro"
          ? "Claude Pro"
          : orgType === "claude_team"
            ? "Claude Team"
            : orgType === "claude_enterprise"
              ? "Claude Enterprise"
              : fromCached.subscriptionType;
    const info: AccountProfileInfo = {
      provider: "firstParty",
      profileId: profile.id,
      profileLabel: profile.label,
      profileKind: profile.kind,
      email: data.account?.email ?? fromCached.email,
      displayName: data.account?.display_name,
      organizationUuid: data.organization?.uuid ?? fromCached.organizationUuid,
      subscriptionType,
      rateLimitTier: data.organization?.rate_limit_tier,
    };
    cache.set(profileId, { info, fetchedAt: Date.now() });
    // Backfill the on-disk profile so future lookups have a fallback
    // even after a Claudius restart wipes the in-memory cache. Also
    // unlocks the SDK env-var fast path on the NEXT session spawn:
    // once we have all three of accountUuid/email/orgUuid persisted,
    // `buildEnvForProfile` exports them and the SDK skips
    // /api/oauth/profile entirely (the path that's failing under
    // inference-only scope). Fire-and-forget — a write failure isn't
    // worth surfacing to the user.
    void updateAccountMetadata(profile.id, {
      accountUuid: data.account?.uuid,
      emailAddress: info.email,
      organizationUuid: info.organizationUuid,
      subscriptionType: info.subscriptionType,
    }).catch(() => {});
    return info;
  } catch (err) {
    // Network failure, JSON parse, etc. — return cached info with a
    // soft warning. Same don't-cache-transient logic as the !res.ok
    // branch above.
    return {
      ...fromCached,
      errored: !(fromCached.email || fromCached.subscriptionType),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Drop a cached profile so the next lookup re-fetches. Called after
 * adding / switching / deleting an account so the UI doesn't show
 * stale data.
 */
export function invalidateProfileCache(profileId?: string): void {
  if (profileId) cache.delete(profileId);
  else cache.clear();
}

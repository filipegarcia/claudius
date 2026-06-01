import { createHash, randomBytes } from "node:crypto";

/**
 * Anthropic OAuth manual-flow driver for the account switcher.
 *
 * This implements the same Authorization Code + PKCE flow that the
 * Claude Code CLI's `setup-token` command uses, but driven from the
 * browser instead of a terminal. We deliberately request the
 * "inferenceOnly" scope (`user:inference`) because that's the codepath
 * the CLI uses to mint LONG-LIVED tokens — see
 * `claude-code-leak-main/src/services/oauth/client.ts`:
 *
 *   const scopesToUse = inferenceOnly
 *     ? [CLAUDE_AI_INFERENCE_SCOPE] // Long-lived inference-only tokens
 *     : ALL_OAUTH_SCOPES
 *
 * A short-lived session-scoped token would die in hours and defeat the
 * "set the profile once, use it for weeks" UX. Inference-only is the
 * SDK-compatible shape for `CLAUDE_CODE_OAUTH_TOKEN`.
 *
 * Endpoints / client_id / scope constants come from the leaked CLI
 * source already checked into this repo
 * (`claude-code-leak-main/src/constants/oauth.ts`) — we're not
 * reverse-engineering anything, we're reusing the same OAuth client
 * Anthropic ships in `@anthropic-ai/claude-code`. If Anthropic rotates
 * these endpoints we'll have to mirror the constants change.
 */

const OAUTH_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_MANUAL_REDIRECT_URL =
  "https://platform.claude.com/oauth/code/callback";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// Scope set that produces a long-lived token via the inferenceOnly
// codepath the CLI uses for `setup-token`. Single scope, space-joined
// in the request.
const OAUTH_SCOPES = ["user:inference"];

/** Lifetime cap for an in-progress flow before we GC its PKCE state. */
const FLOW_TTL_MS = 10 * 60 * 1000; // 10min — covers a slow user login

export type OAuthStartResult = {
  /** Opaque id the client passes back to /complete to resume the flow. */
  flowId: string;
  /** Anthropic authorize URL the user opens to grant access. */
  authUrl: string;
  /**
   * The exact `state` value the user must paste back (or the code
   * returned will already carry it as `<code>#<state>`). Surfaced so
   * the UI can hint the format.
   */
  state: string;
};

export type OAuthExchangeResult = {
  accessToken: string;
  /** Server-issued refresh token. Stored alongside the access token. */
  refreshToken?: string;
  /** Unix-ms instant after which the access token stops working. */
  expiresAt?: number;
  /** Space-separated scope string the server actually granted. */
  scope?: string;
  /**
   * Best-effort account info from the token-exchange response. These
   * fields are persisted on the AccountProfile and used as the
   * fallback when the /api/oauth/profile lookup fails or returns a
   * transient error (Anthropic 529s, etc.). Mirrors what
   * `claude setup-token` captures from the same response —
   * see `services/oauth/index.ts.formatTokens`.
   *
   * All three of accountUuid/emailAddress/organizationUuid are
   * needed together for the SDK env-var fast path
   * (CLAUDE_CODE_{ACCOUNT_UUID,USER_EMAIL,ORGANIZATION_UUID}) —
   * see `claude-code-leak-main/src/services/oauth/client.ts:457`.
   */
  accountUuid?: string;
  emailAddress?: string;
  organizationUuid?: string;
  /**
   * Subscription tier from the token-exchange's account block, when
   * present. The response sometimes carries `organization.organization_type`
   * which we normalize to a display label.
   */
  subscriptionType?: string;
};

type PendingFlow = {
  codeVerifier: string;
  state: string;
  createdAt: number;
};

// In-memory map of flowId → PKCE state. Lives for the lifetime of the
// Node process which is fine: an OAuth flow that survives a restart is
// rare and the user can just click "Sign in" again. A bounded TTL sweep
// keeps the map from leaking across abandoned flows.
const pendingFlows = new Map<string, PendingFlow>();

function gcFlows(): void {
  const cutoff = Date.now() - FLOW_TTL_MS;
  for (const [id, flow] of pendingFlows.entries()) {
    if (flow.createdAt < cutoff) pendingFlows.delete(id);
  }
}

/**
 * RFC 7636 PKCE code verifier — 32 random bytes, base64url-encoded.
 * (43 chars after padding strip, well inside the 43–128 range.)
 */
function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(32));
}

function generateCodeChallenge(verifier: string): string {
  return base64UrlEncode(createHash("sha256").update(verifier).digest());
}

function generateState(): string {
  return base64UrlEncode(randomBytes(24));
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function newFlowId(): string {
  return `oauth_${randomBytes(8).toString("hex")}`;
}

/**
 * Begin an OAuth flow. Returns the authorize URL for the user to open
 * and the flowId to resume on /complete. The PKCE verifier is kept
 * server-side so the client never sees it (the verifier is the secret
 * that proves we're the same party that initiated the flow).
 */
export function startOAuthFlow(): OAuthStartResult {
  gcFlows();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();
  const flowId = newFlowId();
  pendingFlows.set(flowId, { codeVerifier, state, createdAt: Date.now() });

  const url = new URL(OAUTH_AUTHORIZE_URL);
  // `code=true` tells the consent screen to show the Claude-Max upsell
  // and emit the manual-paste UI on the success page — matches what
  // setup-token requests.
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", OAUTH_MANUAL_REDIRECT_URL);
  url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  return { flowId, authUrl: url.toString(), state };
}

/**
 * Exchange the user-pasted code for an access token. The user pastes a
 * single string of the form `<code>#<state>` (Claude's manual-redirect
 * success page emits exactly that — see the CLI's
 * `OAuthFlowStep.tsx`). We accept either the combined form OR the bare
 * code (in which case we trust the matching state from the saved
 * verifier — equivalent to OAuth servers that only return the code).
 */
export async function exchangeOAuthCode(
  flowId: string,
  rawCode: string,
): Promise<OAuthExchangeResult> {
  gcFlows();
  const flow = pendingFlows.get(flowId);
  if (!flow) throw new Error("flow expired or unknown — please restart sign-in");
  pendingFlows.delete(flowId);

  const trimmed = rawCode.trim();
  if (!trimmed) throw new Error("authorization code required");
  // The Claude manual-paste UI hands the user a `<code>#<state>` blob.
  // If the user pasted that whole thing, split it; if they pasted just
  // the code, fall back to our stored state. Either path validates the
  // state matches before doing the exchange.
  let code = trimmed;
  let state = flow.state;
  if (trimmed.includes("#")) {
    const parts = trimmed.split("#");
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      throw new Error("expected code#state format from the success page");
    }
    code = parts[0];
    state = parts[1];
    if (state !== flow.state) {
      throw new Error("OAuth state mismatch — please restart sign-in");
    }
  }

  const body = {
    grant_type: "authorization_code",
    code,
    redirect_uri: OAUTH_MANUAL_REDIRECT_URL,
    client_id: OAUTH_CLIENT_ID,
    code_verifier: flow.codeVerifier,
    state,
    // Request the 1-year lifetime the canonical `claude setup-token`
    // flow uses — without this, tokens carry the server default
    // (~minutes/hours) and the profile dies before the user even
    // notices. See ConsoleOAuthFlow.tsx:203 in the reference repo:
    //   `expiresIn: mode === 'setup-token' ? 365 * 24 * 60 * 60 : undefined`
    expires_in: 365 * 24 * 60 * 60,
  };

  // `fetch` is the standard runtime API since Node 18 — no axios dep.
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // Keep the request snappy — a hung exchange will just bubble up as
    // a fetch error and the user can retry. AbortController not needed
    // because fetch's default timeout is reasonable for the auth path.
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401) {
      throw new Error(
        "Invalid authorization code. The codes expire fast — try signing in again.",
      );
    }
    throw new Error(`token exchange failed (${res.status}): ${text || res.statusText}`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    account?: { uuid?: string; email_address?: string };
    organization?: { uuid?: string; organization_type?: string };
  };

  if (!data.access_token) {
    throw new Error("token exchange returned no access_token");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt:
      typeof data.expires_in === "number"
        ? Date.now() + data.expires_in * 1000
        : undefined,
    scope: data.scope,
    accountUuid: data.account?.uuid,
    emailAddress: data.account?.email_address,
    organizationUuid: data.organization?.uuid,
    subscriptionType: subscriptionTypeFromOrgType(data.organization?.organization_type),
  };
}

/**
 * Map Anthropic's `organization_type` enum onto a human display label
 * (parity with the reference CLI's switch in
 * `services/oauth/client.ts.fetchProfileInfo`). Returns undefined for
 * unknown types so the UI shows "—" instead of a raw enum.
 */
function subscriptionTypeFromOrgType(orgType?: string): string | undefined {
  switch (orgType) {
    case "claude_max":
      return "Claude Max";
    case "claude_pro":
      return "Claude Pro";
    case "claude_team":
      return "Claude Team";
    case "claude_enterprise":
      return "Claude Enterprise";
    default:
      return undefined;
  }
}

/**
 * Test-only handle on the pending-flow map so the unit test for the
 * URL builder can introspect state without going through a live HTTP
 * exchange. Not exported from the package root; consumers should use
 * `startOAuthFlow` / `exchangeOAuthCode`.
 */
export function __debugFlowCount(): number {
  return pendingFlows.size;
}

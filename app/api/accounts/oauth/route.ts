import { NextResponse } from "next/server";
import {
  exchangeOAuthCode,
  startOAuthFlow,
} from "@/lib/server/account-oauth";
import {
  addAccount,
  readAccountsPublic,
} from "@/lib/server/accounts-store";
import { invalidateProfileCache } from "@/lib/server/account-profile";

export const runtime = "nodejs";

type PostBody =
  | { action: "start" }
  | { action: "complete"; flowId: string; code: string; label: string };

/**
 * Browser OAuth flow for the account switcher.
 *
 * `action: "start"` returns an authorize URL — the user opens it,
 * signs in on claude.ai, and gets a `<code>#<state>` blob from the
 * success page.
 *
 * `action: "complete"` takes that blob plus a user-chosen label,
 * exchanges it for a long-lived OAuth token via the Anthropic token
 * endpoint, and stores it as a new account profile. Returns the
 * updated public accounts state so the UI can re-render without a
 * second GET.
 *
 * Both branches POST to this single endpoint to keep the route shallow.
 */
export async function POST(req: Request) {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (body.action === "start") {
    const flow = startOAuthFlow();
    return NextResponse.json(flow);
  }

  if (body.action === "complete") {
    if (!body.flowId || !body.code || !body.label) {
      return NextResponse.json(
        { error: "flowId, code, label required" },
        { status: 400 },
      );
    }
    try {
      const exchanged = await exchangeOAuthCode(body.flowId, body.code);
      // Suggest the granted email as a default suffix when the user's
      // label is generic — purely cosmetic, no security impact.
      const label =
        body.label.trim() ||
        (exchanged.emailAddress ? `Claude (${exchanged.emailAddress})` : "Claude");
      const added = await addAccount({
        label,
        kind: "oauth-token",
        secret: exchanged.accessToken,
        // Pin whatever the token-exchange response told us about the
        // account. accountUuid + emailAddress + organizationUuid are
        // ALL needed together for `buildEnvForProfile`'s SDK env-var
        // fast path (CLAUDE_CODE_{ACCOUNT_UUID,USER_EMAIL,ORGANIZATION_UUID})
        // — the SDK short-circuits to those instead of hitting
        // /api/oauth/profile, which is the path that's failing under
        // inference-only scope.
        accountUuid: exchanged.accountUuid,
        emailAddress: exchanged.emailAddress,
        organizationUuid: exchanged.organizationUuid,
        subscriptionType: exchanged.subscriptionType,
      });
      // Fresh token, fresh profile — drop any stale cache so the
      // next Account-page read hits the OAuth endpoint with the new
      // credential.
      invalidateProfileCache(added.profile.id);
      const state = await readAccountsPublic();
      return NextResponse.json({
        state,
        emailAddress: exchanged.emailAddress ?? null,
      });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "oauth failed" },
        { status: 400 },
      );
    }
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}

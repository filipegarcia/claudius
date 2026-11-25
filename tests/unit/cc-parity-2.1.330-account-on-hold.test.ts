import { afterEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountOnHoldError, exchangeOAuthCode, startOAuthFlow } from "@/lib/server/account-oauth";
import {
  ACCOUNT_RESTRICTED_URL,
  accountOnHoldAppealUrl,
  accountOnHoldFromTokenError,
  accountOnHoldSignInNotice,
} from "@/lib/shared/account-on-hold";
import { SignInErrorText } from "@/components/accounts/SignInErrorText";

/**
 * CC 2.1.330 — "[VSCode] Fixed signing in to an account on hold showing a
 * generic failure instead of the on-hold notice and appeal link".
 *
 * An on-hold account's sign-in showed `token exchange failed (400):
 * {"error":"invalid_grant","error_description":"account_on_hold",…}`. It now
 * gets the engine's notice, with the appeal link vetted by the engine's rule.
 */

const REF = "TS-0a1b2c3d-1111-2222-3333-444455556666";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("accountOnHoldAppealUrl — the engine's link check", () => {
  test("a plain https claude.ai / anthropic.com URL is kept", () => {
    expect(accountOnHoldAppealUrl(`https://claude.ai/restricted?ref=${REF}`)).toBe(`https://claude.ai/restricted?ref=${REF}`);
    expect(accountOnHoldAppealUrl("https://support.anthropic.com/appeal")).toBe("https://support.anthropic.com/appeal");
    expect(accountOnHoldAppealUrl("https://claude.ai")).toBe("https://claude.ai/");
    // Normalized by URL first, as in the engine: the escaped form is what's linked.
    expect(accountOnHoldAppealUrl("https://claude.ai/a b?q=<x>")).toBe("https://claude.ai/a%20b?q=%3Cx%3E");
  });

  test("anything else falls back to the restricted page", () => {
    for (const bad of [
      undefined,
      42,
      "http://claude.ai/restricted",
      "https://evil.example/claude.ai",
      "https://claude.ai.evil.example/x",
      "https://user:pw@claude.ai/x",
      "https://claude.ai:8443/x",
      "https://claude.ai/x#frag",
      "https://claude.ai/x?",
      "javascript:alert(1)",
      `https://claude.ai/${"a".repeat(2100)}`,
    ]) {
      expect(accountOnHoldAppealUrl(bad), String(bad)).toBe(ACCOUNT_RESTRICTED_URL);
    }
  });
});

describe("the notice and the token-error shape", () => {
  test("the engine's wording, with the reference when the link carries one", () => {
    expect(accountOnHoldSignInNotice(ACCOUNT_RESTRICTED_URL)).toBe(
      "Your account is on hold and can't sign in to Claude Code. View details or appeal: https://claude.ai/restricted",
    );
    expect(accountOnHoldSignInNotice(`https://claude.ai/restricted?ref=${REF}`)).toBe(
      `Your account is on hold and can't sign in to Claude Code. View details or appeal: https://claude.ai/restricted?ref=${REF} (Reference: ${REF})`,
    );
  });

  test("invalid_grant or access_denied with account_on_hold; error_uri optional", () => {
    expect(accountOnHoldFromTokenError('{"error":"invalid_grant","error_description":"account_on_hold"}')).toEqual({
      appealUrl: ACCOUNT_RESTRICTED_URL,
    });
    expect(
      accountOnHoldFromTokenError(
        JSON.stringify({ error: "access_denied", error_description: "account_on_hold", error_uri: `https://claude.ai/restricted?ref=${REF}` }),
      ),
    ).toEqual({ appealUrl: `https://claude.ai/restricted?ref=${REF}` });
    expect(
      accountOnHoldFromTokenError(
        JSON.stringify({ error: "invalid_grant", error_description: "account_on_hold", error_uri: "http://phish.example/x" }),
      ),
    ).toEqual({ appealUrl: ACCOUNT_RESTRICTED_URL });
  });

  test("other errors are not on-hold", () => {
    expect(accountOnHoldFromTokenError('{"error":"invalid_grant","error_description":"Invalid code"}')).toBeNull();
    expect(accountOnHoldFromTokenError('{"error":"invalid_scope","error_description":"account_on_hold"}')).toBeNull();
    expect(
      accountOnHoldFromTokenError('{"error":"invalid_grant","error_description":"account_on_hold","error_uri":null}'),
    ).toBeNull();
    expect(accountOnHoldFromTokenError("account_on_hold")).toBeNull();
    expect(accountOnHoldFromTokenError("")).toBeNull();
  });
});

describe("exchangeOAuthCode — an account on hold", () => {
  test("throws the notice with the appeal link, not the raw token error", async () => {
    const body = JSON.stringify({
      error: "invalid_grant",
      error_description: "account_on_hold",
      error_uri: `https://claude.ai/restricted?ref=${REF}`,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 400 })));
    const { flowId, state } = startOAuthFlow();
    const err = await exchangeOAuthCode(flowId, `abc#${state}`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountOnHoldError);
    expect((err as AccountOnHoldError).appealUrl).toBe(`https://claude.ai/restricted?ref=${REF}`);
    expect((err as Error).message).toBe(
      `Your account is on hold and can't sign in to Claude Code. View details or appeal: https://claude.ai/restricted?ref=${REF} (Reference: ${REF})`,
    );
    expect((err as Error).message).not.toContain("token exchange failed");
  });

  test("a non-https error_uri is replaced by the restricted page", async () => {
    const body = JSON.stringify({ error: "access_denied", error_description: "account_on_hold", error_uri: "http://x.example/" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 403 })));
    const { flowId } = startOAuthFlow();
    const err = (await exchangeOAuthCode(flowId, "abc").catch((e: unknown) => e)) as AccountOnHoldError;
    expect(err.appealUrl).toBe(ACCOUNT_RESTRICTED_URL);
  });
});

describe("SignInErrorText", () => {
  const notice = accountOnHoldSignInNotice(`https://claude.ai/restricted?ref=${REF}`);
  const render = (message: string, appealUrl?: string | null) =>
    renderToStaticMarkup(createElement(SignInErrorText, { message, appealUrl }));

  test("links the appeal URL where it appears in the notice", () => {
    const html = render(notice, `https://claude.ai/restricted?ref=${REF}`);
    expect(html).toContain(
      `View details or appeal: <a href="https://claude.ai/restricted?ref=${REF}" target="_blank" rel="noreferrer"`,
    );
    expect(html).toContain(`</a> (Reference: ${REF})`);
  });

  test("no link for a URL the engine's rule rejects, or one not in the message", () => {
    expect(render("Your account is on hold … appeal: http://evil.example/", "http://evil.example/")).not.toContain("<a");
    expect(render("Sign-in failed", ACCOUNT_RESTRICTED_URL)).toBe("Sign-in failed");
    expect(render("Sign-in failed")).toBe("Sign-in failed");
  });
});

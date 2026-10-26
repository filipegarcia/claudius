import { afterEach, describe, expect, test, vi } from "vitest";

import {
  REFUSED_AUTH_CODE_MESSAGE,
  exchangeOAuthCode,
  isRefusedAuthCode,
  startOAuthFlow,
} from "@/lib/server/account-oauth";

/**
 * CC 2.1.311 parity — a refused pasted sign-in code says the code may be
 * expired or already used, and to sign in again. Mirrors the engine's
 * predicate (400/401 + `invalid_grant`) and its exact wording; every other
 * token-endpoint failure keeps its own message.
 */

function stubTokenEndpoint(status: number, body: string) {
  const fetchMock = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isRefusedAuthCode", () => {
  test("400 or 401 with invalid_grant is a refused code", () => {
    expect(isRefusedAuthCode(400, '{"error":"invalid_grant","error_description":"bad"}')).toBe(true);
    expect(isRefusedAuthCode(401, '{"error":"invalid_grant"}')).toBe(true);
    expect(isRefusedAuthCode(400, '{"error":{"type":"invalid_grant","message":"x"}}')).toBe(true);
  });

  test("other errors and statuses are not", () => {
    expect(isRefusedAuthCode(400, '{"error":"invalid_scope"}')).toBe(false);
    expect(isRefusedAuthCode(400, '{"error":"invalid_client"}')).toBe(false);
    expect(isRefusedAuthCode(500, '{"error":"invalid_grant"}')).toBe(false);
    expect(isRefusedAuthCode(403, '{"error":"invalid_grant"}')).toBe(false);
    expect(isRefusedAuthCode(400, "Bad Request")).toBe(false);
    expect(isRefusedAuthCode(400, "")).toBe(false);
  });
});

describe("exchangeOAuthCode — refused code", () => {
  test("a 400 invalid_grant surfaces the sign-in-again message", async () => {
    stubTokenEndpoint(400, '{"error":"invalid_grant","error_description":"Invalid code"}');
    const { flowId, state } = startOAuthFlow();
    await expect(exchangeOAuthCode(flowId, `abc123#${state}`)).rejects.toThrow(REFUSED_AUTH_CODE_MESSAGE);
  });

  test("a 401 invalid_grant does too", async () => {
    stubTokenEndpoint(401, '{"error":"invalid_grant"}');
    const { flowId } = startOAuthFlow();
    await expect(exchangeOAuthCode(flowId, "abc123")).rejects.toThrow(REFUSED_AUTH_CODE_MESSAGE);
  });

  test("an unrelated 400 keeps the raw status and body", async () => {
    stubTokenEndpoint(400, '{"error":"invalid_scope"}');
    const { flowId } = startOAuthFlow();
    await expect(exchangeOAuthCode(flowId, "abc123")).rejects.toThrow(
      'token exchange failed (400): {"error":"invalid_scope"}',
    );
  });

  test("a bare 401 keeps the old expired-code hint", async () => {
    stubTokenEndpoint(401, "Unauthorized");
    const { flowId } = startOAuthFlow();
    await expect(exchangeOAuthCode(flowId, "abc123")).rejects.toThrow(/Invalid authorization code/);
  });

  test("the message says the code may be expired or used and to sign in again", () => {
    expect(REFUSED_AUTH_CODE_MESSAGE).toMatch(/expired, already used/);
    expect(REFUSED_AUTH_CODE_MESSAGE).toMatch(/Sign in again/);
  });
});

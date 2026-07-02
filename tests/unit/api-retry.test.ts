import { describe, expect, test } from "vitest";
import {
  ANTHROPIC_STATUS_URL,
  describeApiRetry,
  humanizeApiRetryError,
  type ApiRetryState,
} from "@/lib/client/api-retry";

function retry(overrides: Partial<ApiRetryState> = {}): ApiRetryState {
  return {
    attempt: 1,
    maxRetries: 5,
    retryDelayMs: 1000,
    errorStatus: null,
    error: "server_error",
    ...overrides,
  };
}

describe("humanizeApiRetryError", () => {
  test("maps known SDK error codes to friendly phrases", () => {
    expect(humanizeApiRetryError("overloaded")).toBe("high demand on Anthropic's API");
    expect(humanizeApiRetryError("rate_limit")).toBe("a rate limit");
    expect(humanizeApiRetryError("server_error")).toBe("a server error");
  });

  test("falls back to a generic phrase for unrecognized codes", () => {
    expect(humanizeApiRetryError("some_future_code")).toBe("a temporary error");
    expect(humanizeApiRetryError("")).toBe("a temporary error");
  });
});

describe("describeApiRetry", () => {
  test("first attempt (non-overload) shows a generic retrying line, no reason", () => {
    const { message, showStatusLink } = describeApiRetry(retry({ attempt: 1, error: "server_error" }));
    expect(message).toBe("Retrying the request…");
    expect(showStatusLink).toBe(false);
  });

  test("second attempt (non-overload) names the reason and attempt count", () => {
    const { message, showStatusLink } = describeApiRetry(
      retry({ attempt: 2, maxRetries: 5, error: "rate_limit" }),
    );
    expect(message).toBe("Retrying after a rate limit (attempt 2/5)…");
    expect(showStatusLink).toBe(false);
  });

  test("third+ attempt keeps naming the reason", () => {
    const { message } = describeApiRetry(retry({ attempt: 4, maxRetries: 8, error: "server_error" }));
    expect(message).toBe("Retrying after a server error (attempt 4/8)…");
  });

  test("overload replaces the tip with a status-page link, even on the first attempt", () => {
    const { message, showStatusLink } = describeApiRetry(retry({ attempt: 1, error: "overloaded" }));
    expect(message).toMatch(/overloaded/i);
    expect(showStatusLink).toBe(true);
  });

  test("overload stays on the status-page link regardless of attempt number", () => {
    const { showStatusLink } = describeApiRetry(retry({ attempt: 3, error: "overloaded" }));
    expect(showStatusLink).toBe(true);
  });
});

test("ANTHROPIC_STATUS_URL is the public status page", () => {
  expect(ANTHROPIC_STATUS_URL).toBe("https://status.anthropic.com");
});

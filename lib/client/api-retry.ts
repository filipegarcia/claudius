/**
 * Pure presentation logic for the SDK's `api_retry` system message
 * (`SDKAPIRetryMessage` in `@anthropic-ai/claude-agent-sdk`), emitted when an
 * API request fails with a retryable error and will be retried after a
 * delay — connection drops, 5xx responses, rate limits, and Anthropic's own
 * 529 "Overloaded" status.
 *
 * Mirrors the Claude Code CLI's 2.1.198 "Improved API retry UX": the error
 * reason is shown once the SDK is on its second attempt (the first retry is
 * usually a transient blip not worth naming), and a status-page link
 * replaces the ordinary spinner tip while the API is specifically
 * overloaded — that's the one case where "check back later" is actionable
 * advice rather than noise.
 *
 * Extracted from the rendering components so the attempt/reason logic is
 * unit-testable without mounting React.
 */

/** Mirrors the SDK's `SDKAssistantMessageError` union (sdk.d.ts). */
export type ApiRetryErrorReason =
  | "authentication_failed"
  | "oauth_org_not_allowed"
  | "billing_error"
  | "rate_limit"
  | "overloaded"
  | "invalid_request"
  | "model_not_found"
  | "server_error"
  | "unknown"
  | "max_output_tokens";

/** Client-local mirror of `SDKAPIRetryMessage`'s payload fields. */
export type ApiRetryState = {
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  errorStatus: number | null;
  error: ApiRetryErrorReason | (string & {});
};

/**
 * Anthropic's public status page. Surfaced only when the retry is due to
 * an overload (529) — "check back later" is genuinely actionable there,
 * unlike a one-off connection blip.
 */
export const ANTHROPIC_STATUS_URL = "https://status.anthropic.com";

/**
 * The SDK's `attempt` counts *retries*, 1-indexed — `attempt: 1` is the
 * first retry after the initial request failed. "After the second attempt"
 * in the CLI's changelog means once the SDK reports `attempt >= 2`.
 */
const SHOW_REASON_AT_ATTEMPT = 2;

const REASON_COPY: Record<string, string> = {
  authentication_failed: "an authentication error",
  oauth_org_not_allowed: "an organization access error",
  billing_error: "a billing error",
  rate_limit: "a rate limit",
  overloaded: "high demand on Anthropic's API",
  invalid_request: "an invalid request error",
  model_not_found: "a model availability error",
  server_error: "a server error",
  max_output_tokens: "an output-length limit",
  unknown: "a temporary error",
};

/** Human-readable reason phrase for one of the SDK's retry error codes. */
export function humanizeApiRetryError(error: string): string {
  return REASON_COPY[error] ?? "a temporary error";
}

export type ApiRetryDescription = {
  /** Line to render in place of the rotating spinner tip. */
  message: string;
  /** When true, render a link to {@link ANTHROPIC_STATUS_URL} alongside the message. */
  showStatusLink: boolean;
};

/**
 * Decide what the "Claude is working…" row should say while a retry is in
 * flight. Pure so the attempt-gating and overload special-case are
 * unit-testable independent of the spinner component.
 */
export function describeApiRetry(retry: ApiRetryState): ApiRetryDescription {
  if (retry.error === "overloaded") {
    return {
      message: "Anthropic's API is overloaded right now — Claude will keep retrying.",
      showStatusLink: true,
    };
  }
  if (retry.attempt >= SHOW_REASON_AT_ATTEMPT) {
    return {
      message: `Retrying after ${humanizeApiRetryError(retry.error)} (attempt ${retry.attempt}/${retry.maxRetries})…`,
      showStatusLink: false,
    };
  }
  return { message: "Retrying the request…", showStatusLink: false };
}

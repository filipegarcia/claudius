import { describe, expect, test } from "vitest";
import { STARTUP_FAILURE_REASON_LABELS } from "@/lib/client/use-session";

/**
 * SDK 0.3.274 — `startup_failure_reason` on the zeroed error result a
 * stream-json run (Claudius's session process) writes before exiting on a
 * known startup failure. `STARTUP_FAILURE_REASON_LABELS` maps each of the
 * SDK's documented reason codes (see `SDKStartupFailureReason` in
 * node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts) to the friendly copy
 * the "Session failed to start" banner shows. This pins the full catalog so
 * a future SDK reason value doesn't silently fall back to the raw code.
 */
describe("STARTUP_FAILURE_REASON_LABELS", () => {
  const REASONS = [
    "org_pin_api_key_conflict",
    "org_verify_failed",
    "org_pin_mismatch",
    "managed_settings_invalid",
    "remote_settings_required_unavailable",
    "gateway_signin_required",
    "gateway_access_denied",
    "proxy_invalid",
    "temp_dir_unusable",
    "cwd_unavailable",
    "shell_tool_missing",
    "session_held_by_background",
    "worktree_resume_refused",
    "worktree_unverified",
    "cli_version_too_old",
    "bypass_root",
  ];

  test("covers every reason value the SDK documents", () => {
    for (const reason of REASONS) {
      expect(STARTUP_FAILURE_REASON_LABELS[reason]).toBeTruthy();
    }
  });

  test("every label is a non-empty, lowercase-leading clause (fits 'failed to start: <label>' phrasing)", () => {
    for (const label of Object.values(STARTUP_FAILURE_REASON_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
      expect(label[0]).toBe(label[0].toLowerCase());
    }
  });
});

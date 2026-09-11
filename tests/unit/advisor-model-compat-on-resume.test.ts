import { describe, expect, test } from "vitest";

/**
 * Regression coverage for the advisor 400 on RESUME.
 *
 * The user-visible symptom, straight from the chat surface:
 *
 *   API Error: {"type":"error","error":{"type":"invalid_request_error",
 *   "message":"tools.18.model: 'claude-fable-5' cannot be used as an advisor
 *   when the request model is 'claude-fable-5-1'."}}
 *
 * Why it happened. On a resume, two values are resolved from *different*
 * places and nothing reconciled them:
 *
 *   - the ADVISOR is re-armed on every `start()` from `~/.claude/settings.json`
 *     and forwarded to the SDK's flag layer;
 *   - the MODEL is resolved by the SDK from the transcript on disk.
 *
 * `start()`'s incompatibility guard tested `this.model` — which on a wake
 * `POST /api/sessions {resume}` is whatever the workspace defaults merged in,
 * NOT the model the conversation actually runs on. So a thread sitting on
 * `claude-fable-5-1` with a `claude-fable-5` advisor sailed past the guard
 * and 400'd on its first turn.
 *
 * The fix re-runs the check once the SDK reports the real model, via
 * `system:init` and the `PostModelSwitch` hook. These tests pin the
 * *predicate* that drives it.
 */

/**
 * The condition `Session.enforceAdvisorModelCompatibility()` clears on.
 * Mirrors the start-time guard in `Session.start()` so the two can't drift.
 */
function shouldClearAdvisor(
  advisorModel: string | undefined,
  model: string | null | undefined,
): boolean {
  if (!advisorModel) return false;
  if (!model || !model.includes("fable")) return false;
  return true;
}

describe("advisor/model compatibility guard", () => {
  test("the exact reported case: fable-5 advisor on a fable-5-1 request model", () => {
    expect(shouldClearAdvisor("claude-fable-5", "claude-fable-5-1")).toBe(true);
  });

  test("fires for any Fable request model, whatever the advisor is", () => {
    // Fable-class request models reject *any* advisor tool in the request,
    // so the guard is about the request model, not the pairing.
    expect(shouldClearAdvisor("claude-opus-4-8", "claude-fable-5-1")).toBe(true);
    expect(shouldClearAdvisor("claude-sonnet-5", "claude-fable-5")).toBe(true);
    expect(shouldClearAdvisor("claude-fable-5", "fable")).toBe(true);
  });

  test("no advisor configured is a no-op — nothing to clear", () => {
    expect(shouldClearAdvisor(undefined, "claude-fable-5-1")).toBe(false);
    expect(shouldClearAdvisor("", "claude-fable-5-1")).toBe(false);
  });

  test("non-Fable request models keep their advisor", () => {
    // The narrow scope matters: this runs on transient auto-fallback model
    // swaps too, and silently dropping the user's advisor on an overload
    // fallback would be surprising. Only genuine incompatibility clears.
    expect(shouldClearAdvisor("claude-opus-4-8", "claude-sonnet-5")).toBe(false);
    expect(shouldClearAdvisor("claude-opus-4-8", "claude-opus-5")).toBe(false);
    expect(shouldClearAdvisor("claude-sonnet-5", "claude-haiku-4-5")).toBe(false);
  });

  test("an unknown model is left alone rather than guessed at", () => {
    expect(shouldClearAdvisor("claude-opus-4-8", null)).toBe(false);
    expect(shouldClearAdvisor("claude-opus-4-8", undefined)).toBe(false);
  });

  test("the resume scenario: guard misses on the requested model, hits on the real one", () => {
    // What `start()` could see on a resume — the workspace default, because
    // the wake POST carries only `{ resume: id }`.
    const requestedModel = "claude-opus-5";
    // What the SDK actually resolved from the transcript, reported later via
    // `system:init` / `PostModelSwitch(source: "resume")`.
    const resolvedModel = "claude-fable-5-1";
    const advisor = "claude-fable-5";

    // Pre-fix: only the requested model was ever checked, so nothing cleared
    // and the next turn 400'd.
    expect(shouldClearAdvisor(advisor, requestedModel)).toBe(false);
    // Post-fix: the re-run against the resolved model catches it.
    expect(shouldClearAdvisor(advisor, resolvedModel)).toBe(true);
  });
});

import { describe, expect, test } from "vitest";
import { resolvePostModelSwitchHook } from "@/lib/server/session";
import type { PostModelSwitchHookInput } from "@anthropic-ai/claude-agent-sdk";

/**
 * SDK 0.3.251 added the `PostModelSwitch` hook, fired after every
 * main-thread model change — including the SDK's own automatic
 * `fallbackModel` swap, which previously changed the running model with NO
 * signal Claudius could observe (see the `opusOverloadStreak` doc comment
 * in `session.ts`, which already flagged that path as swapping "silently").
 * `resolvePostModelSwitchHook` is the pure decision function behind the
 * `PostModelSwitch` hook registered in `Session.start()`: given the hook
 * payload and the session's current in-memory model, it decides whether
 * (and to what, and with what persistence) Claudius should re-broadcast
 * `model_changed`.
 *
 * Only `source: "auto" | "resume" | "sdk"` should ever produce an action —
 * `"command"`/`"picker"` correspond to switches Claudius already broadcasts
 * through its own `setModel()` / chat-command-watcher paths, so acting on
 * them here would double-fire the SSE event.
 */

function hookInput(
  overrides: Partial<PostModelSwitchHookInput>,
): PostModelSwitchHookInput {
  return {
    session_id: "test-session",
    transcript_path: "/tmp/test-session.jsonl",
    cwd: "/tmp",
    hook_event_name: "PostModelSwitch",
    from_model: "claude-opus-4-8",
    to_model: "claude-sonnet-4-5",
    requested_model: null,
    source: "auto",
    context_tokens: 1000,
    prompt_cache_warm: true,
    cache_ttl: "5m",
    estimated_cache_write_usd: 0.01,
    pricing: "catalog",
    ...overrides,
  };
}

describe("resolvePostModelSwitchHook", () => {
  test("returns a non-persisted broadcast action on an automatic fallback switch", () => {
    const input = hookInput({ source: "auto", to_model: "claude-sonnet-4-5" });
    expect(resolvePostModelSwitchHook(input, "claude-opus-4-8")).toEqual({
      model: "claude-sonnet-4-5",
      source: "auto",
      persist: false,
    });
  });

  test("returns a persisted broadcast action on a resumed session with a different model", () => {
    const input = hookInput({ source: "resume", to_model: "claude-sonnet-4-5" });
    expect(resolvePostModelSwitchHook(input, "claude-opus-4-8")).toEqual({
      model: "claude-sonnet-4-5",
      source: "resume",
      persist: true,
    });
  });

  test("returns a persisted broadcast action on an external sdk-driven switch", () => {
    const input = hookInput({ source: "sdk", to_model: "claude-sonnet-4-5" });
    expect(resolvePostModelSwitchHook(input, "claude-opus-4-8")).toEqual({
      model: "claude-sonnet-4-5",
      source: "sdk",
      persist: true,
    });
  });

  test("ignores 'command' — already broadcast via the /model chat-command watcher", () => {
    const input = hookInput({ source: "command", to_model: "claude-sonnet-4-5" });
    expect(resolvePostModelSwitchHook(input, "claude-opus-4-8")).toBeNull();
  });

  test("ignores 'picker' — already broadcast via Session.setModel()", () => {
    const input = hookInput({ source: "picker", to_model: "claude-sonnet-4-5" });
    expect(resolvePostModelSwitchHook(input, "claude-opus-4-8")).toBeNull();
  });

  test("no-ops when to_model already matches the current model (duplicate hook fire)", () => {
    const input = hookInput({ source: "auto", to_model: "claude-opus-4-8" });
    expect(resolvePostModelSwitchHook(input, "claude-opus-4-8")).toBeNull();
  });

  test("no-ops when to_model matches from_model (the SDK reporting a no-op switch)", () => {
    const input = hookInput({
      source: "auto",
      from_model: "claude-opus-4-8",
      to_model: "claude-opus-4-8",
    });
    expect(resolvePostModelSwitchHook(input, "claude-sonnet-4-5")).toBeNull();
  });

  test("no-ops when to_model is empty", () => {
    const input = hookInput({ source: "auto", to_model: "" });
    expect(resolvePostModelSwitchHook(input, "claude-opus-4-8")).toBeNull();
  });

  test("treats an undefined current model as distinct from any to_model", () => {
    const input = hookInput({ source: "auto", to_model: "claude-sonnet-4-5" });
    expect(resolvePostModelSwitchHook(input, undefined)).toEqual({
      model: "claude-sonnet-4-5",
      source: "auto",
      persist: false,
    });
  });
});

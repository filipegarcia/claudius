import { mkdtempSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { addGroup, listAll } from "@/lib/server/hooks";
import {
  handlerBlocksOnFailure,
  handlerSupportsOnFailure,
  ON_FAILURE_IGNORED_EVENTS,
  onFailureBlockIgnoredReason,
} from "@/lib/shared/hook-events";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.295 parity — `onFailure: "block"` on `command` / `http` hook handlers
 * (fail-closed: a hook that can't start, times out, or exits unexpectedly blocks
 * the action). Pins the shared helpers the Hooks editor uses for its toggle,
 * badge and async hint, and that the flag round-trips verbatim through the
 * settings store (the server is pure JSON passthrough).
 */

describe("onFailure helpers", () => {
  test("only command and http handlers support onFailure", () => {
    expect(handlerSupportsOnFailure("command")).toBe(true);
    expect(handlerSupportsOnFailure("http")).toBe(true);
    expect(handlerSupportsOnFailure("prompt")).toBe(false);
    expect(handlerSupportsOnFailure("agent")).toBe(false);
    expect(handlerSupportsOnFailure("mcp_tool")).toBe(false);
  });

  test("handlerBlocksOnFailure reads the flag on command/http handlers", () => {
    expect(handlerBlocksOnFailure({ type: "command", command: "x", onFailure: "block" })).toBe(true);
    expect(handlerBlocksOnFailure({ type: "http", url: "https://h", onFailure: "block" })).toBe(true);
    expect(handlerBlocksOnFailure({ type: "command", command: "x" })).toBe(false);
    expect(handlerBlocksOnFailure({ type: "prompt", prompt: "p" })).toBe(false);
  });

  test("handlerBlocksOnFailure ignores a stray flag on other handler types", () => {
    // Hand-edited settings could carry the key on a prompt handler; the engine
    // only honours it on command/http, so the badge shouldn't claim otherwise.
    const stray = { type: "prompt", prompt: "p", onFailure: "block" } as unknown as Parameters<
      typeof handlerBlocksOnFailure
    >[0];
    expect(handlerBlocksOnFailure(stray)).toBe(false);
  });

  test("onFailureBlockIgnoredReason flags a background command hook", () => {
    const r = onFailureBlockIgnoredReason;
    expect(r({ type: "command", onFailure: "block", async: true })).toBe("async");
    expect(r({ type: "command", onFailure: "block", asyncRewake: true })).toBe("asyncRewake");
    expect(r({ type: "command", onFailure: "block" })).toBeNull();
    expect(r({ type: "command", async: true })).toBeNull();
    expect(r({ type: "command" })).toBeNull();
  });

  test("an http hook's block holds even with async set (engine only drops it for command)", () => {
    expect(onFailureBlockIgnoredReason({ type: "http", onFailure: "block", async: true })).toBeNull();
    expect(onFailureBlockIgnoredReason({ type: "http", onFailure: "block", asyncRewake: true })).toBeNull();
  });

  test("onFailure is ignored on Stop, SubagentStop, TaskCompleted and TeammateIdle", () => {
    expect([...ON_FAILURE_IGNORED_EVENTS]).toEqual(["Stop", "SubagentStop", "TaskCompleted", "TeammateIdle"]);
    for (const event of ON_FAILURE_IGNORED_EVENTS) {
      expect(onFailureBlockIgnoredReason({ type: "command", event, onFailure: "block" })).toBe("event");
      expect(onFailureBlockIgnoredReason({ type: "http", event, onFailure: "block" })).toBe("event");
      expect(onFailureBlockIgnoredReason({ type: "command", event })).toBeNull();
    }
    expect(onFailureBlockIgnoredReason({ type: "command", event: "PreToolUse", onFailure: "block" })).toBeNull();
    // A background command hook reports its async reason first.
    expect(onFailureBlockIgnoredReason({ type: "command", event: "Stop", onFailure: "block", async: true })).toBe("async");
  });

  test("handler types without onFailure never report a reason", () => {
    expect(onFailureBlockIgnoredReason({ type: "prompt", event: "Stop", onFailure: "block" })).toBeNull();
  });
});

let tmp: TmpHome;
let cwd: string;

beforeEach(() => {
  tmp = makeTempHome();
  cwd = mkdtempSync(join(tmp.home, "ws-"));
});

afterEach(() => {
  tmp.restore();
});

describe("onFailure round-trip", () => {
  test("`onFailure: \"block\"` round-trips through addGroup/listAll for command and http", async () => {
    await addGroup("project", cwd, "PreToolUse", {
      matcher: "Bash",
      hooks: [
        { type: "command", command: "./guard.sh", onFailure: "block" },
        { type: "http", url: "https://hooks.example.com/guard", onFailure: "block" },
      ],
    });

    const scoped = (await listAll(cwd)).find((s) => s.scope === "project")!;
    const [cmd, http] = (scoped.hooks.PreToolUse ?? [])[0].hooks;
    expect(handlerBlocksOnFailure(cmd)).toBe(true);
    expect(handlerBlocksOnFailure(http)).toBe(true);
  });

  test("a handler saved without the flag omits the key (default fail-open)", async () => {
    await addGroup("project", cwd, "PreToolUse", {
      hooks: [{ type: "command", command: "./guard.sh" }],
    });

    const scoped = (await listAll(cwd)).find((s) => s.scope === "project")!;
    const handler = (scoped.hooks.PreToolUse ?? [])[0].hooks[0];
    expect("onFailure" in handler).toBe(false);
  });
});

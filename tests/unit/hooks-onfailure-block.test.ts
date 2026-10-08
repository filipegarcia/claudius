import { mkdtempSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { addGroup, listAll } from "@/lib/server/hooks";
import {
  handlerBlocksOnFailure,
  handlerSupportsOnFailure,
  onFailureBlockIneffective,
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

  test("onFailureBlockIneffective flags block + background (async / asyncRewake)", () => {
    expect(onFailureBlockIneffective({ onFailure: "block", async: true })).toBe(true);
    expect(onFailureBlockIneffective({ onFailure: "block", asyncRewake: true })).toBe(true);
    expect(onFailureBlockIneffective({ onFailure: "block" })).toBe(false);
    expect(onFailureBlockIneffective({ async: true })).toBe(false);
    expect(onFailureBlockIneffective({})).toBe(false);
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

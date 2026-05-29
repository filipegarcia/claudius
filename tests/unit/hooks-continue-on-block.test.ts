import { mkdtempSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { addGroup, listAll } from "@/lib/server/hooks";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * `continueOnBlock` on `prompt` hook steps. The data model carries the optional
 * flag on the `prompt` variant of `HookHandler`, and the server is pure JSON
 * passthrough: `addGroup` writes the group verbatim into `.claude/settings.json`
 * and `listAll` reads it back.
 *
 * These tests pin the behavioral claim the feature rests on — that the flag
 * round-trips through the settings store unchanged with no special server
 * handling, and that a prompt handler without the flag omits the field entirely
 * (default-false semantics) — by exercising the real write→read path against a
 * throwaway $HOME so the on-disk settings file is the source of truth.
 */

let tmp: TmpHome;
let cwd: string;

beforeEach(() => {
  tmp = makeTempHome();
  // Project scope writes to `<cwd>/.claude/settings.json`; keep cwd under the
  // temp HOME so cleanup reaps it. `writeSettings` mkdirs the `.claude` dir.
  cwd = mkdtempSync(join(tmp.home, "ws-"));
});

afterEach(() => {
  tmp.restore();
});

describe("prompt hook `continueOnBlock`", () => {
  test("`continueOnBlock: true` round-trips through addGroup/listAll", async () => {
    await addGroup("project", cwd, "PostToolUse", {
      matcher: "*",
      hooks: [{ type: "prompt", prompt: "verify", continueOnBlock: true }],
    });

    const scoped = (await listAll(cwd)).find((s) => s.scope === "project");
    expect(scoped).toBeDefined();
    const groups = scoped!.hooks.PostToolUse ?? [];
    expect(groups).toHaveLength(1);
    const handler = groups[0].hooks[0];
    expect(handler.type).toBe("prompt");
    // The flag must survive the write→read trip untouched.
    expect("continueOnBlock" in handler && handler.continueOnBlock).toBe(true);
  });

  test("a prompt handler without the flag omits the field (default-false)", async () => {
    await addGroup("project", cwd, "PostToolUse", {
      matcher: "*",
      hooks: [{ type: "prompt", prompt: "verify" }],
    });

    const scoped = (await listAll(cwd)).find((s) => s.scope === "project")!;
    const handler = (scoped.hooks.PostToolUse ?? [])[0].hooks[0];
    expect("continueOnBlock" in handler).toBe(false);
  });
});

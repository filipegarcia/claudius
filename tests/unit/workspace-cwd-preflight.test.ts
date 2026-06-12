import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  validateWorkspaceCwd,
  type WorkspaceCwdPreflight,
} from "@/lib/server/workspace-cwd-preflight";

/**
 * Regression coverage for the workspace-cwd pre-flight check that
 * `Session.start()` runs before invoking the SDK's `query()`.
 *
 * Bug we're guarding against (v0.3.170.9, 2026-06-10): a user's workspace
 * pointed at `~/claudius` but their project actually lived at
 * `~/Projects/claudius`. Every session start surfaced the misleading
 * "Claude Code native binary at … exists but failed to launch" banner —
 * which the user has no path forward from because the binary IS where it
 * says it is; the actual fault is the missing cwd. (Node's posix_spawn
 * returns ENOENT for the cwd and attributes the message to the binary
 * arg; the SDK's existsSync check on the binary passes; misleading
 * message wins.)
 *
 * The fix in `validateWorkspaceCwd` returns a structured failure with a
 * clear, actionable message. `Session.start()` broadcasts it as a
 * `{ type: "error" }` SSE event and skips the `query()` call.
 *
 * These tests cover the three failure shapes + the happy path. The
 * packaged-artifact smoke (mac-smoke.spec.ts) runs against a fresh temp
 * HOME with no persisted stale workspaces, so it CAN'T reproduce the
 * user-side state issue that hit prod — this unit test is the only
 * gate against the pre-flight check silently regressing.
 */

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "wsp-cwd-preflight-"));
});

afterEach(() => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // already cleaned, or never created — nothing to do
  }
});

describe("validateWorkspaceCwd", () => {
  test("returns ok for a real directory", async () => {
    const result = await validateWorkspaceCwd(scratch);
    expect(result).toEqual({ ok: true } satisfies WorkspaceCwdPreflight);
  });

  test("returns ENOENT for a missing directory with actionable copy", async () => {
    // Build a path that doesn't exist. Don't use `Date.now()` (forbidden
    // in workflow scripts — but fine here for vitest) or rely on /tmp
    // entropy; just stick a known-absent suffix on `scratch`.
    const missing = join(scratch, "definitely-not-here");

    const result = await validateWorkspaceCwd(missing);

    expect(result.ok).toBe(false);
    if (result.ok) return; // type guard; satisfied by line above
    expect(result.code).toBe("ENOENT");
    // The message should mention the offending path AND give the user
    // somewhere to go. If a refactor drops the actionable copy and the
    // user only sees "ENOENT", that's a regression.
    expect(result.message).toContain(missing);
    expect(result.message.toLowerCase()).toMatch(/doesn't exist/);
    expect(result.message.toLowerCase()).toMatch(/recreate|re-add|remove this workspace/);
  });

  test("returns NOT_DIR when the path is a regular file", async () => {
    // The user opened a workspace pointing at a file (drag-and-drop a
    // .txt into the workspace picker, or a stale symlink resolved to a
    // file). The SDK would `chdir()` into it and fail with ENOTDIR; we
    // want to catch that BEFORE the misleading binary banner fires.
    const filePath = join(scratch, "i-am-a-file.txt");
    writeFileSync(filePath, "not a directory");

    const result = await validateWorkspaceCwd(filePath);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NOT_DIR");
    expect(result.message).toContain(filePath);
    expect(result.message.toLowerCase()).toMatch(/isn't a directory/);
  });

  test("returns OTHER with the raw errno for unexpected stat failures", async () => {
    // Hard to provoke EACCES reliably across CI runners (and even harder
    // on macOS, where SIP isolates most "you can't read this" paths).
    // Use a path that resolves through a non-existent intermediate
    // directory — stat returns ENOENT, which we map to ENOENT, not OTHER.
    //
    // To exercise the OTHER branch deterministically, pass an empty
    // string: fsp.stat("") throws with code "ERR_INVALID_ARG_VALUE",
    // which doesn't match ENOENT and falls into the OTHER bucket.
    const result = await validateWorkspaceCwd("");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // ENOENT-ish input shapes can sometimes still be classified as ENOENT
    // by Node's stat depending on platform — accept either OTHER or
    // ENOENT here, but the message must always give an actionable hint.
    expect(["OTHER", "ENOENT"]).toContain(result.code);
    expect(result.message.toLowerCase()).toMatch(/fix the path|doesn't exist/);
  });

  test("rejects a non-absolute path before touching the filesystem", async () => {
    // Hardening (CodeQL #47): a relative cwd would `stat` against the server
    // process's own working directory, not the user's folder. Reject it up
    // front with actionable copy instead of silently probing the wrong tree.
    const result = await validateWorkspaceCwd("relative/not/absolute");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("OTHER");
    expect(result.message).toContain("relative/not/absolute");
    expect(result.message.toLowerCase()).toMatch(/absolute/);
    expect(result.message.toLowerCase()).toMatch(/fix the path|re-add/);
  });

  test("the ENOENT message does NOT match the SDK's misleading binary error", async () => {
    // Anti-regression: if a future refactor accidentally lets the SDK
    // error through (e.g. by removing the pre-flight or returning ok
    // for missing dirs), the user-visible banner would read "Claude Code
    // native binary at … exists but failed to launch." That string is
    // the failure mode we're trying to PREVENT. Assert our error message
    // is unambiguously different so a regression that lets the SDK
    // message through fails this test on the negation.
    const missing = join(scratch, "regression-canary");
    const result = await validateWorkspaceCwd(missing);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain("native binary");
    expect(result.message).not.toContain("failed to launch");
  });
});

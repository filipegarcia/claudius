import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeProjectDir } from "@/lib/server/auto-memory";
import { lastRecordedPermissionMode, resumePermissionMode } from "@/lib/server/session-resume";
import { sessionManager } from "@/lib/server/session-manager";
import type { Session } from "@/lib/server/session";

/**
 * CC 2.1.292 — "Fixed plan mode not being restored when resuming a session".
 * Claudius resumed every session (tab switch, reap, server restart) into the
 * workspace default — or "default" — so a plan-mode session silently became
 * one that could edit files.
 */

const CWD = "/tmp/claudius-resume-mode-project";
const prevHome = process.env.HOME;
let home: string;

function writeTranscript(id: string, entries: object[], trailing = ""): void {
  const dir = join(home, ".claude", "projects", encodeProjectDir(CWD));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.jsonl`),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n" + trailing,
  );
}

const prompt = (mode: string, extra: object = {}) => ({
  type: "user",
  permissionMode: mode,
  message: { role: "user", content: "hi" },
  ...extra,
});

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "claudius-resume-"));
  process.env.HOME = home;
});

afterAll(() => {
  process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("lastRecordedPermissionMode", () => {
  test("the last prompt's mode wins", async () => {
    writeTranscript("s-prompts", [prompt("default"), { type: "assistant" }, prompt("plan")]);
    expect(await lastRecordedPermissionMode("s-prompts", CWD)).toBe("plan");
  });

  test("a later permission-mode entry overrides the last prompt", async () => {
    writeTranscript("s-switch", [
      prompt("plan"),
      { type: "permission-mode", permissionMode: "acceptEdits", sessionId: "s-switch" },
    ]);
    expect(await lastRecordedPermissionMode("s-switch", CWD)).toBe("acceptEdits");
  });

  test("skips subagent sidechain lines and a torn trailing line", async () => {
    writeTranscript(
      "s-side",
      [prompt("plan"), prompt("bypassPermissions", { isSidechain: true })],
      '{"type":"user","permissionMode":"defau',
    );
    expect(await lastRecordedPermissionMode("s-side", CWD)).toBe("plan");
  });

  test("null when the transcript is missing or the id is malformed", async () => {
    expect(await lastRecordedPermissionMode("no-such-session", CWD)).toBeNull();
    expect(await lastRecordedPermissionMode("../escape", CWD)).toBeNull();
  });
});

describe("resumePermissionMode", () => {
  const internals = sessionManager as unknown as { sessions: Map<string, Session> };

  afterEach(() => {
    internals.sessions.delete("s-live");
  });

  test("restores plan from the transcript over the workspace default", async () => {
    writeTranscript("s-reaped", [prompt("plan")]);
    expect(await resumePermissionMode("s-reaped", CWD, "acceptEdits")).toBe("plan");
  });

  test("other recorded modes fall back to the workspace default, as before", async () => {
    writeTranscript("s-edits", [prompt("bypassPermissions")]);
    expect(await resumePermissionMode("s-edits", CWD, "default")).toBe("default");
    expect(await resumePermissionMode("s-edits", CWD, undefined)).toBeUndefined();
  });

  test("a live session in plan mode keeps it (tab-switch wake POST)", async () => {
    writeTranscript("s-live", [prompt("default")]);
    internals.sessions.set("s-live", { getPermissionMode: () => "plan" } as unknown as Session);
    expect(await resumePermissionMode("s-live", CWD, "acceptEdits")).toBe("plan");
  });
});

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { forkSession } from "@anthropic-ai/claude-agent-sdk";

import { Session } from "@/lib/server/session";
import { openDb } from "@/lib/server/db";
import { encodeProjectDir } from "@/lib/server/auto-memory";
import { readForkedFromByUuid, withForkedFrom } from "@/lib/server/fork-lineage";
import { isLoopArmed } from "@/lib/server/loop-keepalive";
import { isForkedCopy, type SessionLoop } from "@/lib/shared/session-loops";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.330 — "[VSCode] Fixed a forked conversation running the original
 * conversation's `/loop` schedules a second time".
 *
 * The SDK's `forkSession` copies the source transcript with fresh uuids and a
 * `forkedFrom` on every copied line, which `getSessionMessages` drops. The
 * fork's replay tracked the source's `/loop` crons as its own: running in the
 * rail, and pinning the fork's process in the idle reaper.
 */

let CWD = "";
const SRC = "11111111-2222-3333-4444-555555555330";

let tmp: TmpHome;
let prevConfigDir: string | undefined;

beforeEach(async () => {
  tmp = makeTempHome();
  // Keep the SDK's session readers/writers in the temp home too.
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(tmp.home, ".claude");
  // A real directory: the SDK's forkSession resolves the project dir from it.
  mkdirSync(join(tmp.home, "proj"));
  CWD = realpathSync(join(tmp.home, "proj"));
  await openDb(CWD);
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  tmp.restore();
});

function projectDir(): string {
  return join(tmp.home, ".claude", "projects", encodeProjectDir(CWD));
}

/** A source transcript in which the agent armed a recurring `/loop` cron. */
function writeSourceTranscript(): void {
  const base = { sessionId: SRC, cwd: CWD, isSidechain: false, userType: "external", version: "2.1.332" };
  const now = Date.now();
  const rows = [
    {
      ...base,
      type: "user",
      uuid: "src-u1",
      parentUuid: null,
      timestamp: new Date(now - 60_000).toISOString(),
      message: { role: "user", content: "/loop 30m check the deploy queue" },
    },
    {
      ...base,
      type: "assistant",
      uuid: "src-a1",
      parentUuid: "src-u1",
      timestamp: new Date(now - 59_000).toISOString(),
      message: {
        id: "msg_src_1",
        role: "assistant",
        model: "claude-sonnet-4-6",
        type: "message",
        content: [
          {
            type: "tool_use",
            id: "toolu_src_cron",
            name: "CronCreate",
            input: { cron: "*/30 * * * *", prompt: "check the deploy queue" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    },
    {
      ...base,
      type: "user",
      uuid: "src-u2",
      parentUuid: "src-a1",
      timestamp: new Date(now - 58_000).toISOString(),
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_src_cron",
            content:
              "Scheduled recurring job 1545ddb6 (Every 30 minutes). Session-only (not written to disk, dies when Claude exits). Auto-expires after 30 days. Use CronDelete to cancel sooner.",
          },
        ],
      },
      toolUseResult: { id: "1545ddb6", humanSchedule: "Every 30 minutes", recurring: true, maxAgeMs: 2_592_000_000 },
    },
    {
      ...base,
      type: "assistant",
      uuid: "src-a2",
      parentUuid: "src-u2",
      timestamp: new Date(now - 57_000).toISOString(),
      message: {
        id: "msg_src_2",
        role: "assistant",
        model: "claude-sonnet-4-6",
        type: "message",
        content: [{ type: "text", text: "Armed. I'll check the deploy queue every 30 minutes." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    },
  ];
  mkdirSync(projectDir(), { recursive: true });
  writeFileSync(join(projectDir(), `${SRC}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

type SessionInternals = {
  resyncFromDisk: () => Promise<{ added: number }>;
  getScheduledLoops: () => SessionLoop[];
  hasArmedLoops: (now?: number) => boolean;
  buffer: Array<{ type: string; message?: unknown }>;
};

function openSession(id: string): SessionInternals {
  return new Session({ id, cwd: CWD }) as unknown as SessionInternals;
}

describe("a fork's copied /loop is inherited, not its own", () => {
  test("the source session's own loop is armed (control)", async () => {
    writeSourceTranscript();
    const s = openSession(SRC);
    expect((await s.resyncFromDisk()).added).toBeGreaterThan(0);
    const loops = s.getScheduledLoops();
    expect(loops).toHaveLength(1);
    expect(loops[0]!.inherited).toBeUndefined();
    expect(s.hasArmedLoops()).toBe(true);
  });

  test("the fork (made by the SDK's forkSession) tracks it as inherited and doesn't pin its process", async () => {
    writeSourceTranscript();
    const { sessionId: forkId } = await forkSession(SRC, { dir: CWD });
    const s = openSession(forkId);
    expect((await s.resyncFromDisk()).added).toBeGreaterThan(0);

    const loops = s.getScheduledLoops();
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ id: "1545ddb6", recurring: true, inherited: true });
    expect(s.hasArmedLoops()).toBe(false);

    // The replayed messages carry `forkedFrom` again, so the client reducer
    // marks the same loop inherited.
    const replayed = s.buffer.filter((e) => e.type === "sdk").map((e) => e.message);
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.every(isForkedCopy)).toBe(true);
    expect((replayed[0] as { forkedFrom: { sessionId: string } }).forkedFrom.sessionId).toBe(SRC);
  });
});

describe("readForkedFromByUuid / withForkedFrom", () => {
  test("maps each copied line's own uuid; ignores lines without forkedFrom", async () => {
    mkdirSync(projectDir(), { recursive: true });
    const file = join(projectDir(), "fork.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "user", uuid: "f-1", forkedFrom: { sessionId: SRC, messageUuid: "src-u1" } }),
        "{torn",
        JSON.stringify({ type: "assistant", uuid: "own-1" }),
      ].join("\n"),
    );
    const map = await readForkedFromByUuid(file, join(tmp.home, ".claude", "projects"));
    expect([...map.entries()]).toEqual([["f-1", { sessionId: SRC, messageUuid: "src-u1" }]]);

    const copied = withForkedFrom({ uuid: "f-1", type: "user" }, map);
    expect(isForkedCopy(copied)).toBe(true);
    const own = { uuid: "own-1", type: "assistant" };
    expect(withForkedFrom(own, map)).toBe(own);
  });

  test("refuses a file outside the projects dir", async () => {
    const map = await readForkedFromByUuid("/etc/hosts", join(tmp.home, ".claude", "projects"));
    expect(map.size).toBe(0);
  });

  test("an inherited loop is never armed", () => {
    const loop: SessionLoop = {
      kind: "cron",
      id: "1545ddb6",
      toolUseId: "toolu_src_cron",
      cron: "*/30 * * * *",
      humanSchedule: "Every 30 minutes",
      delaySeconds: null,
      prompt: "check the deploy queue",
      recurring: true,
      durable: false,
      startedAt: Date.now(),
      cancelled: false,
    };
    expect(isLoopArmed(loop, Date.now() + 60_000)).toBe(true);
    expect(isLoopArmed({ ...loop, inherited: true }, Date.now() + 60_000)).toBe(false);
  });
});

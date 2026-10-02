import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolvePeerSource, type PeerSourceRoots } from "@/lib/server/peer-source";
import {
  PEER_SNIPPET_MAX,
  canLookUpPeer,
  peerSourceQuery,
  peerSourceTarget,
  type PeerSourceInfo,
} from "@/lib/shared/peer-source";

/**
 * Linking a cross-session peer message back to its sender.
 *
 * The SDK's `origin.fromSession` is only stamped for desktop/IDE hosts, so
 * Claudius resolves the sender from what IS on the wire: the kernel-verified
 * pid (→ the CLI's `sessions/<pid>.json` registry) and `msg_id` (→ the
 * sender's own transcript, which records it as `toolUseResult.msg_id`).
 */

const SENDER_SESSION = "a9e0f784-70a0-4534-98e9-cba0ef2577dd";
const RECEIVER_SESSION = "615bc074-933a-43e0-977e-6be1350f6f30";
const MSG_ID = "9861e8f9-3c29-45c7-9fa5-3182778c60c5";
const SENT_AT = Date.parse("2026-09-10T20:17:28.000Z");
// A pid that's essentially never alive, so `live` is deterministic.
const DEAD_PID = 999_999;

describe("resolvePeerSource", () => {
  let tmp: string;
  let roots: PeerSourceRoots;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "claudius-peer-source-"));
    roots = { claudeDir: join(tmp, "claude"), profilesRoot: join(tmp, "accounts", "profiles") };
    mkdirSync(join(roots.claudeDir, "sessions"), { recursive: true });
    mkdirSync(join(roots.claudeDir, "projects", "-work-afrexim"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeRegistry(dir: string, rec: Record<string, unknown>) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${rec.pid}.json`), JSON.stringify(rec));
  }

  function writeTranscript(sessionId: string, lines: unknown[], mtimeMs = SENT_AT + 1_000) {
    const file = join(roots.claudeDir, "projects", "-work-afrexim", `${sessionId}.jsonl`);
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  }

  test("registry hit: pid + matching socket resolves the sender", async () => {
    writeRegistry(join(roots.claudeDir, "sessions"), {
      pid: DEAD_PID,
      sessionId: SENDER_SESSION,
      cwd: "/work/afrexim",
      name: "afrexim-99",
      messagingSocketPath: `/tmp/cc-socks/${DEAD_PID}.sock`,
      startedAt: SENT_AT - 60_000,
    });
    const src = await resolvePeerSource(
      { pid: DEAD_PID, from: `uds:/tmp/cc-socks/${DEAD_PID}.sock`, msgId: MSG_ID, at: SENT_AT },
      roots,
    );
    expect(src).toEqual({
      sessionId: SENDER_SESSION,
      cwd: "/work/afrexim",
      name: "afrexim-99",
      live: false,
      via: "registry",
    });
  });

  test("registry entry under a profile's own sessions dir is found too", async () => {
    writeRegistry(join(roots.profilesRoot, "acc_x", "sessions"), {
      pid: DEAD_PID,
      sessionId: SENDER_SESSION,
      cwd: "/work/afrexim",
      messagingSocketPath: `/tmp/cc-socks/${DEAD_PID}.sock`,
    });
    const src = await resolvePeerSource({ pid: DEAD_PID, from: `uds:/tmp/cc-socks/${DEAD_PID}.sock` }, roots);
    expect(src?.sessionId).toBe(SENDER_SESSION);
  });

  test("recycled pid (different socket, or started after the message) is rejected", async () => {
    writeRegistry(join(roots.claudeDir, "sessions"), {
      pid: DEAD_PID,
      sessionId: "00000000-0000-0000-0000-000000000000",
      cwd: "/somewhere/else",
      messagingSocketPath: "/tmp/cc-socks/other.sock",
      startedAt: SENT_AT - 60_000,
    });
    expect(
      await resolvePeerSource({ pid: DEAD_PID, from: `uds:/tmp/cc-socks/${DEAD_PID}.sock`, at: SENT_AT }, roots),
    ).toBeNull();

    writeRegistry(join(roots.claudeDir, "sessions"), {
      pid: DEAD_PID + 1,
      sessionId: "00000000-0000-0000-0000-000000000000",
      cwd: "/somewhere/else",
      startedAt: SENT_AT + 3_600_000,
    });
    expect(await resolvePeerSource({ pid: DEAD_PID + 1, from: "uds:/x.sock", at: SENT_AT }, roots)).toBeNull();
  });

  test("transcript fallback: finds the sender by its SendMessage tool result, not by mentions", async () => {
    // The RECEIVER's transcript also carries the id (in `origin`) — must not match.
    writeTranscript(RECEIVER_SESSION, [
      {
        type: "user",
        sessionId: RECEIVER_SESSION,
        cwd: "/work/afrexim",
        origin: { kind: "peer", from: "uds:/tmp/cc-socks/1.sock", msg_id: MSG_ID },
      },
    ]);
    writeTranscript(SENDER_SESSION, [
      { type: "assistant", sessionId: SENDER_SESSION, cwd: "/work/afrexim" },
      {
        type: "user",
        sessionId: SENDER_SESSION,
        cwd: "/work/afrexim",
        toolUseResult: { success: true, message: "sent", msg_id: MSG_ID },
      },
    ]);
    const src = await resolvePeerSource({ pid: DEAD_PID, from: "uds:/gone.sock", msgId: MSG_ID, at: SENT_AT }, roots);
    expect(src).toEqual({
      sessionId: SENDER_SESSION,
      cwd: "/work/afrexim",
      name: null,
      live: false,
      via: "transcript",
    });
  });

  test("queued delivery (no pid): matches the registry by socket path", async () => {
    writeRegistry(join(roots.claudeDir, "sessions"), {
      pid: DEAD_PID,
      sessionId: SENDER_SESSION,
      cwd: "/work/afrexim",
      name: "afrexim-99",
      messagingSocketPath: "/tmp/cc-socks/99549.sock",
      startedAt: SENT_AT - 60_000,
    });
    writeRegistry(join(roots.claudeDir, "sessions"), {
      pid: DEAD_PID - 1,
      sessionId: RECEIVER_SESSION,
      messagingSocketPath: "/tmp/cc-socks/7942.sock",
    });
    const src = await resolvePeerSource({ from: "uds:/tmp/cc-socks/99549.sock", at: SENT_AT }, roots);
    expect(src?.sessionId).toBe(SENDER_SESSION);
    expect(src?.name).toBe("afrexim-99");
  });

  test("queued delivery, sender exited: matches its SendMessage call by body", async () => {
    const body = "Re D128 — fine by me; here is where I (D127, pause/resume a report run) am editing.";
    // Receiver's queued copy of the same text must not match.
    writeTranscript(RECEIVER_SESSION, [
      { type: "attachment", sessionId: RECEIVER_SESSION, attachment: { type: "queued_command", prompt: body } },
    ]);
    writeTranscript(SENDER_SESSION, [
      // Start cwd is the project root; the agent later cd'd into a subdir.
      { type: "user", sessionId: SENDER_SESSION, cwd: "/work/afrexim" },
      {
        type: "assistant",
        sessionId: SENDER_SESSION,
        cwd: "/work/afrexim/frontend",
        message: {
          content: [
            { type: "tool_use", name: "SendMessage", input: { to: "uds:/tmp/cc-socks/7942.sock", message: body } },
          ],
        },
      },
    ]);
    const src = await resolvePeerSource(
      { from: "uds:/tmp/cc-socks/99549.sock", snippet: body.slice(0, 40), at: SENT_AT },
      roots,
    );
    expect(src).toEqual({
      sessionId: SENDER_SESSION,
      cwd: "/work/afrexim",
      name: null,
      live: false,
      via: "transcript",
    });
  });

  test("body matching needs a real snippet and a time anchor", async () => {
    writeTranscript(SENDER_SESSION, [
      {
        type: "assistant",
        sessionId: SENDER_SESSION,
        message: { content: [{ type: "tool_use", name: "SendMessage", input: { message: "ok" } }] },
      },
    ]);
    expect(await resolvePeerSource({ from: "x", snippet: "ok", at: SENT_AT }, roots)).toBeNull();
    expect(
      await resolvePeerSource({ from: "x", snippet: "a sufficiently long snippet here" }, roots),
    ).toBeNull();
  });

  test("transcripts last touched before the message are skipped", async () => {
    writeTranscript(
      SENDER_SESSION,
      [{ type: "user", sessionId: SENDER_SESSION, toolUseResult: { msg_id: MSG_ID } }],
      SENT_AT - 3_600_000,
    );
    expect(await resolvePeerSource({ msgId: MSG_ID, from: "uds:/x.sock", at: SENT_AT }, roots)).toBeNull();
  });

  test("malformed msgId never reaches the scan", async () => {
    expect(await resolvePeerSource({ msgId: "../../etc/passwd", from: "uds:/x.sock" }, roots)).toBeNull();
  });
});

describe("peerSourceTarget", () => {
  const base: PeerSourceInfo = {
    sessionId: SENDER_SESSION,
    cwd: "/work/afrexim",
    name: "afrexim-99",
    live: true,
    hostedHere: true,
    workspaceId: "wks_aaaaaaaaaaaa",
  };

  test("running in this server → chat in its workspace", () => {
    expect(peerSourceTarget(base, "wks_bbbbbbbbbbbb")).toEqual({
      kind: "chat",
      sessionId: SENDER_SESSION,
      workspaceId: "wks_aaaaaaaaaaaa",
    });
  });

  test("exited → chat (resuming is safe)", () => {
    expect(peerSourceTarget({ ...base, live: false, hostedHere: false }, null)?.kind).toBe("chat");
  });

  test("running in another process → read-only transcript, never a second writer", () => {
    expect(peerSourceTarget({ ...base, hostedHere: false }, null)).toEqual({
      kind: "transcript",
      href: `/wks_aaaaaaaaaaaa/sessions/${SENDER_SESSION}?dir=%2Fwork%2Fafrexim`,
    });
  });

  test("no matching workspace → transcript under the current workspace", () => {
    expect(peerSourceTarget({ ...base, workspaceId: null }, "wks_cccccccccccc")).toEqual({
      kind: "transcript",
      href: `/wks_cccccccccccc/sessions/${SENDER_SESSION}?dir=%2Fwork%2Fafrexim`,
    });
    expect(peerSourceTarget({ ...base, workspaceId: null }, null)).toBeNull();
  });
});

describe("peerSourceQuery", () => {
  test("serializes only the fields that are present", () => {
    expect(peerSourceQuery({ from: "uds:/tmp/a.sock" })).toBe("from=uds%3A%2Ftmp%2Fa.sock");
    expect(new URLSearchParams(peerSourceQuery({ from: "x", pid: 42, msgId: MSG_ID, at: 7 })).toString()).toBe(
      `from=x&pid=42&msgId=${MSG_ID}&at=7`,
    );
  });

  test("snippet is the trimmed body, capped by code point (never splits an emoji)", () => {
    const body = `  ${"a".repeat(PEER_SNIPPET_MAX - 1)}😀tail`;
    const snippet = new URLSearchParams(peerSourceQuery({ from: "x", body })).get("snippet")!;
    expect(snippet).toBe(`${"a".repeat(PEER_SNIPPET_MAX - 1)}😀`);
    expect(snippet).not.toContain("�");
  });
});

describe("canLookUpPeer", () => {
  test("queued deliveries are still linkable through their uds address or body", () => {
    expect(canLookUpPeer({ from: "uds:/tmp/cc-socks/1.sock" })).toBe(true);
    expect(canLookUpPeer({ from: "bridge:abc", body: "hello" })).toBe(true);
    expect(canLookUpPeer({ from: "bridge:abc", body: "  " })).toBe(false);
  });
});

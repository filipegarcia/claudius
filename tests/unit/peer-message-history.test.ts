import { describe, expect, test } from "vitest";
import { synthesizeOlder } from "@/lib/client/use-session";

/**
 * Cross-session peer messages must survive the "load older" pagination path
 * (`/api/sessions/[id]/transcript` → `synthesizeOlder`), which is how the
 * chat reaches history outside the server's tail-replay window after a tab
 * switch or reload.
 *
 * Fixtures are the two real shapes `getSessionMessages` returns (captured
 * from live sessions on CLI 2.1.285, trimmed):
 *   - idle delivery: an `is_meta` user record whose content is the
 *     "Another Claude session sent a message:" envelope;
 *   - mid-turn delivery: the JSONL `queued_command` attachment, synthesized
 *     into an `isQueuedCommand` user record carrying the raw envelope.
 * Both carry `origin.kind === "peer"` with the decoded `body`.
 */

const SESSION = "91fdf388-91ab-41b9-bf59-b16e3799b871";

function assistant(uuid: string, text: string): Record<string, unknown> {
  return {
    type: "assistant",
    uuid,
    session_id: SESSION,
    parent_tool_use_id: null,
    message: { id: `msg_${uuid}`, role: "assistant", content: [{ type: "text", text }] },
  };
}

const IDLE_PEER = {
  type: "user",
  uuid: "f2e9334e-1169-41ce-9e23-ed4a4986f006",
  session_id: SESSION,
  parent_tool_use_id: null,
  parent_agent_id: null,
  is_meta: true,
  timestamp: "2026-10-04T15:44:24.428Z",
  message: {
    role: "user",
    content:
      "Another Claude session sent a message:\n" +
      '<cross-session-message from="uds:/tmp/cc-socks/3974.sock" from-name="compliance-benchmark-07" from-mode="bypass">\n' +
      "node@22 is fixed: Filipe asked for `brew reinstall node@22`.\n" +
      "</cross-session-message>",
  },
  origin: {
    kind: "peer",
    from: "uds:/tmp/cc-socks/3974.sock",
    verifiedPeerPid: 3974,
    msg_id: "29021b5e-198f-46a1-8b71-f77a399e4a34",
    name: "compliance-benchmark-07",
    fromMode: "bypass",
    body: "node@22 is fixed: Filipe asked for `brew reinstall node@22`.",
  },
};

const QUEUED_PEER = {
  type: "user",
  uuid: "272ec4fb-1681-4762-b66a-810d9c5fa19a",
  session_id: SESSION,
  parent_tool_use_id: null,
  parent_agent_id: null,
  is_meta: true,
  isQueuedCommand: true,
  timestamp: "2026-10-04T15:13:40.213Z",
  message: {
    role: "user",
    content:
      '<cross-session-message from="uds:/tmp/cc-socks/4757.sock" from-name="compliance-benchmark-7b" from-mode="bypass">\n' +
      "FYI from compliance-benchmark-7b: new private lane cases/ (real-world case library).\n" +
      "</cross-session-message>",
  },
  origin: {
    kind: "peer",
    from: "uds:/tmp/cc-socks/4757.sock",
    verifiedPeerPid: 4757,
    msg_id: "10c34b0c-a931-4f51-9ab4-17000f085fac",
    name: "compliance-benchmark-7b",
    fromMode: "bypass",
    body: "FYI from compliance-benchmark-7b: new private lane cases/ (real-world case library).",
  },
};

describe("peer messages in paginated history (synthesizeOlder)", () => {
  const { messages } = synthesizeOlder([
    assistant("a-1", "Working on the bench harness."),
    QUEUED_PEER,
    assistant("a-2", "Noted — staying out of cases/."),
    IDLE_PEER,
    assistant("a-3", "Thanks, re-running with node@22."),
  ]);
  const peers = messages.filter((m) => m.peer);

  test("both delivery shapes render as peer bubbles, in order", () => {
    expect(peers.map((m) => m.uuid)).toEqual([QUEUED_PEER.uuid, IDLE_PEER.uuid]);
    expect(messages.map((m) => m.uuid)).toEqual(["msg_a-1", QUEUED_PEER.uuid, "msg_a-2", IDLE_PEER.uuid, "msg_a-3"]);
  });

  test("bubbles show the decoded body, not the raw envelope", () => {
    for (const m of peers) {
      const text = m.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("");
      expect(text).not.toContain("cross-session-message");
      expect(text).not.toContain("Another Claude session sent a message");
    }
    expect(peers[0].blocks).toEqual([{ kind: "text", text: QUEUED_PEER.origin.body }]);
  });

  test("sender identity and link keys are kept", () => {
    expect(peers[1].peer).toEqual({
      from: "uds:/tmp/cc-socks/3974.sock",
      name: "compliance-benchmark-07",
      pid: 3974,
      msgId: "29021b5e-198f-46a1-8b71-f77a399e4a34",
    });
    expect(peers[0].createdAt).toBe(Date.parse(QUEUED_PEER.timestamp));
  });
});

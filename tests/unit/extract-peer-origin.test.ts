import { describe, expect, test } from "vitest";
import { extractPeerOrigin } from "@/lib/client/use-session";

/**
 * SDK 0.3.205 added structured `name` and `body` fields to peer-message
 * session events (`SDKMessageOrigin` with `kind: "peer"`). This guards the
 * client-side helper that reads them off a raw SDK user-role message so
 * `UserMessage` can render a "From <name>" badge and prefer the
 * envelope-stripped `body` over re-parsing `message.content`.
 */

describe("extractPeerOrigin", () => {
  test("human-authored message (no origin) returns undefined", () => {
    expect(extractPeerOrigin({ type: "user", message: { content: "hi" } })).toBeUndefined();
  });

  test("origin.kind !== 'peer' (e.g. human/channel/task-notification) returns undefined", () => {
    expect(extractPeerOrigin({ origin: { kind: "human" } })).toBeUndefined();
    expect(extractPeerOrigin({ origin: { kind: "channel", server: "slack" } })).toBeUndefined();
    expect(extractPeerOrigin({ origin: { kind: "task-notification" } })).toBeUndefined();
    expect(extractPeerOrigin({ origin: { kind: "coordinator" } })).toBeUndefined();
  });

  test("peer origin missing 'from' is treated as malformed and dropped", () => {
    expect(extractPeerOrigin({ origin: { kind: "peer" } })).toBeUndefined();
    expect(extractPeerOrigin({ origin: { kind: "peer", from: "" } })).toBeUndefined();
    expect(extractPeerOrigin({ origin: { kind: "peer", from: 42 } })).toBeUndefined();
  });

  test("peer origin with only 'from' (older sender, pre-0.3.205 shape)", () => {
    expect(extractPeerOrigin({ origin: { kind: "peer", from: "session-abc" } })).toEqual({
      from: "session-abc",
    });
  });

  test("peer origin with name + body (0.3.205 shape) surfaces both", () => {
    expect(
      extractPeerOrigin({
        origin: {
          kind: "peer",
          from: "session-abc",
          name: "Release Bot",
          body: "Please review PR #42",
        },
      }),
    ).toEqual({
      from: "session-abc",
      name: "Release Bot",
      body: "Please review PR #42",
    });
  });

  test("empty-string name/body are dropped rather than surfaced as empty", () => {
    expect(
      extractPeerOrigin({
        origin: { kind: "peer", from: "session-abc", name: "", body: "" },
      }),
    ).toEqual({ from: "session-abc" });
  });

  test("non-string name/body are ignored", () => {
    expect(
      extractPeerOrigin({
        origin: { kind: "peer", from: "session-abc", name: 1, body: { x: 1 } },
      }),
    ).toEqual({ from: "session-abc" });
  });
});

import { describe, expect, test } from "vitest";
import { extractPeerOrigin } from "@/lib/client/use-session";

/**
 * SDK 0.3.205 — `SDKMessageOrigin` gained structured `name` and `body`
 * fields on the `peer` variant (sender display name + envelope-stripped
 * decoded body). `extractPeerOrigin` reads `origin` off a raw user-role SDK
 * message and returns `undefined` for anything that isn't a well-formed
 * peer origin, so `UserMessage.tsx`'s "From `<name>`" badge only renders
 * for genuine cross-session turns.
 */
describe("extractPeerOrigin", () => {
  test("human origin returns undefined", () => {
    expect(extractPeerOrigin({ origin: { kind: "human" } })).toBeUndefined();
  });

  test("channel origin returns undefined", () => {
    expect(extractPeerOrigin({ origin: { kind: "channel", server: "slack" } })).toBeUndefined();
  });

  test("task-notification origin returns undefined", () => {
    expect(extractPeerOrigin({ origin: { kind: "task-notification" } })).toBeUndefined();
  });

  test("no origin at all returns undefined", () => {
    expect(extractPeerOrigin({})).toBeUndefined();
    expect(extractPeerOrigin(null)).toBeUndefined();
    expect(extractPeerOrigin(undefined)).toBeUndefined();
  });

  test("malformed peer origin missing `from` is dropped", () => {
    expect(extractPeerOrigin({ origin: { kind: "peer", name: "Release Bot" } })).toBeUndefined();
  });

  test("older-sender peer origin with only `from` (0.3.204 shape)", () => {
    expect(extractPeerOrigin({ origin: { kind: "peer", from: "session-abc" } })).toEqual({
      from: "session-abc",
    });
  });

  test("full 0.3.205 shape carries name and body", () => {
    expect(
      extractPeerOrigin({
        origin: { kind: "peer", from: "session-abc", name: "Release Bot", body: "Deploy finished." },
      }),
    ).toEqual({ from: "session-abc", name: "Release Bot", body: "Deploy finished." });
  });

  test("empty-string name/body are treated as absent, not surfaced", () => {
    expect(
      extractPeerOrigin({ origin: { kind: "peer", from: "session-abc", name: "", body: "" } }),
    ).toEqual({ from: "session-abc" });
  });

  test("non-string name/body are ignored rather than surfaced", () => {
    expect(
      extractPeerOrigin({
        origin: { kind: "peer", from: "session-abc", name: 123, body: { not: "a string" } },
      }),
    ).toEqual({ from: "session-abc" });
  });
});

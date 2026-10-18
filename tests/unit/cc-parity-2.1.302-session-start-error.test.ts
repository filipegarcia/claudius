import { describe, expect, test } from "vitest";
import { sessionStartConnectionLost, sessionStartHttpError } from "@/lib/shared/session-start-error";

/**
 * CC 2.1.302 — a session that fails to start says "Connection lost" or
 * "Server error" instead of a generic message.
 */
describe("session start error text", () => {
  test("network failure reads as connection lost", () => {
    expect(sessionStartConnectionLost()).toBe("create session failed: connection lost — couldn't reach Claudius");
  });

  test("5xx reads as server error, with or without the route's detail", () => {
    expect(sessionStartHttpError(500, "Error: spawn ENOENT")).toBe(
      "create session failed: server error (500) — Error: spawn ENOENT",
    );
    expect(sessionStartHttpError(503)).toBe("create session failed: server error (503)");
    expect(sessionStartHttpError(502, "   ")).toBe("create session failed: server error (502)");
  });

  test("4xx keeps the route's own message, or the bare status", () => {
    expect(sessionStartHttpError(400, "cwd is not a directory")).toBe("create session failed: cwd is not a directory");
    expect(sessionStartHttpError(403)).toBe("create session failed: 403");
  });
});

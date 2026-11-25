import { describe, expect, test } from "vitest";

import { reconnectOutcome, type LiveStatus } from "@/lib/client/useMcp";

/**
 * CC 2.1.330 — "Improved Reconnect in `/mcp` and `/plugin`: a server's page
 * now stays open, with the cause in view, when the server still fails or
 * needs sign-in".
 *
 * On /mcp, Reconnect dropped the route's error and left the row collapsed, so
 * a server that still failed (or still needed sign-in) looked as if nothing
 * had happened. `reconnectOutcome` decides when the row opens itself.
 */

const failed: LiveStatus = { name: "github", status: "failed", error: "connection refused" };

describe("reconnectOutcome", () => {
  test("no Reconnect pressed: the row stays as the user left it", () => {
    expect(reconnectOutcome(undefined, failed)).toEqual({ stillFailing: false, showCause: false });
  });

  test("the reconnect call failed: show its error straight away", () => {
    expect(reconnectOutcome({ before: failed, error: "spawn npx ENOENT" }, failed)).toEqual({
      stillFailing: false,
      showCause: true,
    });
  });

  test("before the status refreshes, the old failed status isn't read as the outcome", () => {
    expect(reconnectOutcome({ before: failed, error: null }, failed)).toEqual({
      stillFailing: false,
      showCause: false,
    });
  });

  test("the refreshed status still fails: open with the cause", () => {
    const after: LiveStatus = { name: "github", status: "failed", error: "connection refused" };
    expect(reconnectOutcome({ before: failed, error: null }, after)).toEqual({ stillFailing: true, showCause: true });
  });

  test("the refreshed status still needs sign-in: open", () => {
    const before: LiveStatus = { name: "linear", status: "needs-auth" };
    const after: LiveStatus = { name: "linear", status: "needs-auth" };
    expect(reconnectOutcome({ before, error: null }, after)).toEqual({ stillFailing: true, showCause: true });
  });

  test("the refreshed status is connected: nothing to show", () => {
    const after: LiveStatus = { name: "github", status: "connected" };
    expect(reconnectOutcome({ before: failed, error: null }, after)).toEqual({ stillFailing: false, showCause: false });
  });
});

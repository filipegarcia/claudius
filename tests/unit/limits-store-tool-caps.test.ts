import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { readLimits, writeLimits } from "@/lib/server/limits-store";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.212 parity: `maxWebSearches`/`maxSubagents` round-trip through the
 * same per-cwd JSON store as the existing USD caps (lib/server/limits-store.ts).
 */
describe("limits-store tool-call caps", () => {
  let tmp: TmpHome;
  const cwd = "/tmp/some-project";

  beforeEach(() => {
    tmp = makeTempHome();
  });

  afterEach(() => {
    tmp.restore();
  });

  test("defaults to disabled (undefined) when nothing has been written", async () => {
    const state = await readLimits(cwd);
    expect(state.limits.maxWebSearches).toBeUndefined();
    expect(state.limits.maxSubagents).toBeUndefined();
  });

  test("round-trips maxWebSearches and maxSubagents through writeLimits/readLimits", async () => {
    await writeLimits(cwd, { maxWebSearches: 50, maxSubagents: 10 });
    const state = await readLimits(cwd);
    expect(state.limits.maxWebSearches).toBe(50);
    expect(state.limits.maxSubagents).toBe(10);
  });

  test("writeLimits fully replaces the limits object (not a merge)", async () => {
    await writeLimits(cwd, { maxWebSearches: 50 });
    await writeLimits(cwd, { sessionUsd: 5 });
    const state = await readLimits(cwd);
    // Matches the existing USD-cap semantics: each writeLimits call is a
    // full replace of `limits`, not a per-field patch — the caller (the PUT
    // route) is responsible for sending the whole desired shape.
    expect(state.limits.maxWebSearches).toBeUndefined();
    expect(state.limits.sessionUsd).toBe(5);
  });

  test("preserves audit/override history across a tool-cap write", async () => {
    await writeLimits(cwd, { maxWebSearches: 50 });
    const { appendAudit } = await import("@/lib/server/limits-store");
    await appendAudit(cwd, {
      ts: new Date().toISOString(),
      kind: "breach",
      scope: "session",
      capUsd: 1,
      spentUsd: 2,
    });
    await writeLimits(cwd, { maxWebSearches: 75 });
    const state = await readLimits(cwd);
    expect(state.limits.maxWebSearches).toBe(75);
    expect(state.audit).toHaveLength(1);
  });
});

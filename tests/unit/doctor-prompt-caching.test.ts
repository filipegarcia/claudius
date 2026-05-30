import { afterEach, beforeEach, describe, expect, test } from "vitest";

/**
 * Coverage for the DISABLE_PROMPT_CACHING doctor check:
 *   GET /api/doctor → checks[] includes a `warn` "prompt-caching" entry only
 *   when process.env.DISABLE_PROMPT_CACHING is set.
 *
 * The doctor route is a Node-runtime GET handler that probes the host
 * environment and returns a list of checks. The new behavior is purely a
 * conditional push gated on the env var, so we drive the real handler with the
 * env var toggled and assert the check's presence/absence and shape.
 */

const { GET } = await import("@/app/api/doctor/route");

type Check = { id: string; label: string; status: string; detail?: string };

async function runChecks(): Promise<Check[]> {
  const res = await GET();
  const body = (await res.json()) as { checks: Check[] };
  return body.checks;
}

describe("GET /api/doctor — prompt-caching check", () => {
  const original = process.env.DISABLE_PROMPT_CACHING;

  beforeEach(() => {
    delete process.env.DISABLE_PROMPT_CACHING;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.DISABLE_PROMPT_CACHING;
    else process.env.DISABLE_PROMPT_CACHING = original;
  });

  test("omits the prompt-caching check when DISABLE_PROMPT_CACHING is unset", async () => {
    const checks = await runChecks();
    expect(checks.find((c) => c.id === "prompt-caching")).toBeUndefined();
  });

  test("emits a warn prompt-caching check when DISABLE_PROMPT_CACHING is set", async () => {
    process.env.DISABLE_PROMPT_CACHING = "1";
    const checks = await runChecks();
    const check = checks.find((c) => c.id === "prompt-caching");
    expect(check).toBeDefined();
    expect(check?.status).toBe("warn");
    expect(check?.label).toBe("Prompt caching");
    expect(check?.detail).toContain("DISABLE_PROMPT_CACHING");
  });

  test("treats any truthy env value (not just '1') as disabled", async () => {
    process.env.DISABLE_PROMPT_CACHING = "true";
    const checks = await runChecks();
    expect(checks.find((c) => c.id === "prompt-caching")?.status).toBe("warn");
  });
});

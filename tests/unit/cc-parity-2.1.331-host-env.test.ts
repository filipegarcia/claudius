import { afterEach, describe, expect, test } from "vitest";

import { HOST_ONLY_ENV_KEYS, scrubHostEnv } from "@/lib/server/host-env";
import { buildQueryEnv } from "@/lib/server/session";
import { getOrCreateBashSession, dropBashSession } from "@/lib/server/bash-mode";
import { execShellCommand } from "@/lib/server/shell";

/**
 * CC 2.1.331 — "Fixed Electron apps and extension tests failing to start from
 * Claude, a hook or an MCP server". The desktop app runs the Next server with
 * ELECTRON_RUN_AS_NODE=1, and Claudius handed that env to the engine (so every
 * Bash command, hook and stdio MCP server) and to `!` bash mode.
 */
describe("host-only env never reaches what Claude starts (2.1.331)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of HOST_ONLY_ENV_KEYS) delete process.env[k];
    Object.assign(process.env, saved);
  });

  test("scrubHostEnv drops the Electron host keys and leaves everything else", () => {
    const env = { ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ASAR: "1", PATH: "/bin", HOME: "/h" };
    expect(scrubHostEnv(env)).toEqual({ PATH: "/bin", HOME: "/h" });
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1"); // input untouched
  });

  test("buildQueryEnv scrubs both the inherited env and an account override", () => {
    process.env.ELECTRON_RUN_AS_NODE = "1";
    expect(buildQueryEnv(null)).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    const override = buildQueryEnv({ ELECTRON_RUN_AS_NODE: "1", CLAUDE_CONFIG_DIR: "/p" });
    expect(override).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(override.CLAUDE_CONFIG_DIR).toBe("/p");
    expect(override.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe("1");
  });

  test("one-shot shell commands and `!` bash mode don't see it", async () => {
    process.env.ELECTRON_RUN_AS_NODE = "1";
    const once = await execShellCommand(process.cwd(), 'printf %s "${ELECTRON_RUN_AS_NODE-unset}"');
    expect(once.stdout).toBe("unset");
    const id = "host-env-test";
    const bash = getOrCreateBashSession(id, process.cwd());
    try {
      const r = await bash.exec('printf %s "${ELECTRON_RUN_AS_NODE-unset}"');
      expect(r.stdout).toBe("unset");
    } finally {
      dropBashSession(id);
    }
  });
});

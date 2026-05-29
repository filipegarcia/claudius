import { afterEach, describe, expect, test } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnStreamed } from "@/lib/server/updater/git";
import { envForBunPhase } from "@/lib/server/updater/apply";

/**
 * Regression coverage for the updater's NODE_ENV plumbing.
 *
 * The bug this catches:
 *
 *   The updater spawns `bun run build` as a subprocess during apply. If the
 *   running Claudius daemon was started via `bun run dev` (the "dev"
 *   runtimeMode), the parent process has `NODE_ENV=development`. Without an
 *   explicit override that leaks into the child, and Next 16's static export
 *   pass dies during the `/_global-error` prerender with:
 *
 *     TypeError: Cannot read properties of null (reading 'useContext')
 *
 *   because React's dispatcher ends up wedged between dev and prod modes.
 *   `apply.ts` now forces `NODE_ENV=production` for the build phase and
 *   `NODE_ENV=development` for the install phase (to keep devDependencies).
 *
 *   The mechanism that makes that work is `spawnStreamed`'s `envOverrides`
 *   argument — if a future refactor drops it on the floor, every install's
 *   updater silently regresses to the original `useContext` failure. These
 *   tests pin the mechanism so that regression shows up as a red bar instead
 *   of a fleet-wide outage.
 *
 * Strategy: spawn a real `node -e "..."` subprocess and have it print
 * whichever env var we care about. Real process, no mocks — the same code
 * path the production updater uses.
 */

const NODE_BIN = process.execPath; // absolute path to the node we're running under

/**
 * Helper: spawn `node -e` with `console.log` of the requested env keys and
 * collect stdout into a single trimmed string. Resolves to the child's exit
 * code + stdout so a test can assert both.
 */
async function spawnPrintingEnv(
  envKeys: string[],
  envOverrides: Partial<NodeJS.ProcessEnv>,
  cwd: string,
): Promise<{ code: number; out: string }> {
  const expr = envKeys
    .map((k) => `(process.env[${JSON.stringify(k)}] ?? "<undef>")`)
    .join(' + "\\n" + ');
  const lines: string[] = [];
  const code = await spawnStreamed(
    NODE_BIN,
    ["-e", `process.stdout.write(${expr})`],
    cwd,
    (line, stream) => {
      if (stream === "out") lines.push(line);
    },
    envOverrides,
  );
  return { code, out: lines.join("\n") };
}

describe("spawnStreamed env overrides", () => {
  let tmp: string;

  // Each test gets a fresh tmp dir so an accidentally side-effecting child
  // can't contaminate the next case. Cheap (mkdtemp + rmSync), worth it.
  let made: string[] = [];
  function freshCwd(): string {
    const d = mkdtempSync(join(tmpdir(), "claudius-updater-env-"));
    made.push(d);
    return d;
  }
  afterEach(() => {
    for (const d of made) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    made = [];
  });

  test(
    "overrides NODE_ENV in the child even when the parent is NODE_ENV=development",
    async () => {
      tmp = freshCwd();
      // Simulate the production failure mode: parent says "development",
      // override says "production". The pre-fix updater would have leaked
      // the parent value and Next would have prerender-failed.
      const prev = process.env.NODE_ENV;
      (process.env as Partial<Record<string, string>>)["NODE_ENV"] = "development";
      try {
        const { code, out } = await spawnPrintingEnv(
          ["NODE_ENV"],
          { NODE_ENV: "production" },
          tmp,
        );
        expect(code).toBe(0);
        expect(out).toBe("production");
      } finally {
        if (prev === undefined) delete (process.env as Partial<Record<string, string>>)["NODE_ENV"];
        else (process.env as Partial<Record<string, string>>)["NODE_ENV"] = prev;
      }
    },
    15_000,
  );

  test(
    "inherits parent env for keys the caller didn't override",
    async () => {
      tmp = freshCwd();
      const tag = `claudius-test-${Date.now()}`;
      process.env.CLAUDIUS_TEST_INHERIT = tag;
      try {
        const { code, out } = await spawnPrintingEnv(
          ["CLAUDIUS_TEST_INHERIT", "NODE_ENV"],
          { NODE_ENV: "production" }, // only override NODE_ENV
          tmp,
        );
        expect(code).toBe(0);
        const [inherited, nodeEnv] = out.split("\n");
        expect(inherited).toBe(tag);
        expect(nodeEnv).toBe("production");
      } finally {
        delete process.env.CLAUDIUS_TEST_INHERIT;
      }
    },
    15_000,
  );

  test(
    "leaves NODE_ENV alone when no override is passed",
    async () => {
      tmp = freshCwd();
      // Belt-and-suspenders: prove the override is opt-in. Without it, the
      // parent value should reach the child unchanged. This is the
      // pre-fix behavior — the test exists to make the contract explicit
      // so a future "always force production" change is a deliberate
      // decision, not an accident.
      const prev = process.env.NODE_ENV;
      (process.env as Partial<Record<string, string>>)["NODE_ENV"] = "development";
      try {
        const { code, out } = await spawnPrintingEnv(["NODE_ENV"], {}, tmp);
        expect(code).toBe(0);
        expect(out).toBe("development");
      } finally {
        if (prev === undefined) delete (process.env as Partial<Record<string, string>>)["NODE_ENV"];
        else (process.env as Partial<Record<string, string>>)["NODE_ENV"] = prev;
      }
    },
    15_000,
  );

  test(
    "envForBunPhase pins the install/build NODE_ENV contract apply.ts depends on",
    () => {
      // These two lines are the entire bug fix. If a future change flips
      // either value, every install of Claudius that tries to update will
      // either (a) miss devDependencies on install, then explode in build
      // with "tsc: command not found", or (b) hit the Next 16
      // /_global-error useContext-null prerender failure.
      //
      // Locking the rule here makes the regression a one-line test failure
      // instead of a fleet-wide outage discovered by users.
      expect(envForBunPhase("install")).toEqual({ NODE_ENV: "development" });
      expect(envForBunPhase("build")).toEqual({ NODE_ENV: "production" });
    },
  );

  test(
    "preserves the updater's git env hardening alongside caller overrides",
    async () => {
      tmp = freshCwd();
      // spawnStreamed pins GIT_TERMINAL_PROMPT=0 and GIT_ASKPASS=/bin/echo
      // unconditionally (so a credential-prompting git op can never wedge
      // the daemon). Overrides must not stomp those.
      const { code, out } = await spawnPrintingEnv(
        ["GIT_TERMINAL_PROMPT", "GIT_ASKPASS", "NODE_ENV"],
        { NODE_ENV: "production" },
        tmp,
      );
      expect(code).toBe(0);
      const [prompt, askpass, nodeEnv] = out.split("\n");
      expect(prompt).toBe("0");
      expect(askpass).toBe("/bin/echo");
      expect(nodeEnv).toBe("production");
    },
    15_000,
  );
});

/**
 * CC 2.1.295 parity — "Added a warning to claude plugin install, enable,
 * disable and marketplace add when the settings file they write to does not
 * load".
 *
 * A malformed settings file used to 500 `GET /api/plugins` (one bad scope took
 * the whole page down) and silently fail every write. Now:
 *   - `readSettings` throws a typed `SettingsParseError` (path + sanitized
 *     reason — no echoed file content, since settings hold `env` secrets);
 *   - `listAll` reports it on that scope only (`parseError`) and still returns
 *     the other scopes;
 *   - writes still refuse — the file is left byte-identical, which is what the
 *     UI's "The file was not changed." promises.
 * Mirrors `auto-mode-settings.test.ts`'s tmpdir-as-HOME approach.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { addExtraMarketplace, listAll, setEnabled } from "@/lib/server/plugins";
import { readSettings, SettingsParseError } from "@/lib/server/settings";
import {
  pluginSettingsWriteBlockedMessage,
  sanitizeJsonParseReason,
} from "@/lib/shared/settings-load-error";

let home: string;
let cwd: string;
let originalHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claudius-plugin-invalid-home-"));
  cwd = mkdtempSync(join(tmpdir(), "claudius-plugin-invalid-project-"));
  originalHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const projectPath = () => join(cwd, ".claude", "settings.json");
// Trailing comma + a secret-looking value that must never reach the client.
const BROKEN = '{\n  "env": { "API_TOKEN": "sk-very-secret" },\n  "enabledPlugins": { "a@m": true },\n}\n';

function writeBrokenProject(body = BROKEN) {
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(projectPath(), body, "utf8");
}

describe("readSettings → SettingsParseError", () => {
  test("throws a typed error naming the file", async () => {
    writeBrokenProject();
    const err = await readSettings("project", cwd).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SettingsParseError);
    expect(err).toBeInstanceOf(SyntaxError);
    expect((err as SettingsParseError).path).toBe(projectPath());
    expect((err as SettingsParseError).reason).not.toContain("sk-very-secret");
  });

  test("a missing file is still {} (not an error)", async () => {
    expect(await readSettings("local", cwd)).toEqual({});
  });
});

describe("listAll per-scope parse errors", () => {
  test("a broken project file is reported on that scope; user/local still render", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "good@market": true } }),
    );
    writeBrokenProject();

    const scopes = await listAll(cwd);
    expect(scopes.map((s) => s.scope)).toEqual(["user", "project", "local"]);

    const [user, project, local] = scopes;
    expect(user.parseError).toBeUndefined();
    expect(user.enabledPlugins).toEqual({ "good@market": true });

    expect(project.path).toBe(projectPath());
    expect(typeof project.parseError).toBe("string");
    expect(project.parseError).not.toContain("sk-very-secret");
    expect(project.enabledPlugins).toEqual({});
    expect(project.extraKnownMarketplaces).toEqual([]);

    expect(local.parseError).toBeUndefined();
  });
});

describe("writes to a broken scope leave the file untouched", () => {
  test("setEnabled rejects and the file is byte-identical", async () => {
    writeBrokenProject();
    await expect(setEnabled("project", cwd, "x@m", true)).rejects.toBeInstanceOf(SettingsParseError);
    expect(readFileSync(projectPath(), "utf8")).toBe(BROKEN);
  });

  test("addExtraMarketplace rejects and the file is byte-identical", async () => {
    writeBrokenProject();
    await expect(
      addExtraMarketplace("project", cwd, "acme", { source: "github", repo: "acme/plugins" }),
    ).rejects.toBeInstanceOf(SettingsParseError);
    expect(readFileSync(projectPath(), "utf8")).toBe(BROKEN);
  });
});

describe("sanitizeJsonParseReason", () => {
  test("drops V8's echoed source fragment", () => {
    const r = sanitizeJsonParseReason('Unexpected token \'h\', "hello secret" is not valid JSON');
    expect(r).not.toContain("secret");
    expect(r).toContain("Unexpected token");
  });

  test("keeps position info for positional errors", () => {
    const msg = "Expected double-quoted property name in JSON at position 22 (line 1 column 23)";
    expect(sanitizeJsonParseReason(msg)).toBe(msg);
  });

  test("redacts any other quoted fragment and collapses whitespace", () => {
    expect(sanitizeJsonParseReason('bad "sk-123"\n here')).toBe('bad "…" here');
  });

  test("never returns an empty reason and caps length", () => {
    expect(sanitizeJsonParseReason("")).toBe("invalid JSON");
    expect(sanitizeJsonParseReason("x".repeat(500)).length).toBeLessThanOrEqual(160);
  });

  test("real JSON.parse messages never leak the file content", () => {
    for (const body of [BROKEN, "hello secret", '{"k": "sk-abc" "x": 1}', ""]) {
      let message = "";
      try {
        JSON.parse(body);
      } catch (e) {
        message = (e as Error).message;
      }
      const reason = sanitizeJsonParseReason(message);
      expect(reason).not.toMatch(/secret|sk-abc|sk-very/);
    }
  });
});

describe("pluginSettingsWriteBlockedMessage", () => {
  test("names the file, the reason, and that it was not changed", () => {
    const m = pluginSettingsWriteBlockedMessage("/p/.claude/settings.json", "Unexpected end of JSON input");
    expect(m).toBe(
      "/p/.claude/settings.json doesn't load (Unexpected end of JSON input) — fix it before Claudius can change plugins there. The file was not changed.",
    );
  });
});

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { POST } from "@/app/api/settings/permissions/route";
import { createWorkspace } from "@/lib/server/workspaces-store";
import {
  permissionRuleRefusalMessage,
  validatePermissionRule,
  type PermissionRuleKind,
} from "@/lib/shared/permission-rule-lint";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.332 — "Improved `/permissions` to refuse a rule that would be
 * skipped at the next start, such as `rm -rf` with no tool name, and to show
 * the reason". `validatePermissionRule` ports the refusal branches of the
 * engine's validator (`pme` in the bundled 2.1.332 CLI). Every case below was
 * traced through that source: one per refusal string, plus rules it loads.
 */

describe("validatePermissionRule — refusals (one per engine error)", () => {
  const refused: Array<[rule: string, kind: PermissionRuleKind, error: string]> = [
    ["   ", "deny", "Permission rule cannot be empty"],
    ["Bash(foo) bar", "deny", "Malformed Tool(content) rule"],
    ["Bash(npm test", "allow", "Malformed Tool(content) rule"],
    ["Bash)", "ask", "Malformed Tool(content) rule"],
    ["()", "deny", "Empty parentheses with no tool name"],
    ["Bash()", "deny", "Empty parentheses"],
    ["mcp__srv__tool(x)", "deny", "MCP rules do not support patterns in parentheses"],
    ["mcp__srv(x)", "allow", "MCP rules do not support patterns in parentheses"],
    ["rm -rf", "deny", "Tool names must start with uppercase"],
    ["bash", "ask", "Tool names must start with uppercase"],
    ["Edit(C:\\dir\\(name)\\**)", "allow", 'Ambiguous "\\(" or "\\)" beside an unescaped parenthesis'],
    ["Bash(:*)", "deny", "Prefix cannot be empty before :*"],
    ["Read(src:*)", "deny", 'The ":*" syntax is only for Bash prefix rules'],
    ["WebSearch(claude*)", "allow", "WebSearch does not support wildcards"],
    ["WebFetch(https://example.com)", "allow", "WebFetch permissions use domain format, not URLs"],
    ["WebFetch(example.com)", "deny", 'WebFetch permissions must use "domain:" prefix'],
    ["Bash*", "allow", 'Wildcard tool name "Bash*" is not supported in allow rules'],
    ["mcp__*", "allow", 'Wildcard tool name "mcp__*" is not supported in allow rules'],
  ];

  test.each(refused)("%s (%s) → %s", (rule, kind, error) => {
    const check = validatePermissionRule(rule, kind);
    expect(check.valid).toBe(false);
    if (!check.valid) expect(check.error).toBe(error);
  });

  test("rm -rf carries the engine's suggestion", () => {
    expect(validatePermissionRule("rm -rf", "deny")).toEqual({
      valid: false,
      error: "Tool names must start with uppercase",
      suggestion: 'Use "Rm -rf"',
    });
  });

  test("the reason reads like the engine's start-up message", () => {
    expect(permissionRuleRefusalMessage(validatePermissionRule("Bash()", "deny"))).toBe(
      'Empty parentheses. Either specify a pattern or use just "Bash" without parentheses. Examples: Bash, Bash(some-pattern)',
    );
    expect(permissionRuleRefusalMessage(validatePermissionRule("Bash(npm test)", "allow"))).toBeNull();
  });
});

describe("validatePermissionRule — rules the engine loads", () => {
  const loaded: Array<[rule: string, kind: PermissionRuleKind]> = [
    ["Bash", "allow"],
    ["Bash(npm test)", "allow"],
    ["Bash(*)", "allow"],
    ["Bash(npm run *)", "allow"],
    ["Read(./src/**)", "allow"],
    ["Edit(C:/dir/(name)/**)", "allow"],
    ["WebFetch(domain:example.com)", "allow"],
    ["mcp__srv", "allow"],
    ["mcp__srv__*", "allow"],
    ["mcp__srv__tool", "deny"],
    // Valid with an engine warning — the inline lints cover these.
    ["Write(./src/**)", "allow"],
    ["Bash(git * main)", "allow"],
    ["Bash(PORT=* npm run dev)", "allow"],
    // Balanced escaped parentheses aren't ambiguous.
    ["Bash(echo \\(hi\\))", "allow"],
    // Wildcard tool names are allow-only refusals.
    ["Bash*", "deny"],
    ["mcp__*", "ask"],
    // A tool name containing "_" skips the uppercase check.
    ["custom_tool", "allow"],
    // The engine's parser reads "(foo)" as a tool literally named "(foo)",
    // which passes its checks ("(" upper-cases to itself). Ported as is.
    ["(foo)", "deny"],
  ];

  test.each(loaded)("%s (%s) loads", (rule, kind) => {
    expect(validatePermissionRule(rule, kind)).toEqual({ valid: true });
  });
});

describe("POST /api/settings/permissions refuses rules the engine skips", () => {
  let home: TmpHome;
  let root: string;

  beforeEach(async () => {
    home = makeTempHome();
    root = mkdtempSync(join(home.home, "proj-"));
    await createWorkspace({ name: "Proj", rootPath: root });
  });
  afterEach(() => home.restore());

  const post = (body: unknown) =>
    POST(new Request("http://localhost/api/settings/permissions", { method: "POST", body: JSON.stringify(body) }));
  const settingsPath = () => join(root, ".claude", "settings.json");

  test("a refused ruleDelta.add is a 400 with the reason, and nothing is written", async () => {
    const res = await post({ scope: "project", cwd: root, ruleDelta: { kind: "deny", add: ["rm -rf"] } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('"rm -rf" would be skipped at the next start: Tool names must start with uppercase. Use "Rm -rf"');
    expect(() => readFileSync(settingsPath(), "utf8")).toThrow();
  });

  test("a valid rule still saves", async () => {
    const res = await post({ scope: "project", cwd: root, ruleDelta: { kind: "deny", add: ["Bash(rm -rf *)"] } });
    expect(res.status).toBe(200);
    expect(JSON.parse(readFileSync(settingsPath(), "utf8")).permissions.deny).toEqual(["Bash(rm -rf *)"]);
  });

  test("removing a rule the engine skips is still allowed", async () => {
    // A hand-edited bad rule already in the file.
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({ permissions: { deny: ["rm -rf", "Bash(curl *)"] } }));
    const res = await post({ scope: "project", cwd: root, ruleDelta: { kind: "deny", remove: ["rm -rf"] } });
    expect(res.status).toBe(200);
    expect(JSON.parse(readFileSync(settingsPath(), "utf8")).permissions.deny).toEqual(["Bash(curl *)"]);
  });

  test("a patch list can't smuggle a refused rule in", async () => {
    const res = await post({ scope: "project", cwd: root, patch: { allow: ["Bash(ls)", "*"] } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^"\*" would be skipped at the next start: Wildcard tool name/);
  });
});

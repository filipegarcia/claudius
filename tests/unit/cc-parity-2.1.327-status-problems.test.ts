import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CC 2.1.327 parity — "Added a list in /status of broken agent, skill,
 * command and output style files, keybinding errors, …".
 *
 * Claudius parses agent/skill frontmatter itself and used to drop malformed
 * YAML silently (the file listed as a normal row with no description). This
 * covers the strict detector, the lister over a temp HOME + project dir, and
 * both real routes (`/api/doctor/files` for /status, `/api/doctor` for the
 * Config files section). `os.homedir()` reads `HOME` at call time, so the
 * temp HOME keeps the real `~/.claude` untouched.
 */

const { frontmatterError, parseFrontmatter, parseFrontmatterYaml } = await import("@/lib/server/agents");
const { listConfigFileProblems, configFileChecks } = await import("@/lib/server/config-file-problems");
const { createWorkspace } = await import("@/lib/server/workspaces-store");
const filesRoute = await import("@/app/api/doctor/files/route");
const doctorRoute = await import("@/app/api/doctor/route");

const GOOD = "---\nname: good\ndescription: Reviews code\n---\nYou review code.\n";
// A mis-indented line: the engine's quote-wrapping fallback only rewrites
// top-level `key: value` lines, so this still fails its second parse.
const BROKEN = "---\nname: broken\ndescription: Reviews code\n  model: sonnet\n---\nYou review code.\n";
// Strict YAML rejects these (`: ` inside a plain scalar), but the engine
// quote-wraps the value and loads the agent — so they must not be flagged.
const RESCUED = "---\nname: rescued\ndescription: Reviews: code\n---\nYou review code.\n";
const RESCUED_EXAMPLES =
  "---\nname: helper\ndescription: Use this agent when reviewing. Examples: <example>Context: a PR</example>\n" +
  "tools: [Read, Grep]\n---\nBody\n";

describe("frontmatterError", () => {
  test("null for valid, empty or missing frontmatter", () => {
    expect(frontmatterError(GOOD)).toBeNull();
    expect(frontmatterError("﻿" + GOOD)).toBeNull();
    expect(frontmatterError("No frontmatter at all.\n")).toBeNull();
    expect(frontmatterError("---\n---\nbody\n")).toBeNull();
    expect(frontmatterError("---\n# just a comment\n---\nbody\n")).toBeNull();
  });

  test("mirrors the engine's fallback: values with `: ` or indicator characters still load", () => {
    expect(frontmatterError(RESCUED)).toBeNull();
    expect(parseFrontmatter(RESCUED).frontmatter).toEqual({ name: "rescued", description: "Reviews: code" });
    expect(frontmatterError(RESCUED_EXAMPLES)).toBeNull();
    expect(parseFrontmatter(RESCUED_EXAMPLES).frontmatter).toEqual({
      name: "helper",
      description: "Use this agent when reviewing. Examples: <example>Context: a PR</example>",
      tools: ["Read", "Grep"],
    });
    // Backslashes and double quotes survive the quote-wrap.
    expect(parseFrontmatter('---\ndescription: say "hi" \\ then: go\n---\n').frontmatter).toEqual({
      description: 'say "hi" \\ then: go',
    });
    // Leading tabs become two spaces each.
    expect(parseFrontmatterYaml("tools:\n\t- Read\n\t- Grep\n")).toEqual({ tools: ["Read", "Grep"] });
  });

  test("names the YAML error with its file line number", () => {
    expect(frontmatterError(BROKEN)).toBe("Nested mappings are not allowed in compact mappings (line 3)");
    expect(frontmatterError("---\nname: a\nname: b\n---\n")).toBe("Map keys must be unique (line 3)");
    // Only the first line of the yaml package's multi-line message survives.
    expect(frontmatterError('---\ndescription: "open\n---\n')).not.toContain("\n");
    // Not rescued: an unterminated quote isn't rewritten by the fallback.
    expect(frontmatterError('---\nname: x\ndescription: "Reviews code\n---\n')).toBe('Missing closing "quote (line 3)');
  });

  test("flags frontmatter parseFrontmatter would drop for not being a map", () => {
    expect(frontmatterError("---\n- a\n- b\n---\nbody\n")).toBe("Frontmatter is not a list of key: value fields");
    expect(parseFrontmatter("---\n- a\n- b\n---\nbody\n").frontmatter).toEqual({});
  });

  test("flags an opening --- that is never closed", () => {
    expect(frontmatterError("---\nname: x\nbody without a closing line\n")).toBe(
      "Frontmatter has no closing --- line",
    );
  });

  test("agrees with parseFrontmatter: every flagged file parses to {}", () => {
    expect(parseFrontmatter(BROKEN).frontmatter).toEqual({});
    expect(parseFrontmatter(GOOD).frontmatter).toMatchObject({ name: "good" });
  });
});

describe("config file problems", () => {
  const originalHome = process.env.HOME;
  let fakeHome: string;
  let projectDir: string;

  async function write(path: string, text: string) {
    await fs.mkdir(join(path, ".."), { recursive: true });
    await fs.writeFile(path, text, "utf8");
  }

  beforeEach(async () => {
    fakeHome = await fs.mkdtemp(join(tmpdir(), "claudius-status-problems-home-"));
    process.env.HOME = fakeHome;
    projectDir = await fs.mkdtemp(join(tmpdir(), "claudius-status-problems-proj-"));
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.rm(fakeHome, { recursive: true, force: true });
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  test("nothing to report when every file is fine", async () => {
    await write(join(fakeHome, ".claude", "agents", "good.md"), GOOD);
    await write(join(projectDir, ".claude", "skills", "good", "SKILL.md"), GOOD);
    await write(join(fakeHome, ".claude", "keybindings.json"), '{"bindings": []}\n');
    const problems = await listConfigFileProblems([{ id: "ws1", name: "Proj", rootPath: projectDir }]);
    expect(problems).toEqual([]);
    const checks = configFileChecks(problems);
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ["config-file:agents-skills", "ok"],
      ["config-file:keybindings", "ok"],
    ]);
  });

  test("lists broken agents and skills in both scopes, and bad keybindings.json", async () => {
    await write(join(fakeHome, ".claude", "agents", "good.md"), GOOD);
    await write(join(fakeHome, ".claude", "agents", "broken.md"), BROKEN);
    await write(join(fakeHome, ".claude", "skills", "good", "SKILL.md"), GOOD);
    await write(join(fakeHome, ".claude", "skills", "busted", "SKILL.md"), BROKEN);
    await write(join(projectDir, ".claude", "agents", "proj-broken.md"), BROKEN);
    await write(join(projectDir, ".claude", "agents", "proj-good.md"), GOOD);
    await write(join(projectDir, ".claude", "skills", "proj-skill", "SKILL.md"), "---\n- a\n---\n");
    await write(join(fakeHome, ".claude", "keybindings.json"), '{"bindings": [,]}');

    const problems = await listConfigFileProblems([{ id: "ws1", name: "Proj", rootPath: projectDir }]);
    const summary = problems.map((p) => [p.kind, p.scope, p.name, p.workspace?.id ?? null]);
    expect(summary).toEqual([
      ["agent", "user", "broken", null],
      ["skill", "user", "busted", null],
      ["keybindings", "user", "keybindings.json", null],
      ["agent", "project", "proj-broken", "ws1"],
      ["skill", "project", "proj-skill", "ws1"],
    ]);
    const agent = problems[0];
    expect(agent.path).toBe(join(fakeHome, ".claude", "agents", "broken.md"));
    expect(agent.reason).toContain("(line 3)");
    // Don't pin V8's JSON error text — it differs across Node versions.
    expect(problems[2].reason.length).toBeGreaterThan(0);
    expect(problems[2].reason).not.toContain("\n");

    const checks = configFileChecks(problems);
    expect(checks.every((c) => c.status === "warn" && c.category === "config-files")).toBe(true);
    const projAgent = checks.find((c) => c.id === "config-file:agent:ws1:proj-broken");
    expect(projAgent?.label).toBe("Broken agent — proj-broken (Proj)");
    expect(projAgent?.detail).toContain(join(projectDir, ".claude", "agents", "proj-broken.md"));
    expect(projAgent?.link).toEqual({ href: "/ws1/agents", label: "Open Agents" });
    expect(checks.find((c) => c.id === "config-file:skill:user:busted")?.link).toEqual({
      href: "/skills",
      label: "Open Skills",
    });
    expect(checks.find((c) => c.id.startsWith("config-file:keybindings"))?.link?.href).toBe("/keybindings");
  });

  test("keybindings.json that isn't a JSON object is a problem", async () => {
    await write(join(fakeHome, ".claude", "keybindings.json"), "[1, 2]\n");
    const problems = await listConfigFileProblems([]);
    expect(problems).toEqual([
      expect.objectContaining({ kind: "keybindings", reason: "Expected a JSON object" }),
    ]);
  });

  test("a workspace rooted at HOME isn't reported twice", async () => {
    await write(join(fakeHome, ".claude", "agents", "broken.md"), BROKEN);
    const problems = await listConfigFileProblems([{ id: "home", name: "Home", rootPath: fakeHome }]);
    expect(problems).toHaveLength(1);
  });

  test("GET /api/doctor/files scopes to the given workspace and the user scope", async () => {
    await write(join(fakeHome, ".claude", "agents", "broken.md"), BROKEN);
    await write(join(projectDir, ".claude", "skills", "bad", "SKILL.md"), BROKEN);
    const otherDir = await fs.mkdtemp(join(tmpdir(), "claudius-status-problems-other-"));
    try {
      await write(join(otherDir, ".claude", "agents", "elsewhere.md"), BROKEN);
      const ws = await createWorkspace({ name: "Proj", rootPath: projectDir });
      await createWorkspace({ name: "Other", rootPath: otherDir });

      const scoped = await filesRoute.GET(
        new Request(`http://localhost/api/doctor/files?workspaceId=${encodeURIComponent(ws.id)}`),
      );
      const scopedBody = (await scoped.json()) as { problems: Array<{ name: string }> };
      expect(scopedBody.problems.map((p) => p.name).sort()).toEqual(["bad", "broken"]);

      const all = await filesRoute.GET(new Request("http://localhost/api/doctor/files"));
      const allBody = (await all.json()) as { problems: Array<{ name: string }> };
      expect(allBody.problems.map((p) => p.name).sort()).toEqual(["bad", "broken", "elsewhere"]);

      const unknown = await filesRoute.GET(new Request("http://localhost/api/doctor/files?workspaceId=nope"));
      const unknownBody = (await unknown.json()) as { problems: Array<{ name: string }> };
      expect(unknownBody.problems.map((p) => p.name)).toEqual(["broken"]);

      // /doctor carries the same checks in its Config files section.
      const doctor = await doctorRoute.GET();
      const doctorBody = (await doctor.json()) as { checks: Array<{ id: string; category?: string }> };
      const ids = doctorBody.checks.filter((c) => c.category === "config-files").map((c) => c.id);
      expect(ids).toContain("config-file:agent:user:broken");
      expect(ids).toContain(`config-file:skill:${ws.id}:bad`);
      expect(ids).toContain("config-file:keybindings");
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Coverage for CC 2.1.283 parity ("Added `/doctor prompt-audit` (also
 * `/checkup prompt-audit`) to audit your CLAUDE.md files, skills, agents and
 * commands for prompting patterns written for older models"). Modeled on
 * `tests/unit/doctor-claude-md-size.test.ts` — pointing `HOME` at a
 * throwaway temp dir exercises the real `GET /api/doctor` handler against a
 * real (fake) workspace without touching the developer/CI
 * `~/.claude/.claudius/workspaces.json`.
 */

const { GET } = await import("@/app/api/doctor/route");
const { createWorkspace, updateWorkspace } = await import("@/lib/server/workspaces-store");
const { upsertDbAgent } = await import("@/lib/server/db-agents");

type Check = {
  id: string;
  label: string;
  status: string;
  detail?: string;
  link?: { href: string; label: string };
  category?: string;
};

async function runChecks(): Promise<Check[]> {
  const res = await GET();
  const body = (await res.json()) as { checks: Check[] };
  return body.checks;
}

describe("GET /api/doctor — prompt-audit check", () => {
  const originalHome = process.env.HOME;
  let fakeHome: string;
  let projectDir: string;

  beforeEach(async () => {
    fakeHome = await fs.mkdtemp(join(tmpdir(), "claudius-doctor-promptaudit-"));
    process.env.HOME = fakeHome;
    projectDir = await fs.mkdtemp(join(tmpdir(), "claudius-doctor-promptaudit-project-"));
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.rm(fakeHome, { recursive: true, force: true });
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  test("omits the check for a workspace with no CLAUDE.md, skills, agents, or commands", async () => {
    await createWorkspace({ name: "Empty project", rootPath: projectDir });
    const checks = await runChecks();
    expect(checks.some((c) => c.id.startsWith("prompt-audit:"))).toBe(false);
  });

  test("reports ok for a clean checked-in CLAUDE.md", async () => {
    await fs.writeFile(
      join(projectDir, "CLAUDE.md"),
      "# House style\n\nRead the relevant files first, then make the change.\n",
      "utf8",
    );
    const ws = await createWorkspace({ name: "Clean project", rootPath: projectDir });

    const checks = await runChecks();
    const check = checks.find((c) => c.id === `prompt-audit:${ws.id}`);
    expect(check).toBeDefined();
    expect(check?.status).toBe("ok");
    expect(check?.category).toBe("prompt-audit");
  });

  test("warns on chain-of-thought scaffolding in CLAUDE.md but not on documented thinking keywords", async () => {
    await fs.writeFile(
      join(projectDir, "CLAUDE.md"),
      "Always think step by step before writing code. Think hard about edge cases.\n",
      "utf8",
    );
    const ws = await createWorkspace({ name: "Stale prompting project", rootPath: projectDir });

    const checks = await runChecks();
    const check = checks.find((c) => c.id === `prompt-audit:${ws.id}`);
    expect(check).toBeDefined();
    expect(check?.status).toBe("warn");
    expect(check?.label).toContain("Stale prompting project");
    expect(check?.detail).toContain("stale prompting pattern");
    expect(check?.detail).toContain("step by step");
    expect(check?.link).toEqual({ href: `/${ws.id}/memory`, label: "Review in Memory" });
  });

  test("warns on a CLAUDE.md path reference to a file that doesn't exist", async () => {
    await fs.writeFile(
      join(projectDir, "CLAUDE.md"),
      "See `lib/server/does-not-exist.ts` for the session lifecycle.\n",
      "utf8",
    );
    const ws = await createWorkspace({ name: "Stale path project", rootPath: projectDir });

    const checks = await runChecks();
    const check = checks.find((c) => c.id === `prompt-audit:${ws.id}`);
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("path reference");
    expect(check?.detail).toContain("lib/server/does-not-exist.ts");
  });

  test("does not warn on a CLAUDE.md path reference to a file that exists", async () => {
    await fs.mkdir(join(projectDir, "lib"), { recursive: true });
    await fs.writeFile(join(projectDir, "lib", "real.ts"), "export {};\n", "utf8");
    await fs.writeFile(join(projectDir, "CLAUDE.md"), "See `lib/real.ts` for details.\n", "utf8");
    const ws = await createWorkspace({ name: "Real path project", rootPath: projectDir });

    const checks = await runChecks();
    const check = checks.find((c) => c.id === `prompt-audit:${ws.id}`);
    expect(check?.status).toBe("ok");
  });

  test("scans project skills for stale prompting patterns", async () => {
    await fs.mkdir(join(projectDir, ".claude", "skills", "my-skill"), { recursive: true });
    await fs.writeFile(
      join(projectDir, ".claude", "skills", "my-skill", "SKILL.md"),
      "---\nname: my-skill\ndescription: test skill\n---\nYou are a helpful AI assistant. Always be nice.\n",
      "utf8",
    );
    const ws = await createWorkspace({ name: "Skill project", rootPath: projectDir });

    const checks = await runChecks();
    const check = checks.find((c) => c.id === `prompt-audit:${ws.id}`);
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("skill:my-skill");
    // No CLAUDE.md finding here — link goes to Skills, not the unrelated
    // Memory page.
    expect(check?.link).toEqual({ href: `/${ws.id}/skills`, label: "Review in Skills" });
  });

  test("scans DB-backed agents for stale prompting patterns", async () => {
    const ws = await createWorkspace({ name: "Agent project", rootPath: projectDir });
    await upsertDbAgent(projectDir, "reviewer", {
      description: "Reviews code as an AI language model.",
      prompt: "Review the diff carefully.",
    });

    const checks = await runChecks();
    const check = checks.find((c) => c.id === `prompt-audit:${ws.id}`);
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("agent:reviewer");
    expect(check?.link).toEqual({ href: `/${ws.id}/agents`, label: "Review in Agents" });
  });

  test("scans .claude/commands/*.md files for stale prompting patterns", async () => {
    await fs.mkdir(join(projectDir, ".claude", "commands"), { recursive: true });
    await fs.writeFile(
      join(projectDir, ".claude", "commands", "review.md"),
      "As an AI language model, review this PR thoroughly.\n",
      "utf8",
    );
    const ws = await createWorkspace({ name: "Command project", rootPath: projectDir });

    const checks = await runChecks();
    const check = checks.find((c) => c.id === `prompt-audit:${ws.id}`);
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("command:review.md");
    // No dedicated Claudius page for `.claude/commands/*.md` yet — no link.
    expect(check?.link).toBeUndefined();
  });

  test("skips customization workspaces (not a user project)", async () => {
    await fs.writeFile(join(projectDir, "CLAUDE.md"), "Think step by step.\n", "utf8");
    const ws = await createWorkspace({ name: "Dogfood workspace", rootPath: projectDir });
    await updateWorkspace(ws.id, { kind: "customization" });

    const checks = await runChecks();
    expect(checks.find((c) => c.id === `prompt-audit:${ws.id}`)).toBeUndefined();
  });
});

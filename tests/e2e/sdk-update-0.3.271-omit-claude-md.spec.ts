/**
 * SDK 0.3.271 — added `omitClaudeMd` to `AgentDefinition` (the `agents`
 * option): "Run this agent without the user, project and local CLAUDE.md
 * instruction files when it runs as a subagent; managed policy files still
 * load."
 *
 * This is also a recognized `.claude/agents/*.md` frontmatter key — verified
 * against the bundled `claude` binary, which lists `omitClaudeMd` alongside
 * `background`/`memory`/`permissionMode` in its subagent frontmatter parser
 * and its markdown-agent schema key list. The Agents editor
 * (`app/[workspaceId]/agents/page.tsx`) already renders compact "meta
 * badges" for the other advanced `AgentDefinition` fields (`background`,
 * `memory`, `effort`, …) that survive into frontmatter — this adds the same
 * treatment for `omitClaudeMd`, plus a commented line in the "new agent"
 * template.
 *
 * This spec seeds a scratch workspace with three `.claude/agents/*.md`
 * files (only one with `omitClaudeMd: true`), opens the Agents page, and
 * asserts the new "no CLAUDE.md" badge renders only for that agent — in
 * the real sidebar, next to the other agents' badges, with the page chrome
 * (side nav, header, scope toggle) in frame.
 *
 * Screenshot target: docs/sdk-updates/0.3.271/omit-claude-md-badge.png
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.271");
mkdirSync(SHOTS_DIR, { recursive: true });

test.describe("omitClaudeMd agent badge (SDK 0.3.271)", () => {
  test("renders a 'no CLAUDE.md' badge only for the agent with omitClaudeMd: true", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(60_000);

    const dir = mktempAgentsWorkspace();
    let wsId: string | undefined;

    try {
      const created = await page.request.post(`${baseURL}/api/workspaces`, {
        data: { name: `omit-claude-md-${Date.now()}`, rootPath: dir },
      });
      expect(created.ok(), "creating scratch workspace").toBeTruthy();
      const ws = (await created.json()) as { id: string };
      wsId = ws.id;

      await page.request.post(`${baseURL}/api/workspaces/${ws.id}/select`);
      await page.goto(`/${ws.id}/agents`);

      // Sidebar lists all three project agents once the fetch settles.
      await expect(page.getByText("no-flags-agent")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("background-agent")).toBeVisible();
      await expect(page.getByText("quiet-subagent")).toBeVisible();

      // Only the agent authored with `omitClaudeMd: true` shows the badge.
      const badges = page.getByTestId("agent-meta-badge");
      await expect(badges.filter({ hasText: "no CLAUDE.md" })).toHaveCount(1);
      await expect(badges.filter({ hasText: "background" })).toHaveCount(1);

      // Screenshot in context — full Agents page chrome with the populated
      // sidebar (side nav, header, scope toggle, all three agents visible).
      const list = page.locator("aside").first();
      await list.scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      await page.screenshot({
        path: resolve(SHOTS_DIR, "omit-claude-md-badge.png"),
        fullPage: false,
      });
    } finally {
      if (wsId) {
        await page.request.delete(`${baseURL}/api/workspaces/${wsId}`).catch(() => {});
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup — never fail the test over a leftover tmpdir
      }
    }
  });
});

function mktempAgentsWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "claudius-omit-claude-md-"));
  const agentsDir = join(dir, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });

  writeFileSync(
    join(agentsDir, "quiet-subagent.md"),
    [
      "---",
      "name: quiet-subagent",
      "description: Runs without any project instruction files",
      "tools: [Read, Grep]",
      "omitClaudeMd: true",
      "---",
      "",
      "You are a focused subagent that only sees this prompt.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(agentsDir, "background-agent.md"),
    [
      "---",
      "name: background-agent",
      "description: Runs as a non-blocking background task",
      "background: true",
      "---",
      "",
      "You run in the background.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(agentsDir, "no-flags-agent.md"),
    [
      "---",
      "name: no-flags-agent",
      "description: Plain agent with no advanced fields set",
      "---",
      "",
      "You are a plain subagent.",
      "",
    ].join("\n"),
  );

  return dir;
}

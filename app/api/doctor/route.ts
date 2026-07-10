import { NextResponse } from "next/server";
import { promises as fs, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readScope, claudeMdSizeWarning } from "@/lib/server/claudemd";
import { listWorkspaces } from "@/lib/server/workspaces-store";

const execFileP = promisify(execFile);

export const runtime = "nodejs";

type Status = "ok" | "warn" | "fail";

type Check = {
  id: string;
  label: string;
  status: Status;
  detail?: string;
  /**
   * True when this check has a corresponding `POST /api/doctor/fix` action
   * (see that route for the fixed allowlist of ids). Only offered for checks
   * that are pure, local, non-destructive filesystem fixes against fixed
   * paths derived from `homedir()` — never for auth, package installs, or
   * anything that would require running an external command.
   */
  fixable?: boolean;
  /**
   * Optional call-to-action link (CC 2.1.206 parity: the "checked-in
   * CLAUDE.md too big" check). Routes into an existing Claudius screen
   * rather than offering a `fixable` auto-fix — trimming CLAUDE.md is a
   * judgment call, not a safe automated filesystem op.
   */
  link?: { href: string; label: string };
};

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function writable(path: string): Promise<boolean> {
  try {
    await fs.access(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function gitVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["--version"], { timeout: 1500 });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function GET() {
  const checks: Check[] = [];

  // Node version
  const node = process.versions.node;
  const major = Number(node.split(".")[0] ?? "0");
  checks.push({
    id: "node",
    label: "Node.js",
    status: major >= 20 ? "ok" : major >= 18 ? "warn" : "fail",
    detail: `v${node}`,
  });

  // Anthropic SDK present
  let sdkVer: string | null = null;
  try {
    const pkg = await fs.readFile(
      join(process.cwd(), "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"),
      "utf8",
    );
    sdkVer = (JSON.parse(pkg) as { version?: string; claudeCodeVersion?: string }).version ?? null;
    const ccv = (JSON.parse(pkg) as { claudeCodeVersion?: string }).claudeCodeVersion;
    checks.push({
      id: "agent-sdk",
      label: "@anthropic-ai/claude-agent-sdk",
      status: "ok",
      detail: ccv ? `${sdkVer} (Claude Code ${ccv})` : (sdkVer ?? "(unknown)"),
    });
  } catch {
    checks.push({
      id: "agent-sdk",
      label: "@anthropic-ai/claude-agent-sdk",
      status: "fail",
      detail: "package not found — npm install",
    });
  }

  // Auth: env or credentials file
  const hasEnv = !!process.env.ANTHROPIC_API_KEY;
  const credsPath = join(homedir(), ".claude", ".credentials.json");
  const hasCreds = await exists(credsPath);
  const provider =
    process.env.CLAUDE_CODE_USE_BEDROCK === "1"
      ? "Bedrock"
      : process.env.CLAUDE_CODE_USE_VERTEX === "1"
      ? "Vertex"
      : process.env.CLAUDE_CODE_USE_FOUNDRY === "1"
      ? "Foundry"
      : "Anthropic";
  checks.push({
    id: "auth",
    label: "Auth",
    status: hasEnv || hasCreds || provider !== "Anthropic" ? "ok" : "warn",
    detail:
      provider !== "Anthropic"
        ? `Provider: ${provider} (uses external credentials)`
        : hasEnv
        ? "ANTHROPIC_API_KEY set"
        : hasCreds
        ? "OAuth credentials file present"
        : "No API key or OAuth credentials found",
  });

  // ~/.claude writable
  const claudeDir = join(homedir(), ".claude");
  const claudeOk = (await exists(claudeDir)) && (await writable(claudeDir));
  checks.push({
    id: "claude-dir",
    label: "~/.claude",
    status: claudeOk ? "ok" : "warn",
    detail: claudeDir,
    // Only offer the Fix action when the directory is simply missing — an
    // existing-but-read-only directory needs a permissions change we won't
    // make on the user's behalf.
    fixable: !claudeOk && !(await exists(claudeDir)),
  });

  // Sessions / projects directory writable
  const projectsDir = join(homedir(), ".claude", "projects");
  const projectsOk = (await exists(projectsDir)) && (await writable(projectsDir));
  checks.push({
    id: "projects-dir",
    label: "~/.claude/projects",
    status: projectsOk ? "ok" : "warn",
    detail: projectsOk ? "writable" : "missing or read-only — sessions can't persist",
    fixable: !projectsOk && !(await exists(projectsDir)),
  });

  // git available
  const git = await gitVersion();
  checks.push({
    id: "git",
    label: "git",
    status: git ? "ok" : "warn",
    detail: git ?? "git not on PATH — worktrees won't work",
  });

  // Prompt caching disabled
  if (process.env.DISABLE_PROMPT_CACHING) {
    checks.push({
      id: "prompt-caching",
      label: "Prompt caching",
      status: "warn",
      detail: "DISABLE_PROMPT_CACHING is set — caching off increases token cost and latency",
    });
  }

  // Checked-in CLAUDE.md size (CC 2.1.206 parity) — one warn row per
  // workspace whose checked-in CLAUDE.md content (project root +
  // .claude/CLAUDE.md) crosses a line-count threshold. Best-effort: a
  // workspace-store read failure shouldn't fail the whole doctor report.
  try {
    const workspaces = await listWorkspaces();
    for (const ws of workspaces) {
      const [root, projectClaude] = await Promise.all([
        readScope("project", ws.rootPath),
        readScope("project-claude", ws.rootPath),
      ]);
      const combined = [root.content, projectClaude.content].filter(Boolean).join("\n");
      const warning = claudeMdSizeWarning(ws.id, combined);
      if (!warning) continue;
      checks.push({
        id: `claude-md-size-${ws.id}`,
        label: `CLAUDE.md size — ${ws.name}`,
        status: "warn",
        detail: warning.detail,
        link: warning.link,
      });
    }
  } catch {
    // Best-effort — see comment above.
  }

  return NextResponse.json({
    runtime: { node, platform: process.platform, arch: process.arch },
    sdk: { version: sdkVer },
    checks,
  });
}

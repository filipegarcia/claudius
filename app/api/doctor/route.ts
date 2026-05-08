import { NextResponse } from "next/server";
import { promises as fs, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const runtime = "nodejs";

type Status = "ok" | "warn" | "fail";

type Check = {
  id: string;
  label: string;
  status: Status;
  detail?: string;
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
  });

  // Sessions / projects directory writable
  const projectsDir = join(homedir(), ".claude", "projects");
  const projectsOk = (await exists(projectsDir)) && (await writable(projectsDir));
  checks.push({
    id: "projects-dir",
    label: "~/.claude/projects",
    status: projectsOk ? "ok" : "warn",
    detail: projectsOk ? "writable" : "missing or read-only — sessions can't persist",
  });

  // git available
  const git = await gitVersion();
  checks.push({
    id: "git",
    label: "git",
    status: git ? "ok" : "warn",
    detail: git ?? "git not on PATH — worktrees won't work",
  });

  return NextResponse.json({
    runtime: { node, platform: process.platform, arch: process.arch },
    sdk: { version: sdkVer },
    checks,
  });
}

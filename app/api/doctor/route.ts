import { NextResponse } from "next/server";
import { promises as fs, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listWorkspaces } from "@/lib/server/workspaces-store";
import { readScope } from "@/lib/server/claudemd";

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
   * Optional navigation affordance for checks that need a human/model
   * judgment call rather than a mechanical fix (see `claudeMdSizeChecks`
   * below) — the Doctor page renders this as a link button instead of a
   * "Fix" button.
   */
  link?: { href: string; label: string };
};

/**
 * CC 2.1.206 parity: "/doctor ... proposes trimming checked-in CLAUDE.md
 * files by cutting content Claude could derive from the codebase." Upstream
 * does this with a model call inside an interactive session; this route is a
 * fast, deterministic, session-less GET probe (every other check here is a
 * sync/fs heuristic), so trimming which lines to cut isn't something to do
 * here — instead we flag checked-in CLAUDE.md files that have grown past a
 * size where that kind of review is worth doing, and link to the existing
 * per-workspace Memory editor where a human (or a chat turn) can actually
 * do the trim.
 *
 * 300 lines is a Claudius-chosen heuristic, not scraped from upstream —
 * upstream scales its own "CLAUDE.md is too long" threshold off the active
 * model's context window, which a no-session diagnostic like this doesn't
 * have. Flagged in the run-notes risk section for review.
 */
const CLAUDE_MD_TRIM_THRESHOLD_LINES = 300;

async function claudeMdSizeChecks(): Promise<Check[]> {
  let workspaces: Awaited<ReturnType<typeof listWorkspaces>>;
  try {
    workspaces = await listWorkspaces();
  } catch {
    return [];
  }

  const checks: Check[] = [];
  for (const ws of workspaces) {
    // Skip "customization" workspaces (Claudius's own dogfood/demo
    // workspaces, not a user's project) — CLAUDE.md size only matters for
    // real project checkouts. `kind` is absent on older records, which
    // `?? "project"` treats as a project (matches the store's own
    // documented default).
    if ((ws.kind ?? "project") !== "project") continue;

    const [project, projectClaude] = await Promise.all([
      readScope("project", ws.rootPath),
      readScope("project-claude", ws.rootPath),
    ]);
    const files = [project, projectClaude].filter((f) => f.exists);
    if (files.length === 0) continue;

    // `.split("\n").length` overcounts by one for the (near-universal) case
    // of a trailing newline — subtract it so a file with exactly N lines
    // and a trailing "\n" reports N, not N+1, matching `wc -l`.
    const lineCount = (content: string): number => {
      const parts = content.split("\n").length;
      return content.endsWith("\n") ? parts - 1 : parts;
    };
    const totalLines = files.reduce((n, f) => n + lineCount(f.content), 0);
    if (totalLines <= CLAUDE_MD_TRIM_THRESHOLD_LINES) continue;

    const totalBytes = files.reduce((n, f) => n + Buffer.byteLength(f.content, "utf8"), 0);
    checks.push({
      id: `claude-md-size:${ws.id}`,
      label: `CLAUDE.md size — ${ws.name}`,
      status: "warn",
      detail:
        `${totalLines} lines (~${Math.round(totalBytes / 1024)} KB) across ${files.length} ` +
        `checked-in file${files.length > 1 ? "s" : ""} — Claude can usually re-derive routine ` +
        `info (file layout, tech stack, build commands) from the codebase itself; consider ` +
        `trimming content it doesn't need spelled out, or moving procedures into a skill.`,
      link: { href: `/${ws.id}/memory`, label: "Review in Memory" },
    });
  }
  return checks;
}

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

  // Checked-in CLAUDE.md files that have grown large enough to be worth
  // trimming (CC 2.1.206 parity — see `claudeMdSizeChecks` above).
  checks.push(...(await claudeMdSizeChecks()));

  return NextResponse.json({
    runtime: { node, platform: process.platform, arch: process.arch },
    sdk: { version: sdkVer },
    checks,
  });
}

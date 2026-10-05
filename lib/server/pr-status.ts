import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getOriginRemoteUrl } from "./git";
import { detectGitRemoteHost } from "@/lib/shared/git-host";
import { normalizeGithubPr, normalizeGitlabMr, type PrBadge } from "@/lib/shared/pr-badge";

const execFileP = promisify(execFile);

/**
 * CC 2.1.234 (H7) — resolve the current branch's PR (GitHub, via `gh`) or MR
 * (GitLab, via `glab`) into a {@link PrBadge}. Best-effort and defensive:
 * returns `null` for a non-GitHub/GitLab remote, a detached HEAD, a missing /
 * unauthenticated CLI, no open PR/MR for the branch, or a timeout. Never
 * throws. Results are cached briefly per (cwd, branch) so repeated page loads
 * don't re-shell on every render.
 */

const CACHE_TTL_MS = 30_000;
const EXEC_TIMEOUT_MS = 6_000;
const cache = new Map<string, { at: number; badge: PrBadge | null }>();

async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      timeout: 2_000,
    });
    const branch = stdout.trim();
    // Detached HEAD → no branch to look a PR up by.
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

export async function getPrStatus(cwd: string): Promise<PrBadge | null> {
  const host = detectGitRemoteHost(await getOriginRemoteUrl(cwd));
  if (host !== "github" && host !== "gitlab") return null;
  const branch = await currentBranch(cwd);
  if (!branch) return null;

  const key = `${cwd}|${host}|${branch}`;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.badge;

  let badge: PrBadge | null = null;
  try {
    if (host === "github") {
      const { stdout } = await execFileP(
        "gh",
        ["pr", "view", branch, "--json", "number,state,isDraft,statusCheckRollup,title,url"],
        {
          cwd,
          timeout: EXEC_TIMEOUT_MS,
          // Keep the CLI non-interactive and quiet so it can never block.
          env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
        },
      );
      badge = normalizeGithubPr(JSON.parse(stdout));
    } else {
      const { stdout } = await execFileP("glab", ["mr", "view", branch, "-F", "json"], {
        cwd,
        timeout: EXEC_TIMEOUT_MS,
        env: { ...process.env, GLAB_CHECK_UPDATE: "false" },
      });
      badge = normalizeGitlabMr(JSON.parse(stdout));
    }
  } catch {
    // CLI missing / unauthenticated / no PR for this branch / timeout / bad
    // JSON — all map to "no badge", cached briefly so we don't retry per load.
    badge = null;
  }

  cache.set(key, { at: now, badge });
  return badge;
}

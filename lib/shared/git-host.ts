/**
 * CC 2.1.259 — `/install-github-app` is GitHub-only. In a GitLab repo, Claude
 * Code explains that and points to the GitLab CI/CD setup docs instead of
 * opening the GitHub App page. This classifies an `origin` remote URL by host
 * so the slash handler can branch. Pure, so it's unit-testable without git.
 *
 * Handles both HTTPS (`https://gitlab.com/org/repo.git`) and SSH
 * (`git@gitlab.com:org/repo.git`, `ssh://git@gitlab.com/...`) forms, plus
 * self-managed hosts whose name contains `gitlab` (e.g. `gitlab.example.com`).
 */
export type GitRemoteHost = "github" | "gitlab" | "other";

export function detectGitRemoteHost(url: string | null | undefined): GitRemoteHost {
  if (!url) return "other";
  const u = url.toLowerCase();
  // Pull out the host portion from either `scheme://[user@]host/...` or the
  // scp-like `[user@]host:path` SSH form.
  let host = "";
  const schemeMatch = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/.exec(u);
  if (schemeMatch) {
    host = schemeMatch[1];
  } else {
    const scpMatch = /^(?:[^@]*@)?([^/:]+):/.exec(u);
    if (scpMatch) host = scpMatch[1];
  }
  // Classify by the parsed host's dot-separated labels rather than a substring
  // of the URL. Anchoring to a whole label avoids CodeQL's incomplete-URL-
  // substring-sanitization footgun — a bare `.includes("github.com")` would
  // also match a hostile URL where the string appears elsewhere (e.g.
  // `evil.com/github.com` or `github.com.attacker.net`) — while still catching
  // self-managed hosts like `github.mycorp.com` / `gitlab.example.com`.
  const labels = host.split(".");
  if (labels.includes("github")) return "github";
  if (labels.includes("gitlab")) return "gitlab";
  return "other";
}

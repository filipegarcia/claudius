import { describe, expect, test } from "vitest";
import { detectGitRemoteHost } from "@/lib/shared/git-host";

/**
 * CC 2.1.259 (D8) — classify an `origin` remote URL so `/install-github-app`
 * can show GitLab CI/CD docs in a GitLab repo instead of the GitHub App page.
 */
describe("detectGitRemoteHost (CC 2.1.259 — D8)", () => {
  test("GitHub — https and ssh forms", () => {
    expect(detectGitRemoteHost("https://github.com/org/repo.git")).toBe("github");
    expect(detectGitRemoteHost("git@github.com:org/repo.git")).toBe("github");
    expect(detectGitRemoteHost("https://github.mycorp.com/org/repo.git")).toBe("github");
  });

  test("GitLab — https, ssh, and self-managed hosts", () => {
    expect(detectGitRemoteHost("https://gitlab.com/org/repo.git")).toBe("gitlab");
    expect(detectGitRemoteHost("git@gitlab.com:org/repo.git")).toBe("gitlab");
    expect(detectGitRemoteHost("ssh://git@gitlab.example.com/org/repo.git")).toBe("gitlab");
  });

  test("other hosts and empty input", () => {
    expect(detectGitRemoteHost("https://bitbucket.org/org/repo.git")).toBe("other");
    expect(detectGitRemoteHost("git@codeberg.org:org/repo.git")).toBe("other");
    expect(detectGitRemoteHost("")).toBe("other");
    expect(detectGitRemoteHost(null)).toBe("other");
    expect(detectGitRemoteHost(undefined)).toBe("other");
  });
});

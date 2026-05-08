/* Single source of truth for marketing-site URLs.
 *
 * Change this file, redeploy. `index.html` reads it on load and rewrites
 * the install command, the "view the script" link, and the source-code
 * link — so you don't have to grep/replace strings across the site.
 *
 * Keep `siteUrl` in sync with whatever GitLab Pages URL (or custom domain)
 * actually serves these files. `repoUrl` is the public clone URL.
 */
window.__CLAUDIUS_CONFIG = {
  /**
   * Public origin where setup.sh is served. NO trailing slash.
   *
   * Default: GitLab Pages URL for filipegarcia/claudius. Replace with your
   * own user/group URL or a custom domain you've pointed at GitLab Pages
   * (e.g., "https://claudius.example.com").
   */
  siteUrl: "https://filipegarcia.gitlab.io/claudius",

  /** Public clone URL printed on the page and used by setup.sh's default. */
  repoUrl: "https://gitlab.com/filipegarcia/claudius",

  /** Display label for the source-code link footer. */
  repoLabel: "GitLab",
};

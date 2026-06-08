import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Static integrity checks for `site/` — the marketing surface published to
 * GitHub Pages.
 *
 * The `pages` job in `.github/workflows/` is a no-op script that just bundles
 * the directory; without this suite a broken anchor, a missing screenshot,
 * or a stale install URL would only be caught by humans clicking around
 * post-deploy. Runs in the `unit` job so failures gate the deploy via the
 * test→deploy stage ordering.
 *
 * If you're adding new content to the site, see `site/AGENTS.md` for the
 * checklist these tests enforce.
 */
const REPO_ROOT = resolve(__dirname, "../..");
const SITE_DIR = resolve(REPO_ROOT, "site");
const INDEX_HTML = readFileSync(resolve(SITE_DIR, "index.html"), "utf8");
const SETUP_SH = readFileSync(resolve(SITE_DIR, "setup.sh"), "utf8");

/** All values of `id="…"` on the page, in document order. */
function collectIds(html: string): string[] {
  const out: string[] = [];
  // Quote-style is consistent throughout the file (double quotes); tolerate
  // single quotes too in case someone hand-edits a snippet.
  const re = /\sid\s*=\s*(?:"([^"]+)"|'([^']+)')/g;
  for (const m of html.matchAll(re)) {
    out.push((m[1] ?? m[2])!);
  }
  return out;
}

/** All same-document anchor targets (`href="#foo"`). */
function collectInternalAnchors(html: string): string[] {
  const out: string[] = [];
  const re = /\shref\s*=\s*(?:"#([^"]+)"|'#([^']+)')/g;
  for (const m of html.matchAll(re)) {
    out.push((m[1] ?? m[2])!);
  }
  return out;
}

/**
 * All local file references (`src="claudius.svg"`, `src="screenshots/x.png"`,
 * `href="./setup.sh"`). Skips external URLs, `#fragment` links, `mailto:`,
 * inline `data:`, and the `https://filipegarcia.github.io/...` install URL
 * (covered by a dedicated assertion below).
 */
function collectLocalAssetRefs(html: string): string[] {
  const out = new Set<string>();
  const re = /\s(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)')/g;
  for (const m of html.matchAll(re)) {
    const raw = (m[1] ?? m[2])!;
    if (!raw) continue;
    if (raw.startsWith("#")) continue;
    if (/^[a-z]+:/i.test(raw)) continue; // http(s):, mailto:, data:, etc.
    if (raw.startsWith("//")) continue; // protocol-relative externals
    // Strip a leading `./` so callers can compare against on-disk paths
    // without worrying about the dot.
    out.add(raw.replace(/^\.\//, ""));
  }
  return [...out];
}

describe("site/index.html structural integrity", () => {
  const ids = collectIds(INDEX_HTML);
  const anchors = collectInternalAnchors(INDEX_HTML);
  const localRefs = collectLocalAssetRefs(INDEX_HTML);

  it("declares at least one id (sanity)", () => {
    expect(ids.length).toBeGreaterThan(0);
  });

  it("has no duplicate id attributes", () => {
    const seen = new Map<string, number>();
    for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1);
    expect(dupes, `duplicate ids: ${JSON.stringify(dupes)}`).toEqual([]);
  });

  it("renders every section the top-nav advertises", () => {
    // Pinned list — if you rename or drop one, the nav has to follow and
    // this test is the place to catch the mismatch.
    const REQUIRED = ["top", "install", "features", "desktop", "gallery", "customize", "meta", "legal"];
    const missing = REQUIRED.filter((id) => !ids.includes(id));
    expect(missing, `missing required section ids: ${missing.join(", ")}`).toEqual([]);
  });

  it("resolves every internal anchor href to a real id", () => {
    const idSet = new Set(ids);
    const dangling = anchors.filter((target) => !idSet.has(target));
    expect(dangling, `dangling anchors: ${dangling.join(", ")}`).toEqual([]);
  });

  it("resolves every local asset reference to an on-disk file", () => {
    const missing: string[] = [];
    for (const rel of localRefs) {
      const abs = resolve(SITE_DIR, rel);
      if (!existsSync(abs)) missing.push(rel);
    }
    expect(missing, `missing local assets: ${missing.join(", ")}`).toEqual([]);
  });

  it("has every gallery image reference a non-empty PNG", () => {
    // Gallery shots are the heaviest content on the page and the easiest
    // thing to forget after a screenshot refresh — `make screenshots` writes
    // a 0-byte placeholder if the route 404s. Catch that here.
    const shotRefs = localRefs.filter((r) => r.startsWith("screenshots/") && r.endsWith(".png"));
    expect(shotRefs.length, "expected at least one /screenshots/*.png reference").toBeGreaterThan(0);
    const empties: string[] = [];
    for (const rel of shotRefs) {
      const size = statSync(resolve(SITE_DIR, rel)).size;
      if (size === 0) empties.push(rel);
    }
    expect(empties, `zero-byte gallery images: ${empties.join(", ")}`).toEqual([]);
  });

  it("ships the placeholder svg the gallery onerror handlers fall back to", () => {
    // The `<img onerror="...src='screenshots/_placeholder.svg'">` fallback
    // is what keeps the page from showing broken-image icons when a shot
    // hasn't been captured yet; if the placeholder itself goes missing the
    // graceful-degradation story breaks.
    expect(existsSync(resolve(SITE_DIR, "screenshots/_placeholder.svg"))).toBe(true);
  });
});

describe("site/index.html ↔ site/setup.sh consistency", () => {
  it("renders the same install one-liner the script advertises in its own header", () => {
    // The hosted curl URL appears in:
    //   • the <code id="install-cmd"> block (the one users copy)
    //   • setup.sh's own usage docs (`# curl -fsSL …`)
    // If one moves and the other doesn't, copy/paste users land on a 404.
    // The advertised URL can be the canonical /setup.sh OR the prettier
    // /install alias (a Cloudflare Single Redirect at the edge — see
    // cloudflare/redirects.sh). The contract is "whatever URL the site
    // shows must appear in setup.sh too", not "the URL must be /setup.sh".
    const installCmdMatch = INDEX_HTML.match(
      /<code id="install-cmd">([^<]+)<\/code>/,
    );
    expect(installCmdMatch, "site is missing <code id=\"install-cmd\">").not.toBeNull();
    const installCmd = installCmdMatch![1]!.trim();
    expect(installCmd).toMatch(/^curl -fsSL https:\/\/\S+ \| bash$/);
    const url = installCmd.match(/https:\/\/\S+/)![0]!;
    expect(SETUP_SH).toContain(url);
  });

  it("advertises the same repo URL the install script clones from", () => {
    // setup.sh's DEFAULT_REPO is the source of truth for the canonical repo.
    // The site needs to match — humans use the "Read the source" / "Repo"
    // links instead of inspecting the script.
    const repoMatch = SETUP_SH.match(/DEFAULT_REPO="([^"]+)"/);
    expect(repoMatch, "could not find DEFAULT_REPO in setup.sh").not.toBeNull();
    const defaultRepo = repoMatch![1]!;
    // Strip the trailing `.git` — the site links to the web view of the
    // project, not the clone URL.
    const webRepo = defaultRepo.replace(/\.git$/, "");
    expect(INDEX_HTML).toContain(webRepo);
  });
});

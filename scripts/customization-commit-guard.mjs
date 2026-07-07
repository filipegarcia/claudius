#!/usr/bin/env node
/**
 * Pre-commit guard: block commits that stage files currently owned by an
 * ACTIVE customization publish.
 *
 * Why: publishing a customization copies its files straight into the live
 * source tree (see lib/server/customization-publish.ts) so the running app
 * picks them up. Git can't tell those apart from your own edits, so a
 * `git add -A` sweeps customization output into main — exactly how the
 * cross-check button leaked in commit edabbb6. This guard cross-references
 * the staged paths against the publish records in
 * `~/.claude/.claudius/customizations/index.json` (publishes with
 * `revertedAt == null`) and refuses the commit when they overlap.
 *
 * The store is intentionally plain JSON-on-disk (not SQLite) so standalone
 * tooling like this — and `bin/claudius-revert` — can read it without
 * loading any Claudius runtime.
 *
 * Escape hatch: CLAUDIUS_ALLOW_CUSTOMIZATION_COMMIT=1 skips the check for a
 * single commit, for the rare "I really do want to upstream this
 * customization" case.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

if (process.env.CLAUDIUS_ALLOW_CUSTOMIZATION_COMMIT === "1") {
  process.exit(0);
}

const INDEX_PATH = join(homedir(), ".claude", ".claudius", "customizations", "index.json");

let index;
try {
  index = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
} catch {
  // No store (fresh machine) or unreadable/corrupt JSON → nothing is
  // published, nothing to guard. Never block commits on store problems.
  process.exit(0);
}

const publishes = Array.isArray(index?.publishes) ? index.publishes : [];
const active = publishes.filter((p) => p && p.revertedAt == null);
if (active.length === 0) process.exit(0);

/** repo-relative path → customizationId that currently owns it */
const owned = new Map();
for (const pub of active) {
  for (const f of Array.isArray(pub.files) ? pub.files : []) {
    if (f && typeof f.path === "string") owned.set(f.path, pub.customizationId);
  }
}
if (owned.size === 0) process.exit(0);

const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const hits = staged.filter((f) => owned.has(f));
if (hits.length === 0) process.exit(0);

const names = new Map(
  (Array.isArray(index?.customizations) ? index.customizations : []).map((c) => [c.id, c.name]),
);

console.error("✖ Commit blocked: staged file(s) are owned by an active customization publish.");
console.error("  Published customizations live in the working tree so the app can run them,");
console.error("  but they don't belong in git history:");
console.error("");
for (const f of hits) {
  const id = owned.get(f);
  console.error(`    ${f}  ← "${names.get(id) ?? id}"`);
}
console.error("");
console.error("  Fix: revert the publish on /customize (keeps the customization, restores");
console.error("  the base files), commit, then re-publish. To intentionally upstream a");
console.error("  customization into main, bypass once with:");
console.error("");
console.error("    CLAUDIUS_ALLOW_CUSTOMIZATION_COMMIT=1 git commit …");
console.error("");
process.exit(1);

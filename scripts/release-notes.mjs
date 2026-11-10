#!/usr/bin/env node
/**
 * scripts/release-notes.mjs
 *
 * Bundles Claudius' release history into the build as
 * `public/release-notes.json`, so every shipped build carries the notes for
 * itself AND every release before it. The post-update "What's new" window
 * (components/updater/WhatsNewWindow.tsx) and the /release-notes page read it
 * — offline, no GitHub API quota, and someone who skipped five updates can
 * still read all five.
 *
 * Where the notes come from: GitHub Releases are published with an empty body,
 * so the notes are the commits themselves. Each `v<sdk>.<N>` release tag owns
 * the commits reachable from it that no EARLIER release tag reaches (the same
 * set `git log <prev>..<tag>` gives on a linear history, but correct when a
 * merged PR's commits predate the previous tag). The oldest tag is the
 * baseline only — it has no predecessor to diff against, so it gets no entry.
 *
 * Output is deliberately raw (short sha + subject per non-merge commit):
 * turning subjects into "New / Fixes / Improvements" happens at render time in
 * lib/shared/release-changelog.ts, the same classifier the pre-download update
 * modal uses, so the two can never disagree.
 *
 * Run from next.config.ts at build / dev-server start (like
 * claudius-release.mjs). Never fails the build:
 *   - not a git checkout, or git missing  → leave any existing file alone
 *   - shallow clone (CI's default)        → same; the tag ranges would be
 *     truncated and misleading. release.yml checks out with fetch-depth: 0.
 * The file is only rewritten when its content changes, so a dev-server
 * restart doesn't churn mtimes. It is gitignored (generated per build).
 *
 * Usage: node scripts/release-notes.mjs [--out <path>] [--stdout]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 4-part release tags only (`v0.3.322.2`); legacy 3-part tags are ignored. */
const RELEASE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)\.(\d+)$/;
/** Hard cap so a pathological subject can't bloat the bundle. */
const MAX_SUBJECT = 240;
const FILE_VERSION = 1;

/** Numeric, component-wise compare of two `vA.B.C.D` tags. */
export function compareTags(a, b) {
  const pa = RELEASE_TAG_RE.exec(a);
  const pb = RELEASE_TAG_RE.exec(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 1; i <= 4; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Pure core: assign every commit to the earliest release tag that contains it.
 *
 * @param {Array<{ tag: string, sha: string, date: string }>} tags release tags (any order)
 * @param {Array<{ sha: string, parents: string[], subject: string }>} log
 *   commits newest-first (as `git log` prints them)
 * @returns {Array<{ tag: string, previous: string, date: string,
 *   commits: Array<{ sha: string, subject: string }> }>} newest release first,
 *   baseline (oldest) tag omitted, merge commits dropped.
 */
export function assignReleases(tags, log) {
  const order = new Map();
  const bySha = new Map();
  log.forEach((c, i) => {
    order.set(c.sha, i);
    bySha.set(c.sha, c);
  });
  const sorted = tags
    .filter((t) => RELEASE_TAG_RE.test(t.tag) && bySha.has(t.sha))
    .sort((a, b) => compareTags(a.tag, b.tag));

  const owner = new Map(); // sha → tag
  const owned = new Map(); // tag → sha[]
  for (const t of sorted) {
    const mine = [];
    const stack = [t.sha];
    while (stack.length) {
      const sha = stack.pop();
      if (owner.has(sha)) continue;
      const c = bySha.get(sha);
      if (!c) continue; // outside the logged history (shouldn't happen when not shallow)
      owner.set(sha, t.tag);
      mine.push(sha);
      for (const p of c.parents) stack.push(p);
    }
    owned.set(t.tag, mine);
  }

  const releases = [];
  for (let i = 1; i < sorted.length; i++) {
    const t = sorted[i];
    const commits = owned
      .get(t.tag)
      .map((sha) => bySha.get(sha))
      .filter((c) => c.parents.length <= 1) // merge commits are never news
      .sort((a, b) => order.get(a.sha) - order.get(b.sha))
      .map((c) => ({ sha: c.sha.slice(0, 8), subject: c.subject.slice(0, MAX_SUBJECT) }));
    releases.push({ tag: t.tag, previous: sorted[i - 1].tag, date: t.date, commits });
  }
  return releases.reverse();
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
}

/** Read tags + history from the repo at `root`. Returns null when unusable. */
export function readHistory(root) {
  let shallow;
  try {
    shallow = git(root, ["rev-parse", "--is-shallow-repository"]).trim();
  } catch {
    return { skip: "not a git checkout" };
  }
  if (shallow === "true") return { skip: "shallow clone — release ranges would be truncated" };

  const tags = git(root, [
    "for-each-ref",
    "--merged=HEAD",
    // `*objectname` is the peeled commit of an annotated tag; empty for a
    // lightweight tag, whose own objectname is the commit.
    "--format=%(refname:short)%09%(*objectname)%09%(objectname)%09%(creatordate:iso-strict)",
    "refs/tags/v*",
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [tag, peeled, obj, date] = line.split("\t");
      return { tag, sha: peeled || obj, date };
    })
    .filter((t) => RELEASE_TAG_RE.test(t.tag));

  const log = git(root, ["log", "--format=%H%x1f%P%x1f%s%x1e", "HEAD"])
    .split("\x1e")
    .map((rec) => rec.replace(/^\n/, ""))
    .filter(Boolean)
    .map((rec) => {
      const [sha, parents, subject] = rec.split("\x1f");
      return { sha, parents: parents ? parents.split(" ") : [], subject: subject ?? "" };
    });

  const headTag = git(root, ["tag", "--points-at", "HEAD", "--list", "v*"])
    .split("\n")
    .filter((t) => RELEASE_TAG_RE.test(t))
    .sort(compareTags)
    .pop();

  return { tags, log, headTag: headTag ?? null };
}

export function buildFile(history) {
  return {
    version: FILE_VERSION,
    /** The release tag at HEAD, when this build IS a release. */
    head: history.headTag,
    releases: assignReleases(history.tags, history.log),
  };
}

/** Write `content` to `out` atomically, only when it differs. */
function writeIfChanged(out, content) {
  if (existsSync(out) && readFileSync(out, "utf8") === content) return false;
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, out);
  return true;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const out = outIdx !== -1 && args[outIdx + 1]
    ? resolve(process.cwd(), args[outIdx + 1])
    : resolve(root, "public", "release-notes.json");

  const history = readHistory(root);
  if (history.skip) {
    process.stderr.write(`[release-notes] skipped: ${history.skip}\n`);
    return;
  }
  const content = JSON.stringify(buildFile(history)) + "\n";
  if (args.includes("--stdout")) {
    process.stdout.write(content);
    return;
  }
  writeIfChanged(out, content);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (err) {
    // Never fail a build over release notes.
    process.stderr.write(`[release-notes] failed: ${err instanceof Error ? err.message : err}\n`);
  }
}

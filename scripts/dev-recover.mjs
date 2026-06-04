#!/usr/bin/env bun
// Recovery probe for the dev server when the browser shows an empty
// workspace rail (or any similar "Electron sees it, browser doesn't"
// symptom). Diagnoses the three things that can independently break:
//
//   1. The on-disk workspaces.json file (parseable? non-empty?).
//   2. The running dev server's /api/workspaces (same count as disk?).
//   3. The stale .next/ dev cache (wedged after an HMR misstep?).
//
// Cleanup is conservative: .next/ is only deleted when no process is
// listening on PORT, because next dev re-creates files while we walk
// the tree and would spam ENOENT errors otherwise. Pass `--restart` to
// kill the dev process, clear the cache, and exec `bun run dev` in its
// place. Without it the script just reports + cleans (if safe) and
// tells the user the next step.
//
// Run: `make recover`  or  `bun run scripts/dev-recover.mjs [--restart]`

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = process.env.PORT ?? "3000";
const WORKSPACES_FILE = join(homedir(), ".claude", ".claudius", "workspaces.json");
const NEXT_DIR = ".next";
const RESTART = process.argv.includes("--restart");

// ── ANSI helpers — silent on non-TTY (e.g. piped into a file). ────────
const tty = process.stdout.isTTY;
const c = {
  ok: tty ? "\x1b[32m" : "",
  warn: tty ? "\x1b[33m" : "",
  fail: tty ? "\x1b[31m" : "",
  bold: tty ? "\x1b[1m" : "",
  dim: tty ? "\x1b[2m" : "",
  reset: tty ? "\x1b[0m" : "",
};
const ok = (msg) => console.log(`  ${c.ok}✓${c.reset} ${msg}`);
const warn = (msg) => console.log(`  ${c.warn}!${c.reset} ${msg}`);
const fail = (msg) => console.log(`  ${c.fail}✗${c.reset} ${msg}`);
const hdr = (msg) => console.log(`\n${c.bold}${msg}${c.reset}`);
const info = (msg) => console.log(`    ${c.dim}${msg}${c.reset}`);

// Track soft problems so we can summarise + set a non-zero exit code
// when something definitive is wrong (vs "ok but here are tips").
let hardFail = false;
let advisory = false;

// ── 1. Workspace store on disk ────────────────────────────────────────
hdr("1. Workspace store on disk");

let diskCount = null;
if (!existsSync(WORKSPACES_FILE)) {
  fail(`${WORKSPACES_FILE} — missing`);
  info("Backups live next to it as workspaces.json.bak.*. To restore the latest:");
  const dir = join(homedir(), ".claude", ".claudius");
  if (existsSync(dir)) {
    const baks = readdirSync(dir)
      .filter((f) => f.startsWith("workspaces.json.bak."))
      .sort()
      .reverse()
      .slice(0, 5);
    if (baks.length === 0) {
      info("  (no .bak.* snapshots found — start Claudius and create a workspace)");
    } else {
      info(`  cp ${join(dir, baks[0])} \\`);
      info(`     ${WORKSPACES_FILE}`);
    }
  }
  hardFail = true;
} else {
  try {
    const raw = readFileSync(WORKSPACES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.workspaces)) {
      throw new Error('no "workspaces" array');
    }
    diskCount = parsed.workspaces.length;
    ok(`${WORKSPACES_FILE} — ${diskCount} workspaces`);
    if (parsed.activeId) info(`activeId: ${parsed.activeId}`);
    if (diskCount === 0) {
      warn("file is valid but empty — open Claudius and add a workspace");
      advisory = true;
    }
  } catch (err) {
    fail(`${WORKSPACES_FILE} — invalid JSON (${err.message})`);
    info("Latest backups (most recent first):");
    const dir = join(homedir(), ".claude", ".claudius");
    const baks = readdirSync(dir)
      .filter((f) => f.startsWith("workspaces.json.bak."))
      .sort()
      .reverse()
      .slice(0, 5);
    for (const b of baks) info(`  ${join(dir, b)}`);
    hardFail = true;
  }
}

// ── 2. Running dev server ─────────────────────────────────────────────
hdr(`2. Dev server at http://127.0.0.1:${PORT}`);

const devPid = findListenerPid(PORT);
let apiCount = null;

if (devPid == null) {
  warn(`nothing listening on ${PORT}`);
  info("(skipping API probe)");
} else {
  ok(`PID ${devPid} listening on ${PORT}`);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/workspaces`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      fail(`/api/workspaces → HTTP ${res.status}`);
      advisory = true;
    } else {
      const j = await res.json();
      apiCount = Array.isArray(j.workspaces) ? j.workspaces.length : null;
      if (apiCount == null) {
        fail("/api/workspaces — response has no workspaces array");
        advisory = true;
      } else {
        ok(`/api/workspaces → ${apiCount} workspaces`);
        if (diskCount != null && apiCount !== diskCount) {
          warn(
            `disk has ${diskCount}, API returned ${apiCount} — the dev process may be reading a different HOME or holding cached state`,
          );
          advisory = true;
        }
      }
    }
  } catch (err) {
    fail(`/api/workspaces did not respond: ${err?.message ?? err}`);
    info("The dev server may be mid-compile or wedged.");
    advisory = true;
  }
}

// ── 3. .next/ dev cache ───────────────────────────────────────────────
hdr("3. .next/ dev cache");

if (!existsSync(NEXT_DIR)) {
  ok(".next/ not present — nothing to clear");
} else {
  const size = humanSize(dirSize(NEXT_DIR));
  if (devPid != null && !RESTART) {
    warn(`.next/ (${size}) — leaving alone, dev server is up (PID ${devPid})`);
    info(`To clear it too: \`make recover RESTART=1\` or stop dev first.`);
  } else {
    if (devPid != null) {
      // RESTART path. Politely SIGTERM the dev, wait briefly, escalate if needed.
      info(`Stopping dev server (PID ${devPid})…`);
      try {
        process.kill(devPid, "SIGTERM");
      } catch {
        /* already gone */
      }
      await waitForPortFree(PORT, 5000);
      if (findListenerPid(PORT) != null) {
        try {
          process.kill(devPid, "SIGKILL");
        } catch {
          /* ignore */
        }
        await waitForPortFree(PORT, 2000);
      }
    }
    rmSync(NEXT_DIR, { recursive: true, force: true });
    ok(`cleared .next/ (${size})`);
  }
}

// ── 4. Next step or restart ───────────────────────────────────────────
hdr("Next steps");

if (RESTART) {
  info("Starting `bun run dev`… (Ctrl-C to stop)");
  info("Once it's listening, hard-reload the browser tab: ⌘⇧R (mac) / ⌃⇧R (other)");
  const r = spawnSync("bun", ["run", "dev"], { stdio: "inherit" });
  process.exit(r.status ?? 0);
}

if (devPid == null) {
  info("1. `make dev` — start the dev server");
} else {
  info(`1. Dev server already running on ${PORT}.`);
  if (existsSync(NEXT_DIR)) {
    info("   To also clear the .next/ cache, rerun with `make recover RESTART=1`.");
  }
}
info("2. Hard-reload the browser tab: ⌘⇧R (mac) / ⌃⇧R (other).");
info("3. Still empty? DevTools → Network → /api/workspaces — share status + body.");

if (hardFail) process.exit(2);
if (advisory) process.exit(1);

// ── helpers ───────────────────────────────────────────────────────────

function findListenerPid(port) {
  // lsof is the most reliable cross-version way to find the PID bound to
  // a TCP port on macOS + Linux. We tolerate its absence (rare on macOS,
  // possible on minimal Linux images) by returning null — the script
  // then degrades to "no running server detected".
  try {
    const out = execFileSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (!out) return null;
    const pid = parseInt(out.split(/\s+/)[0], 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function waitForPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (findListenerPid(port) == null) return;
    await sleep(150);
  }
}

function dirSize(dir) {
  let total = 0;
  const walk = (p) => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      let entries = [];
      try {
        entries = readdirSync(p);
      } catch {
        return;
      }
      for (const e of entries) walk(join(p, e));
    } else {
      total += st.size;
    }
  };
  walk(dir);
  return total;
}

function humanSize(bytes) {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${u[i]}`;
}

#!/usr/bin/env bun
/**
 * debug-export.ts
 *
 * Generates a Claudius debug bundle — a JSON file that:
 *   1. Is a valid Claudius settings bundle importable via Settings → Import,
 *      so the maintainer can recreate the user's exact configuration.
 *   2. Carries a `debug` section with diagnostic info (version, runtime,
 *      which env vars are set) that helps reproduce the issue.
 *
 * API keys and other secrets are redacted before the file is written.
 *
 * Usage:
 *   make debug-export              (recommended)
 *   bun run scripts/debug-export.ts
 *
 * Output: claudius-debug-YYYY-MM-DD.json in the current directory.
 */

import { existsSync, readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, platform, arch, hostname } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildExportBundle } from "../lib/server/settings-export";
import { encodeProjectDir } from "../lib/server/auto-memory";
import type { SettingsBundle } from "../lib/shared/settings-bundle";

// ── Sensitive-key scrubber ───────────────────────────────────────────────────
//
// Walk the bundle JSON recursively. When a string-valued leaf is keyed by a
// name that matches the pattern (case-insensitive) replace the value with
// "[REDACTED]". This catches:
//   • MCP server env blocks: { "env": { "GITHUB_TOKEN": "ghp_..." } }
//   • Any stray apiKey / secret / password at any nesting level
//
// Object-valued or array-valued entries are never redacted in full — only
// their string leaves are, so the structure remains import-compatible.

// Matches compound credential names but NOT a bare "key" field, which is
// used for keyboard bindings (e.g. `bindings[].key = "ctrl+s"`).
//
// Accepted: apiKey, api_key, API_KEY, secretKey, secret_key, accessToken,
//           auth_token, password, credential, bearer, passphrase, …
// Exempted: "key" alone (keyboard / map keys).
const SENSITIVE_KEY = /key|secret|token|password|auth|credential|bearer|passphrase/i;
const BARE_KEY = /^key$/i; // keyboard key — not a credential

function scrub(value: unknown, keyName = ""): unknown {
  if (typeof value === "string") {
    const isSensitive = SENSITIVE_KEY.test(keyName) && !BARE_KEY.test(keyName);
    return isSensitive && value.length > 0 ? "[REDACTED]" : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrub(v, keyName));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = scrub(v, k);
    }
    return result;
  }
  return value;
}

// ── Workspace session count ──────────────────────────────────────────────────
//
// Count JSONL session files under ~/.claude/projects/<encoded-rootPath>/.
// This is a quick file-system stat — no SQLite needed. Returns 0 on any error
// so a missing or inaccessible projects dir doesn't abort the export.

function sessionCount(rootPath: string): number {
  try {
    const dir = join(homedir(), ".claude", "projects", encodeProjectDir(rootPath));
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}

// ── Claudius package version ─────────────────────────────────────────────────

const _scriptDir = dirname(fileURLToPath(import.meta.url));
const _pkg = JSON.parse(readFileSync(join(_scriptDir, "../package.json"), "utf-8")) as {
  version: string;
};
const claudiusVersion: string = _pkg.version;

// ── Relevant env vars (presence only — never values) ─────────────────────────

const WATCHED_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDIUS_PORT",
  "PORT",
  "HOST",
  "NODE_ENV",
  "HOME",
];

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  process.stderr.write("Building Claudius debug bundle…\n");

  let bundle: SettingsBundle;
  try {
    bundle = await buildExportBundle();
  } catch (err) {
    process.stderr.write(
      `\nError reading Claudius settings: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.stderr.write(
      "Make sure ~/.claude/ exists and you have read access to your Claudius data.\n",
    );
    process.exit(1);
  }

  // Scrub secrets — keep structure intact so the file remains importable.
  const scrubbedBundle = scrub(bundle) as SettingsBundle;

  // ── Debug diagnostics (ignored on import) ──────────────────────────────────
  const debug = {
    _note:
      "This file is a valid Claudius settings bundle (importable via Settings → Import). " +
      "The 'debug' field is extra diagnostic info that Claudius ignores during import.",
    claudiusVersion,
    capturedAt: new Date().toISOString(),
    runtime: {
      platform: platform(),
      arch: arch(),
      hostname: hostname(),
      nodeVersion: process.version,
      bunVersion:
        (process.versions as Record<string, string | undefined>).bun ?? null,
    },
    envVarsPresent: WATCHED_VARS.filter((v) => Boolean(process.env[v])),
    workspaceSummary: bundle.workspaces.map((ws) => ({
      id: ws.meta.id,
      name: ws.meta.name,
      rootPath: ws.meta.rootPath,
      sessionCount: sessionCount(ws.meta.rootPath),
      hasProjectSettings: Boolean(ws.projectSettings),
      hasLocalSettings: Boolean(ws.localSettings),
      mcpServerCount: ws.projectSettings?.mcpServers
        ? Object.keys(ws.projectSettings.mcpServers).length
        : (ws.localSettings?.mcpServers
            ? Object.keys(ws.localSettings.mcpServers).length
            : 0),
    })),
  };

  // Top-level: standard SettingsBundle fields + debug. The import route
  // validates `version` and `workspaces`; extra keys are silently ignored.
  const output = { ...scrubbedBundle, debug };

  const d = new Date();
  const ymd = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
  const filename = `claudius-debug-${ymd}.json`;

  await writeFile(filename, JSON.stringify(output, null, 2));

  const wsCount = bundle.workspaces.length;
  process.stderr.write(`\n✓ Written to: ${filename}\n`);
  process.stderr.write(`  Workspaces : ${wsCount}\n`);
  process.stderr.write(`  Version    : ${claudiusVersion}\n`);
  process.stderr.write(`  Platform   : ${platform()}/${arch()}\n`);
  process.stderr.write("\nNext steps:\n");
  process.stderr.write("  1. Review the file (it contains your workspace paths).\n");
  process.stderr.write(
    "  2. Attach it to your GitHub bug report — see docs/debug-export.md.\n",
  );
  process.stderr.write(
    "  3. The maintainer can import it via Settings → Import to recreate\n",
  );
  process.stderr.write("     your configuration (without API keys).\n");
}

main().catch((err) => {
  process.stderr.write(`Unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

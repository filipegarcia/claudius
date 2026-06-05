#!/usr/bin/env node
// Workaround for a Next.js 16.2.6 regression: `next build` dies with
// `TypeError: generate is not a function` at
// node_modules/next/dist/build/generate-build-id.js, because that helper
// calls `await generate()` UNCONDITIONALLY even when the caller passed an
// undefined `config.generateBuildId`. The user-facing config can't fix this
// — `defaultConfig` already has `generateBuildId: () => null`, but
// something between `assignDefaults` and the cached config strips the
// function field, so by the time the build helper reads it the value is
// undefined again. Rather than monkey-patch deeper into Next's config
// pipeline, we patch the helper itself to no-op into the fallback path
// when its first arg isn't callable.
//
// Idempotent: re-runs cheaply, re-writes only when the patch marker is
// missing. Hooked into the build pipeline via the `prebuild` script in
// package.json so a fresh `bun install` followed by `bun run build`
// "just works".
//
// Drop this file (and its prebuild hook) once the upstream Next.js fix
// lands. Tracking: TypeError surfaces from
// node_modules/next/dist/build/generate-build-id.js:12.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(
  PROJECT_ROOT,
  "node_modules/next/dist/build/generate-build-id.js",
);
const MARKER = "// @claudius-patched-generate-fallback";

const PATCHED_BODY = `async function generateBuildId(generate, fallback) {
    ${MARKER}
    let buildId = typeof generate === 'function' ? await generate() : null;
    // If there's no buildId defined we'll fall back
    if (buildId === null) {
        // We also create a new buildId if it contains the word \`ad\` to avoid false
        // positives with ad blockers
        while(!buildId || /ad/i.test(buildId)){
            buildId = fallback();
        }
    }
    if (typeof buildId !== 'string') {
        throw Object.defineProperty(new Error('generateBuildId did not return a string. https://nextjs.org/docs/messages/generatebuildid-not-a-string'), "__NEXT_ERROR_CODE", {
            value: "E455",
            enumerable: false,
            configurable: true
        });
    }
    return buildId.trim();
}`;

if (!existsSync(TARGET)) {
  // Next isn't installed at the expected path — assume the user is in an
  // unusual setup (e.g. workspaces, custom resolver) and bail silently
  // rather than fail the build script.
  process.exit(0);
}

const src = readFileSync(TARGET, "utf8");

if (src.includes(MARKER)) {
  // Already patched. Cheap exit.
  process.exit(0);
}

const ORIGINAL_FN_RE =
  /async function generateBuildId\(generate, fallback\) \{[\s\S]*?\n\}/;

if (!ORIGINAL_FN_RE.test(src)) {
  console.error(
    "[patch-next-generate-build-id] Unexpected file layout; refusing to patch. " +
      "Bump or remove this script.",
  );
  process.exit(1);
}

const next = src.replace(ORIGINAL_FN_RE, PATCHED_BODY);
writeFileSync(TARGET, next, "utf8");
console.log(
  "[patch-next-generate-build-id] Applied workaround to " +
    "node_modules/next/dist/build/generate-build-id.js",
);

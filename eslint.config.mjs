import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // Per-run dist dir used by the e2e Playwright server (see
    // playwright.config.ts / next.config.ts). Same generated-code
    // shape as `.next/`, so keep it out of lint runs.
    ".next-e2e/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // chat-server is a standalone Bun service with its own tsconfig +
    // (eventually) its own lint setup. Don't drag it into the Next
    // app's ESLint run.
    "chat-server/**",
    // Generated test artifacts. ESLint flat config does not auto-respect
    // .gitignore, so without these the linter walks Playwright's report
    // bundle and Babel emits a 500KB-deopt note on minified assets.
    "playwright-report/**",
    "test-results/**",
    "blob-report/**",
    "playwright/.cache/**",
    // Claudiusd runtime state (pid file, logs, sqlite).
    ".claudius/**",
    // Per-session agent git worktrees (gitignored). Each is a full repo
    // copy with its own build output (.next, .next-e2e, etc.). The ignore
    // patterns above are relative to cwd and don't match these nested
    // copies, so ESLint would walk in and lint hundreds of minified
    // bundles. Ignore the whole tree.
    ".claude/worktrees/**",
    // Electron main-process build output (see electron/tsconfig.json).
    "dist-electron/**",
    // Electron-builder packaged artifacts.
    "release/**",
    // Third-party minified vendor bundles dropped into the marketing site
    // (jQuery + turn.js for the flipbook). Linting them produces hundreds
    // of warnings on perfectly intentional minification patterns.
    "site/vendor/**",
  ]),
  // The React 19 / React Compiler rule set fires on patterns this codebase
  // hasn't been migrated for (see `user_lint_policy.md` memory). Demote to
  // warnings so feature work doesn't block on a codebase-wide refactor; we
  // can re-tighten once the patterns are sorted.
  {
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/refs": "warn",
    },
  },
  // Electron main-process code is plain Node (CommonJS) — no DOM, no React,
  // no Next routing rules. Override the inherited Next.js rules here.
  {
    files: ["electron/**/*.{ts,tsx,js,mjs}"],
    rules: {
      // The Electron main entry intentionally uses node:console / console.log
      // for boot diagnostics that aren't surfaced to the renderer.
      "no-console": "off",
      // Main process imports things like `electron-updater` that aren't on
      // the Next.js whitelist.
      "@next/next/no-html-link-for-pages": "off",
      "@next/next/no-img-element": "off",
    },
  },
]);

export default eslintConfig;

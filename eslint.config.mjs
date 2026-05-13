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
]);

export default eslintConfig;

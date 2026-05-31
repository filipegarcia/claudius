"use client";

import { createHighlighter, type Highlighter } from "shiki";

let highlighterPromise: Promise<Highlighter> | null = null;

/**
 * Grammars we pre-register on the singleton highlighter. shiki lazy-loads
 * each grammar on first use, so listing them here is cheap — none of them
 * are bundled until the user opens a file that triggers it.
 *
 * The set is curated to cover the long tail of files people typically open
 * in a code editor (web, systems, scripting, infra, data). If a file
 * extension we DON'T have a grammar for shows up, `highlight()` falls back
 * to `"text"` (no colour) instead of throwing.
 */
const LANGUAGES = [
  // Web / JS family
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "html",
  "css",
  "scss",
  "sass",
  "less",
  "vue",
  "svelte",
  "astro",
  "graphql",
  // Data / config
  "json",
  "jsonc",
  "json5",
  "yaml",
  "toml",
  "ini",
  "xml",
  "properties",
  "csv",
  // Markup / docs
  "markdown",
  "mdx",
  "tex",
  "bibtex",
  // Shells / scripting
  "bash",
  "shell",
  "fish",
  "powershell",
  "bat",
  "awk",
  // Systems / compiled
  "c",
  "cpp",
  "csharp",
  "rust",
  "go",
  "zig",
  "swift",
  "kotlin",
  "java",
  "scala",
  "objective-c",
  // Dynamic
  "python",
  "ruby",
  "php",
  "perl",
  "lua",
  "r",
  "julia",
  "dart",
  "elixir",
  "erlang",
  "haskell",
  "clojure",
  "ocaml",
  "fsharp",
  // DB
  "sql",
  "plsql",
  "prisma",
  // Infra
  "dockerfile",
  "nginx",
  "apache",
  "terraform",
  "hcl",
  "make",
  "cmake",
  // Misc
  "diff",
  "regex",
  "groovy",
  "vim",
  // Plain text fallback — used when we can't resolve a language for a path.
  // Including it in the registered list lets us call codeToHtml(_, "text")
  // without an extra try/catch.
  "text",
];

export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark-default"],
      langs: LANGUAGES,
    });
  }
  return highlighterPromise;
}

export async function highlight(code: string, lang: string | undefined): Promise<string> {
  const hl = await getHighlighter();
  const language = lang && LANGUAGES.includes(lang) ? lang : "text";
  try {
    return hl.codeToHtml(code, {
      lang: language,
      theme: "github-dark-default",
    });
  } catch {
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  }
}

/**
 * Synchronous variant of `highlight` for callers (like react-simple-code-editor)
 * that need a string back immediately on every keystroke. Returns the
 * highlighted HTML if the singleton highlighter is already initialised and
 * the language is registered; otherwise returns escaped plain text and
 * kicks off the async init so the next call has it ready.
 *
 * The first call always returns the escaped fallback while the highlighter
 * boots (a few ms). Subsequent calls are synchronous.
 */
export function highlightSync(code: string, lang: string | undefined): string {
  const hl = currentHighlighter();
  if (!hl) {
    // Kick off init for the next call.
    void getHighlighter();
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  }
  const language = lang && LANGUAGES.includes(lang) ? lang : "text";
  try {
    return hl.codeToHtml(code, {
      lang: language,
      theme: "github-dark-default",
    });
  } catch {
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  }
}

/**
 * Promise-resolved highlighter, surfaced for components that want to await
 * boot before they start rendering (avoids the "flash of escaped HTML" on
 * first paint).
 */
let resolvedHighlighter: Highlighter | null = null;
function currentHighlighter(): Highlighter | null {
  return resolvedHighlighter;
}
export async function ensureHighlighter(): Promise<Highlighter> {
  const hl = await getHighlighter();
  resolvedHighlighter = hl;
  return hl;
}

/**
 * Map a workspace-relative file path to a shiki grammar id, or `undefined`
 * if we don't have one (caller falls back to `"text"`).
 *
 * Resolution order:
 *   1. Exact basename match (Dockerfile, Makefile, package.json, .env, …)
 *   2. Extension match (lowercased).
 *   3. Multi-part extensions (.env.local, .d.ts) walked outermost → innermost.
 *
 * The basename table is intentionally broad — most developer projects have
 * a handful of well-known files that don't carry a recognisable extension
 * (CMakeLists.txt, Gemfile, Pipfile, …). Highlighting these gives the file
 * tree a real "code editor" feel rather than a glorified textarea.
 */
export function languageForPath(path: string): string | undefined {
  if (!path) return undefined;
  const base = path.split("/").pop() ?? path;
  const lowerBase = base.toLowerCase();

  // 1. Exact basename / well-known file matches.
  const byName = BASENAME_TO_LANG[lowerBase];
  if (byName) return byName;

  // Dockerfile.something / Makefile.something
  if (lowerBase.startsWith("dockerfile")) return "dockerfile";
  if (lowerBase.startsWith("makefile") || lowerBase.startsWith("gnumakefile")) return "make";
  if (lowerBase.startsWith(".env")) return "bash";

  // 2. Extension match — try the longest tail first so ".d.ts" beats ".ts".
  const dot = lowerBase.indexOf(".");
  if (dot >= 0) {
    const tail = lowerBase.slice(dot); // e.g. ".d.ts", ".env.local"
    if (EXT_TO_LANG[tail]) return EXT_TO_LANG[tail];
    const lastDot = lowerBase.lastIndexOf(".");
    if (lastDot > 0) {
      const last = lowerBase.slice(lastDot);
      if (EXT_TO_LANG[last]) return EXT_TO_LANG[last];
    }
  }
  return undefined;
}

const BASENAME_TO_LANG: Record<string, string> = {
  // Build / package
  "package.json": "json",
  "package-lock.json": "json",
  "tsconfig.json": "jsonc",
  "jsconfig.json": "jsonc",
  "deno.json": "jsonc",
  "deno.jsonc": "jsonc",
  "bun.lock": "json",
  "bunfig.toml": "toml",
  "cargo.toml": "toml",
  "cargo.lock": "toml",
  "pyproject.toml": "toml",
  "pipfile": "toml",
  "gemfile": "ruby",
  "rakefile": "ruby",
  "podfile": "ruby",
  "fastfile": "ruby",
  "appfile": "ruby",
  "matchfile": "ruby",
  "scanfile": "ruby",
  "guardfile": "ruby",
  "berksfile": "ruby",
  "vagrantfile": "ruby",
  "build.gradle": "groovy",
  "build.gradle.kts": "kotlin",
  "settings.gradle": "groovy",
  "settings.gradle.kts": "kotlin",
  "cmakelists.txt": "cmake",
  // Infra
  "dockerfile": "dockerfile",
  "containerfile": "dockerfile",
  "makefile": "make",
  "gnumakefile": "make",
  "justfile": "make",
  "procfile": "yaml",
  // Git / CI
  ".gitignore": "text",
  ".gitattributes": "text",
  ".dockerignore": "text",
  ".npmignore": "text",
  ".prettierignore": "text",
  ".eslintignore": "text",
  ".editorconfig": "ini",
  // Env
  ".env": "bash",
  // Misc dotfiles
  ".babelrc": "json",
  ".eslintrc": "json",
  ".eslintrc.json": "json",
  ".prettierrc": "json",
  ".prettierrc.json": "json",
  ".nvmrc": "text",
  ".node-version": "text",
  ".python-version": "text",
  ".ruby-version": "text",
  ".tool-versions": "text",
  "readme": "markdown",
  "license": "text",
  "changelog": "markdown",
  "notice": "text",
  "authors": "text",
  "claude.md": "markdown",
  "agents.md": "markdown",
};

const EXT_TO_LANG: Record<string, string> = {
  // Web / JS family
  ".ts": "typescript",
  ".d.ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".html": "html",
  ".htm": "html",
  ".xhtml": "html",
  ".css": "css",
  ".scss": "scss",
  ".sass": "sass",
  ".less": "less",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
  ".graphql": "graphql",
  ".gql": "graphql",
  // Data / config
  ".json": "json",
  ".jsonc": "jsonc",
  ".json5": "json5",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".ini": "ini",
  ".cfg": "ini",
  ".conf": "ini",
  ".properties": "properties",
  ".xml": "xml",
  ".svg": "xml",
  ".plist": "xml",
  ".csv": "csv",
  ".tsv": "csv",
  // Markup / docs
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "mdx",
  ".tex": "tex",
  ".bib": "bibtex",
  // Shells / scripts
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".ksh": "bash",
  ".fish": "fish",
  ".ps1": "powershell",
  ".psm1": "powershell",
  ".bat": "bat",
  ".cmd": "bat",
  ".awk": "awk",
  // Systems / compiled
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".hh": "cpp",
  ".cs": "csharp",
  ".rs": "rust",
  ".go": "go",
  ".zig": "zig",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".java": "java",
  ".scala": "scala",
  ".sc": "scala",
  ".m": "objective-c",
  ".mm": "objective-c",
  // Dynamic
  ".py": "python",
  ".pyi": "python",
  ".pyw": "python",
  ".rb": "ruby",
  ".rake": "ruby",
  ".gemspec": "ruby",
  ".php": "php",
  ".phtml": "php",
  ".pl": "perl",
  ".pm": "perl",
  ".lua": "lua",
  ".r": "r",
  ".jl": "julia",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hrl": "erlang",
  ".hs": "haskell",
  ".lhs": "haskell",
  ".clj": "clojure",
  ".cljs": "clojure",
  ".cljc": "clojure",
  ".edn": "clojure",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".fs": "fsharp",
  ".fsx": "fsharp",
  ".fsi": "fsharp",
  // DB
  ".sql": "sql",
  ".pls": "plsql",
  ".pks": "plsql",
  ".pkb": "plsql",
  ".prisma": "prisma",
  // Infra
  ".tf": "terraform",
  ".tfvars": "terraform",
  ".hcl": "hcl",
  ".nginx": "nginx",
  // Misc
  ".diff": "diff",
  ".patch": "diff",
  ".groovy": "groovy",
  ".gvy": "groovy",
  ".vim": "vim",
  ".vimrc": "vim",
  ".log": "text",
  ".txt": "text",
};

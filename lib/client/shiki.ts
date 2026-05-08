"use client";

import { createHighlighter, type Highlighter } from "shiki";

let highlighterPromise: Promise<Highlighter> | null = null;

const LANGUAGES = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "bash",
  "shell",
  "python",
  "rust",
  "go",
  "java",
  "html",
  "css",
  "yaml",
  "toml",
  "markdown",
  "diff",
  "sql",
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

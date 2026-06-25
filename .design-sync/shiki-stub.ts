// Lightweight stand-in for the `shiki` package, used ONLY by the design-sync
// bundle so its ~13 MB of grammars/themes never ships in _ds_bundle.js (the
// upload rejects files over 5 MB). It preserves the minimal surface the repo's
// wrapper (lib/client/shiki.ts) consumes — createHighlighter().codeToHtml() —
// so CodeBlock and friends still render; code just isn't syntax-highlighted in
// the design tool (structure, layout, and tokens are unaffected).

export type Highlighter = {
  codeToHtml: (code: string, opts?: unknown) => string;
  codeToHast?: (code: string, opts?: unknown) => unknown;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function createHighlighter(): Promise<Highlighter> {
  return {
    codeToHtml: (code: string) =>
      `<pre class="shiki" style="background-color:transparent"><code>${escapeHtml(code)}</code></pre>`,
  };
}

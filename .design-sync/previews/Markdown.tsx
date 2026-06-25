import { Markdown } from "claudius";

export const RichText = () => (
  <div style={{ maxWidth: 620 }}>
    <Markdown>
      {[
        "## Design system sync",
        "",
        "Claudius wraps the **Claude Agent SDK** in the browser. Key points:",
        "",
        "- Local persistence via `better-sqlite3`",
        "- Streaming over SSE",
        "- _Seven_ built-in themes",
        "",
        "> Floor cards are the honest baseline — real components, authored later.",
        "",
        "See [the README](https://example.com) for the full overview.",
      ].join("\n")}
    </Markdown>
  </div>
);

export const WithCode = () => (
  <div style={{ maxWidth: 620 }}>
    <Markdown>{["Run the dev server:", "", "```bash", "bun run dev", "```", "", "Then open `localhost:3000`."].join("\n")}</Markdown>
  </div>
);

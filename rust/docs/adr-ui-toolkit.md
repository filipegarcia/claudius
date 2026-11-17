# ADR: UI toolkit for the native Rust UI

- **Status:** accepted 2026-11-16 (the user), pending the confirming spike (TODO U00a)
- **Decision:** GPUI + gpui-component
- **Task:** TODO U00. Gates section 7 (U01–U22).

## Context

Section 7 replaces the React UI (~113k lines across `components/`, `app/` pages,
`lib/client/`, `lib/shared/`) and the Electron shell (`electron/`, 5k lines) with a native
Rust UI that calls `claudius-core` in-process.

The user's criteria: **speed and rich text elements.** Porting effort is explicitly not a
criterion.

What the UI has to render, from the current React code:

- Markdown (`react-markdown` + `remark-gfm`, `remark-breaks`), with tables, links and inline code
- Code blocks highlighted with Shiki
- Math (`remark-math` + `rehype-katex`)
- Unified diffs, images, charts (`recharts`), and a code editor (`react-simple-code-editor`)
- HTML that can run scripts, in sandboxed iframes: AskUserQuestion `previewFormat: "html"`,
  HTML file previews (`FilePreview.tsx`), HTML blocks in markdown (`Markdown.tsx`),
  customization previews, and the in-app browser window (`electron/ipc/in-app-browser.ts`)
- Transcripts of 10k+ events with streaming text, text selection across messages, IME input
  and VoiceOver

## Options considered

| Option | Speed | Rich text | Notes |
|---|---|---|---|
| **GPUI + gpui-component** | GPU-rendered, no DOM or JS; Zed's editor and agent panel run on it | Zed's agent panel is this kind of UI (markdown threads, code blocks, tool cards). gpui-component adds `TextView` (markdown and simple HTML, syntax highlighting), a code editor, charts, virtualized lists and tables, and a Wry `WebView` | Few docs and the API changes. Screen-reader support not settled. No native KaTeX |
| Dioxus + Blitz (native renderer) | GPU (Vello), unproven at this scale | Real HTML/CSS layout (Stylo, Taffy), so markdown-as-HTML maps directly | Pre-1.0: Blitz 0.3 alphas through 2026. **Runner-up and fallback** |
| Dioxus (webview renderer) | Same as a webview | Full HTML | A full rewrite that is still a webview |
| Tauri + the React UI | Smaller and lighter than Electron, but React and the DOM still bound rendering | Full browser | Least work; doesn't meet the speed goal as an end state |
| Slint, egui | Fast | Weak: long markdown documents and selection across widgets are hard | Better suited to tools and dashboards |

## Decision

Build the native UI on **GPUI** (the `gpui` crate from Zed) with **gpui-component**
(Longbridge). The UI talks to `claudius-core` in-process through the U02 transport; the HTTP
server remains for browser and remote use.

## Consequences

- **Licensing.** `gpui` is Apache-2.0 and Claudius is MIT. Most of Zed (editor, markdown,
  agent panel crates) is GPL-3.0. **Never copy code from Zed's GPL crates**; read them for
  ideas only. Confirm gpui-component's license before depending on it (U00a).
- **Math.** There is no KaTeX equivalent. U05 picks a native LaTeX renderer, prototyped in
  U00a, and checks it against KaTeX's output.
- **Script-running HTML** goes in embedded `WebView` panes (gpui-component's Wry element,
  described upstream as experimental): AskUserQuestion previews (U08), HTML file previews
  (U12) and the in-app browser (U18). Keep the React iframe's sandbox rules.
- **Accessibility.** GPUI's AccessKit support wasn't settled in 2026-11. U22 checks the
  upstream state and reports any VoiceOver gap to the user.
- **Customizations** are mirrors of the React/Next source today. With a GPUI UI they need a
  new design; U17 is `[?]` until the user decides.
- **Testing.** The 228 Playwright specs keep covering the React UI and the HTTP API. The
  native UI gets the U21 strategy (state-machine snapshots over U01, plus a scripted driver).

## Confirming spike (U00a)

A throwaway `rust/spikes/gpui-transcript` binary on `gpui` + `gpui-component`, fed live from
`claudius-core`. Record the results here:

| Check | Target | Result |
|---|---|---|
| 10k-event session: scroll | steady at display refresh | |
| Streaming text | no visible lag | |
| Memory, cold start | measure | |
| Markdown, tables, code, diff, images | correct render | |
| LaTeX math | renderer chosen and prototyped | |
| AskUserQuestion HTML preview in a `WebView` pane | renders, sandboxed | |
| Selection across messages, copy, IME (Japanese) | works | |
| Release binary size (macOS arm64) | measure | |

If GPUI fails a must-have (scroll speed, selection, the HTML pane), stop and report to the
user with the evidence; evaluate Dioxus + Blitz next.

## Sources

- gpui-component README: <https://docs.rs/crate/gpui-component/0.4.1/source/README.md>
- gpui-component docs: <https://longbridge.github.io/gpui-component/docs/>
- Zed licensing overview: <https://zed.dev/software-overview>
- Blitz releases: <https://lib.rs/crates/blitz-html>

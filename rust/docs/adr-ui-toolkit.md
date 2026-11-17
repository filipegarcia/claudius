# ADR: UI toolkit for the native Rust UI

- **Status:** accepted 2026-11-16 (the user). Confirming spike (TODO U00a) run 2026-11-17: no
  must-have failed; Japanese IME and VoiceOver still need a manual check (see below)
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
`claudius-core`: a `Session` resumed (or fed) in-process, `subscribe()`d before `start()`,
with live turns from the scripted fake CLI. It is its own cargo workspace, so the root gate
never builds gpui. How to rerun it is at the end of this section.

**Machine and load.** Apple M5 Max (18 cores), macOS 27.0, built-in display at 120 Hz,
Rust 1.99.1. Other agents loaded the machine heavily for every run: the 1-minute load
average was 120–930 on 18 cores. Each number below is the median of 3 runs unless it says
"one run", with the load of those runs next to it. "CPU" is the main thread's own CPU time
over the frame (render start to paint end). It excludes time the thread waited to be
scheduled, so it separates the toolkit's work from the load. An idle-machine rerun should
improve the frame-interval numbers. The CPU numbers should change less, although a loaded
machine can also slow a thread down by running it on efficiency cores or at lower clocks.

**Workloads.**

- **Scroll:** GPUI `PlatformInput::Scroll` events dispatched into the window, 100 px per
  frame (12,000 px/s, a fast flick sustained end to end).
- **Streaming:** a 600-delta answer, one delta every 16 ms. It is mixed markdown and
  re-laid out every frame.
- **Synthetic 10k:** `--synthetic 10000`, a generated 10,000-entry transcript resumed through
  `Session::start`'s own disk replay.
- **Real 10k:** the first 10,000 user/assistant entries of one of the user's real
  transcripts (13,645 entries, read-only, never copied), broadcast through the same
  in-process fan-out (`--raw-replay 10000`). They fold into 7,800 rows. A real `--resume`
  replays only the main chain after the last compaction, and no transcript on this machine
  replays more than 610 events that way. That is why the 10k real-content run feeds entries
  directly.

| Check | Target | Result |
|---|---|---|
| 10k-event session: scroll | steady at display refresh | **Pass for ordinary rows. Real content needs U05/U06 to fold rows over about 4 KB.** **Synthetic 10k** (load 743/387/362): 119.3 fps average at 120 Hz. Frame interval p50/p95/p99: 8.33/13.5/17.0 ms. 6.5% of frames dropped (over 1.5 vsyncs). CPU per frame p50/p95/p99: 2.3/7.1/10.0 ms, so only 2.7% of frames exceeded the 8.33 ms budget; the rest of the drops come from the load. **Real 10k, every row rendered in full** (load 676/420/525): 99.2 fps. Interval p95/p99: 24.7/35.5 ms, 13.3% dropped. CPU p50/p95/p99: 1.7/21.5/31.9 ms. CPU time matches wall time, so this is real main-thread work, not load. The worst frames (up to 281 ms) are the ones where a 12–30 KB row (a pasted prompt, a huge tool input) scrolls into view, because gpui-component lays out a row's whole document in one frame. **Real 10k, rows over 4 KB folded** (`--row-cap 4096`; load 206/352/155): 115.6 fps. Interval p95/p99: 13.2/24.0 ms, 5.7% dropped. CPU p50/p95/p99: 1.7/6.3/16.9 ms, 3.5% over budget. **Folded, and each row's markdown parsed when the row arrives** (`--stateful-rows`; load 127/137/212): 117.4 fps. Interval p95/p99: 11.1/19.5 ms, 3.4% dropped. CPU p50/p95/p99: 1.8/5.2/12.6 ms, 2.3% over budget. Peak RSS rises to 667 MB because every row's parsed state is kept. The 20–40 ms frames that remain come from several code-heavy rows entering in the same frame at this 12,000 px/s flick. At a still-fast 4,800 px/s (40 px per frame; one run, load 122), the same configuration ran at 118.9 fps. Interval p95/p99: 9.7/13.7 ms, 1.3% dropped, and CPU p99 8.1 ms is inside the budget. Pre-parsing without folding does not help: one run reached 334 ms frames. |
| Streaming text | no visible lag | **Pass.** Real-10k session (load as above): 119.9 fps. Interval p95/p99: 9.1/10.0 ms, 0.48% dropped, CPU p95 3.8 ms. Latency from the core thread receiving a delta to the pixel being painted: p50/p95/p99/max 7.1/11.0/12.4/17.0 ms, about one frame. Synthetic session: 119.8 fps, latency p95 11.0 ms. |
| Memory, cold start | measure | **Memory, 10k sessions.** Peak RSS: 394 MB synthetic, 353 MB real. RSS at the end: 175 MB and 223 MB. `phys_footprint`, which includes GPU atlases: 461 MB and 443 MB. **Cold start, under load.** exec→`main` (dyld): median 127–203 ms, range 65–806 ms. `main`→first frame: 872 ms (real; range 656–1524 ms). `main`→the whole 10k real session replayed and painted: 3.6 s (range 1.4–4.2 s), which includes reading the 102 MB file. The first frame waits on Metal shader compilation at runtime, the WKWebView (created eagerly here), and font loading. |
| Markdown, tables, code, diff, images | correct render | **Pass** (visual check; screenshots `gallery-top.png`, `gallery-900.png`, `gallery-1800.png` and `transcript-synthetic.png` in `/tmp/u00a-shots/`, not in the repo). gpui-component `TextView` rendered headings, ordered, unordered and task lists, tables, links, inline code, blockquotes, and fenced code highlighted by syntect (TextMate grammars, like Shiki) for rust, ts, py and diff. The unified diff rendered both through gpui-component's `Diff` element and as `Edit` tool rows turned into a `diff` fence (`similar`). Images: PNG through `img()`, a `data:` URL image in markdown, and base64 image blocks from transcripts. Two catches. First, the `Diff` element rendered at zero height until it was wrapped in `flex_shrink_0` (a list inside a scrolling column has no minimum size). Second, a `diff` fence in markdown gets no red or green from syntect's theme, so U06 should render Edit/Write cards with the `Diff` element, which adds line numbers, word-level changes and syntax colors. |
| LaTeX math | renderer chosen and prototyped | **RaTeX 0.1.16** (pure Rust; KaTeX's parser, layout rules and fonts). Pipeline: parse → layout → display list → SVG with embedded glyph outlines → GPUI image. Hooked into markdown as `MarkdownPlugin`s for `$…$` (baseline-aligned) and `$$…$$`. Takes 0.2–0.8 ms per formula. Compared with KaTeX 0.19.0 (the React renderer) on 8 formulas: widths equal (within 0.1%) on 5; −1.4% (`cases`), +1.6% (Maxwell), +3.4% (Cauchy–Schwarz). Total heights equal on 5; +5.4% (`\sum` over a fraction) and +18% (Cauchy–Schwarz, where `\left(` picks a larger delimiter). The −23% on `e^{i\pi}` is KaTeX's 1.25 em strut, not ink. Glyphs look identical (`/tmp/u00a-shots/math-katex-vs-ratex.png`). |
| AskUserQuestion HTML preview in a `WebView` pane | renders, sandboxed | **Pass.** gpui-webview (Wry, WKWebView) shows the option's HTML from a custom `preview://` scheme with the response header `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:`. The webview is incognito, with no devtools and no zoom keys. A navigation handler allows only `preview://`, and new-window requests are denied. An in-pane probe script ran (scripts are allowed) and reported: `origin` was `"null"`; `localStorage` and `indexedDB` threw `SecurityError`; `window.open` returned null with no new-window request; `fetch` was blocked by the CSP; a link click and `top.location = …` did not navigate (the handler logged and denied the top navigation). One difference from an `<iframe sandbox="allow-scripts">`: `document.cookie` reads `""` instead of throwing. Network is stricter than the iframe (`default-src 'none'`). |
| Selection across messages, copy, IME (Japanese) | works | **Selection and copy pass. The IME passes at the component boundary; the OS IME and VoiceOver need a manual check.** `--selftest` drives the window's input path, one event per frame. A mouse drag starting in an assistant paragraph and running down 5 rows selected 728 characters. `⌘C` was handled (Root's binding). The pasteboard held 727 characters, the same as `pbpaste`, and spanned rows 7–11. Math copies as its LaTeX source. An earlier run over rows 223–229 (544 characters) agrees. Limitation: a drag that **starts inside a table cell** stays in that cell (6 characters). gpui-component does this on purpose (`selection_adapter.rs`), but it is unlike a browser. IME: the composer's `EntityInputHandler` received the calls macOS's text-input bridge makes. Preedit `にほんご` was marked at UTF-16 range 0..4. Conversion to `日本語` was marked at 0..3. The commit cleared the marked range and left `日本語`. `bounds_for_range` returned a rect for the candidate window, and nothing was sent. |
| Release binary size (macOS arm64) | measure | 40.2 MB (38.4 MiB) as built (release, thin LTO, `debug = false`, cargo's default `strip = "debuginfo"`). 31.0 MB (29.6 MiB) after `strip`, and 13.1 MB (12.5 MiB) gzip −9. It links the system WebKit, Metal, CoreText and QuartzCore, and includes all of `claudius-core` and `claudius-agent`. |

GPUI did not fail a must-have. Selection and the HTML pane pass outright. Scroll passes on
ordinary rows, and on real content once big rows are folded. Folding is a design requirement
for U05/U06, possibly with an upstream fix to `TextView` laying out the whole document;
it is not a reason to change toolkits. So Dioxus + Blitz was not evaluated.

### Spike findings

**Versions used**

| Crate | Version | License | Notes |
|---|---|---|---|
| `gpui-kit` (umbrella), `gpui-component`, `gpui-base`, `gpui-kit-assets`, `gpui-webview` | 0.10.0 | Apache-2.0 | longbridge/gpui-kit tag v0.10.0 (`f697c31`). gpui-component is now published under the `gpui-kit` umbrella (the README linked below is 0.4.1). `syntect` feature on |
| `gpui` as `gpui-pre` (+ `-platform`, `-macos`, …) | `=0.3.12` | Apache-2.0 | An exact-pinned weekly snapshot of Zed's `crates/gpui`. The optional `gpui-fast` backend (a Longbridge fork) was not used |
| `lb-wry` | 0.53.3 | Apache-2.0 OR MIT | Longbridge's Wry fork, behind `gpui-webview` |
| `ratex-parser`, `ratex-layout`, `ratex-svg` (`embed-fonts`), `ratex-types` | 0.1.16 | MIT | erweixin/RaTeX. The bundled KaTeX fonts are OFL-1.1 |
| `syntect` | 5.3.0 | MIT | Through gpui-component |
| `similar` 2.7, `image` 0.25, `base64` 0.22, `objc2` 0.6, `raw-window-handle` 0.6 | | MIT and/or Apache-2.0 | Spike-only helpers |

**Licenses confirmed.** The spike's resolved macOS tree has 557 crates. None is GPL, AGPL or
LGPL, and none of Zed's GPL crates (editor, markdown, agent panel, ui) is a dependency.
Nothing was copied from them. The non-permissive licenses in the tree:

- MPL-2.0: `option-ext`, linked (file-level copyleft; fine to ship unmodified).
- MPL-2.0: `cbindgen`, a build tool only.
- OFL-1.1: the KaTeX fonts.
- Unicode-3.0: the ICU data crates.

The KaTeX comparison script uses the repo's existing `katex` and `playwright-core` (MIT and
Apache-2.0).

**Problems hit, and what they mean for later tasks**

1. **Upstream churn.** gpui-component went from 0.7 to 0.10 in about six weeks, and it pins
   gpui as an exact weekly snapshot. Pin both exactly, and plan for an API fix-up on every
   bump. The docs lag the code, so read the crate source.
2. **Big rows have to be folded (U05, U06).** A `TextView` measures its whole document when
   it appears: synchronously for text under 4 KB, otherwise after a background parse, then laid
   out on the main thread. One 20–30 KB message costs 100–330 ms in a single frame. Fold
   long tool inputs and outputs (React's tool cards start collapsed) and long pastes behind
   "show more". Folding is the fix that matters. Parsing every row ahead of time
   (`--stateful-rows`) cut CPU p99 from 16.9 to 12.6 ms but nearly doubled RSS (to 667 MB,
   with a 1.2 GB footprint). So keep parsed state only for rows near the viewport (an LRU),
   not for all 10k. A stateless `TextView::markdown(id, …)` drops its state when the row
   leaves the viewport and parses again when it returns.

   gpui-component 0.10 has no public way to give a `TextViewState` its markdown extensions
   up front. The element applies them at layout, which parses again, so pre-parsed rows had
   to render without the math plugins. This is worth a small upstream PR.
   `MarkdownExtensions` has a revision, so build it once and clone it, or every row parses
   again. Stream deltas with `TextViewState::push_str`, not `set_text`: a full re-parse per
   delta raised streaming CPU p95 from 3.7 to 9.9 ms.
3. **The list.** gpui-component's `MessageScroller` keeps its `ListState` private, so the
   spike uses GPUI's `list()` directly (`FollowMode::Tail`), with its own row-to-entity
   mapping. U05 should do the same, or upstream a way to reach the `ListState`.
4. **Frame pacing.** GPUI caps inactive and low-power windows at 30 fps and thermal states at
   60 fps (`WindowOptions::{inactive,low_power,thermal}_frame_interval`). It renders nothing
   for an occluded window. The bench lifts the caps and floats an always-visible panel
   (`setHidesOnDeactivate: NO`); otherwise it stalls on a busy desktop. Keep the defaults in
   the product. Every perf test (U21) has to account for them.
5. **`replay_done` ordering (U02).** `Session::subscribe` sends `replay_done` at subscribe
   time. An in-process subscriber that attaches before `start()` (needed to see the whole
   disk replay, because the buffer keeps 1,000 events) gets no marker for the end of the
   replay. The spike broadcasts its own marker. U02 should define a replay-complete event
   for the in-process transport.
6. **Math (U05).** GPUI rasterizes SVG images at scale 1, so the spike renders formulas at
   2× and draws them at 1×. Theme colors are baked into the SVG, so a theme change means
   rendering again. For U05, either paint RaTeX's display list natively (glyph runs, rules
   and paths through GPUI) or rasterize at the window's scale factor, and cache by (source,
   display, size, color). Fix `\left…\right` delimiter sizing (+18%) against KaTeX.
7. **WebView panes (U08, U12, U18).** Without the `gpui-fast` backend, the native WKWebView
   sits above all GPUI content, so popovers and menus can't overlap the pane. Lay out
   around it, or hide it while an overlay is open. The pane takes CSP from the scheme
   handler's response, not from an iframe attribute.
8. **The React sandbox is not what it looks like (U08 decides).** AskUserQuestion's
   `previewFormat: "html"` is rendered with `dangerouslySetInnerHTML`, so its scripts never
   run. The iframes in `Markdown.tsx` and `FilePreview.tsx` use
   `sandbox="allow-scripts allow-same-origin"`. The spike implements the stricter target
   (scripts on, no same origin, no navigation, no network).
9. **Raw HTML in markdown** is parsed by `TextView` by default. For model output, consider
   `markdown_raw_html(false)` (U05).
10. **Cold start (U04).** Precompile the Metal shaders, create WebViews lazily, and load
    fonts early. A real `--resume` replays only the chain after the last compaction. The four
    real sessions probed here opened with 170–610 events.
11. **Accessibility (U22).** `gpui-pre` 0.3.12 depends on `accesskit` 0.24. Whether the macOS
    adapter exposes the transcript to VoiceOver is the manual check below.
12. **Build cost.** A clean release build of the spike takes about 14 minutes on this loaded
    machine (thin LTO).
13. **Theming (U03).** Colors come from `cx.theme()` (`ThemeColor` fields such as
    `background`, `foreground`, `border`, `secondary`, `muted_foreground`), and
    `Theme::change` switches light and dark. Code highlighting uses syntect themes.

**Manual checks pending** (run `spikes/gpui-transcript/target/release/gpui-transcript
--synthetic 2000` after building):

- **Japanese IME.**
  1. In System Settings → Keyboard → Input Sources, add Japanese – Romaji.
  2. Click the composer, switch to Japanese, and type `nihongo`.
  3. Expect underlined marked text, with the candidate window at the caret.
  4. Press Space. It should convert to 日本語.
  5. Press Enter. It should commit the text without sending.
  6. Press ⌘↩. A user row with 日本語 should appear.
- **Selection by hand.** Drag from inside one message into the next one, press ⌘C, and
  paste into TextEdit. You should get the text of both messages, in order.
- **VoiceOver.** Turn on VoiceOver (⌘F5), then use VO-arrow keys to move into the
  transcript. Note whether rows, the composer and buttons are announced, and with what
  roles.
- **Idle-machine bench (optional).** Run `scripts/bench.sh 3 --synthetic 10000 --scroll-px
  100` on an idle machine to get the frame-interval numbers without the load.

**Rerunning.**

1. Build the fake CLI in `rust/`:
   ```
   cargo build --release -p claudius-agent --bin claudius-fake-claude
   ```
2. Build the spike in `spikes/gpui-transcript`:
   ```
   cargo build --release
   ```
3. Run the bench and the self-test:
   - `scripts/bench.sh 3 --synthetic 10000 --scroll-px 100`
   - `… --transcript <file.jsonl> --raw-replay 10000 [--row-cap 4096]` for real content
   - `--selftest` checks selection, copy, the IME component path and the WebView probe.
     It prints JSON and puts your clipboard back.
4. Other modes:
   - `--gallery` shows the rich elements.
   - `--math-report` with `node scripts/katex-compare.mjs` runs the KaTeX comparison.

## Sources

- gpui-component README: <https://docs.rs/crate/gpui-component/0.4.1/source/README.md> (the
  spike used 0.10.0 from <https://github.com/longbridge/gpui-kit>, tag v0.10.0)
- RaTeX: <https://github.com/erweixin/RaTeX>
- gpui-component docs: <https://longbridge.github.io/gpui-component/docs/>
- Zed licensing overview: <https://zed.dev/software-overview>
- Blitz releases: <https://lib.rs/crates/blitz-html>

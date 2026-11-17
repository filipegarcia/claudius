//! Every rich element on one screen: markdown (headings, lists, tables,
//! links, inline code), fenced code with highlighting, a unified diff,
//! images, LaTeX math (RaTeX), and an AskUserQuestion-style HTML preview in a
//! sandboxed WebView pane.

use std::borrow::Cow;
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use gpui_kit::component::{
    ActiveTheme as _,
    button::{Button, ButtonVariants as _},
    diff::{Diff, DiffFile, DiffState},
    h_flex,
    text::{MarkdownExtensions, TextView},
    v_flex,
};
use gpui_kit::*;
use gpui_webview::WebView;
use serde_json::{Value, json};

use crate::app::Mode;

const MARKDOWN: &str = r#"# Heading 1
## Heading 2
### Heading 3

A paragraph with **bold**, *italic*, ~~strike~~, `inline code`, a [link to Anthropic](https://www.anthropic.com) and an autolink <https://example.com>.

- Unordered item
  - Nested item with `code`
- [x] Task done
- [ ] Task open

1. First
2. Second
3. Third

> A blockquote: the transcript must render long, mixed content at display refresh.

| Tool | Calls | p95 (ms) |
|------|------:|---------:|
| Bash | 1,204 | 31.2 |
| Edit | 877 | 4.9 |
| Read | 2,310 | 1.7 |

```rust
/// Highlighted with syntect (TextMate grammars, like Shiki).
fn main() {
    let xs: Vec<u32> = (1..=10).filter(|x| x % 2 == 0).collect();
    println!("{xs:?}");
}
```

```ts
export function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
```

```diff
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1,4 +1,4 @@
 fn greet() {
-    println!("hello");
+    println!("hello, world");
 }
```

Inline math $e^{i\pi} + 1 = 0$ sits on the text baseline, and display math is centered:

$$
\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}
$$
"#;

const PATCH: &str = "diff --git a/src/retry.rs b/src/retry.rs\n--- a/src/retry.rs\n+++ b/src/retry.rs\n@@ -1,9 +1,10 @@\n use std::time::Duration;\n \n /// How often a failed request is retried.\n pub struct RetryPolicy {\n-    pub max_attempts: u32,\n+    pub max_attempts: u8,\n     pub base_delay: Duration,\n+    pub jitter: bool,\n }\n \n impl RetryPolicy {\n@@ -12,3 +13,3 @@ impl RetryPolicy {\n     pub fn delay(&self, attempt: u32) -> Duration {\n-        self.base_delay * 2_u32.pow(attempt)\n+        self.base_delay * 2_u32.pow(attempt.min(6))\n     }\n";

/// AskUserQuestion `previewFormat: "html"` options, plus a probe script that
/// reports what the sandbox let it do.
fn option_html(ix: usize) -> String {
    let (title, body) = if ix == 0 {
        (
            "Card layout",
            "<div class=card><h3>Settings</h3><p>Theme: <b>Dark</b></p><button id=b>Save</button></div>",
        )
    } else {
        (
            "Table layout",
            "<table><tr><th>Key</th><th>Value</th></tr><tr><td>theme</td><td>dark</td></tr><tr><td>font</td><td>14px</td></tr></table>",
        )
    };
    format!(
        r#"<!doctype html><html><head><meta charset=utf-8><title>{title}</title>
<style>body{{font:14px -apple-system,sans-serif;background:#fff;color:#1a1a1a;margin:12px}}
.card{{border:1px solid #ddd;border-radius:8px;padding:12px}} table{{border-collapse:collapse}} td,th{{border:1px solid #ccc;padding:4px 8px}}
#probe{{font:11px ui-monospace,monospace;white-space:pre-wrap;color:#555;margin-top:12px}}</style></head>
<body><div style="font-size:11px;color:#888">Preview · {title}</div>{body}<div id=js>scripts: not run</div>
<a id=out href="https://example.com/navigated" target="_blank">external link</a><div id=probe></div>
<script>
document.getElementById('js').textContent = 'scripts: run ✓';
const r = {{option: {ix}}};
r.origin = String(self.origin);
r.location = String(location.href);
try {{ document.cookie = 'probe=1'; r.cookie = 'readable:' + JSON.stringify(document.cookie); }} catch (e) {{ r.cookie = 'blocked:' + e.name; }}
try {{ localStorage.setItem('probe', '1'); r.localStorage = 'allowed'; }} catch (e) {{ r.localStorage = 'blocked:' + e.name; }}
try {{ indexedDB.open('probe'); r.indexedDB = 'open() returned'; }} catch (e) {{ r.indexedDB = 'blocked:' + e.name; }}
try {{ const w = window.open('https://example.com/popup'); r.windowOpen = w ? 'opened' : 'null (blocked)'; }} catch (e) {{ r.windowOpen = 'blocked:' + e.name; }}
const done = () => {{
  document.getElementById('probe').textContent = JSON.stringify(r, null, 1);
  try {{ window.ipc && window.ipc.postMessage(JSON.stringify(r)); }} catch (e) {{}}
}};
fetch('https://example.com/').then(() => {{ r.fetch = 'allowed'; }}, (e) => {{ r.fetch = 'blocked:' + e.name; }}).finally(() => {{
  setTimeout(() => {{
    try {{ document.getElementById('out').click(); r.linkClick = 'clicked'; }} catch (e) {{ r.linkClick = 'blocked:' + e.name; }}
    try {{ window.top.location.href = 'https://example.com/top'; r.topNav = 'assigned'; }} catch (e) {{ r.topNav = 'blocked:' + e.name; }}
    setTimeout(() => {{ r.stillHere = location.href; done(); }}, 400);
  }}, 100);
}});
</script></body></html>"#
    )
}

/// The policy the pane is served with: CSP `sandbox allow-scripts` is the
/// header form of `<iframe sandbox="allow-scripts">` (opaque origin, no
/// top navigation, no popups, no forms), plus no network at all.
pub const CSP: &str = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";

pub struct Gallery {
    ext: MarkdownExtensions,
    diff: Entity<DiffState>,
    sample_png: Arc<Image>,
    webview: Entity<WebView>,
    current: Arc<Mutex<String>>,
    option: usize,
    probes: Rc<RefCell<Vec<Value>>>,
    navs: Rc<RefCell<Vec<String>>>,
    popups: Arc<Mutex<Vec<String>>>,
    math: Vec<(String, Result<crate::math::Rendered, String>)>,
    visible: bool,
    scroll: ScrollHandle,
}

fn sample_png() -> Vec<u8> {
    let (w, h) = (240u32, 120u32);
    let img = image::RgbaImage::from_fn(w, h, |x, y| {
        let r = (x * 255 / w) as u8;
        let g = (y * 255 / h) as u8;
        image::Rgba([r, g, 200, 255])
    });
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png)
        .expect("png");
    out.into_inner()
}

impl Gallery {
    pub fn new(
        ext: MarkdownExtensions,
        _mode: Mode,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let files = DiffFile::parse(PATCH).expect("patch");
        let diff = cx.new(|cx| DiffState::new(files, cx));
        let current = Arc::new(Mutex::new(option_html(0)));
        let probes: Rc<RefCell<Vec<Value>>> = Rc::default();
        let navs: Rc<RefCell<Vec<String>>> = Rc::default();
        let popups: Arc<Mutex<Vec<String>>> = Arc::default();
        let webview = {
            let current = current.clone();
            let probes = probes.clone();
            let navs = navs.clone();
            let popups = popups.clone();
            cx.new(|cx| {
                let builder = wry::WebViewBuilder::new()
                    .with_incognito(true)
                    .with_devtools(false)
                    .with_hotkeys_zoom(false)
                    .with_custom_protocol("preview".into(), move |_id, _req| {
                        let html = current.lock().unwrap().clone();
                        wry::http::Response::builder()
                            .header("Content-Type", "text/html; charset=utf-8")
                            .header("Content-Security-Policy", CSP)
                            .body(Cow::Owned(html.into_bytes()))
                            .unwrap()
                    })
                    .with_navigation_handler(move |url| {
                        let ok = url.starts_with("preview://");
                        navs.borrow_mut()
                            .push(format!("{} {url}", if ok { "allow" } else { "deny" }));
                        ok
                    })
                    .with_new_window_req_handler(move |url, _| {
                        popups.lock().unwrap().push(url);
                        wry::NewWindowResponse::Deny
                    })
                    .with_ipc_handler(move |req| {
                        let v: Value =
                            serde_json::from_str(req.body()).unwrap_or(json!(req.body()));
                        probes.borrow_mut().push(v);
                    })
                    .with_url("preview://localhost/option-0");
                WebView::build(builder, window, cx).expect("WebView")
            })
        };
        let fg = cx.theme().foreground;
        let text_px = f32::from(cx.theme().font_size);
        let math = crate::math::FORMULAS
            .iter()
            .map(|f| {
                (
                    f.to_string(),
                    crate::math::render(f, true, text_px * crate::math::KATEX_SCALE, fg),
                )
            })
            .collect();
        let mut g = Self {
            ext,
            diff,
            sample_png: Arc::new(Image::from_bytes(ImageFormat::Png, sample_png())),
            webview,
            current,
            option: 0,
            probes,
            navs,
            popups,
            math,
            visible: true,
            scroll: ScrollHandle::new(),
        };
        g.set_visible(false, cx);
        g
    }

    pub fn set_visible(&mut self, visible: bool, cx: &mut Context<Self>) {
        self.visible = visible;
        self.webview
            .update(cx, |w, _| if visible { w.show() } else { w.hide() });
        cx.notify();
    }

    fn select(&mut self, ix: usize, cx: &mut Context<Self>) {
        self.option = ix;
        *self.current.lock().unwrap() = option_html(ix);
        self.webview.update(cx, |w, _| {
            w.load_url(&format!("preview://localhost/option-{ix}"))
        });
        cx.notify();
    }

    /// `--gallery-scroll`: start the left column scrolled down (screenshots).
    pub fn scroll_to(&self, y: f32) {
        self.scroll.set_offset(point(px(0.), px(-y)));
    }

    pub fn probe_done(&self) -> bool {
        !self.probes.borrow().is_empty()
    }

    pub fn probe_report(&self) -> Value {
        json!({
            "csp": CSP,
            "probes": *self.probes.borrow(),
            "navigation": *self.navs.borrow(),
            "new_window_requests": *self.popups.lock().unwrap(),
        })
    }

    pub fn math_report(&self) -> Value {
        Value::Array(
            self.math
                .iter()
                .map(|(f, r)| match r {
                    Ok(r) => json!({"tex": f, "us": r.micros, "w": r.width, "h": r.height, "svg_bytes": r.svg_bytes}),
                    Err(e) => json!({"tex": f, "error": e}),
                })
                .collect(),
        )
    }
}

impl Render for Gallery {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let section = |title: &'static str| {
            div()
                .mt_4()
                .mb_1()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(title.to_uppercase())
        };
        let data_url = format!(
            "data:image/png;base64,{}",
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, sample_png())
        );
        let left = v_flex()
            .id("gallery-left")
            .flex_1()
            .min_w_0()
            .h_full()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .p_4()
            .child(section("Markdown, code, math (TextView)"))
            .child(
                TextView::markdown("gallery-md", MARKDOWN)
                    .selectable(true)
                    .markdown_extensions(self.ext.clone()),
            )
            .child(section("Images: GPUI img() and a markdown data: URL"))
            .child(
                h_flex()
                    .gap_4()
                    .child(
                        img(self.sample_png.clone())
                            .w(px(240.))
                            .h(px(120.))
                            .rounded_md(),
                    )
                    .child(
                        div().w(px(260.)).child(
                            TextView::markdown("gallery-img", format!("![gradient]({data_url})"))
                                .selectable(true),
                        ),
                    ),
            )
            .child(section("Unified diff (gpui-component Diff)"))
            // A list inside a scrolling column: without `flex_shrink_0` it shrinks
            // to zero height (it has no min-content size).
            .child(
                div()
                    .flex_shrink_0()
                    .w_full()
                    .h(px(300.))
                    .child(Diff::new(&self.diff).size_full()),
            )
            .child(section("LaTeX via RaTeX → SVG (layout µs, size px)"))
            .children(self.math.iter().map(|(tex, r)| {
                h_flex()
                    .gap_3()
                    .py_1()
                    .items_center()
                    .child(match r {
                        Ok(r) => crate::math::element(r),
                        Err(e) => div()
                            .text_color(theme.danger)
                            .child(e.clone())
                            .into_any_element(),
                    })
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(match r {
                                Ok(r) => format!("{} µs · {}×{}", r.micros, r.width, r.height),
                                Err(_) => String::new(),
                            }),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(tex.clone()),
                    )
            }));
        let option_btn = |ix: usize, label: &'static str, cur: usize| {
            let b = Button::new(("opt", ix)).label(label);
            if ix == cur { b.primary() } else { b.outline() }
        };
        let right = v_flex()
            .w(px(420.))
            .h_full()
            .p_4()
            .gap_2()
            .border_l_1()
            .border_color(theme.border)
            .child(
                div()
                    .text_sm()
                    .child("AskUserQuestion · Which layout should the settings page use?"),
            )
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        option_btn(0, "Card layout", self.option)
                            .on_click(cx.listener(|this, _, _, cx| this.select(0, cx))),
                    )
                    .child(
                        option_btn(1, "Table layout", self.option)
                            .on_click(cx.listener(|this, _, _, cx| this.select(1, cx))),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h(px(320.))
                    .border_1()
                    .border_color(theme.border)
                    .rounded_md()
                    .overflow_hidden()
                    .child(self.webview.clone()),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(format!("served with CSP: {CSP}")),
            );
        h_flex().size_full().child(left).child(right)
    }
}

//! Screenshots of the transcript, light and dark, drawn offscreen by gpui's
//! headless Metal renderer (no window on screen, no Screen Recording grant).
//!
//! `cargo run -p claudius-chat --example transcript_shots -- <out-dir>` (from rust/app)
//! writes `<theme>-<scene>.png` at 2x. macOS only.

#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
    shots::run()
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("the screenshots draw with Metal: macOS only");
}

#[cfg(target_os = "macos")]
mod shots {
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use claudius_chat::TranscriptView;
    use claudius_chat::fixture::{DEMO_START_MS, FixtureTranscripts, golden, parse_log};
    use claudius_chat::rows::{Pill, Row};
    use claudius_chat::script;
    use claudius_chat::verbose::Verbose;
    use claudius_gpui_theme::{ThemeName, icons::IconAssets};
    use gpui::{
        AnyWindowHandle, AppContext as _, Bounds, Context, Entity, HeadlessAppContext,
        WindowBounds, WindowOptions, px, size,
    };
    use gpui_apple::{AppleTextSystem, metal_renderer::MetalHeadlessRenderer};

    type Setup = fn(&mut TranscriptView, &mut Context<TranscriptView>);

    struct Scene {
        name: &'static str,
        session: &'static str,
        height: f32,
        setup: Setup,
    }

    fn source() -> Arc<FixtureTranscripts> {
        let src = FixtureTranscripts::new();
        let t = DEMO_START_MS;
        src.insert("markdown", &script::markdown_turn("markdown", t));
        src.insert("code", &script::code_turn("code", t));
        src.insert("hooks", &script::hooks_turn("hooks", t));
        src.insert("folded", &script::long_turn("folded", t, 12));
        src.insert("pills", &parse_log(golden::PILLS));
        let (history, stream) = script::demo("demo", t, 60.0);
        src.insert_streaming("demo", &history, stream.clone());
        src.insert_streaming("streaming", &history, stream);
        // Mid-reply: about half the words in.
        let half = src.remaining("streaming") / 2;
        for _ in 0..half {
            src.advance("streaming");
        }
        Arc::new(src)
    }

    fn expand_hook_failures(view: &mut TranscriptView, cx: &mut Context<TranscriptView>) {
        let keys: Vec<String> = view
            .transcript()
            .rows
            .iter()
            .filter_map(|r| match r {
                Row::System(s) if matches!(s.pill, Pill::HookFailure { .. }) => {
                    Some(format!("pill:{}", s.uuid))
                }
                _ => None,
            })
            .collect();
        for k in keys {
            view.toggle(k, cx);
        }
    }

    fn scenes() -> Vec<Scene> {
        vec![
            Scene {
                name: "markdown",
                session: "markdown",
                height: 1040.,
                setup: |_, _| {},
            },
            Scene {
                name: "code",
                session: "code",
                height: 900.,
                setup: |_, _| {},
            },
            Scene {
                name: "streaming",
                session: "streaming",
                height: 900.,
                setup: |_, _| {},
            },
            Scene {
                name: "system-hooks",
                session: "hooks",
                height: 700.,
                setup: expand_hook_failures,
            },
            Scene {
                name: "system-pills",
                session: "pills",
                height: 900.,
                setup: |_, _| {},
            },
            Scene {
                name: "folded",
                session: "folded",
                height: 900.,
                setup: |_, _| {},
            },
            Scene {
                name: "verbose",
                session: "demo",
                height: 1400.,
                setup: |v, cx| v.set_verbose(Verbose::UltraVerbose, cx),
            },
        ]
    }

    fn draw(cx: &mut HeadlessAppContext, handle: AnyWindowHandle) -> anyhow::Result<()> {
        // Markdown parses (some in the background) and the list measures.
        for _ in 0..6 {
            cx.run_until_parked();
            cx.update_window(handle, |_, window, cx| {
                window.refresh();
                window.draw(cx).clear(cx);
            })?;
        }
        cx.run_until_parked();
        Ok(())
    }

    fn shoot(
        theme: ThemeName,
        scene: &Scene,
        src: &Arc<FixtureTranscripts>,
        out: &Path,
    ) -> anyhow::Result<PathBuf> {
        let mut cx = HeadlessAppContext::with_platform(
            Arc::new(AppleTextSystem::new()),
            Arc::new(IconAssets),
            || Ok(Some(Box::new(MetalHeadlessRenderer::new()?))),
        );
        cx.update(|cx| {
            gpui_kit::init(cx);
            claudius_gpui_theme::init(theme, cx);
        });
        let source: Arc<dyn claudius_chat::TranscriptSource> = src.clone();
        let session = scene.session;
        let (handle, view): (AnyWindowHandle, Entity<TranscriptView>) = cx.update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds {
                        origin: Default::default(),
                        size: size(px(900.), px(scene.height)),
                    })),
                    focus: false,
                    show: false,
                    ..Default::default()
                },
                cx,
                |_, cx| {
                    cx.new(|cx| {
                        let mut v = TranscriptView::new(source, session, theme, cx);
                        v.set_now(DEMO_START_MS + 3_600_000.0, cx);
                        v
                    })
                },
            )
        })?;
        draw(&mut cx, handle)?;
        cx.update(|cx| view.update(cx, |v, cx| (scene.setup)(v, cx)));
        draw(&mut cx, handle)?;
        let image = cx.capture_screenshot(handle)?;
        let path = out.join(format!("{}-{}.png", theme.id(), scene.name));
        image.save(&path)?;
        Ok(path)
    }

    pub fn run() -> anyhow::Result<()> {
        let out = std::env::args_os()
            .nth(1)
            .map(PathBuf::from)
            .ok_or_else(|| anyhow::anyhow!("usage: shots <out-dir>"))?;
        std::fs::create_dir_all(&out)?;
        let src = source();
        for theme in [ThemeName::Light, ThemeName::Dark] {
            for scene in scenes() {
                let path = shoot(theme, &scene, &src, &out)?;
                println!("{}", path.display());
            }
        }
        Ok(())
    }
}

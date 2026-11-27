//! Screenshots of the overlays (U10a) over the shell's chat route, over the
//! bundled fixtures, light and dark, drawn offscreen by gpui's headless
//! Metal renderer (no window on screen, no Screen Recording grant): the
//! command palette (empty, then with a query), the keyboard cheatsheet and
//! the slash commands' help (all, then a topic's usage).
//!
//! `cargo run -p claudius-app --example overlay_shots -- <out-dir>` (from
//! rust/app) writes `<theme>-overlay-<scene>.png` at 2x. macOS only.

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

    use claudius_app::data::ShellData;
    use claudius_app::fixture::FixtureShellData;
    use claudius_app::shell::{Appearance, Shell};
    use claudius_chat::TranscriptSource;
    use claudius_chat::fixture::FixtureTranscripts;
    use claudius_gpui_theme::{ThemeName, icons::IconAssets};
    use gpui::{
        AnyWindowHandle, AppContext as _, Bounds, Entity, HeadlessAppContext, WindowBounds,
        WindowOptions, px, size,
    };
    use gpui_apple::{AppleTextSystem, metal_renderer::MetalHeadlessRenderer};

    type Step = fn(&mut Shell, &mut gpui::Window, &mut gpui::Context<Shell>);

    /// A scene: what opens the overlay, then what's typed into it.
    struct Scene {
        name: &'static str,
        open: Step,
        query: Option<&'static str>,
    }

    fn scenes() -> Vec<Scene> {
        vec![
            Scene {
                name: "palette",
                open: |s, w, cx| s.toggle_command_palette(w, cx),
                query: None,
            },
            Scene {
                name: "palette-query",
                open: |s, w, cx| s.toggle_command_palette(w, cx),
                query: Some("se"),
            },
            Scene {
                name: "cheatsheet",
                open: |s, w, cx| s.toggle_cheatsheet(w, cx),
                query: None,
            },
            Scene {
                name: "help",
                open: |s, w, cx| s.open_help(None, w, cx),
                query: None,
            },
            Scene {
                name: "help-topic",
                open: |s, w, cx| s.open_help(Some("model".into()), w, cx),
                query: None,
            },
        ]
    }

    fn draw(cx: &mut HeadlessAppContext, handle: AnyWindowHandle) -> anyhow::Result<()> {
        for _ in 0..4 {
            cx.run_until_parked();
            cx.update_window(handle, |_, window, cx| {
                window.refresh();
                window.draw(cx).clear(cx);
            })?;
        }
        cx.run_until_parked();
        Ok(())
    }

    fn shoot(theme: ThemeName, scene: &Scene, out: &Path) -> anyhow::Result<PathBuf> {
        let mut cx = HeadlessAppContext::with_platform(
            Arc::new(AppleTextSystem::new()),
            Arc::new(IconAssets),
            || Ok(Some(Box::new(MetalHeadlessRenderer::new()?))),
        );
        cx.update(|cx| claudius_app::init(theme, cx));
        let data: Arc<dyn ShellData> = Arc::new(FixtureShellData::builtin());
        let transcripts: Arc<dyn TranscriptSource> = FixtureTranscripts::builtin();
        let (handle, shell): (AnyWindowHandle, Entity<Shell>) = cx.update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds {
                        origin: Default::default(),
                        size: size(px(1280.), px(800.)),
                    })),
                    focus: false,
                    show: false,
                    ..Default::default()
                },
                cx,
                |window, cx| {
                    cx.new(|cx| {
                        Shell::with_transcripts(
                            data,
                            transcripts,
                            Appearance::Fixed(theme),
                            window,
                            cx,
                        )
                    })
                },
            )
        })?;
        draw(&mut cx, handle)?;
        let open = scene.open;
        cx.update_window(handle, |_, window, cx| {
            shell.update(cx, |s, cx| open(s, window, cx));
        })?;
        draw(&mut cx, handle)?;
        if let Some(q) = scene.query {
            cx.update_window(handle, |_, window, cx| {
                let palette = shell.read(cx).command_palette().expect("the palette");
                palette.update(cx, |p, cx| p.type_query(q, window, cx));
            })?;
            draw(&mut cx, handle)?;
        }
        let image = cx.capture_screenshot(handle)?;
        let path = out.join(format!("{}-overlay-{}.png", theme.id(), scene.name));
        image.save(&path)?;
        Ok(path)
    }

    pub fn run() -> anyhow::Result<()> {
        let out = std::env::args_os()
            .nth(1)
            .map(PathBuf::from)
            .ok_or_else(|| anyhow::anyhow!("usage: overlay_shots <out-dir>"))?;
        std::fs::create_dir_all(&out)?;
        for theme in [ThemeName::Light, ThemeName::Dark] {
            for scene in scenes() {
                let path = shoot(theme, &scene, &out)?;
                println!("{}", path.display());
            }
        }
        Ok(())
    }
}

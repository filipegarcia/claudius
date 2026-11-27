//! Screenshots of the prompt cards (U08a) in the chat route, light and
//! dark, drawn offscreen by gpui's headless Metal renderer.
//!
//! `cargo run -p claudius-app --example prompt_shots -- <out-dir>` (from
//! rust/app) writes `<theme>-<scene>.png` at 2x. macOS only.

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
    use claudius_chat::fixture::{FixtureTranscripts, ids};
    use claudius_gpui_theme::{ThemeName, icons::IconAssets};
    use claudius_prompts::target::samples;
    use claudius_prompts::{ChatPrompts, FixturePromptSource, PromptSource};
    use gpui::{
        AnyWindowHandle, AppContext as _, Bounds, Entity, HeadlessAppContext, WindowBounds,
        WindowOptions, px, size,
    };
    use gpui_apple::{AppleTextSystem, metal_renderer::MetalHeadlessRenderer};

    struct Scene {
        name: &'static str,
        seed: &'static str,
        /// Drives the cards once they're drawn.
        setup: fn(&ChatPrompts, &mut gpui::Window, &mut gpui::App),
    }

    fn scenes() -> Vec<Scene> {
        vec![
            Scene {
                name: "permission",
                seed: "permission-queue",
                setup: |_, _, _| {},
            },
            Scene {
                name: "permission-deny-feedback",
                seed: "permission",
                setup: |p, window, cx| {
                    let Some(v) = p.overlays.read(cx).permission().cloned() else {
                        return;
                    };
                    v.update(cx, |v, cx| v.toggle_deny(window, cx));
                    if let Some(input) = v.read(cx).feedback_input() {
                        input.update(cx, |i, cx| {
                            i.set_value(
                                "Don't force-push the shared branch; open a PR instead.",
                                window,
                                cx,
                            )
                        });
                    }
                },
            },
            Scene {
                name: "plan",
                seed: "plan-mode,plan",
                setup: |_, _, _| {},
            },
            Scene {
                name: "elicitation",
                seed: "elicitation",
                setup: |_, _, _| {},
            },
            Scene {
                name: "ask",
                seed: "ask",
                setup: |p, _, cx| {
                    let Some(v) = p.inline.read(cx).view().cloned() else {
                        return;
                    };
                    v.update(cx, |v, cx| {
                        v.pick(0, cx);
                        v.set_active(1, cx);
                        v.pick(0, cx);
                        v.pick(1, cx);
                    });
                },
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
        let fixture = FixturePromptSource::new();
        let unknown = samples::seed(&fixture.session(ids::DEMO), scene.seed);
        anyhow::ensure!(unknown.is_empty(), "unknown samples {unknown:?}");
        let source: Arc<dyn PromptSource> = fixture;
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
                        let mut shell = Shell::with_transcripts(
                            data,
                            transcripts,
                            Appearance::Fixed(theme),
                            window,
                            cx,
                        );
                        shell.set_prompt_source(source, cx);
                        shell
                    })
                },
            )
        })?;
        draw(&mut cx, handle)?;
        cx.update_window(handle, |_, window, cx| {
            let prompts = shell.read(cx).chat_prompts(ids::DEMO);
            if let Some(p) = prompts {
                (scene.setup)(&p, window, cx);
            }
        })?;
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
            .ok_or_else(|| anyhow::anyhow!("usage: prompt_shots <out-dir>"))?;
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

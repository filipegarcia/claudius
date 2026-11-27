//! Screenshots of the chat route's composer (U07) under the bundled demo
//! transcript, light and dark, drawn offscreen as `shots.rs` draws the
//! shell.
//!
//! `cargo run -p claudius-app --example composer_shots -- <out-dir>` (from
//! rust/app) writes `<theme>-composer-<scene>.png` at 2x. macOS only.

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
    use claudius_composer::ComposerView;
    use claudius_composer::fixture::FixtureComposer;
    use claudius_gpui_theme::{ThemeName, icons::IconAssets};
    use claudius_theme::prompt::PromptColor;
    use gpui::{
        AnyWindowHandle, AppContext as _, Bounds, Entity, HeadlessAppContext, WindowBounds,
        WindowOptions, px, size,
    };
    use gpui_apple::{AppleTextSystem, metal_renderer::MetalHeadlessRenderer};

    type Setup = fn(&Entity<ComposerView>, &mut gpui::Window, &mut gpui::App);

    struct Scene {
        name: &'static str,
        setup: Setup,
        /// Reply batches to play once the setup ran.
        play: usize,
    }

    fn submit(
        view: &Entity<ComposerView>,
        text: &str,
        window: &mut gpui::Window,
        cx: &mut gpui::App,
    ) {
        view.update(cx, |v, cx| {
            v.inject(text, window, cx);
            v.submit(window, cx);
        });
    }

    fn scenes() -> Vec<Scene> {
        vec![
            Scene {
                name: "empty",
                setup: |_, _, _| {},
                play: 0,
            },
            Scene {
                name: "multiline-draft",
                setup: |view, window, cx| {
                    view.update(cx, |v, cx| {
                        v.inject(
                            "Before the next release:\n\u{2022} run the full gate\n\u{2022} refresh the screenshots\n\u{2022} write the changelog entry",
                            window,
                            cx,
                        )
                    });
                },
                play: 0,
            },
            Scene {
                name: "bash-mode",
                setup: |view, window, cx| {
                    view.update(cx, |v, cx| v.inject("!git status --short", window, cx));
                },
                play: 0,
            },
            Scene {
                name: "running-two-queued",
                setup: |view, window, cx| {
                    submit(view, "Port the composer's queue strip", window, cx);
                    submit(view, "Then run the app gate", window, cx);
                    submit(view, "And summarize what changed", window, cx);
                    view.update(cx, |v, cx| {
                        v.inject("A third follow-up, still a draft", window, cx)
                    });
                },
                play: 3,
            },
            Scene {
                name: "suggestions",
                setup: |view, window, cx| submit(view, "What can the composer do?", window, cx),
                play: usize::MAX,
            },
            Scene {
                name: "prompt-color",
                setup: |view, window, cx| {
                    // What `/color purple` sets.
                    view.update(cx, |v, cx| {
                        v.set_prompt_color(Some(PromptColor::Purple), cx);
                        v.inject("A purple prompt", window, cx);
                    });
                },
                play: 0,
            },
            // The pickers (U07b): a filtered slash list with its matched
            // letters, the `@` files and agents, the `:shortcode:` list.
            Scene {
                name: "slash-picker",
                setup: |view, window, cx| {
                    view.update(cx, |v, cx| v.inject("/co", window, cx));
                },
                play: 0,
            },
            Scene {
                name: "at-picker",
                setup: |view, window, cx| {
                    view.update(cx, |v, cx| v.inject("Look at @co", window, cx));
                },
                play: 0,
            },
            Scene {
                name: "emoji-picker",
                setup: |view, window, cx| {
                    view.update(cx, |v, cx| v.inject("Nice work :smi", window, cx));
                },
                play: 0,
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
        let fixture = FixtureTranscripts::builtin();
        // No autoplay: a reply plays only as far as the scene asks.
        let fx = FixtureComposer::builtin(fixture.clone(), None);
        let transcripts: Arc<dyn TranscriptSource> = fixture.clone();
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
        let target = fx.clone();
        cx.update(|cx| shell.update(cx, |s, cx| s.set_composer_target(target, cx)));
        draw(&mut cx, handle)?;
        let session = cx
            .update(|cx| shell.read(cx).chat_tab())
            .ok_or_else(|| anyhow::anyhow!("the fixture opens on a chat tab"))?;
        // The demo's reply to its end, so the scene starts idle.
        while fixture.advance(&session) {}
        draw(&mut cx, handle)?;
        let view = cx
            .update(|cx| shell.read(cx).composer())
            .ok_or_else(|| anyhow::anyhow!("the composer is shown"))?;
        cx.update_window(handle, |_, window, cx| (scene.setup)(&view, window, cx))?;
        draw(&mut cx, handle)?;
        for _ in 0..scene.play {
            if !fx.advance(&session) {
                break;
            }
        }
        draw(&mut cx, handle)?;
        let image = cx.capture_screenshot(handle)?;
        let path = out.join(format!("{}-composer-{}.png", theme.id(), scene.name));
        image.save(&path)?;
        Ok(path)
    }

    pub fn run() -> anyhow::Result<()> {
        let out = std::env::args_os()
            .nth(1)
            .map(PathBuf::from)
            .ok_or_else(|| anyhow::anyhow!("usage: composer_shots <out-dir>"))?;
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

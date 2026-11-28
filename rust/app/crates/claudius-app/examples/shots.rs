//! Screenshots of the shell over the bundled fixture (and claudius-chat's
//! bundled transcripts), light and dark,
//! drawn offscreen by gpui's headless Metal renderer (no window on screen,
//! no Screen Recording grant).
//!
//! `cargo run -p claudius-app --example shots -- <out-dir>` (from rust/app)
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

    use claudius_app::data::ShellData;
    use claudius_app::fixture::FixtureShellData;
    use claudius_app::nav::FocusLevel;
    use claudius_app::route::{Route, WorkspacePage};
    use claudius_app::shell::{Appearance, Shell};
    use claudius_chat::TranscriptSource;
    use claudius_chat::fixture::FixtureTranscripts;
    use claudius_gpui_theme::{ThemeName, icons::IconAssets};
    use gpui::{
        AnyWindowHandle, AppContext as _, Bounds, Entity, HeadlessAppContext, WindowBounds,
        WindowOptions, px, size,
    };
    use gpui_apple::{AppleTextSystem, metal_renderer::MetalHeadlessRenderer};

    const W1: &str = "wks_3f2a9c81d0e4";
    const W2: &str = "wks_7b41e05c92aa";

    struct Scene {
        name: &'static str,
        width: f32,
        height: f32,
        setup: fn(&mut Shell, &mut gpui::Context<Shell>),
    }

    fn scenes() -> Vec<Scene> {
        vec![
            Scene {
                name: "chat",
                width: 1280.,
                height: 800.,
                setup: |_, _| {},
            },
            Scene {
                name: "chat-overflow-menu",
                width: 960.,
                height: 640.,
                setup: |shell, cx| shell.toggle_overflow(cx),
            },
            Scene {
                name: "rust-port-workspace",
                width: 1280.,
                height: 800.,
                setup: |shell, cx| shell.update_state(cx, |s| s.select_workspace(W2)),
            },
            Scene {
                name: "git",
                width: 1280.,
                height: 800.,
                setup: |shell, cx| shell.navigate(Route::page(W1, WorkspacePage::Git), cx),
            },
            Scene {
                name: "files",
                width: 1280.,
                height: 800.,
                setup: |shell, cx| shell.open_url(&format!("/{W1}/files?path=src/app"), cx),
            },
            Scene {
                name: "settings",
                width: 1280.,
                height: 800.,
                setup: |shell, cx| shell.navigate(Route::Settings, cx),
            },
            Scene {
                name: "focus-mode",
                width: 1280.,
                height: 800.,
                setup: |shell, cx| {
                    shell.update_state(cx, |s| {
                        s.set_focus(FocusLevel::Focus);
                        Vec::new()
                    })
                },
            },
            Scene {
                name: "close-all-confirm",
                width: 1280.,
                height: 800.,
                setup: |shell, cx| shell.update_state(cx, |s| s.close_all_tabs()),
            },
        ]
    }

    fn draw(cx: &mut HeadlessAppContext, handle: AnyWindowHandle) -> anyhow::Result<()> {
        // The tab strip measures on one frame and fits on the next.
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
                        size: size(px(scene.width), px(scene.height)),
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
        // The live app installs the Git and Files pages at startup (main.rs);
        // without them those routes draw the placeholder card.
        cx.update(|cx| {
            shell.update(cx, |shell, cx| {
                shell.set_git_data(Arc::new(claudius_git::fixture::FixtureGitData::demo()), cx);
                shell.set_files_data(
                    Arc::new(claudius_files::fixture::FixtureFilesData::builtin()),
                    cx,
                );
            })
        });
        cx.update(|cx| shell.update(cx, |shell, cx| (scene.setup)(shell, cx)));
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
        for theme in [ThemeName::Light, ThemeName::Dark] {
            for scene in scenes() {
                let path = shoot(theme, &scene, &out)?;
                println!("{}", path.display());
            }
        }
        Ok(())
    }
}

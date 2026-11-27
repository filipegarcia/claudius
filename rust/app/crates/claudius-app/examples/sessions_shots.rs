//! Screenshots of the sessions browser (U11) over the bundled fixtures,
//! light and dark, drawn offscreen by gpui's headless Metal renderer (no
//! window on screen, no Screen Recording grant).
//!
//! `cargo run -p claudius-app --example sessions_shots -- <out-dir>` (from
//! rust/app) writes `<theme>-sessions-<scene>.png` at 2x. macOS only.

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
    use std::time::Duration;

    use claudius_app::data::ShellData;
    use claudius_app::fixture::FixtureShellData;
    use claudius_app::sessions::data::SessionsData;
    use claudius_app::sessions::fixture::FixtureSessionsData;
    use claudius_app::sessions::view::SessionsScreen;
    use claudius_app::shell::{Appearance, Shell};
    use claudius_gpui_theme::{ThemeName, icons::IconAssets};
    use gpui::{
        AnyWindowHandle, AppContext as _, Bounds, Entity, HeadlessAppContext, WindowBounds,
        WindowOptions, px, size,
    };
    use gpui_apple::{AppleTextSystem, metal_renderer::MetalHeadlessRenderer};

    const W1: &str = "wks_3f2a9c81d0e4";
    const RICH: &str = "3e9a7c41-0b2d-4e8f-8c6a-1d2e3f405162";

    /// What a scene does once the shell is up: a URL to open, then steps on
    /// the screen (each followed by a draw).
    struct Scene {
        name: &'static str,
        url: String,
        steps: Vec<Step>,
    }

    type Step =
        Box<dyn Fn(&mut SessionsScreen, &mut gpui::Window, &mut gpui::Context<SessionsScreen>)>;

    fn step(
        f: impl Fn(&mut SessionsScreen, &mut gpui::Window, &mut gpui::Context<SessionsScreen>) + 'static,
    ) -> Step {
        Box::new(f)
    }

    fn scenes() -> Vec<Scene> {
        let list = format!("/{W1}/sessions");
        let one = format!("/{W1}/sessions/{RICH}?dir=%2FUsers%2Fdemo%2Fsrc%2Fclaudius");
        vec![
            Scene {
                name: "list",
                url: list.clone(),
                steps: vec![step(|s, _, cx| s.select_row(1, cx))],
            },
            Scene {
                name: "search",
                url: list.clone(),
                steps: vec![step(|s, w, cx| s.type_query("login", w, cx))],
            },
            Scene {
                name: "search-transcripts",
                url: list.clone(),
                steps: vec![
                    step(|s, _, cx| s.toggle_transcripts(cx)),
                    step(|s, w, cx| s.type_query("bare scoped", w, cx)),
                ],
            },
            Scene {
                name: "branch-filter",
                url: list.clone(),
                steps: vec![step(|s, _, cx| s.pick_branch(Some("feat/rust-port"), cx))],
            },
            Scene {
                name: "no-match",
                url: list.clone(),
                steps: vec![step(|s, w, cx| s.type_query("n: zzz-nothing", w, cx))],
            },
            Scene {
                name: "delete-confirm",
                url: list.clone(),
                steps: vec![step(|s, _, cx| s.ask_delete_row(2, cx))],
            },
            Scene {
                name: "session",
                url: one.clone(),
                steps: vec![step(|s, _, cx| s.open_all_blocks(cx))],
            },
            Scene {
                name: "rename",
                url: one.clone(),
                steps: vec![step(|s, w, cx| s.begin_rename(w, cx))],
            },
            Scene {
                name: "session-delete-confirm",
                url: one.clone(),
                steps: vec![step(|s, _, cx| s.ask_delete_session(cx))],
            },
            Scene {
                name: "session-raw",
                url: one,
                steps: vec![step(|s, _, cx| s.toggle_raw(cx))],
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
        let fixture = FixtureSessionsData::builtin();
        let now = fixture.now();
        let sessions: Arc<dyn SessionsData> = Arc::new(fixture);
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
                        Shell::new(data, Appearance::Fixed(theme), window, cx)
                            .with_sessions(sessions, window, cx)
                    })
                },
            )
        })?;
        draw(&mut cx, handle)?;
        let screen = cx
            .update(|cx| shell.read(cx).sessions_screen().cloned())
            .expect("the shell has the sessions screen");
        cx.update(|cx| screen.update(cx, |s, cx| s.set_clock(now, cx)));
        cx.update(|cx| shell.update(cx, |shell, cx| shell.open_url(&scene.url, cx)));
        draw(&mut cx, handle)?;
        for f in &scene.steps {
            cx.update_window(handle, |_, window, cx| {
                screen.update(cx, |s, cx| f(s, window, cx));
            })?;
            draw(&mut cx, handle)?;
            // The search's debounces (250 / 300 ms), on the simulated clock.
            cx.advance_clock(Duration::from_millis(350));
            draw(&mut cx, handle)?;
        }
        let image = cx.capture_screenshot(handle)?;
        let path = out.join(format!("{}-sessions-{}.png", theme.id(), scene.name));
        image.save(&path)?;
        Ok(path)
    }

    pub fn run() -> anyhow::Result<()> {
        let out = std::env::args_os()
            .nth(1)
            .map(PathBuf::from)
            .ok_or_else(|| anyhow::anyhow!("usage: sessions_shots <out-dir>"))?;
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

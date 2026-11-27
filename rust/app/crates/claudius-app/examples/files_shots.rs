//! Screenshots of the Files page (U12c) in the shell, over the bundled
//! fixtures (claudius-files' `FixtureFilesData::builtin`), light and dark,
//! drawn offscreen by gpui's headless Metal renderer (no window on screen,
//! no Screen Recording grant).
//!
//! `cargo run -p claudius-app --example files_shots -- <out-dir>` (from
//! rust/app) writes `<theme>-files-<scene>.png` at 2x. macOS only.

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
    use claudius_app::shell::{Appearance, Shell};
    use claudius_files::fixture::FixtureFilesData;
    use claudius_files::{FilesData, FilesScreen};
    use claudius_gpui_theme::{ThemeName, icons::IconAssets};
    use gpui::{
        AnyWindowHandle, AppContext as _, Bounds, Entity, HeadlessAppContext, WindowBounds,
        WindowOptions, px, size,
    };
    use gpui_apple::{AppleTextSystem, metal_renderer::MetalHeadlessRenderer};

    const W1: &str = "wks_3f2a9c81d0e4";

    type Step = Box<dyn Fn(&mut FilesScreen, &mut gpui::Window, &mut gpui::Context<FilesScreen>)>;

    fn step(
        f: impl Fn(&mut FilesScreen, &mut gpui::Window, &mut gpui::Context<FilesScreen>) + 'static,
    ) -> Step {
        Box::new(f)
    }

    /// A scene: the URL the shell opens, then steps on the screen.
    struct Scene {
        name: &'static str,
        url: String,
        steps: Vec<Step>,
    }

    fn open_dir(dir: &'static str) -> Step {
        step(move |s, _, cx| {
            s.act(cx, |p| {
                let tree = p.trees[0].id;
                p.click_row(tree, dir)
            })
        })
    }

    fn scenes() -> Vec<Scene> {
        let files = format!("/{W1}/files");
        vec![
            Scene {
                name: "tree",
                url: format!("{files}?path=src%2Ftree.rs"),
                steps: vec![open_dir("web/")],
            },
            Scene {
                name: "find-in-file",
                url: format!("{files}?path=src%2Fmain.rs"),
                steps: vec![step(|s, w, cx| s.type_find_in_file("entry", w, cx))],
            },
            Scene {
                name: "find-in-folder",
                url: format!("{files}?path=README.md"),
                steps: vec![step(|s, w, cx| s.type_find_in_folder("tree", w, cx))],
            },
            Scene {
                name: "binary",
                url: format!("{files}?path=data%2Fmetrics.parquet"),
                steps: Vec::new(),
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
        let files: Arc<dyn FilesData> = Arc::new(FixtureFilesData::builtin());
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
                |window, cx| cx.new(|cx| Shell::new(data, Appearance::Fixed(theme), window, cx)),
            )
        })?;
        cx.update(|cx| shell.update(cx, |s, cx| s.set_files_data(files, cx)));
        draw(&mut cx, handle)?;
        cx.update(|cx| shell.update(cx, |shell, cx| shell.open_url(&scene.url, cx)));
        draw(&mut cx, handle)?;
        let screen = cx
            .update(|cx| shell.read(cx).files_screen())
            .expect("the shell has the files screen");
        for f in &scene.steps {
            cx.update_window(handle, |_, window, cx| {
                screen.update(cx, |s, cx| f(s, window, cx));
            })?;
            draw(&mut cx, handle)?;
            // The debounces (200 / 250 ms), on the simulated clock.
            cx.advance_clock(Duration::from_millis(300));
            draw(&mut cx, handle)?;
        }
        let image = cx.capture_screenshot(handle)?;
        let path = out.join(format!("{}-files-{}.png", theme.id(), scene.name));
        image.save(&path)?;
        Ok(path)
    }

    pub fn run() -> anyhow::Result<()> {
        let out = std::env::args_os()
            .nth(1)
            .map(PathBuf::from)
            .ok_or_else(|| anyhow::anyhow!("usage: files_shots <out-dir>"))?;
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

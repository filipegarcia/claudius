//! Screenshots of the Git page (U12a) over the demo fixture, light and
//! dark, drawn offscreen by gpui's headless Metal renderer (no window on
//! screen, no Screen Recording grant).
//!
//! `cargo run -p claudius-git --example git_shots -- <out-dir>` (from
//! rust/app) writes `<theme>-git-<scene>.png` at 2x. macOS only.

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

    use claudius_git::changes::{DiffMode, DiffSelection};
    use claudius_git::data::GitData;
    use claudius_git::fixture::FixtureGitData;
    use claudius_git::page::{GitPage, Scope};
    use claudius_git::types::CommitPrefixConfig;
    use claudius_git::view::GitScreen;
    use claudius_gpui_theme::{ThemeName, icons::IconAssets};
    use gpui::{
        AnyWindowHandle, AppContext as _, Bounds, Entity, HeadlessAppContext, WindowBounds,
        WindowOptions, px, size,
    };
    use gpui_apple::{AppleTextSystem, metal_renderer::MetalHeadlessRenderer};

    const PAGE: &str = "app/[workspaceId]/git/page.tsx";

    /// One step of a scene: an action on the page, its requests run.
    type Step = Box<dyn Fn(&mut GitPage) -> Vec<claudius_git::page::Out>>;

    struct Scene {
        name: &'static str,
        draft: Option<&'static str>,
        steps: Vec<Step>,
    }

    fn scenes() -> Vec<Scene> {
        vec![
            Scene {
                name: "changes-diff",
                draft: None,
                steps: vec![Box::new(|p| {
                    p.toggle_check(PAGE, true);
                    p.toggle_check("lib/server/git.ts", true);
                    p.select_change(Some(DiffSelection::new(PAGE, DiffMode::Staged)))
                })],
            },
            Scene {
                name: "commit-draft",
                draft: Some(
                    "feat #4715 - add the sessions search filter\n\nFilter the list by title and branch.",
                ),
                steps: vec![Box::new(|p| {
                    p.toggle_check("lib/server/git.ts", true);
                    p.toggle_check("lib/shared/commit-prefix.ts", true);
                    p.select_change(Some(DiffSelection::new(
                        "components/git/ChangesList.tsx",
                        DiffMode::Worktree,
                    )))
                })],
            },
            Scene {
                name: "branches",
                draft: None,
                steps: vec![
                    Box::new(GitPage::toggle_branches),
                    Box::new(|p| {
                        p.branches.toggle_menu("local:main");
                        Vec::new()
                    }),
                ],
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
        cx.update(|cx| {
            gpui_kit::init(cx);
            claudius_gpui_theme::init(theme, cx);
            claudius_git::view::bind(cx);
        });
        let fixture = FixtureGitData::demo();
        fixture.set_draft(scene.draft);
        let data: Arc<dyn GitData> = Arc::new(fixture);
        let (handle, screen): (AnyWindowHandle, Entity<GitScreen>) = cx.update(|cx| {
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
                |_window, cx| cx.new(|cx| GitScreen::new(data, cx)),
            )
        })?;
        let scope = Scope {
            id: "wks_3f2a9c81d0e4".into(),
            name: "claudius".into(),
            root_path: "/Users/demo/src/claudius".into(),
            commit_prefix: Some(CommitPrefixConfig {
                enabled: true,
                branch_pattern: "feat/{ticket}-{slug}".into(),
                template: "feat #{ticket} - ".into(),
            }),
        };
        cx.update(|cx| screen.update(cx, |s, cx| s.sync(Some(scope), theme, cx)));
        draw(&mut cx, handle)?;
        for f in &scene.steps {
            cx.update(|cx| screen.update(cx, |s, cx| s.act(|p| f(p), cx)));
            draw(&mut cx, handle)?;
        }
        let image = cx.capture_screenshot(handle)?;
        let path = out.join(format!("{}-git-{}.png", theme.id(), scene.name));
        image.save(&path)?;
        Ok(path)
    }

    pub fn run() -> anyhow::Result<()> {
        let out = std::env::args_os()
            .nth(1)
            .map(PathBuf::from)
            .ok_or_else(|| anyhow::anyhow!("usage: git_shots <out-dir>"))?;
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

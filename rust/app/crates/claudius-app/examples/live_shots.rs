//! Screenshots of the shell over the engine in this process (U04b), light
//! and dark, drawn offscreen by gpui's headless Metal renderer.
//!
//! A throwaway world (a temporary HOME and config dir, the fake CLI
//! `claudius-fake-claude`; never `~/.claude` or the real `claude`): three
//! workspaces, one with an uploaded icon, and a few sessions the fake CLI
//! ran turns in. Each theme draws the chat bound and idle, mid-turn (the
//! dot and the chat running), and after the turn.
//!
//! `cargo run -p claudius-app --example live_shots -- <out-dir>` (from
//! rust/app) writes `<theme>-live-<scene>.png` at 2x. macOS only.

#[cfg(target_os = "macos")]
#[path = "../../../../crates/claudius-agent/tests/support/test_bins.rs"]
mod test_bins;
#[cfg(target_os = "macos")]
#[path = "../tests/support/world.rs"]
mod world;

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
    use std::time::{Duration, Instant};

    use claudius_app::data::{OpenTabsPut, ShellData, TabStatus};
    use claudius_app::shell::{Appearance, Shell};
    use claudius_app::store::LocalStore;
    use claudius_core::workspaces;
    use claudius_gpui_theme::{ThemeName, icons::IconAssets};
    use claudius_transport::Request;
    use futures::executor::block_on;
    use gpui::{
        AnyWindowHandle, AppContext as _, Bounds, Entity, HeadlessAppContext, WindowBounds,
        WindowOptions, px, size,
    };
    use gpui_apple::{AppleTextSystem, metal_renderer::MetalHeadlessRenderer};
    use serde_json::json;

    use super::test_bins;
    use super::world::{World, slow_turn, wait_for, world};

    const LIMIT: Duration = Duration::from_secs(60);

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

    fn wait(
        cx: &mut HeadlessAppContext,
        handle: AnyWindowHandle,
        shell: &Entity<Shell>,
        what: &str,
        f: impl Fn(&Shell) -> bool,
    ) -> anyhow::Result<()> {
        let t0 = Instant::now();
        loop {
            draw(cx, handle)?;
            if cx.update(|cx| f(shell.read(cx))) {
                return Ok(());
            }
            anyhow::ensure!(t0.elapsed() < LIMIT, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    fn bound_status(s: &Shell) -> Option<TabStatus> {
        let ws = s.state().active_workspace()?.id.clone();
        let bound = s.live_chat()?.session_id()?;
        s.state()
            .tab_views(s.bound_state(&ws), 2026)
            .into_iter()
            .find(|t| t.id == bound && t.active)
            .map(|t| t.status)
    }

    fn save(
        cx: &mut HeadlessAppContext,
        handle: AnyWindowHandle,
        out: &Path,
        theme: ThemeName,
        scene: &str,
    ) -> anyhow::Result<()> {
        draw(cx, handle)?;
        let image = cx.capture_screenshot(handle)?;
        let path = out.join(format!("{}-live-{scene}.png", theme.id()));
        image.save(&path)?;
        println!("{}", path.display());
        Ok(())
    }

    /// The sessions the strip shows, each with a title and a turn run.
    fn seed(w: &World) -> anyhow::Result<Vec<String>> {
        let ws = &w.workspaces[0].id;
        let mut ids = Vec::new();
        for (title, prompt) in [
            ("Port the shell to GPUI", "hello"),
            ("Wire the transport", "wire it"),
            ("Fix the flaky e2e", "flaky"),
        ] {
            let id = block_on(w.data.create_session(ws))?;
            wait_for("idle", LIMIT, || {
                let rows = block_on(w.data.sessions(ws)).ok()?;
                rows.iter()
                    .any(|r| r.id == id && r.status == Some(claudius_app::data::LiveStatus::Idle))
                    .then_some(())
            });
            w.input(ws, &id, prompt);
            let t = w.data.page(ws);
            let body = json!({"sessionId": id, "title": title}).to_string();
            let res = w.backend.handle().block_on(async move {
                t.fetch(Request::post("/api/sessions/rename").json(body))
                    .await
            })?;
            anyhow::ensure!(res.ok(), "rename: {}", res.text());
            ids.push(id);
        }
        // Let the turns end.
        wait_for("the turns' end", LIMIT, || {
            let rows = block_on(w.data.sessions(ws)).ok()?;
            rows.iter()
                .all(|r| r.status == Some(claudius_app::data::LiveStatus::Idle))
                .then_some(())
        });
        block_on(w.data.put_open_tabs(
            ws,
            OpenTabsPut {
                tabs: Some(ids.clone()),
                active_id: Some(Some(ids[0].clone())),
                pinned: Some(vec![]),
                label_max_width: None,
            },
        ))?;
        // An uploaded icon for the second workspace.
        let icon = image::RgbaImage::from_fn(96, 96, |x, y| {
            let t = (x + y) as f32 / 190.;
            image::Rgba([
                (40. + 180. * t) as u8,
                (110. + 60. * (1. - t)) as u8,
                (200. - 120. * t) as u8,
                255,
            ])
        });
        let mut png = std::io::Cursor::new(Vec::new());
        icon.write_to(&mut png, image::ImageFormat::Png)?;
        let id = &w.workspaces[1].id;
        workspaces::write_icon(id, "png", png.get_ref())?;
        workspaces::update(
            id,
            json!({"icon": {"kind": "image", "ext": "png"}})
                .as_object()
                .unwrap()
                .clone(),
        )?;
        Ok(ids)
    }

    fn shoot(w: &World, theme: ThemeName, out: &Path) -> anyhow::Result<()> {
        let mut cx = HeadlessAppContext::with_platform(
            Arc::new(AppleTextSystem::new()),
            Arc::new(IconAssets),
            || Ok(Some(Box::new(MetalHeadlessRenderer::new()?))),
        );
        cx.update(|cx| claudius_app::init(theme, cx));
        let data: Arc<dyn ShellData> = w.data.clone();
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
                        Shell::with_store(
                            data,
                            Appearance::Fixed(theme),
                            LocalStore::in_memory(),
                            window,
                            cx,
                        )
                    })
                },
            )
        })?;
        wait(&mut cx, handle, &shell, "the chat bound and idle", |s| {
            bound_status(s) == Some(TabStatus::Idle) && s.icon_image(&w.workspaces[1].id).is_some()
        })?;
        save(&mut cx, handle, out, theme, "chat-idle")?;
        let sid = cx
            .update(|cx| shell.read(cx).live_chat().and_then(|c| c.session_id()))
            .expect("bound");
        w.input(&w.workspaces[0].id, &sid, &slow_turn(4000));
        wait(&mut cx, handle, &shell, "mid-turn", |s| {
            bound_status(s) == Some(TabStatus::Running)
        })?;
        save(&mut cx, handle, out, theme, "chat-running")?;
        wait(&mut cx, handle, &shell, "after the turn", |s| {
            bound_status(s) == Some(TabStatus::Idle)
        })?;
        save(&mut cx, handle, out, theme, "chat-after-turn")?;
        Ok(())
    }

    pub fn run() -> anyhow::Result<()> {
        let out = std::env::args_os()
            .nth(1)
            .map(PathBuf::from)
            .ok_or_else(|| anyhow::anyhow!("usage: live_shots <out-dir>"))?;
        std::fs::create_dir_all(&out)?;
        let w = world(
            test_bins::fake_claude(),
            &["Claudius", "Rust port", "Docs site"],
        );
        seed(&w)?;
        let result = [ThemeName::Light, ThemeName::Dark]
            .into_iter()
            .try_for_each(|theme| shoot(&w, theme, &out));
        w.shutdown();
        result
    }
}

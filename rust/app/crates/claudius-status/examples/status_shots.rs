//! Screenshots of the status line, light and dark, drawn offscreen by
//! gpui's headless Metal renderer (no window on screen, no Screen
//! Recording grant), over a [`FixtureStatus`].
//!
//! `cargo run -p claudius-status --example status_shots -- <out-dir>` (from
//! rust/app) writes `<theme>-<scene>.png` at 2x: idle, mid-turn, the mode
//! menu open, the model picker open. macOS only.

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

    use claudius_gpui_theme::{ThemeName, hsla, icons::IconAssets};
    use claudius_status::picker;
    use claudius_status::view::Popup;
    use claudius_status::{FixtureStatus, StatusLineView, StatusTarget};
    use gpui::{
        AnyWindowHandle, AppContext as _, Bounds, Context, Entity, HeadlessAppContext, IntoElement,
        ParentElement as _, Render, Styled as _, Window, WindowBounds, WindowOptions, div, px,
        size,
    };
    use gpui_apple::{AppleTextSystem, metal_renderer::MetalHeadlessRenderer};
    use serde_json::json;

    /// The fixture's clock.
    const T0: f64 = 1_795_683_600_000.0;

    /// The status line on the page's background, as the chat route
    /// shows it above the transcript.
    struct Frame {
        theme: ThemeName,
        status: Entity<StatusLineView>,
    }

    impl Render for Frame {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            let p = claudius_theme::Theme::of(self.theme).palette;
            div()
                .size_full()
                .bg(hsla(p.background))
                .child(self.status.clone())
        }
    }

    struct Scene {
        name: &'static str,
        height: f32,
        running: bool,
        /// Seconds into the running turn.
        at_sec: f64,
        open: Option<Popup>,
    }

    fn scenes() -> Vec<Scene> {
        vec![
            Scene {
                name: "idle",
                height: 72.,
                running: false,
                at_sec: 0.,
                open: None,
            },
            Scene {
                name: "mid-turn",
                height: 72.,
                running: true,
                at_sec: 23.,
                open: None,
            },
            Scene {
                name: "mode-open",
                height: 500.,
                running: false,
                at_sec: 0.,
                open: Some(Popup::Mode),
            },
            Scene {
                name: "model-open",
                height: 640.,
                running: false,
                at_sec: 0.,
                open: Some(Popup::Model),
            },
        ]
    }

    fn chat() -> Arc<FixtureStatus> {
        let chat = FixtureStatus::new("s1");
        chat.update(|s| {
            s.model = json!("claude-opus-4-5");
            s.cwd = json!("/Users/demo/project");
            s.agent_cwd = Some(json!("/Users/demo/project/.claude/worktrees/status-line"));
            s.permission_mode = Some(json!("acceptEdits"));
            s.usage = json!({ "totalCostUsd": 0.4821, "outputTokens": 18_432 });
            s.last_turn_completed_at = Some(T0 - 120_000.);
        });
        chat.reply(&picker::context_url("s1"), 200, json!({ "percentage": 62 }));
        chat.reply(
            &picker::settings_url(Some("/Users/demo/project")).unwrap(),
            200,
            json!({ "settings": {} }),
        );
        chat.reply(
            &picker::models_url(Some("s1")).unwrap(),
            200,
            json!({ "models": [
                {
                    "value": "claude-opus-4-5",
                    "displayName": "Opus 4.5",
                    "description": "Most capable for complex work",
                    "supportsEffort": true,
                    "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"],
                    "supportsFastMode": true,
                },
                {
                    "value": "claude-sonnet-4-5",
                    "displayName": "Sonnet 4.5",
                    "description": "Best for everyday tasks",
                    "supportsEffort": true,
                    "supportedEffortLevels": ["low", "medium", "high"],
                },
                {
                    "value": "claude-haiku-4-5",
                    "displayName": "Haiku 4.5",
                    "description": "Fastest for quick answers",
                },
            ] }),
        );
        chat
    }

    fn draw(cx: &mut HeadlessAppContext, handle: AnyWindowHandle) -> anyhow::Result<()> {
        // The row measures its width, then draws its labels.
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
        });
        let chat = chat();
        if scene.running {
            chat.event(json!({ "type": "turn_status", "status": "running" }));
        }
        let target: Arc<dyn StatusTarget> = chat.clone();
        let (handle, frame): (AnyWindowHandle, Entity<Frame>) = cx.update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds {
                        origin: Default::default(),
                        size: size(px(1200.), px(scene.height)),
                    })),
                    focus: false,
                    show: false,
                    ..Default::default()
                },
                cx,
                |_, cx| {
                    let status = cx.new(|cx| {
                        let mut v = StatusLineView::new(target, theme, cx);
                        v.set_now(T0 + scene.at_sec * 1000., cx);
                        v
                    });
                    cx.new(|_| Frame { theme, status })
                },
            )
        })?;
        draw(&mut cx, handle)?;
        // The context poll's first reading.
        cx.advance_clock(Duration::from_millis(picker::CONTEXT_FIRST_POLL_MS));
        draw(&mut cx, handle)?;
        if let Some(popup) = scene.open {
            cx.update(|cx| {
                let status = frame.read(cx).status.clone();
                status.update(cx, |v, cx| v.toggle(popup, cx));
            });
            draw(&mut cx, handle)?;
        }
        let image = cx.capture_screenshot(handle)?;
        let path = out.join(format!("{}-{}.png", theme.id(), scene.name));
        image.save(&path)?;
        Ok(path)
    }

    pub fn run() -> anyhow::Result<()> {
        let out = std::env::args_os()
            .nth(1)
            .map(PathBuf::from)
            .ok_or_else(|| anyhow::anyhow!("usage: status_shots <out-dir>"))?;
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

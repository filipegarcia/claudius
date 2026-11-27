//! Screenshots of the chat's right rail and goal banner, light and dark,
//! drawn offscreen by gpui's headless Metal renderer (no window on
//! screen, no Screen Recording grant), over a [`FixtureRail`].
//!
//! `cargo run -p claudius-panels --example panels_shots -- <out-dir>`
//! (from rust/app) writes `<theme>-<scene>.png` at 2x: the rail with
//! to-dos, a running task and a shell, scheduled loops and the plan usage
//! card beside a chat whose goal is set; the goal banner once achieved;
//! the empty goal prompt with the usage card minimized. macOS only.

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

    use claudius_client::state::{ChatState, GoalState};
    use claudius_gpui_theme::{ThemeName, hsla, icons::IconAssets};
    use claudius_panels::rail::Prefs;
    use claudius_panels::{FixtureRail, GoalBannerView, RailPanel, RailTarget};
    use claudius_status::{FixtureStatus, StatusLineView, StatusTarget, picker};
    use gpui::{
        AnyWindowHandle, AppContext as _, Bounds, Context, Entity, HeadlessAppContext, IntoElement,
        ParentElement as _, Render, Styled as _, Window, WindowBounds, WindowOptions, div, px,
        size,
    };
    use gpui_apple::{AppleTextSystem, metal_renderer::MetalHeadlessRenderer};
    use serde_json::{Value, json};

    /// The fixture's clock.
    const T0: f64 = 1_795_683_600_000.0;

    /// The chat route: the status line and the session header over an
    /// empty transcript, the rail at the right.
    struct Frame {
        theme: ThemeName,
        status: Entity<StatusLineView>,
        goal: Entity<GoalBannerView>,
        rail: Entity<RailPanel>,
    }

    impl Render for Frame {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            let p = claudius_theme::Theme::of(self.theme).palette;
            div()
                .size_full()
                .flex()
                .bg(hsla(p.background))
                .text_color(hsla(p.foreground))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .child(self.status.clone())
                        .child(self.goal.clone()),
                )
                .child(self.rail.clone())
        }
    }

    struct Scene {
        name: &'static str,
        width: f32,
        height: f32,
        setup: fn(&mut ChatState),
        prefs: &'static [(&'static str, &'static str)],
    }

    fn scenes() -> Vec<Scene> {
        vec![
            Scene {
                name: "rail",
                width: 1280.,
                height: 1180.,
                setup: busy,
                prefs: &[],
            },
            Scene {
                name: "goal-achieved",
                width: 1280.,
                height: 520.,
                setup: achieved,
                prefs: &[],
            },
            Scene {
                name: "goal-empty",
                width: 1000.,
                height: 520.,
                setup: quiet,
                prefs: &[("claudius.activity.plan-usage.collapsed", "1")],
            },
        ]
    }

    fn task(id: &str, status: &str, extra: Value) -> claudius_client::task_status::TaskInfo {
        let mut v = json!({ "taskId": id, "status": status });
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        serde_json::from_value(v).unwrap()
    }

    fn base(s: &mut ChatState) {
        s.model = json!("claude-opus-4-5");
        s.effort = json!("high");
        s.permission_mode = Some(json!("acceptEdits"));
        s.cwd = json!("/Users/demo/projects/claudius/rust/app");
        s.usage = json!({
            "inputTokens": 48_210, "outputTokens": 18_432, "cacheReadInputTokens": 1_284_000,
            "totalCostUsd": 0.4821, "numTurns": 7, "durationMs": 754_000,
        });
        s.plan_usage = json!({
            "subscriptionType": "max",
            "rateLimitsAvailable": true,
            "rateLimits": {
                "fiveHour": { "utilization": 34, "resetsAt": "2026-11-26T11:40:00.000Z" },
                "sevenDay": { "utilization": 81, "resetsAt": "2026-11-29T03:00:00.000Z" }
            }
        });
    }

    fn busy(s: &mut ChatState) {
        base(s);
        s.pending = true;
        s.latest_todos = claudius_client::blocks::coerce_todos(&[
            json!({ "content": "Port the rail's pure model", "status": "completed" }),
            json!({ "content": "Draw the rail in GPUI", "status": "in_progress", "activeForm": "Drawing the rail in GPUI" }),
            json!({ "content": "Take the screenshots", "status": "pending" }),
        ]);
        s.tasks.insert(
            "a1".into(),
            task(
                "a1",
                "running",
                json!({
                    "description": "Review the rail's diff", "taskType": "local_agent",
                    "toolUseId": "tu_a1", "startedAt": T0 - 95_000.0, "totalTokens": 12_840,
                    "toolUses": 9, "lastToolName": "Read", "model": "claude-sonnet-4-5",
                    "summary": "Reading view.rs and the TSX it mirrors",
                }),
            ),
        );
        s.tasks.insert(
            "b1".into(),
            task("b1", "running", json!({ "description": "bun run dev", "taskType": "local_bash", "toolUseId": "tb1" })),
        );
        s.background_bashes.insert(
            "tb1".into(),
            serde_json::from_value(json!({ "toolUseId": "tb1", "command": "bun run dev --port 3000", "startedAt": T0 - 312_000.0 }))
                .unwrap(),
        );
        let lp = |id: &str, kind: &str, extra: Value| {
            let mut v = json!({
                "kind": kind, "id": id, "toolUseId": format!("tu_{id}"), "cron": null, "humanSchedule": null,
                "delaySeconds": null, "prompt": "Check the CI run and report what broke", "recurring": false,
                "durable": false, "startedAt": T0 - 240_000.0,
            });
            for (k, x) in extra.as_object().unwrap() {
                v[k] = x.clone();
            }
            serde_json::from_value::<claudius_client::loops::ScheduledLoop>(v).unwrap()
        };
        s.scheduled_loops.insert(
            "c1".into(),
            lp("c1", "cron", json!({ "cron": "*/10 * * * *", "humanSchedule": "Every 10 minutes", "recurring": true })),
        );
        s.scheduled_loops.insert(
            "w1".into(),
            lp("w1", "wakeup", json!({ "delaySeconds": 600, "startedAt": T0 - 150_000.0, "prompt": "Pick the review back up" })),
        );
        s.tool_history = serde_json::from_value(json!([
            { "toolUseId": "t3", "toolName": "Edit", "primaryArg": "/Users/demo/projects/claudius/rust/app/crates/claudius-panels/src/view.rs", "startedAt": T0 - 4000.0 },
            { "toolUseId": "t2", "toolName": "Bash", "primaryArg": "cargo test -p claudius-panels", "startedAt": T0 - 30_000.0, "endedAt": T0 - 18_000.0, "done": true },
            { "toolUseId": "t1", "toolName": "TodoWrite", "startedAt": T0 - 60_000.0, "endedAt": T0 - 59_800.0, "done": true },
        ]))
        .unwrap();
        s.goal = Some(GoalState {
            text: json!("Port the chat's right rail and goal banner to native GPUI"),
            achieved: false,
            summary: Value::Null,
            set_at: json!(T0 - 900_000.0),
            achieved_at: Value::Null,
        });
    }

    fn achieved(s: &mut ChatState) {
        base(s);
        s.latest_todos = claudius_client::blocks::coerce_todos(&[
            json!({ "content": "Port the rail's pure model", "status": "completed" }),
            json!({ "content": "Draw the rail in GPUI", "status": "completed" }),
        ]);
        s.goal = Some(GoalState {
            text: json!("Port the chat's right rail and goal banner to native GPUI"),
            achieved: true,
            summary: json!(
                "The rail, its widgets and the goal banner draw natively, with tests and screenshots."
            ),
            set_at: json!(T0 - 900_000.0),
            achieved_at: json!(T0 - 5000.0),
        });
    }

    fn quiet(s: &mut ChatState) {
        base(s);
        s.permission_mode = Some(json!("default"));
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
        });
        let chat = FixtureRail::new(FixtureStatus::new("s1"));
        chat.status.update(scene.setup);
        chat.status
            .reply(&picker::context_url("s1"), 200, json!({ "percentage": 62 }));
        chat.status.reply(
            &picker::settings_url(Some("/Users/demo/projects/claudius/rust/app")).unwrap(),
            200,
            json!({ "settings": {} }),
        );
        let prefs: Prefs = scene
            .prefs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        let target: Arc<dyn RailTarget> = chat.clone();
        let status_target: Arc<dyn StatusTarget> = chat.clone();
        let (handle, _frame): (AnyWindowHandle, Entity<Frame>) = cx.update(|cx| {
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
                |_, cx| {
                    let status = cx.new(|cx| {
                        let mut v = StatusLineView::new(status_target, theme, cx);
                        v.set_now(T0, cx);
                        v
                    });
                    let rail = cx.new(|cx| {
                        let mut r =
                            RailPanel::new(target.clone(), Some(status.clone()), theme, prefs, cx);
                        r.set_now(T0, cx);
                        r
                    });
                    let goal = cx.new(|cx| GoalBannerView::new(target, theme, None, cx));
                    cx.new(|_| Frame {
                        theme,
                        status,
                        goal,
                        rail,
                    })
                },
            )
        })?;
        draw(&mut cx, handle)?;
        // The context poll's first reading.
        cx.advance_clock(Duration::from_millis(picker::CONTEXT_FIRST_POLL_MS));
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
            .ok_or_else(|| anyhow::anyhow!("usage: panels_shots <out-dir>"))?;
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

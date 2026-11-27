//! Screenshots of the sessions browser over the engine in this process
//! (U11b), light and dark, drawn offscreen by gpui's headless Metal
//! renderer.
//!
//! A throwaway world (a temporary HOME whose `.claude` is the config dir,
//! the fake CLI `claudius-fake-claude`; never `~/.claude` or the real
//! `claude`): a workspace with a few sessions made by real turns (their
//! scripts write the transcripts, `tests/support/sessions_seed.rs`),
//! renamed through the rename route, their files aged. The unread badges are
//! the turns' own "finished a turn" notifications. Each theme draws the list
//! and one session's page.
//!
//! `cargo run -p claudius-app --example sessions_live_shots -- <out-dir>`
//! (from rust/app) writes `<theme>-sessions-live-<scene>.png` at 2x. macOS
//! only.

#[cfg(target_os = "macos")]
#[path = "../tests/support/sessions_seed.rs"]
mod sessions_seed;
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

    use claudius_app::data::{OpenTabsPut, ShellData};
    use claudius_app::sessions::data::{SessionsData, SessionsRequest};
    use claudius_app::sessions::live::TransportSessionsData;
    use claudius_app::shell::{Appearance, Shell};
    use claudius_app::store::LocalStore;
    use claudius_gpui_theme::{ThemeName, icons::IconAssets};
    use claudius_transport::CookieJar;
    use futures::executor::block_on;
    use gpui::{
        AnyWindowHandle, AppContext as _, Bounds, Entity, HeadlessAppContext, WindowBounds,
        WindowOptions, px, size,
    };
    use gpui_apple::{AppleTextSystem, metal_renderer::MetalHeadlessRenderer};

    use super::sessions_seed::{Spec, age, seed};
    use super::test_bins;
    use super::world::{World, wait_for, world_with};

    const LIMIT: Duration = Duration::from_secs(60);

    /// The sessions: a title (none: the creation time shows), the branch and
    /// the turns (`ago` set from the third), and how long ago the transcript
    /// last changed.
    fn specs() -> Vec<(Option<&'static str>, Spec<'static>, Duration)> {
        let min = |m: u64| Duration::from_secs(m * 60);
        vec![
            (
                Some("Port the sessions browser to GPUI"),
                Spec {
                    ago: min(0),
                    branch: "feat/rust-port",
                    turns: &[
                        (
                            "Port app/[workspaceId]/sessions to the native shell",
                            "The list, its search and filters, and the one-session page are in `claudius-app/src/sessions/`.",
                        ),
                        (
                            "Now put it over the engine",
                            "Every request goes through the transport: `TransportSessionsData` sends the same fetches the React page does, and the unread badges follow the notifications stream.",
                        ),
                    ],
                },
                min(4),
            ),
            (
                Some("Hunt the flaky unread badge"),
                Spec {
                    ago: min(0),
                    branch: "fix/unread-badge",
                    turns: &[(
                        "The unread badge flickers when a turn ends",
                        "The state events are version-gated now, so a slow counts read can't undo a newer stream event.",
                    )],
                },
                min(95),
            ),
            (
                Some("Write the plain-text export"),
                Spec {
                    ago: min(0),
                    branch: "feat/rust-port",
                    turns: &[(
                        "Export a session as text",
                        "One `# User` / `# Claude` block per message, as an attachment.",
                    )],
                },
                min(60 * 26),
            ),
            (
                None,
                Spec {
                    ago: min(0),
                    branch: "main",
                    turns: &[(
                        "Why does the search box ignore regex?",
                        "On purpose: the query is a literal, never compiled, so a crafted pattern can't stall the server.",
                    )],
                },
                min(60 * 24 * 4),
            ),
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

    fn wait(
        cx: &mut HeadlessAppContext,
        handle: AnyWindowHandle,
        shell: &Entity<Shell>,
        what: &str,
        f: impl Fn(&Shell, &gpui::App) -> bool,
    ) -> anyhow::Result<()> {
        let t0 = Instant::now();
        loop {
            draw(cx, handle)?;
            if cx.update(|cx| f(shell.read(cx), cx)) {
                return Ok(());
            }
            anyhow::ensure!(t0.elapsed() < LIMIT, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(25));
        }
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
        let path = out.join(format!("{}-sessions-live-{scene}.png", theme.id()));
        image.save(&path)?;
        println!("{}", path.display());
        Ok(())
    }

    /// Makes the sessions; their ids, newest first.
    fn seed_all(w: &World, data: &TransportSessionsData) -> anyhow::Result<Vec<String>> {
        let ws = &w.workspaces[0];
        let mut ids = Vec::new();
        for (n, (title, spec, ago)) in specs().into_iter().enumerate() {
            // Written a minute before the file last changed.
            let spec = Spec {
                ago: ago + Duration::from_secs(60),
                ..spec
            };
            let s = seed(w, ws, n, &spec, LIMIT);
            if let Some(title) = title {
                let r = block_on(data.send(SessionsRequest::Rename {
                    session_id: s.id.clone(),
                    title: title.into(),
                    dir: Some(ws.root_path.clone()),
                }))?;
                anyhow::ensure!(r.ok(), "rename: {}", r.body);
            }
            age(&ws.root_path, &s.id, ago);
            ids.push(s.id);
        }
        // A second turn: two notifications on the first session.
        w.input(&ws.id, &ids[0], "one more pass");
        wait_for("the badges", LIMIT, || {
            let u = data.unread(&ws.id);
            (u.get(&ids[0]) == Some(&2) && ids.iter().all(|id| u.contains_key(id))).then_some(())
        });
        age(&ws.root_path, &ids[0], Duration::from_secs(4 * 60));
        // The chat binds the first one rather than making a new session.
        block_on(w.data.put_open_tabs(
            &ws.id,
            OpenTabsPut {
                tabs: Some(vec![ids[0].clone()]),
                active_id: Some(Some(ids[0].clone())),
                pinned: Some(vec![]),
                label_max_width: None,
            },
        ))?;
        Ok(ids)
    }

    fn shoot(
        w: &World,
        sessions: Arc<dyn SessionsData>,
        ids: &[String],
        theme: ThemeName,
        out: &Path,
    ) -> anyhow::Result<()> {
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
                        .with_sessions(sessions, window, cx)
                    })
                },
            )
        })?;
        wait(&mut cx, handle, &shell, "the workspace", |s, _| {
            s.state().active_workspace().is_some()
        })?;
        let ws = &w.workspaces[0];
        cx.update(|cx| shell.update(cx, |s, cx| s.open_url(&format!("/{}/sessions", ws.id), cx)));
        wait(&mut cx, handle, &shell, "the list", |s, cx| {
            let Some(screen) = s.sessions_screen() else {
                return false;
            };
            screen.read(cx).list().is_some_and(|l| {
                !l.loading()
                    && ids
                        .iter()
                        .all(|id| l.scoped().iter().any(|r| &r.session_id == id))
            })
        })?;
        save(&mut cx, handle, out, theme, "list")?;
        let screen = cx
            .update(|cx| shell.read(cx).sessions_screen().cloned())
            .expect("the sessions screen");
        cx.update(|cx| screen.update(cx, |s, cx| s.select_row(1, cx)));
        save(&mut cx, handle, out, theme, "list-selected")?;
        let dir: String = ws
            .root_path
            .bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                    char::from(b).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect();
        let url = format!("/{}/sessions/{}?dir={dir}", ws.id, ids[0]);
        cx.update(|cx| shell.update(cx, |s, cx| s.open_url(&url, cx)));
        wait(&mut cx, handle, &shell, "the session", |s, cx| {
            s.sessions_screen()
                .and_then(|screen| screen.read(cx).detail().cloned())
                .is_some_and(|d| !d.loading() && d.info().is_some())
        })?;
        cx.update(|cx| screen.update(cx, |s, cx| s.open_all_blocks(cx)));
        save(&mut cx, handle, out, theme, "session")?;
        Ok(())
    }

    pub fn run() -> anyhow::Result<()> {
        let out = std::env::args_os()
            .nth(1)
            .map(PathBuf::from)
            .ok_or_else(|| anyhow::anyhow!("usage: sessions_live_shots <out-dir>"))?;
        std::fs::create_dir_all(&out)?;
        let w = world_with(test_bins::fake_claude(), &["Claudius", "Docs site"], true);
        let data = Arc::new(TransportSessionsData::new(
            w.backend.transport(Arc::new(CookieJar::new())),
            w.backend.handle(),
        ));
        let result = seed_all(&w, &data).and_then(|ids| {
            [ThemeName::Light, ThemeName::Dark]
                .into_iter()
                .try_for_each(|theme| shoot(&w, data.clone(), &ids, theme, &out))
        });
        w.shutdown();
        result
    }
}

//! `claudius-app`: the native shell.
//!
//! By default over the engine in this process (`engine.rs`: the server's
//! routes in-process, no sockets). `CLAUDIUS_CLAUDE_BIN` names the CLI to
//! spawn; `CLAUDIUS_APP_SCHEDULER=1` runs scheduled jobs here too. The
//! updater never runs in the app.
//!
//! `CLAUDIUS_APP_REMOTE=http://host:port` talks to a running `claudius`
//! server instead (unauthenticated, see below). `CLAUDIUS_APP_FIXTURE=<path>`
//! reads that JSON fixture (the shape is in `fixture.rs`; `builtin` for the
//! bundled one) and needs no engine. `CLAUDIUS_APP_THEME` is `system` (the
//! default: light or dark as macOS is) or a palette id (`dark`, `light`,
//! `paper`, …). `CLAUDIUS_APP_SESSIONS=<path>` is the sessions browser's
//! fixture (the bundled one otherwise). Over the fixture the transcripts
//! are claudius-chat's bundled ones (`FixtureTranscripts::builtin`).
//!
//! Focus mode and the per-workspace route memory persist in
//! `~/.claude/.claudius/native-app/local-storage.json` (`store.rs`).

use std::sync::Arc;
use std::time::Duration;

use claudius_app::data::ShellData;
use claudius_app::engine::{Backend, EngineOptions};
use claudius_app::fixture::FixtureShellData;
use claudius_app::live::TransportShellData;
use claudius_app::sessions::data::SessionsData;
use claudius_app::sessions::fixture::FixtureSessionsData;
use claudius_app::shell::{Appearance, open_main_window};
use claudius_app::store::{self, LocalStore};
use claudius_chat::TranscriptSource;
use claudius_chat::fixture::FixtureTranscripts;
use claudius_gpui_theme::{ThemeName, icons::IconAssets};

fn main() -> anyhow::Result<()> {
    let mut backend: Option<Arc<Backend>> = None;
    let data: Arc<dyn ShellData> = if let Some(path) = std::env::var_os("CLAUDIUS_APP_FIXTURE") {
        if path == "builtin" {
            Arc::new(FixtureShellData::builtin())
        } else {
            Arc::new(FixtureShellData::from_path(path.as_ref())?)
        }
    } else {
        let b = match std::env::var("CLAUDIUS_APP_REMOTE") {
            Ok(origin) if !origin.is_empty() => {
                eprintln!(
                    "claudius-app: talking to {origin}. Remote access is unauthenticated: that \
                     server checks no token, Origin or Host (TODO U02e), so anything that can \
                     reach it can drive its sessions."
                );
                Backend::remote(&origin)?
            }
            _ => Backend::in_process(EngineOptions::from_env())?,
        };
        let b = Arc::new(b);
        backend = Some(b.clone());
        Arc::new(TransportShellData::new(b))
    };
    // `CLAUDIUS_APP_SESSIONS=<path>`: the sessions browser's fixture, else
    // the bundled one, its ages moved to now.
    let sessions: Arc<dyn SessionsData> = match std::env::var_os("CLAUDIUS_APP_SESSIONS") {
        Some(path) => Arc::new(FixtureSessionsData::from_path(path.as_ref())?),
        None => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0., |d| d.as_millis() as f64);
            Arc::new(FixtureSessionsData::builtin().rebased(now))
        }
    };
    let appearance = match std::env::var("CLAUDIUS_APP_THEME") {
        Ok(s) => Appearance::parse(&s)
            .ok_or_else(|| anyhow::anyhow!("CLAUDIUS_APP_THEME={s}: not `system` or a theme id"))?,
        Err(_) => Appearance::System,
    };
    // Over the fixture, the bundled sessions' transcripts; the demo session
    // streams a reply every few seconds (a word each 60 ms).
    let fixture = if backend.is_none() {
        FixtureTranscripts::builtin()
    } else {
        Arc::new(FixtureTranscripts::new())
    };
    let _player = backend
        .is_none()
        .then(|| fixture.spawn_player(Duration::from_millis(60), Duration::from_secs(4)));
    let transcripts: Arc<dyn TranscriptSource> = fixture;
    let store = LocalStore::open(store::default_path());
    gpui_kit::application()
        .with_assets(IconAssets)
        .run(move |cx| {
            claudius_app::init(ThemeName::DEFAULT, cx);
            if let Some(b) = backend.clone() {
                // Every session ends with the app, its CLI with it.
                cx.on_app_quit(move |_| {
                    b.shutdown(Duration::from_secs(5));
                    async {}
                })
                .detach();
            }
            if let Err(e) = open_main_window(data, transcripts, sessions, appearance, store, cx) {
                eprintln!("claudius-app: opening the window: {e:#}");
                cx.quit();
                return;
            }
            cx.on_window_closed(|cx, _| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();
            cx.activate(true);
        });
    Ok(())
}

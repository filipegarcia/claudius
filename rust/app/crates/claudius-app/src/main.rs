//! `claudius-app`: the native shell over a fixture.
//!
//! `CLAUDIUS_APP_FIXTURE=<path>` reads that JSON (the shape is in
//! `fixture.rs`); otherwise the bundled fixture. The transcripts are
//! claudius-chat's bundled ones (`FixtureTranscripts::builtin`). `CLAUDIUS_APP_THEME` is
//! `system` (the default: light or dark as macOS is) or a palette id
//! (`dark`, `light`, `paper`, …).

use std::sync::Arc;

use claudius_app::data::ShellData;
use claudius_app::fixture::FixtureShellData;
use claudius_app::sessions::data::SessionsData;
use claudius_app::sessions::fixture::FixtureSessionsData;
use claudius_app::shell::{Appearance, open_main_window};
use claudius_chat::TranscriptSource;
use claudius_chat::fixture::FixtureTranscripts;
use claudius_gpui_theme::{ThemeName, icons::IconAssets};

fn main() -> anyhow::Result<()> {
    let data: Arc<dyn ShellData> = match std::env::var_os("CLAUDIUS_APP_FIXTURE") {
        Some(path) => Arc::new(FixtureShellData::from_path(path.as_ref())?),
        None => Arc::new(FixtureShellData::builtin()),
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
    // The bundled sessions' transcripts; the demo session streams a reply
    // every few seconds (a word each 60 ms).
    let fixture = FixtureTranscripts::builtin();
    let _player = fixture.spawn_player(
        std::time::Duration::from_millis(60),
        std::time::Duration::from_secs(4),
    );
    let transcripts: Arc<dyn TranscriptSource> = fixture;
    gpui_kit::application()
        .with_assets(IconAssets)
        .run(move |cx| {
            claudius_app::init(ThemeName::DEFAULT, cx);
            if let Err(e) = open_main_window(data, transcripts, sessions, appearance, cx) {
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

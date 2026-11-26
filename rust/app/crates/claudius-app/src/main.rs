//! `claudius-app`: the native shell over a fixture.
//!
//! `CLAUDIUS_APP_FIXTURE=<path>` reads that JSON (the shape is in
//! `fixture.rs`); otherwise the bundled fixture. `CLAUDIUS_APP_THEME` is
//! `system` (the default: light or dark as macOS is) or a palette id
//! (`dark`, `light`, `paper`, …).

use std::sync::Arc;

use claudius_app::data::ShellData;
use claudius_app::fixture::FixtureShellData;
use claudius_app::shell::{Appearance, open_main_window};
use claudius_gpui_theme::{ThemeName, icons::IconAssets};

fn main() -> anyhow::Result<()> {
    let data: Arc<dyn ShellData> = match std::env::var_os("CLAUDIUS_APP_FIXTURE") {
        Some(path) => Arc::new(FixtureShellData::from_path(path.as_ref())?),
        None => Arc::new(FixtureShellData::builtin()),
    };
    let appearance = match std::env::var("CLAUDIUS_APP_THEME") {
        Ok(s) => Appearance::parse(&s)
            .ok_or_else(|| anyhow::anyhow!("CLAUDIUS_APP_THEME={s}: not `system` or a theme id"))?,
        Err(_) => Appearance::System,
    };
    gpui_kit::application()
        .with_assets(IconAssets)
        .run(move |cx| {
            claudius_app::init(ThemeName::DEFAULT, cx);
            if let Err(e) = open_main_window(data, appearance, cx) {
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

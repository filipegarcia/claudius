//! `ShellState` with a live chat (U04b), over the fixture without GPUI:
//! the shell's boot stands aside, `chat_bound` puts the chat's session in
//! the strip and persists it, the chat's `?session=` writer replaces the
//! route, and a remembered page is where a workspace tile goes.

use claudius_app::data::{OpenTabsPut, ShellData};
use claudius_app::fixture::FixtureShellData;
use claudius_app::nav::FocusLevel;
use claudius_app::route::{Route, WorkspacePage};
use claudius_app::shell::icon_format;
use claudius_app::state::{Effect, ShellState};
use futures::executor::block_on;
use gpui_kit::ImageFormat;

const W1: &str = "wks_3f2a9c81d0e4";
const W2: &str = "wks_7b41e05c92aa";
const RUNNING: &str = "3e9a7c41-0b2d-4e8f-8c6a-1d2e3f405162";
const PINNED: &str = "8c1f0b2e-5d4a-4f7e-9a61-2b3c4d5e6f70";
const FRESH: &str = "f0000000-0000-4000-8000-000000000001";

/// Boots a live-chat state over the bundled fixture to W1's chat, its
/// workspace loaded; the effects it asked for.
fn live() -> (ShellState, FixtureShellData, Vec<Effect>) {
    let data = FixtureShellData::builtin();
    let mut s = ShellState::new();
    s.set_live_chat(true);
    assert!(s.is_live_chat());
    let list = block_on(data.workspaces()).unwrap();
    let mut log = s.workspaces_loaded(list);
    let id = W1.to_owned();
    let tabs = block_on(data.open_tabs(&id)).unwrap();
    let rows = block_on(data.sessions(&id)).unwrap();
    log.extend(s.workspace_loaded(&id, tabs, rows));
    (s, data, log)
}

fn persisted(log: &[Effect]) -> Vec<&OpenTabsPut> {
    log.iter()
        .filter_map(|e| match e {
            Effect::PersistTabs(_, b) => Some(b),
            _ => None,
        })
        .collect()
}

#[test]
fn a_live_chat_boots_the_strip_itself() {
    let (s, _, log) = live();
    assert_eq!(s.route(), &Route::chat(W1));
    assert!(s.is_loaded(W1));
    // No resume of the saved tab, no new session, nothing persisted: the
    // chat's own boot picks the session.
    assert!(
        !log.iter()
            .any(|e| matches!(e, Effect::CreateSession(_) | Effect::PersistTabs(..))),
        "{log:?}"
    );
    let strip = s.strip(W1).unwrap();
    assert_eq!(strip.bound(), None);
    assert!(strip.tabs().contains(&RUNNING.to_owned()));
    // Without a live chat the shell resumes the saved tab itself.
    let data = FixtureShellData::builtin();
    let mut fixture = ShellState::new();
    let list = block_on(data.workspaces()).unwrap();
    fixture.workspaces_loaded(list);
    let tabs = block_on(data.open_tabs(W1)).unwrap();
    let rows = block_on(data.sessions(W1)).unwrap();
    let out = fixture.workspace_loaded(W1, tabs, rows);
    assert_eq!(fixture.strip(W1).unwrap().bound(), Some(RUNNING));
    assert_eq!(persisted(&out).len(), 1);
}

#[test]
fn chat_bound_joins_the_strip_and_persists() {
    let (mut s, _, _) = live();
    // The chat resumed the saved tab: bound, nothing new in the strip.
    let out = s.chat_bound(W1, RUNNING);
    let strip = s.strip(W1).unwrap();
    assert_eq!(strip.bound(), Some(RUNNING));
    assert_eq!(strip.active(), Some(RUNNING));
    let p = persisted(&out);
    assert_eq!(p.len(), 1);
    assert_eq!(p[0].active_id, Some(Some(RUNNING.to_owned())));
    // The same again changes nothing.
    assert_eq!(s.chat_bound(W1, RUNNING), vec![]);
    // A fresh session ("+", or a boot with nothing saved) joins at the end.
    let n = s.strip(W1).unwrap().tabs().len();
    let out = s.chat_bound(W1, FRESH);
    let strip = s.strip(W1).unwrap();
    assert_eq!(strip.tabs().len(), n + 1);
    assert_eq!(strip.tabs().last().map(String::as_str), Some(FRESH));
    assert_eq!(strip.active(), Some(FRESH));
    assert_eq!(
        persisted(&out)[0]
            .tabs
            .as_ref()
            .unwrap()
            .last()
            .map(String::as_str),
        Some(FRESH)
    );
    // A workspace not loaded (yet), or unknown: nothing.
    assert_eq!(s.chat_bound(W2, FRESH), vec![]);
    let out = s.select_workspace(W2);
    assert!(out.contains(&Effect::LoadWorkspace(W2.to_owned())));
    assert!(!s.is_loaded(W2));
    assert_eq!(s.chat_bound(W2, FRESH), vec![]);
    assert_eq!(s.chat_bound("wks_000000000000", FRESH), vec![]);
    assert!(s.strip(W2).is_none_or(|st| st.bound().is_none()));
}

#[test]
fn a_tab_click_moves_the_strip_for_the_chat_to_follow() {
    let (mut s, _, _) = live();
    s.chat_bound(W1, RUNNING);
    let out = s.select_tab(PINNED);
    assert_eq!(s.strip(W1).unwrap().bound(), Some(PINNED));
    assert_eq!(persisted(&out).len(), 1);
    // "+" asks for a session; the shell hands it to the chat.
    assert_eq!(s.new_tab(), vec![Effect::CreateSession(W1.to_owned())]);
}

#[test]
fn the_chats_url_writer_replaces_the_route() {
    let (mut s, _, _) = live();
    s.chat_bound(W1, RUNNING);
    assert!(!s.can_go_back());
    let url = format!("/{W1}?session={RUNNING}");
    let out = s.replace_location(&url);
    assert_eq!(
        s.route(),
        &Route::page(
            W1,
            WorkspacePage::Chat {
                session: Some(RUNNING.to_owned())
            }
        )
    );
    // Replaced, not pushed; the strip is untouched.
    assert!(!s.can_go_back());
    assert_eq!(s.strip(W1).unwrap().bound(), Some(RUNNING));
    assert!(!out.iter().any(|e| matches!(e, Effect::CreateSession(_))));
}

#[test]
fn remembered_pages_and_focus_restore() {
    let mut s = ShellState::new();
    s.remember_page(
        W2,
        WorkspacePage::Files {
            root: Some("r".into()),
            path: Some("p".into()),
        },
    );
    assert_eq!(
        s.workspace_target(W2),
        Route::page(
            W2,
            WorkspacePage::Files {
                root: None,
                path: None
            }
        ),
        "kept without its query"
    );
    assert_eq!(s.workspace_target(W1), Route::chat(W1));
    s.set_focus(FocusLevel::Zen);
    assert_eq!(s.focus(), FocusLevel::Zen);
    assert_eq!(s.enabled_customizations(), None);
    s.set_enabled_customizations(vec!["docker".into()]);
    assert_eq!(s.enabled_customizations(), Some(&["docker".to_owned()][..]));
}

#[test]
fn icon_formats_follow_the_route() {
    for (ct, ext, f) in [
        ("image/png", "", Some(ImageFormat::Png)),
        ("IMAGE/PNG; charset=binary", "", Some(ImageFormat::Png)),
        ("image/jpeg", "png", Some(ImageFormat::Jpeg)),
        ("image/jpg", "", Some(ImageFormat::Jpeg)),
        ("image/webp", "", Some(ImageFormat::Webp)),
        ("image/gif", "", Some(ImageFormat::Gif)),
        ("image/svg+xml", "", Some(ImageFormat::Svg)),
        ("application/octet-stream", "PNG", Some(ImageFormat::Png)),
        ("", "jpg", Some(ImageFormat::Jpeg)),
        ("", "jpeg", Some(ImageFormat::Jpeg)),
        ("", "webp", Some(ImageFormat::Webp)),
        ("", "gif", Some(ImageFormat::Gif)),
        ("", "svg", Some(ImageFormat::Svg)),
        ("", "bmp", None),
        ("text/plain", "", None),
    ] {
        assert_eq!(icon_format(ct, ext), f, "{ct:?} {ext:?}");
    }
}

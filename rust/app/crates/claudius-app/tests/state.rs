//! The shell's state over the fixture, without GPUI: boot, navigation and
//! history, the redirects in use, workspace switching and route memory,
//! the tab actions on and off the chat, focus mode, "Close all". The
//! effects run against `FixtureShellData` the way `Shell::run` does.

use claudius_app::data::{OpenTabs, ShellChange, ShellData, TabStatus};
use claudius_app::fixture::{BUILTIN, Fixture, FixtureShellData};
use claudius_app::nav::FocusLevel;
use claudius_app::route::{Route, WorkspacePage};
use claudius_app::state::{Effect, ShellState};
use futures::executor::block_on;

const W1: &str = "wks_3f2a9c81d0e4";
const W2: &str = "wks_7b41e05c92aa";
const W3: &str = "wks_c09d4e7f1b36";
const PINNED: &str = "8c1f0b2e-5d4a-4f7e-9a61-2b3c4d5e6f70";
const RUNNING: &str = "3e9a7c41-0b2d-4e8f-8c6a-1d2e3f405162";
const NEEDS: &str = "b7d24f19-6c3e-4a5b-9d8e-7f6a5b4c3d2e";
const UNTITLED: &str = "51c0e8a3-9f7b-4d2c-a1e6-0b9c8d7e6f5a";
const SAVED_TITLE: &str = "e2a96d07-4b1c-4f3e-8d5a-6c7b8a9f0e1d";
const NO_ROW: &str = "0f4b8c2a-7e6d-4c5b-9a3f-2e1d0c9b8a7f";
const W2_ACTIVE: &str = "a4c3e2f1-8b7a-4d6c-9e5f-3a2b1c0d9e8f";
const W3_ONLY: &str = "d9e8f7a6-b5c4-4d3e-9f2a-1b0c9d8e7f6a";

/// `Shell::run`, synchronously.
struct Harness {
    state: ShellState,
    data: FixtureShellData,
    confirm: Option<(String, String)>,
    log: Vec<Effect>,
}

impl Harness {
    fn new(data: FixtureShellData) -> Harness {
        let mut h = Harness {
            state: ShellState::new(),
            data,
            confirm: None,
            log: Vec::new(),
        };
        let list = block_on(h.data.workspaces()).unwrap();
        let effects = h.state.workspaces_loaded(list);
        h.run(effects);
        h
    }

    fn builtin() -> Harness {
        Harness::new(FixtureShellData::builtin())
    }

    fn run(&mut self, effects: Vec<Effect>) {
        for e in effects {
            self.log.push(e.clone());
            match e {
                Effect::SelectWorkspace(id) => block_on(self.data.select_workspace(&id)).unwrap(),
                Effect::LoadWorkspace(id) => {
                    let tabs = block_on(self.data.open_tabs(&id)).unwrap();
                    let sessions = block_on(self.data.sessions(&id)).unwrap();
                    let next = self.state.workspace_loaded(&id, tabs, sessions);
                    self.run(next);
                }
                Effect::LoadSessions(id) => {
                    let rows = block_on(self.data.sessions(&id)).unwrap();
                    self.state.sessions_loaded(&id, rows);
                }
                Effect::PersistTabs(id, body) => {
                    block_on(self.data.put_open_tabs(&id, body)).unwrap()
                }
                Effect::CreateSession(id) => {
                    let sid = block_on(self.data.create_session(&id)).unwrap();
                    let next = self.state.session_created(&id, &sid);
                    self.run(next);
                }
                Effect::ConfirmCloseAll { workspace, message } => {
                    self.confirm = Some((workspace, message));
                }
            }
        }
    }

    fn act(&mut self, f: impl FnOnce(&mut ShellState) -> Vec<Effect>) -> Vec<Effect> {
        self.log.clear();
        let effects = f(&mut self.state);
        self.run(effects.clone());
        effects
    }

    fn active_tab(&self) -> Option<String> {
        let ws = self.state.active_workspace()?.id.clone();
        self.state.strip(&ws)?.active().map(str::to_owned)
    }

    fn tabs(&self, ws: &str) -> Vec<String> {
        self.state.strip(ws).unwrap().tabs().to_vec()
    }

    fn saved(&self, ws: &str) -> OpenTabs {
        self.data.snapshot().open_tabs.get(ws).cloned().unwrap()
    }
}

#[test]
fn the_bundled_fixture_parses_with_every_tab_status() {
    let f: Fixture = serde_json::from_str(BUILTIN).unwrap();
    assert_eq!(f.workspaces.workspaces.len(), 3);
    assert_eq!(f.workspaces.active_id.as_deref(), Some(W1));
    let tabs: usize = f.open_tabs.values().map(|t| t.tabs.len()).sum();
    assert_eq!(tabs, 10);
    assert_eq!(f.open_tabs[W1].tabs.len(), 6);
    // Round trip: the shapes keep every field.
    let back: Fixture = serde_json::from_value(serde_json::to_value(&f).unwrap()).unwrap();
    assert_eq!(back, f);

    let mut seen = std::collections::BTreeSet::new();
    for ws in [W1, W2, W3] {
        let mut h = Harness::builtin();
        h.act(|s| s.select_workspace(ws));
        let bound = h.data.active_session_state(ws);
        for v in h.state.tab_views(bound, 2026) {
            seen.insert(v.status.as_str());
        }
    }
    let all: std::collections::BTreeSet<_> = [
        TabStatus::Running,
        TabStatus::Idle,
        TabStatus::Starting,
        TabStatus::Error,
        TabStatus::Background,
        TabStatus::NeedsInput,
    ]
    .iter()
    .map(|s| s.as_str())
    .collect();
    assert_eq!(seen, all);
}

#[test]
fn boot_opens_the_active_workspace_and_resumes_its_saved_tab() {
    let h = Harness::builtin();
    assert!(h.state.is_listed());
    assert_eq!(h.state.route(), &Route::chat(W1));
    // `/` replaced the splash: nothing to go back to.
    assert!(!h.state.can_go_back());
    assert!(!h.state.can_go_forward());
    assert_eq!(h.state.active_workspace().unwrap().name, "claudius");
    assert_eq!(h.active_tab().as_deref(), Some(RUNNING));
    // Pinned first, the saved order after.
    assert_eq!(
        h.tabs(W1),
        [PINNED, RUNNING, NEEDS, UNTITLED, SAVED_TITLE, NO_ROW]
    );
    // The boot saved the strip back unchanged.
    let saved = h.saved(W1);
    assert_eq!(saved.tabs, h.tabs(W1));
    assert_eq!(saved.active_id.as_deref(), Some(RUNNING));
    assert_eq!(saved.pinned, [PINNED]);
    assert!(h.log.contains(&Effect::LoadWorkspace(W1.into())));
    assert!(h.log.contains(&Effect::SelectWorkspace(W1.into())));
    // Labels: title, title, title, date, saved title, id prefix.
    let views = h.state.tab_views(None, 2026);
    let labels: Vec<&str> = views.iter().map(|v| v.label.as_str()).collect();
    assert_eq!(labels[0], "Release checklist");
    assert_eq!(labels[1], "Port the app shell to GPUI");
    assert!(labels[3].contains(" at "), "{}", labels[3]);
    assert_eq!(labels[4], "Investigate the SSE memory leak");
    assert_eq!(labels[5], "0f4b8c2a");
}

#[test]
fn no_workspace_shows_the_splash() {
    let mut f: Fixture = serde_json::from_str(BUILTIN).unwrap();
    f.workspaces.workspaces.clear();
    f.workspaces.active_id = None;
    let mut h = Harness::new(FixtureShellData::new(f));
    assert_eq!(h.state.route(), &Route::Welcome);
    assert!(h.state.active_workspace().is_none());
    h.act(|s| s.open_url("/git"));
    assert_eq!(h.state.route(), &Route::Welcome);
    h.act(|s| s.open_url("/settings"));
    assert_eq!(h.state.route(), &Route::Settings);
    // No workspace: the nav and tab actions do nothing.
    assert!(h.act(|s| s.nav("nav.git")).is_empty());
    assert!(h.act(|s| s.cycle_workspace(true)).is_empty());
    assert!(h.act(|s| s.go_workspace(1)).is_empty());
}

#[test]
fn nav_back_and_forward() {
    let mut h = Harness::builtin();
    h.act(|s| s.nav("nav.git"));
    assert_eq!(h.state.route(), &Route::page(W1, WorkspacePage::Git));
    h.act(|s| s.nav("nav.sessions"));
    assert_eq!(h.state.route(), &Route::page(W1, WorkspacePage::Sessions));
    // The same page again adds no entry.
    assert!(h.act(|s| s.nav("nav.sessions")).is_empty());
    h.act(|s| s.back());
    assert_eq!(h.state.route(), &Route::page(W1, WorkspacePage::Git));
    h.act(|s| s.back());
    assert_eq!(h.state.route(), &Route::chat(W1));
    assert!(!h.state.can_go_back());
    assert!(h.act(|s| s.back()).is_empty());
    h.act(|s| s.forward());
    assert_eq!(h.state.route(), &Route::page(W1, WorkspacePage::Git));
    // A new page drops the forward entries.
    h.act(|s| s.nav("nav.cost"));
    assert!(!h.state.can_go_forward());
    assert!(h.act(|s| s.forward()).is_empty());
    h.act(|s| s.back());
    assert_eq!(h.state.route(), &Route::page(W1, WorkspacePage::Git));
    // A gated tile isn't on the rail until its customization is published.
    assert!(h.act(|s| s.nav("nav.docker")).is_empty());
    h.state
        .set_enabled_customizations(vec!["DOCKER MONITORING".into()]);
    h.act(|s| s.nav("nav.docker"));
    assert_eq!(h.state.route(), &Route::page(W1, WorkspacePage::Docker));
    assert!(h.act(|s| s.nav("nav.nope")).is_empty());
    // Back to the chat resumes the same tab.
    h.act(|s| s.nav("nav.chat"));
    assert_eq!(h.active_tab().as_deref(), Some(RUNNING));
}

#[test]
fn switching_workspaces_selects_loads_and_remembers_pages() {
    let mut h = Harness::builtin();
    let effects = h.act(|s| s.select_workspace(W2));
    assert!(effects.contains(&Effect::SelectWorkspace(W2.into())));
    assert!(effects.contains(&Effect::LoadWorkspace(W2.into())));
    assert_eq!(h.state.route(), &Route::chat(W2));
    assert_eq!(h.data.snapshot().workspaces.active_id.as_deref(), Some(W2));
    assert_eq!(h.active_tab().as_deref(), Some(W2_ACTIVE));
    // W2's rail is in its saved order.
    let ids: Vec<&str> = h.state.nav_items().iter().map(|i| i.action_id).collect();
    assert_eq!(
        &ids[..5],
        [
            "nav.chat",
            "nav.git",
            "nav.files",
            "nav.sessions",
            "nav.memory"
        ]
    );
    // The bound tab reads the chat's error.
    let views = h.state.tab_views(h.data.active_session_state(W2), 2026);
    assert_eq!(views[0].status, TabStatus::Error);

    h.act(|s| s.open_url("/files?path=src/lib.rs"));
    assert_eq!(
        h.state.route(),
        &Route::page(
            W2,
            WorkspacePage::Files {
                root: None,
                path: Some("src/lib.rs".into()),
            }
        )
    );
    // Back to W1: its chat (the last page there). Loaded once.
    let effects = h.act(|s| s.select_workspace(W1));
    assert!(!effects.contains(&Effect::LoadWorkspace(W1.into())));
    assert_eq!(h.state.route(), &Route::chat(W1));
    // Back to W2: the files page, without its query.
    h.act(|s| s.select_workspace(W2));
    assert_eq!(
        h.state.route(),
        &Route::page(
            W2,
            WorkspacePage::Files {
                root: None,
                path: None,
            }
        )
    );
    // The current workspace's tile is still a navigation (to its page).
    assert!(h.act(|s| s.select_workspace(W2)).is_empty());
    assert!(h.act(|s| s.select_workspace("wks_000000000000")).is_empty());
    // Back goes through the workspaces visited.
    h.act(|s| s.back());
    assert_eq!(h.state.route(), &Route::chat(W1));
    assert_eq!(h.state.active_workspace().unwrap().id, W1);
}

#[test]
fn cycling_and_numbered_workspaces_wrap() {
    let mut h = Harness::builtin();
    h.act(|s| s.cycle_workspace(true));
    assert_eq!(h.state.active_workspace().unwrap().id, W2);
    h.act(|s| s.cycle_workspace(true));
    assert_eq!(h.state.active_workspace().unwrap().id, W3);
    h.act(|s| s.cycle_workspace(true));
    assert_eq!(h.state.active_workspace().unwrap().id, W1);
    h.act(|s| s.cycle_workspace(false));
    assert_eq!(h.state.active_workspace().unwrap().id, W3);
    // W3's only tab boots as the saved one; its chat isn't ready yet.
    assert_eq!(h.active_tab().as_deref(), Some(W3_ONLY));
    let views = h.state.tab_views(h.data.active_session_state(W3), 2026);
    assert_eq!(views[0].status, TabStatus::Starting);
    h.act(|s| s.go_workspace(1));
    assert_eq!(h.state.active_workspace().unwrap().id, W1);
    assert!(h.act(|s| s.go_workspace(1)).is_empty());
    assert!(h.act(|s| s.go_workspace(9)).is_empty());
    assert!(h.act(|s| s.go_workspace(0)).is_empty());
    h.act(|s| s.go_workspace(2));
    assert_eq!(h.state.active_workspace().unwrap().id, W2);
}

#[test]
fn tab_actions_work_on_the_chat_only_and_persist() {
    let mut h = Harness::builtin();
    h.act(|s| s.cycle_tab(true));
    assert_eq!(h.active_tab().as_deref(), Some(NEEDS));
    assert_eq!(h.saved(W1).active_id.as_deref(), Some(NEEDS));
    h.act(|s| s.go_tab(1));
    assert_eq!(h.active_tab().as_deref(), Some(PINNED));
    h.act(|s| s.last_tab());
    assert_eq!(h.active_tab().as_deref(), Some(NO_ROW));
    h.act(|s| s.select_tab_by_number(4));
    assert_eq!(h.active_tab().as_deref(), Some(UNTITLED));
    h.act(|s| s.select_tab(SAVED_TITLE));
    assert_eq!(h.active_tab().as_deref(), Some(SAVED_TITLE));
    // Selecting the active tab changes nothing, so saves nothing.
    assert!(h.act(|s| s.select_tab(SAVED_TITLE)).is_empty());

    h.act(|s| s.close_active_tab());
    assert_eq!(h.active_tab().as_deref(), Some(UNTITLED));
    assert!(!h.saved(W1).tabs.contains(&SAVED_TITLE.to_owned()));
    h.act(|s| s.reopen_tab());
    assert_eq!(h.active_tab().as_deref(), Some(SAVED_TITLE));
    assert_eq!(h.saved(W1).tabs[4], SAVED_TITLE);
    h.act(|s| s.toggle_pin(NEEDS));
    assert_eq!(h.saved(W1).pinned, [PINNED, NEEDS]);
    assert_eq!(h.tabs(W1)[..2], [PINNED, NEEDS]);
    h.act(|s| s.reorder_tab(5, 2));
    assert_eq!(h.tabs(W1)[2], NO_ROW);

    // Off the chat there is no strip: the tab actions do nothing.
    h.act(|s| s.nav("nav.git"));
    let before = h.tabs(W1);
    for f in [
        ShellState::reopen_tab as fn(&mut ShellState) -> Vec<Effect>,
        ShellState::close_active_tab,
        ShellState::last_tab,
        ShellState::new_tab,
        ShellState::close_all_tabs,
    ] {
        assert!(h.act(f).is_empty());
    }
    assert!(h.act(|s| s.cycle_tab(true)).is_empty());
    assert!(h.act(|s| s.go_tab(1)).is_empty());
    assert!(h.act(|s| s.select_tab_by_number(1)).is_empty());
    assert!(h.act(|s| s.close_tab(NO_ROW)).is_empty());
    assert_eq!(h.tabs(W1), before);
}

#[test]
fn a_new_tab_creates_a_session_and_binds_it() {
    let mut h = Harness::builtin();
    let effects = h.act(|s| s.new_tab());
    assert_eq!(effects, [Effect::CreateSession(W1.into())]);
    let new = h.active_tab().unwrap();
    assert!(new.starts_with("5e55f1c7-"), "{new}");
    assert_eq!(h.tabs(W1).last(), Some(&new));
    assert_eq!(h.saved(W1).active_id.as_deref(), Some(new.as_str()));
    // Its row was re-read: a date label, idle.
    let views = h.state.tab_views(None, 2026);
    let v = views.last().unwrap();
    assert_eq!(v.status, TabStatus::Idle);
    assert!(v.label.contains(" at "), "{}", v.label);
}

#[test]
fn a_workspace_with_no_saved_tabs_boots_a_new_session() {
    let mut f: Fixture = serde_json::from_str(BUILTIN).unwrap();
    f.open_tabs.remove(W3);
    let mut h = Harness::new(FixtureShellData::new(f));
    let effects = h.act(|s| s.select_workspace(W3));
    assert!(effects.contains(&Effect::LoadWorkspace(W3.into())));
    assert!(h.log.contains(&Effect::CreateSession(W3.into())));
    let tabs = h.tabs(W3);
    assert_eq!(tabs.len(), 1);
    assert_eq!(h.active_tab().as_ref(), Some(&tabs[0]));
    assert_eq!(h.saved(W3).tabs, tabs);
}

#[test]
fn the_chat_boots_where_it_arrives_not_where_the_data_loaded() {
    let mut h = Harness::builtin();
    // W3's data loads on its git page; the chat boots on arrival, with the
    // saved tab rather than a new session.
    h.act(|s| s.open_url(&format!("/{W3}/git")));
    assert!(h.log.contains(&Effect::LoadWorkspace(W3.into())));
    assert_eq!(h.state.strip(W3).unwrap().bound(), None);
    h.act(|s| s.nav("nav.chat"));
    assert!(!h.log.iter().any(|e| matches!(e, Effect::CreateSession(_))));
    assert_eq!(h.active_tab().as_deref(), Some(W3_ONLY));
}

#[test]
fn a_session_in_the_url_binds_that_session() {
    let mut h = Harness::builtin();
    h.act(|s| s.open_url(&format!("/{W1}?session={NEEDS}")));
    assert_eq!(h.active_tab().as_deref(), Some(NEEDS));
    // An id not on the strip joins it.
    h.act(|s| s.open_url(&format!("/{W1}?session=feedface-0000")));
    assert_eq!(h.active_tab().as_deref(), Some("feedface-0000"));
    assert_eq!(h.tabs(W1).last().map(String::as_str), Some("feedface-0000"));
}

#[test]
fn close_all_asks_then_keeps_the_pins() {
    let mut h = Harness::builtin();
    let effects = h.act(|s| s.close_all_tabs());
    let msg = "Close 5 unpinned tabs? 1 pinned tab and sessions on disk remain.";
    assert_eq!(
        effects,
        [Effect::ConfirmCloseAll {
            workspace: W1.into(),
            message: msg.into(),
        }]
    );
    // Asking changed nothing.
    assert_eq!(h.tabs(W1).len(), 6);
    h.act(|s| s.close_all_confirmed(W1));
    assert_eq!(h.tabs(W1), [PINNED]);
    assert_eq!(h.saved(W1).tabs, [PINNED]);
    // The bound session lingers off the strip: no tab is active.
    assert_eq!(h.active_tab(), None);
    assert_eq!(h.state.strip(W1).unwrap().bound(), Some(RUNNING));
    // Only pins left: nothing to close.
    assert!(h.act(|s| s.close_all_tabs()).is_empty());

    let mut h = Harness::builtin();
    h.act(|s| s.select_workspace(W3));
    let effects = h.act(|s| s.close_all_tabs());
    assert_eq!(
        effects,
        [Effect::ConfirmCloseAll {
            workspace: W3.into(),
            message: "Close all 1 tabs? Sessions remain on disk.".into(),
        }]
    );
    let mut h = Harness::builtin();
    h.act(|s| s.toggle_pin(RUNNING));
    h.act(|s| s.toggle_pin(PINNED));
    h.act(|s| s.toggle_pin(NEEDS));
    let msg = match &h.act(|s| s.close_all_tabs())[..] {
        [Effect::ConfirmCloseAll { message, .. }] => message.clone(),
        other => panic!("{other:?}"),
    };
    assert_eq!(
        msg,
        "Close 4 unpinned tabs? 2 pinned tabs and sessions on disk remain."
    );
}

#[test]
fn focus_mode_cycles_on_the_chat_only() {
    let mut h = Harness::builtin();
    assert_eq!(h.state.focus(), FocusLevel::Off);
    h.state.cycle_focus();
    assert_eq!(h.state.focus(), FocusLevel::Focus);
    assert!(h.state.effective_focus().shows_workspace_rail());
    assert!(!h.state.effective_focus().shows_nav_rail());
    h.state.cycle_focus();
    assert_eq!(h.state.focus(), FocusLevel::Zen);
    assert!(!h.state.effective_focus().shows_workspace_rail());
    // Another page shows the rails; ⌘. does nothing there.
    h.act(|s| s.nav("nav.git"));
    assert_eq!(h.state.effective_focus(), FocusLevel::Off);
    h.state.cycle_focus();
    assert_eq!(h.state.focus(), FocusLevel::Zen);
    h.act(|s| s.back());
    assert_eq!(h.state.effective_focus(), FocusLevel::Zen);
    h.state.cycle_focus();
    assert_eq!(h.state.focus(), FocusLevel::Off);
    assert!(h.state.effective_focus().shows_nav_rail());
    h.state.set_focus(FocusLevel::Focus);
    assert_eq!(h.state.focus().as_str(), "focus");
}

#[test]
fn a_deleted_workspace_sends_its_page_home() {
    let mut h = Harness::builtin();
    h.act(|s| s.select_workspace(W2));
    h.act(|s| s.nav("nav.git"));
    h.data.change(ShellChange::Workspaces, |f| {
        f.workspaces.workspaces.retain(|w| w.id != W2);
        f.workspaces.active_id = Some(W3.into());
    });
    let list = block_on(h.data.workspaces()).unwrap();
    h.act(|s| s.workspaces_loaded(list));
    // The selected workspace is gone: the store's choice.
    assert_eq!(h.state.route(), &Route::chat(W3));
    // A refresh that keeps the route's workspace changes nothing.
    let list = block_on(h.data.workspaces()).unwrap();
    assert!(h.act(|s| s.workspaces_loaded(list)).is_empty());
}

#[test]
fn label_width_is_saved_alone() {
    let mut h = Harness::builtin();
    h.act(|s| s.set_label_width(9999.));
    assert_eq!(h.state.strip(W1).unwrap().label_max_width(), 600.);
    let saved = h.saved(W1);
    assert_eq!(saved.label_max_width, 600.);
    assert_eq!(saved.tabs.len(), 6);
}

#[test]
fn the_fixture_answers_like_the_routes() {
    let data = FixtureShellData::builtin();
    let mut changes = data.subscribe();
    // `?workspaceId=` filters by cwd; an unknown id lists everything.
    assert_eq!(block_on(data.sessions(W1)).unwrap().len(), 4);
    assert_eq!(block_on(data.sessions(W2)).unwrap().len(), 2);
    assert_eq!(
        block_on(data.sessions("wks_000000000000")).unwrap().len(),
        7
    );
    // A workspace with no saved strip answers the route's defaults.
    let mut f: Fixture = serde_json::from_str(BUILTIN).unwrap();
    f.open_tabs.clear();
    let empty = FixtureShellData::new(f);
    let d = block_on(empty.open_tabs(W1)).unwrap();
    assert_eq!(d, OpenTabs::default());
    assert_eq!(d.label_max_width, 180.);
    assert!(block_on(data.select_workspace("wks_000000000000")).is_err());
    assert!(block_on(data.create_session("wks_000000000000")).is_err());
    block_on(data.select_workspace(W3)).unwrap();
    let a = block_on(data.create_session(W2)).unwrap();
    let b = block_on(data.create_session(W2)).unwrap();
    assert_ne!(a, b);
    assert_eq!(block_on(data.sessions(W2)).unwrap().len(), 4);
    use futures::StreamExt as _;
    let got: Vec<ShellChange> = block_on(changes.by_ref().take(3).collect());
    assert_eq!(
        got,
        [
            ShellChange::Workspaces,
            ShellChange::Sessions {
                workspace_id: W2.into()
            },
            ShellChange::Sessions {
                workspace_id: W2.into()
            },
        ]
    );
    // A missing file is an error that names it.
    let err = FixtureShellData::from_path(std::path::Path::new("/nonexistent/shell.json"))
        .err()
        .unwrap();
    assert!(format!("{err:#}").contains("/nonexistent/shell.json"));
}

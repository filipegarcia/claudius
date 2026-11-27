//! The Files page (U12c) in the shell's headless window (`TestAppContext`,
//! CoreText) over the fixtures: the nav tile opens it, a pick replaces the
//! shell's URL (no history entry) and remembers the file in the store, a
//! delete forgets it, the remembered file reopens on the next visit, and
//! "← Chat" goes to the chat. macOS (the CoreText text system).

#![cfg(target_os = "macos")]

use std::sync::Arc;

use claudius_app::data::ShellData;
use claudius_app::fixture::FixtureShellData;
use claudius_app::route::{Route, WorkspacePage};
use claudius_app::shell::{Appearance, Shell};
use claudius_files::FilesData;
use claudius_files::fixture::FixtureFilesData;
use claudius_gpui_theme::ThemeName;
use gpui::{
    AppContext as _, Entity, Modifiers, TestAppContext, TestDispatcher, VisualTestContext,
    WindowOptions, px, size,
};
use gpui_apple::AppleTextSystem;

const W1: &str = "wks_3f2a9c81d0e4";
const KEY: &str = "claudius.files.lastOpen.wks_3f2a9c81d0e4";

struct Ui {
    shell: Entity<Shell>,
    files: Arc<FixtureFilesData>,
    cx: VisualTestContext,
}

fn open(app: &mut TestAppContext) -> Ui {
    app.update(|cx| claudius_app::init(ThemeName::Dark, cx));
    let shell_data: Arc<dyn ShellData> = Arc::new(FixtureShellData::builtin());
    let files = Arc::new(FixtureFilesData::builtin());
    let data: Arc<dyn FilesData> = files.clone();
    let (handle, shell) = app
        .update(|cx| {
            gpui_kit::open_window(WindowOptions::default(), cx, |window, cx| {
                cx.new(|cx| Shell::new(shell_data, Appearance::Fixed(ThemeName::Dark), window, cx))
            })
        })
        .unwrap();
    let mut cx = VisualTestContext::from_window(handle, app);
    cx.simulate_resize(size(px(1440.), px(900.)));
    cx.update(|_, cx| shell.update(cx, |s, cx| s.set_files_data(data, cx)));
    let mut ui = Ui { shell, files, cx };
    ui.settle();
    ui
}

fn app() -> TestAppContext {
    TestAppContext::build_with_text_system(
        TestDispatcher::new(0),
        None,
        Arc::new(AppleTextSystem::new()),
    )
}

impl Ui {
    fn settle(&mut self) {
        for _ in 0..3 {
            self.cx.run_until_parked();
            self.cx.update(|window, cx| {
                window.refresh();
                window.draw(cx).clear(cx);
            });
        }
        self.cx.run_until_parked();
    }

    fn drawn(&mut self, selector: &'static str) -> bool {
        self.cx.debug_bounds(selector).is_some()
    }

    fn click(&mut self, selector: &'static str) {
        let b = self
            .cx
            .debug_bounds(selector)
            .unwrap_or_else(|| panic!("{selector} isn't on screen"));
        self.cx.simulate_click(b.center(), Modifiers::none());
        self.settle();
    }

    fn route(&mut self) -> Route {
        self.cx
            .read(|cx| self.shell.read(cx).state().route().clone())
    }

    fn stored(&mut self) -> Option<String> {
        self.cx
            .read(|cx| self.shell.read(cx).store().get(KEY).map(str::to_owned))
    }

    fn back(&mut self) {
        let shell = self.shell.clone();
        self.cx
            .update(|_, cx| shell.update(cx, |s, cx| s.update_state(cx, |st| st.back())));
        self.settle();
    }

    fn open_url(&mut self, url: &str) {
        let shell = self.shell.clone();
        self.cx
            .update(|_, cx| shell.update(cx, |s, cx| s.open_url(url, cx)));
        self.settle();
    }
}

fn files(path: Option<&str>) -> Route {
    Route::Workspace {
        id: W1.into(),
        page: WorkspacePage::Files {
            root: None,
            path: path.map(str::to_owned),
        },
    }
}

#[test]
fn the_files_tile_opens_the_page_and_a_pick_replaces_the_url() {
    let mut app = app();
    let mut ui = open(&mut app);
    let before = ui.route();
    ui.click("nav-nav.files");
    assert!(ui.drawn("files-screen"));
    assert_eq!(ui.route(), files(None));
    ui.click("files-row-README.md");
    assert_eq!(ui.route(), files(Some("README.md")));
    assert_eq!(
        ui.stored().as_deref(),
        Some("{\"root\":\"primary\",\"relPath\":\"README.md\"}")
    );
    // `router.replace`: Back leaves the page, not the pick.
    ui.back();
    assert_eq!(ui.route(), before);
}

#[test]
fn a_delete_forgets_the_file_and_the_next_visit_reopens_the_remembered_one() {
    let mut app = app();
    let mut ui = open(&mut app);
    ui.click("nav-nav.files");
    ui.click("files-row-docs/");
    ui.click("files-row-docs/notes.txt");
    ui.click("files-back");
    assert!(matches!(
        ui.route(),
        Route::Workspace {
            page: WorkspacePage::Chat { .. },
            ..
        }
    ));
    // Back on the page without `?path=`: the remembered file opens and
    // the URL names it.
    ui.open_url(&format!("/{W1}/files"));
    assert_eq!(ui.route(), files(Some("docs/notes.txt")));
    assert!(ui.drawn("files-open-path"));
    ui.click("files-delete");
    ui.click("files-dialog-ok");
    assert!(!ui.files.exists("primary", "docs/notes.txt"));
    assert_eq!(ui.stored(), None);
    assert!(ui.drawn("files-pick-a-file"));
}

#[test]
fn a_deep_link_opens_its_file() {
    let mut app = app();
    let mut ui = open(&mut app);
    ui.open_url(&format!("/{W1}/files?path=src%2Fmain.rs"));
    assert!(ui.drawn("files-editor-rust"));
    assert!(ui.drawn("files-row-src/main.rs"));
    assert_eq!(ui.route(), files(Some("src/main.rs")));
}

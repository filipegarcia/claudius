//! The Files screen in a headless GPUI window (`TestAppContext`, CoreText
//! for real glyph widths) over the in-memory fixture: clicks, typing and
//! keys go in as a user's would, and the fixture's request log and files
//! say what reached the "server". macOS (the CoreText text system).

#![cfg(target_os = "macos")]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use claudius_files::fixture::FixtureFilesData;
use claudius_files::model::{Pane, Request};
use claudius_files::view::RouteInfo;
use claudius_files::{FilesEvent, FilesScreen};
use claudius_gpui_theme::ThemeName;
use gpui::{
    Entity, Focusable as _, Modifiers, MouseButton, TestAppContext, TestDispatcher,
    VisualTestContext, px, size,
};
use gpui_apple::AppleTextSystem;

const WS: &str = "w1";
const ROOT: &str = "/Users/me/proj";
const MAIN: &str = "fn main() {\n    println!(\"hello\");\n}\n";

fn app() -> TestAppContext {
    let cx = TestAppContext::build_with_text_system(
        TestDispatcher::new(0),
        None,
        Arc::new(AppleTextSystem::new()),
    );
    cx.update(|cx| {
        gpui_kit::init(cx);
        claudius_gpui_theme::init(ThemeName::Dark, cx);
        claudius_files::view::bind(cx);
    });
    cx
}

fn demo() -> FixtureFilesData {
    FixtureFilesData::new(ROOT)
        .with_file("primary", "README.md", "# demo\nhello world\n")
        .with_file("primary", "src/main.rs", MAIN)
        .with_file("primary", "src/lib.rs", "pub mod tree;\n")
        .with_file("primary", "notes.txt", "Hello hello HELLO\nhello again\n")
        .with_file("primary", "r.txt", "a.b a+b (a [x\n")
        .with_binary("primary", "data/metrics.parquet", 482_113.0)
        .with_file("primary", ".env", "X=1\n")
}

type Events = Arc<Mutex<Vec<FilesEvent>>>;

struct Screen<'a> {
    view: Entity<FilesScreen>,
    cx: &'a mut VisualTestContext,
    data: Arc<FixtureFilesData>,
    events: Events,
}

fn info(root: Option<&str>, path: Option<&str>) -> RouteInfo {
    RouteInfo {
        on_files: true,
        workspace: Some((WS.into(), ROOT.into())),
        root: root.map(str::to_owned),
        path: path.map(str::to_owned),
        last_open: None,
        theme: ThemeName::Dark,
    }
}

fn open(app: &mut TestAppContext, data: FixtureFilesData) -> Screen<'_> {
    open_at(app, data, info(None, None))
}

fn open_at(app: &mut TestAppContext, data: FixtureFilesData, route: RouteInfo) -> Screen<'_> {
    let data = Arc::new(data);
    let shared: Arc<dyn claudius_files::FilesData> = data.clone();
    let (view, cx) = app.add_window_view(|window, cx| FilesScreen::new(shared, window, cx));
    cx.simulate_resize(size(px(1280.), px(820.)));
    let events: Events = Arc::default();
    let log = events.clone();
    cx.update(|_, cx| {
        cx.subscribe(&view, move |_, ev: &FilesEvent, _| {
            log.lock().unwrap().push(ev.clone());
        })
        .detach();
    });
    view.update_in(cx, |v, window, cx| {
        v.sync_route(route, window, cx);
        window.focus(&v.focus_handle(cx), cx);
    });
    let mut s = Screen {
        view,
        cx,
        data,
        events,
    };
    s.settle();
    s
}

impl Screen<'_> {
    /// Runs the tasks (answers, debounces), then draws.
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

    /// Past the debounces (200 / 250 ms).
    fn wait(&mut self) {
        self.cx.executor().advance_clock(Duration::from_millis(300));
        self.settle();
    }

    fn drawn(&mut self, selector: &str) -> bool {
        let s: &'static str = Box::leak(selector.to_owned().into_boxed_str());
        self.cx.debug_bounds(s).is_some()
    }

    fn click_with(&mut self, selector: &str, button: MouseButton) {
        let s: &'static str = Box::leak(selector.to_owned().into_boxed_str());
        let b = self
            .cx
            .debug_bounds(s)
            .unwrap_or_else(|| panic!("{selector} is drawn"));
        let at = b.center();
        if button == MouseButton::Left {
            self.cx.simulate_click(at, Modifiers::default());
        } else {
            self.cx
                .simulate_mouse_down(at, button, Modifiers::default());
            self.cx.simulate_mouse_up(at, button, Modifiers::default());
        }
        self.settle();
    }

    fn click(&mut self, selector: &str) {
        self.click_with(selector, MouseButton::Left);
    }

    fn keys(&mut self, k: &str) {
        self.cx.simulate_keystrokes(k);
        self.settle();
    }

    fn typed(&mut self, text: &str) {
        self.cx.simulate_input(text);
        self.settle();
    }

    fn page<T>(&mut self, f: impl FnOnce(&claudius_files::model::FilesPage) -> T) -> T {
        self.cx.update(|_, cx| f(self.view.read(cx).page()))
    }

    fn editor_text(&mut self) -> Option<String> {
        self.cx.update(|_, cx| {
            self.view
                .read(cx)
                .editor()
                .map(|e| e.read(cx).value().to_string())
        })
    }

    fn requests(&self) -> Vec<Request> {
        self.data.requests()
    }

    fn count(&self, f: impl Fn(&Request) -> bool) -> usize {
        self.requests().iter().filter(|r| f(r)).count()
    }

    fn events(&self) -> Vec<FilesEvent> {
        self.events.lock().unwrap().clone()
    }

    fn open_file(&mut self, rel: &str) {
        let mut at = 0;
        while let Some(i) = rel[at..].find('/') {
            let dir = format!("{}/", &rel[..at + i]);
            if !self.page(|p| p.trees[0].is_open(&dir)) {
                self.click(&format!("files-row-{dir}"));
            }
            at += i + 1;
        }
        self.click(&format!("files-row-{rel}"));
    }

    fn focus_editor(&mut self) {
        let lang = self
            .page(|p| claudius_files::rules::editor_language(&p.open.as_ref().unwrap().rel_path));
        self.click(&format!("files-editor-{lang}"));
    }
}

#[test]
fn the_tree_lists_the_root_folders_first_without_hidden_entries() {
    let mut app = app();
    let mut s = open(&mut app, demo());
    for row in ["data/", "src/", "README.md", "notes.txt"] {
        assert!(s.drawn(&format!("files-row-{row}")), "{row}");
    }
    assert!(!s.drawn("files-row-.env"));
    assert!(s.drawn("files-pick-a-file"));
}

#[test]
fn expanding_a_folder_loads_its_children_once() {
    let mut app = app();
    let mut s = open(&mut app, demo());
    let src = |r: &Request| matches!(r, Request::List { path, .. } if path == "src/");
    assert!(!s.drawn("files-row-src/main.rs"));
    s.click("files-row-src/");
    assert!(s.drawn("files-row-src/main.rs"));
    assert!(s.drawn("files-row-src/lib.rs"));
    assert_eq!(s.count(src), 1);
    // Redraws and other clicks don't list it again.
    s.click("files-row-README.md");
    s.settle();
    assert_eq!(s.count(src), 1);
    // Its chevron closes it.
    s.click("files-row-src/");
    assert!(!s.drawn("files-row-src/main.rs"));
    assert_eq!(s.count(src), 1);
}

#[test]
fn the_filter_lists_matching_files_across_folders() {
    let mut app = app();
    let mut s = open(&mut app, demo());
    s.click("files-search");
    s.typed("main");
    // FileTree.tsx:107 nothing is sent before the debounce.
    assert_eq!(s.count(|r| matches!(r, Request::Search { .. })), 0);
    s.wait();
    assert_eq!(
        s.requests().last(),
        Some(&Request::Search {
            root: None,
            q: "main".into()
        })
    );
    assert!(s.drawn("files-hit-src/main.rs"));
    assert!(!s.drawn("files-row-README.md"));
    s.click("files-hit-src/main.rs");
    assert_eq!(s.editor_text().as_deref(), Some(MAIN));
}

#[test]
fn opening_a_file_shows_it_in_the_highlighted_editor() {
    let mut app = app();
    let mut s = open(&mut app, demo());
    s.open_file("src/main.rs");
    assert!(s.drawn("files-open-path"));
    assert!(s.drawn("files-editor-rust"));
    assert_eq!(s.editor_text().as_deref(), Some(MAIN));
    let lang = s.cx.update(|_, cx| {
        s.view
            .read(cx)
            .editor()
            .map(|e| e.read(cx).language_name().to_string())
    });
    assert_eq!(lang.as_deref(), Some("rust"));
    assert_eq!(
        s.events(),
        vec![
            FilesEvent::ReplaceUrl("/w1/files?path=src%2Fmain.rs".into()),
            FilesEvent::Store {
                key: "claudius.files.lastOpen.w1".into(),
                value: Some("{\"root\":\"primary\",\"relPath\":\"src/main.rs\"}".into()),
            },
        ]
    );
    assert!(!s.drawn("files-dirty"));
}

#[test]
fn editing_marks_the_file_dirty_and_save_sends_the_ts_request() {
    let mut app = app();
    let mut s = open(&mut app, demo());
    s.open_file("notes.txt");
    s.focus_editor();
    s.keys("cmd-a");
    s.typed("rewritten\n");
    assert!(s.drawn("files-dirty"));
    assert!(s.page(|p| p.can_save()));
    s.click("files-save");
    assert!(s.requests().contains(&Request::Save {
        root: "primary".into(),
        rel: "notes.txt".into(),
        text: "rewritten\n".into()
    }));
    assert_eq!(
        s.data.text("primary", "notes.txt").as_deref(),
        Some("rewritten\n")
    );
    assert!(!s.drawn("files-dirty"));
}

#[test]
fn cmd_s_in_the_editor_saves() {
    let mut app = app();
    let mut s = open(&mut app, demo());
    s.open_file("README.md");
    s.focus_editor();
    s.keys("cmd-a");
    s.typed("# saved by keyboard\n");
    s.keys("cmd-s");
    assert_eq!(
        s.data.text("primary", "README.md").as_deref(),
        Some("# saved by keyboard\n")
    );
    assert!(!s.page(|p| p.dirty));
}

#[test]
fn rename_moves_the_open_file() {
    let mut app = app();
    let mut s = open(&mut app, demo());
    s.open_file("notes.txt");
    s.click("files-rename");
    assert!(s.drawn("files-dialog"));
    // The prompt's default is the path, selected: typing replaces it.
    s.typed("docs/notes.md");
    s.keys("enter");
    assert!(!s.drawn("files-dialog"));
    assert!(s.data.exists("primary", "docs/notes.md"));
    assert!(!s.data.exists("primary", "notes.txt"));
    assert_eq!(
        s.page(|p| p.open.as_ref().map(|o| o.rel_path.clone())),
        Some("docs/notes.md".into())
    );
    assert!(s.events().contains(&FilesEvent::ReplaceUrl(
        "/w1/files?path=docs%2Fnotes.md".into()
    )));
    // The tree remounted and shows the new folder.
    assert!(s.drawn("files-row-docs/"));
}

#[test]
fn new_file_creates_and_opens_it_and_new_folder_creates_it() {
    let mut app = app();
    let mut s = open(&mut app, demo());
    s.click("files-new-file");
    assert!(s.drawn("files-dialog-input"));
    s.typed("todo.md");
    s.click("files-dialog-ok");
    assert!(s.requests().contains(&Request::Create {
        root: "primary".into(),
        path: "todo.md".into(),
        kind: claudius_files::rules::NewKind::File
    }));
    assert_eq!(
        s.page(|p| p.open.as_ref().map(|o| o.rel_path.clone())),
        Some("todo.md".into())
    );
    assert_eq!(s.page(|p| p.busy), None);
    assert!(s.drawn("files-row-todo.md"));
    s.click("files-new-folder");
    s.typed("assets");
    s.keys("enter");
    assert!(s.data.exists("primary", "assets"));
    assert!(s.drawn("files-row-assets/"));
}

#[test]
fn cancel_leaves_everything_as_it_was() {
    let mut app = app();
    let mut s = open(&mut app, demo());
    s.open_file("notes.txt");
    s.click("files-delete");
    assert!(s.drawn("files-dialog"));
    s.click("files-dialog-cancel");
    assert!(!s.drawn("files-dialog"));
    assert!(s.data.exists("primary", "notes.txt"));
    s.click("files-delete");
    s.click("files-dialog-ok");
    assert!(!s.data.exists("primary", "notes.txt"));
    assert!(s.drawn("files-pick-a-file"));
}

#[test]
fn find_in_file_moves_between_matches() {
    let mut app = app();
    let mut s = open(&mut app, demo());
    s.open_file("notes.txt");
    s.focus_editor();
    s.keys("cmd-f");
    assert!(s.drawn("files-find-in-file"));
    s.typed("hello");
    let state = |s: &mut Screen| {
        s.page(|p| {
            (
                p.find_matches().len(),
                p.find.as_ref().unwrap().active,
                p.active_match().map(|m| (m.start, m.end)),
            )
        })
    };
    assert_eq!(state(&mut s), (4, 0, Some((0, 5))));
    let selected = |s: &mut Screen| {
        s.cx.update(|_, cx| {
            s.view
                .read(cx)
                .editor()
                .map(|e| e.read(cx).selected_range())
        })
    };
    assert_eq!(selected(&mut s), Some(0..5));
    s.keys("enter");
    assert_eq!(state(&mut s), (4, 1, Some((6, 11))));
    assert_eq!(selected(&mut s), Some(6..11));
    s.click("files-find-next");
    s.click("files-find-next");
    assert_eq!(state(&mut s).1, 3);
    s.click("files-find-next");
    assert_eq!(state(&mut s).1, 0, "wraps");
    // The arrows took the focus (a button's, in the TS): back in the box.
    s.click("files-find-input");
    s.keys("shift-enter");
    assert_eq!(state(&mut s).1, 3, "back wraps");
    s.click("files-find-case");
    assert_eq!(state(&mut s), (2, 0, Some((6, 11))));
    s.keys("escape");
    assert!(!s.drawn("files-find-in-file"));
}

#[test]
fn find_in_file_takes_regex_characters_literally() {
    // FindInFile.tsx has no regex mode: `(a` and `[x` are text, never a
    // pattern (and so never "a bad regex").
    let mut app = app();
    let mut s = open(&mut app, demo());
    s.open_file("r.txt");
    s.click("files-find-button");
    s.typed("(a");
    assert_eq!(s.page(|p| p.find_matches().len()), 1);
    s.keys("cmd-a");
    s.typed("[x");
    assert_eq!(s.page(|p| p.find_matches().len()), 1);
    s.keys("cmd-a");
    s.typed("a.b");
    assert_eq!(s.page(|p| p.find_matches().len()), 1);
}

#[test]
fn find_in_folder_lists_hits_and_opens_one_at_its_line() {
    let mut app = app();
    let mut s = open(&mut app, demo());
    s.keys("cmd-shift-f");
    assert!(s.drawn("files-find-in-folder"));
    s.typed("println");
    assert_eq!(s.count(|r| matches!(r, Request::ContentSearch { .. })), 0);
    s.wait();
    assert_eq!(
        s.requests().last(),
        Some(&Request::ContentSearch {
            root: "primary".into(),
            folder: "".into(),
            q: "println".into(),
            case_sensitive: false
        })
    );
    assert!(s.drawn("files-folder-file-src/main.rs"));
    assert!(s.drawn("files-folder-hit-0"));
    s.click("files-folder-hit-0");
    assert!(!s.drawn("files-find-in-folder"));
    assert_eq!(s.editor_text().as_deref(), Some(MAIN));
    let line = s.cx.update(|_, cx| {
        s.view
            .read(cx)
            .editor()
            .map(|e| e.read(cx).cursor_position().line)
    });
    assert_eq!(line, Some(1), "the caret on line 2");
}

#[test]
fn find_in_folder_says_when_nothing_matches() {
    let mut app = app();
    let mut s = open(&mut app, demo());
    s.click("files-find-folder");
    s.typed("zzz-nothing");
    s.wait();
    assert!(s.drawn("files-folder-none"));
    assert_eq!(
        s.page(|p| p.folder_find.as_ref().unwrap().status()),
        "No matches"
    );
    s.keys("escape");
    assert!(!s.drawn("files-find-in-folder"));
}

#[test]
fn a_folder_s_context_menu_finds_in_it_and_a_file_s_reveals_it() {
    let mut app = app();
    let mut s = open(&mut app, demo());
    s.click_with("files-row-README.md", MouseButton::Right);
    assert!(s.drawn("file-path-context-menu"));
    assert!(!s.drawn("files-menu-find"), "files have no find in folder");
    s.click("files-menu-reveal");
    assert!(!s.drawn("file-path-context-menu"));
    assert!(s.requests().contains(&Request::Reveal {
        root: None,
        rel: "README.md".into()
    }));
    s.click_with("files-row-src/", MouseButton::Right);
    s.click("files-menu-find");
    assert!(s.drawn("files-find-in-folder"));
    s.typed("pub");
    s.wait();
    assert_eq!(
        s.requests().last(),
        Some(&Request::ContentSearch {
            root: "primary".into(),
            folder: "src/".into(),
            q: "pub".into(),
            case_sensitive: false
        })
    );
    assert!(s.drawn("files-folder-file-src/lib.rs"));
}

#[test]
fn escape_closes_the_context_menu() {
    let mut app = app();
    let mut s = open(&mut app, demo());
    s.click_with("files-row-README.md", MouseButton::Right);
    assert!(s.drawn("file-path-context-menu"));
    s.keys("escape");
    assert!(!s.drawn("file-path-context-menu"));
}

#[test]
fn a_binary_file_shows_the_placeholder_and_save_is_off() {
    let mut app = app();
    let mut s = open(&mut app, demo());
    s.open_file("data/metrics.parquet");
    assert!(s.drawn("files-binary-placeholder"));
    assert!(!s.drawn("files-editor-text"));
    assert_eq!(s.page(|p| p.pane()), Pane::Binary);
    assert!(!s.page(|p| p.can_save()));
    let saves = |r: &Request| matches!(r, Request::Save { .. });
    s.click("files-save");
    assert_eq!(s.count(saves), 0);
}

#[test]
fn an_error_shows_as_the_ts_text() {
    let mut app = app();
    let data = demo();
    data.fail("read", "README.md", "File too large to edit (3.1 MB)");
    let mut s = open(&mut app, data);
    s.click("files-row-README.md");
    assert!(s.drawn("files-error"));
    assert_eq!(
        s.page(|p| p.error.clone()).as_deref(),
        Some("File too large to edit (3.1 MB)")
    );
    // A tree error is the tree's own.
    let mut app2 = self::app();
    let data = demo();
    data.fail("list", "", "Failed to fetch");
    let mut s = open(&mut app2, data);
    assert!(s.drawn("file-tree-error"));
}

#[test]
fn the_roots_switcher_draws_a_group_per_root() {
    let mut app = app();
    let data = demo()
        .with_root("extra:0", "/Users/me/shared", "settings")
        .with_file("extra:0", "lib/util.ts", "export const x = 1;\n");
    let mut s = open(&mut app, data);
    assert!(s.drawn("files-group-primary"));
    assert!(s.drawn("files-group-extra:0"));
    assert!(s.drawn("files-extra-roots"));
    assert!(s.drawn("files-row-README.md"));
    assert!(!s.drawn("files-row-lib/"));
    s.click("files-group-extra:0");
    assert!(s.drawn("files-row-lib/"));
    s.click("files-row-lib/");
    s.click("files-row-lib/util.ts");
    assert_eq!(
        s.page(|p| p
            .open
            .as_ref()
            .map(|o| (o.root.clone(), o.rel_path.clone()))),
        Some(("extra:0".into(), "lib/util.ts".into()))
    );
    assert!(s.events().contains(&FilesEvent::ReplaceUrl(
        "/w1/files?path=lib%2Futil.ts&root=extra%3A0".into()
    )));
    s.click("files-group-primary");
    assert!(!s.drawn("files-row-README.md"));
}

#[test]
fn a_deep_link_opens_its_file_and_back_to_chat_is_a_link() {
    let mut app = app();
    let mut s = open_at(&mut app, demo(), info(None, Some("src/main.rs")));
    assert_eq!(s.editor_text().as_deref(), Some(MAIN));
    assert!(s.drawn("files-row-src/main.rs"), "the tree walked to it");
    s.click("files-back");
    assert_eq!(s.events().last(), Some(&FilesEvent::OpenUrl("/".into())));
}

#[test]
fn leaving_the_route_unmounts_and_coming_back_mounts_again() {
    let mut app = app();
    let mut s = open(&mut app, demo());
    s.open_file("README.md");
    let away = RouteInfo {
        on_files: false,
        ..info(None, None)
    };
    s.view
        .update_in(s.cx, |v, window, cx| v.sync_route(away, window, cx));
    s.settle();
    assert!(s.page(|p| p.open.is_none()));
    let roots = |r: &Request| matches!(r, Request::Roots);
    assert_eq!(s.count(roots), 1);
    s.view.update_in(s.cx, |v, window, cx| {
        v.sync_route(info(None, None), window, cx)
    });
    s.settle();
    assert_eq!(s.count(roots), 2);
}

#[test]
fn the_editor_paints_on_the_palette_s_background() {
    // HighlightedEditor.tsx paints on `var(--background)`: on a light
    // palette the code editor isn't the chat block's black.
    let mut app = app();
    let route = RouteInfo {
        theme: ThemeName::Light,
        ..info(None, None)
    };
    let mut s = open_at(&mut app, demo(), route);
    s.open_file("README.md");
    let bg = s.cx.update(|_, cx| {
        gpui_kit::component::Theme::global(cx)
            .highlight_theme
            .style
            .editor_background
    });
    let want = claudius_gpui_theme::hsla(
        claudius_theme::Theme::of(ThemeName::Light)
            .palette
            .background,
    );
    assert_eq!(bg, Some(want));
}

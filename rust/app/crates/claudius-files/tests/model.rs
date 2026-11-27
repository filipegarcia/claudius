//! The page's rules ([`FilesPage`]), each test named after one, over the
//! in-memory fixture: the effects a handler returns, and (through [`Run`],
//! which answers each request from the fixture and replaces the URL as the
//! shell does) where the page ends up.

use std::collections::BTreeMap;

use claudius_files::FilesData;
use claudius_files::data::{ContentSearch, Listing};
use claudius_files::fixture::FixtureFilesData;
use claudius_files::model::{
    Answer, Busy, Call, Dialog, Effect, FOLDER_SEARCH_DEBOUNCE_MS, FilesPage, Pane, Request,
    TREE_SEARCH_DEBOUNCE_MS, Timer, TreeBody, TreeRow,
};
use claudius_files::rules::{ContentMatch, KeyEvent, NewKind};
use futures::executor::block_on;

const WS: &str = "w1";
const ROOT: &str = "/Users/me/proj";

fn ws() -> Option<(String, String)> {
    Some((WS.into(), ROOT.into()))
}

fn demo() -> FixtureFilesData {
    FixtureFilesData::new(ROOT)
        .with_file("primary", "README.md", "# demo\nhello world\n")
        .with_file(
            "primary",
            "src/main.rs",
            "fn main() {\n    println!(\"hello\");\n}\n",
        )
        .with_file("primary", "src/deep/inner.rs", "pub fn inner() {}\n")
        .with_file("primary", "notes.txt", "Hello hello HELLO\n")
        .with_binary("primary", "data/blob.parquet", 482_113.0)
        .with_dir("primary", "empty")
        .with_file("primary", ".env", "SECRET=1\n")
        .with_dir("primary", "node_modules")
}

fn two_roots() -> FixtureFilesData {
    demo()
        .with_root("extra:0", "/Users/me/shared/", "settings")
        .with_file("extra:0", "lib/util.ts", "export const x = 1;\n")
}

/// Answers a request from the fixture, as the view does from its data.
fn answer(data: &FixtureFilesData, req: Request) -> Answer {
    match req {
        Request::Roots => Answer::Roots(block_on(data.roots(WS))),
        Request::List { root, path } => {
            Answer::Listing(block_on(data.list(WS, root.as_deref(), &path)))
        }
        Request::Search { root, q } => {
            Answer::Search(block_on(data.search(WS, root.as_deref(), &q)))
        }
        Request::Read { root, rel } => Answer::File(block_on(data.read(WS, &root, &rel))),
        Request::Save { root, rel, text } => {
            Answer::Done(block_on(data.save(WS, &root, &rel, &text)))
        }
        Request::Delete { root, rel } => Answer::Done(block_on(data.delete(WS, &root, &rel))),
        Request::Rename { root, rel, next } => {
            Answer::Done(block_on(data.rename(WS, &root, &rel, &next)))
        }
        Request::Create { root, path, kind } => {
            Answer::Done(block_on(data.create(WS, &root, &path, kind)))
        }
        Request::ContentSearch {
            root,
            folder,
            q,
            case_sensitive,
        } => Answer::ContentSearch(block_on(data.content_search(
            WS,
            &root,
            &folder,
            &q,
            case_sensitive,
        ))),
        Request::Reveal { root, rel } => {
            Answer::Done(block_on(data.reveal(WS, root.as_deref(), &rel)))
        }
        Request::Image { root, rel } => Answer::Image(block_on(data.image(WS, &root, &rel))),
    }
}

fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let h = u8::from_str_radix(&s[i + 1..i + 3], 16).expect("hex");
            out.push(h);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).expect("utf-8")
}

/// `?path=&root=` of a page URL, as the shell's route reads it.
fn query(url: &str) -> (Option<String>, Option<String>) {
    let q = url.split_once('?').map_or("", |(_, q)| q);
    let mut root = None;
    let mut path = None;
    for pair in q.split('&') {
        match pair.split_once('=') {
            Some(("root", v)) => root = Some(decode(v)),
            Some(("path", v)) => path = Some(decode(v)),
            _ => {}
        }
    }
    (root, path)
}

/// The page over the fixture, with what the shell would do for it.
struct Run {
    page: FilesPage,
    data: FixtureFilesData,
    urls: Vec<String>,
    links: Vec<String>,
    store: BTreeMap<String, String>,
    timers: Vec<(Timer, u64)>,
    held: Vec<(Call, Request)>,
    hold: bool,
}

impl Run {
    fn new(data: FixtureFilesData) -> Run {
        Run {
            page: FilesPage::new(),
            data,
            urls: Vec::new(),
            links: Vec::new(),
            store: BTreeMap::new(),
            timers: Vec::new(),
            held: Vec::new(),
            hold: false,
        }
    }

    fn mounted(data: FixtureFilesData) -> Run {
        let mut r = Run::new(data);
        r.mount(None, None);
        r
    }

    fn mount(&mut self, root: Option<&str>, path: Option<&str>) {
        let stored = self
            .store
            .get(&format!("claudius.files.lastOpen.{WS}"))
            .cloned();
        let fx = self.page.mount(
            ws(),
            root.map(str::to_owned),
            path.map(str::to_owned),
            stored.as_deref(),
        );
        self.go(fx);
    }

    /// Runs effects until none is left (timers wait for [`Run::fire`]).
    fn go(&mut self, fx: Vec<Effect>) {
        let mut queue: std::collections::VecDeque<Effect> = fx.into();
        while let Some(e) = queue.pop_front() {
            match e {
                Effect::Send(call, req) => {
                    if self.hold {
                        self.held.push((call, req));
                        continue;
                    }
                    let a = answer(&self.data, req);
                    queue.extend(self.page.answered(call, a));
                }
                Effect::Timer(t, ms) => self.timers.push((t, ms)),
                Effect::ReplaceUrl(url) => {
                    let (root, path) = query(&url);
                    self.urls.push(url);
                    queue.extend(self.page.set_url(root, path));
                }
                Effect::OpenUrl(url) => self.links.push(url),
                Effect::Store { key, value } => match value {
                    Some(v) => {
                        self.store.insert(key, v);
                    }
                    None => {
                        self.store.remove(&key);
                    }
                },
            }
        }
    }

    fn act(&mut self, f: impl FnOnce(&mut FilesPage) -> Vec<Effect>) {
        let fx = f(&mut self.page);
        self.go(fx);
    }

    /// Fires every pending debounce, in order.
    fn fire(&mut self) {
        while !self.timers.is_empty() {
            let timers = std::mem::take(&mut self.timers);
            for (t, _) in timers {
                let fx = self.page.timer_fired(t);
                self.go(fx);
            }
        }
    }

    fn tree(&self) -> u64 {
        self.page.trees[0].id
    }

    fn click(&mut self, rel: &str) {
        let tree = self.tree();
        self.act(|p| p.click_row(tree, rel));
    }

    fn requests(&self) -> Vec<Request> {
        self.data.requests()
    }

    fn row_paths(&self) -> Vec<(usize, String)> {
        self.page.trees[0]
            .rows()
            .into_iter()
            .map(|r| match r {
                TreeRow::Entry { depth, entry } => (depth, entry.rel_path.clone()),
                TreeRow::Empty {
                    depth,
                    error,
                    hidden,
                } => (depth, format!("<empty {} {hidden}>", error.unwrap_or("-"))),
            })
            .collect()
    }
}

fn list(root: Option<&str>, path: &str) -> Request {
    Request::List {
        root: root.map(str::to_owned),
        path: path.into(),
    }
}

fn read(root: &str, rel: &str) -> Request {
    Request::Read {
        root: root.into(),
        rel: rel.into(),
    }
}

fn key(key: &str, meta: bool, ctrl: bool, shift: bool, alt: bool) -> KeyEvent {
    KeyEvent {
        key: key.into(),
        code: format!("Key{}", key.to_ascii_uppercase()),
        meta,
        ctrl,
        shift,
        alt,
    }
}

// ---- mounting ---------------------------------------------------------------

#[test]
fn mounting_reads_the_roots_and_lists_the_root_page_tsx_108_file_tree_tsx_146() {
    let mut page = FilesPage::new();
    let fx = page.mount(ws(), None, None, None);
    let tree = page.trees[0].id;
    assert_eq!(
        fx,
        vec![
            Effect::Send(Call::Roots { mount: 1 }, Request::Roots),
            Effect::Send(Call::TreeRoot { tree }, list(None, "")),
        ]
    );
    assert_eq!(page.pathname, "/w1/files");
    assert_eq!(page.trees[0].body(""), TreeBody::Loading);
}

#[test]
fn no_workspace_mounts_nothing_page_tsx_394() {
    let mut page = FilesPage::new();
    assert!(page.mount(None, None, Some("p".into()), None).is_empty());
    assert!(page.trees.is_empty());
    assert!(page.save().is_empty());
    page.ask_create(NewKind::File);
    assert_eq!(page.dialog, None);
}

#[test]
fn a_single_root_page_draws_one_tree_without_a_root_param_page_tsx_397() {
    let r = Run::mounted(demo());
    assert_eq!(r.page.trees.len(), 1);
    assert_eq!(r.page.trees[0].root, None);
    assert_eq!(r.requests(), vec![Request::Roots, list(None, "")]);
    // Folders first, hidden entries left out, sizes on files.
    assert_eq!(
        r.row_paths(),
        vec![
            (0, "data/".to_owned()),
            (0, "empty/".to_owned()),
            (0, "src/".to_owned()),
            (0, "README.md".to_owned()),
            (0, "notes.txt".to_owned()),
        ]
    );
    assert_eq!(r.page.trees[0].hidden_in.get(""), Some(&2.0));
}

#[test]
fn extra_roots_draw_a_group_each_and_only_primary_starts_open_page_tsx_70_421() {
    let r = Run::mounted(two_roots());
    assert_eq!(r.page.extra_roots().len(), 1);
    assert!(r.page.group_open("primary"));
    assert!(!r.page.group_open("extra:0"));
    let roots: Vec<_> = r.page.trees.iter().map(|t| t.root.clone()).collect();
    // The single-root tree made way for the primary group's own.
    assert_eq!(roots, vec![Some("primary".to_owned())]);
    assert!(r.requests().contains(&list(Some("primary"), "")));
}

#[test]
fn a_group_s_chevron_mounts_and_drops_its_tree_page_tsx_441() {
    let mut r = Run::mounted(two_roots());
    r.act(|p| p.toggle_group("extra:0"));
    assert_eq!(r.page.trees.len(), 2);
    assert!(r.requests().contains(&list(Some("extra:0"), "")));
    let extra = r.page.trees[1].id;
    r.act(|p| p.toggle_group("extra:0"));
    assert_eq!(r.page.trees.len(), 1);
    // A late answer for the dropped tree is ignored.
    let fx = r.page.answered(
        Call::TreeRoot { tree: extra },
        Answer::Listing(Ok(Listing::default())),
    );
    assert!(fx.is_empty());
    // Opened again, it loads again (a remount).
    let before = r.requests().len();
    r.act(|p| p.toggle_group("extra:0"));
    assert_eq!(r.requests()[before..], [list(Some("extra:0"), "")]);
}

#[test]
fn the_roots_read_soft_fails_to_the_primary_root_page_tsx_113() {
    let data = demo();
    data.fail("roots", "*", "boom");
    let r = Run::mounted(data);
    let roots = r.page.roots.clone().unwrap();
    assert_eq!(roots.len(), 1);
    assert_eq!(roots[0].id, "primary");
    assert_eq!(roots[0].abs_path, ROOT);
    assert_eq!(r.page.error, None);
}

#[test]
fn an_answer_for_an_earlier_mount_is_ignored() {
    let mut page = FilesPage::new();
    page.mount(ws(), None, None, None);
    page.mount(ws(), None, None, None);
    let fx = page.answered(Call::Roots { mount: 1 }, Answer::Roots(Ok(Vec::new())));
    assert!(fx.is_empty());
    assert_eq!(page.roots, None);
}

#[test]
fn a_root_listing_error_shows_as_the_tree_s_error_file_tree_tsx_160() {
    let data = demo();
    data.fail("list", "", "Not a directory");
    let r = Run::mounted(data);
    assert_eq!(r.page.trees[0].body(""), TreeBody::Error("Not a directory"));
}

#[test]
fn an_empty_root_says_how_many_entries_are_hidden_file_tree_tsx_302() {
    let r = Run::mounted(FixtureFilesData::new(ROOT).with_file("primary", ".env", "x"));
    assert_eq!(
        r.page.trees[0].body(""),
        TreeBody::Empty("No visible files \u{2014} 1 hidden item.".into())
    );
    let r = Run::mounted(FixtureFilesData::new(ROOT));
    assert_eq!(
        r.page.trees[0].body(""),
        TreeBody::Empty("This folder is empty.".into())
    );
}

// ---- the tree ---------------------------------------------------------------

#[test]
fn a_folder_click_loads_its_children_once_and_a_second_click_closes_it_file_tree_tsx_206() {
    let mut r = Run::mounted(demo());
    r.click("src/");
    assert_eq!(r.requests().last(), Some(&list(None, "src/")));
    assert_eq!(
        r.row_paths()[2..5],
        [
            (0, "src/".to_owned()),
            (1, "src/deep/".to_owned()),
            (1, "src/main.rs".to_owned()),
        ]
    );
    let n = r.requests().len();
    r.click("src/");
    assert_eq!(r.requests().len(), n, "closing sends nothing");
    assert!(!r.page.trees[0].is_open("src/"));
    r.click("src/");
    assert_eq!(r.requests().len(), n + 1, "reopening lists again");
}

#[test]
fn a_nested_folder_opens_under_its_parent() {
    let mut r = Run::mounted(demo());
    r.click("src/");
    r.click("src/deep/");
    assert!(r.row_paths().contains(&(2, "src/deep/inner.rs".to_owned())));
}

#[test]
fn an_empty_folder_shows_its_placeholder_row_file_tree_tsx_446() {
    let mut r = Run::mounted(demo());
    r.click("empty/");
    assert!(r.row_paths().contains(&(1, "<empty - 0>".to_owned())));
}

#[test]
fn a_folder_that_fails_to_list_shows_its_error_in_the_row_file_tree_tsx_222() {
    let data = demo();
    data.fail("list", "src/", "EACCES: permission denied");
    let mut r = Run::mounted(data);
    r.click("src/");
    assert!(
        r.row_paths()
            .contains(&(1, "<empty EACCES: permission denied 0>".to_owned()))
    );
    // Closing it clears the error.
    r.click("src/");
    assert!(r.page.trees[0].dir_errors.is_empty());
}

// ---- picking ----------------------------------------------------------------

#[test]
fn picking_a_file_opens_it_replaces_the_url_and_remembers_it_page_tsx_127_164() {
    let mut r = Run::mounted(demo());
    r.click("README.md");
    assert_eq!(r.requests().last(), Some(&read("primary", "README.md")));
    let open = r.page.open.as_ref().unwrap();
    assert_eq!(open.rel_path, "README.md");
    assert_eq!(r.page.draft, "# demo\nhello world\n");
    assert!(!r.page.dirty);
    assert_eq!(r.page.pane(), Pane::Text);
    assert_eq!(r.urls, vec!["/w1/files?path=README.md"]);
    assert_eq!(
        r.store
            .get("claudius.files.lastOpen.w1")
            .map(String::as_str),
        Some("{\"root\":\"primary\",\"relPath\":\"README.md\"}")
    );
    assert_eq!(r.page.trees[0].selected.as_deref(), Some("README.md"));
}

#[test]
fn a_failed_read_shows_the_ts_error_page_tsx_135() {
    let data = demo();
    data.fail("read", "README.md", "File too large to edit (3.1 MB)");
    let mut r = Run::mounted(data);
    r.click("README.md");
    assert_eq!(
        r.page.error.as_deref(),
        Some("File too large to edit (3.1 MB)")
    );
    assert_eq!(r.page.open, None);
    assert!(r.urls.is_empty());
}

#[test]
fn a_new_pick_clears_the_last_error_page_tsx_130() {
    let data = demo();
    data.fail("read", "README.md", "nope");
    let mut r = Run::mounted(data);
    r.click("README.md");
    assert!(r.page.error.is_some());
    r.click("notes.txt");
    assert_eq!(r.page.error, None);
}

#[test]
fn the_deep_link_opens_the_url_s_file_and_walks_the_tree_to_it_page_tsx_174_file_tree_tsx_178() {
    let mut r = Run::new(demo());
    r.mount(None, Some("src/deep/inner.rs"));
    assert!(r.requests().contains(&read("primary", "src/deep/inner.rs")));
    assert!(r.requests().contains(&list(None, "src")));
    assert!(r.requests().contains(&list(None, "src/deep")));
    assert!(r.page.trees[0].is_open("src/"));
    assert!(r.page.trees[0].is_open("src/deep/"));
    assert_eq!(
        r.page.trees[0].selected.as_deref(),
        Some("src/deep/inner.rs")
    );
    assert_eq!(r.page.open.as_ref().unwrap().rel_path, "src/deep/inner.rs");
}

#[test]
fn the_walk_stops_at_a_missing_folder_file_tree_tsx_196() {
    let mut r = Run::new(demo());
    r.mount(None, Some("gone/deeper/x.rs"));
    let lists: Vec<_> = r
        .requests()
        .into_iter()
        .filter(|q| matches!(q, Request::List { path, .. } if !path.is_empty()))
        .collect();
    assert_eq!(lists, vec![list(None, "gone")]);
    assert_eq!(r.page.error.as_deref(), Some("path not found"));
}

#[test]
fn the_deep_link_runs_once_per_mount_page_tsx_176() {
    let mut r = Run::new(demo());
    r.mount(None, Some("README.md"));
    let reads = |r: &Run| {
        r.requests()
            .iter()
            .filter(|q| matches!(q, Request::Read { .. }))
            .count()
    };
    assert_eq!(reads(&r), 1);
    r.act(|p| p.set_url(None, Some("notes.txt".into())));
    assert_eq!(reads(&r), 1, "a later URL doesn't open a file");
}

#[test]
fn an_extra_root_s_deep_link_opens_its_group_page_tsx_190() {
    let mut r = Run::new(two_roots());
    r.mount(Some("extra:0"), Some("lib/util.ts"));
    assert!(r.page.group_open("extra:0"));
    assert!(r.requests().contains(&read("extra:0", "lib/util.ts")));
    assert_eq!(r.urls, vec!["/w1/files?path=lib%2Futil.ts&root=extra%3A0"]);
    let extra = r
        .page
        .trees
        .iter()
        .find(|t| t.root.as_deref() == Some("extra:0"))
        .unwrap();
    assert_eq!(extra.selected.as_deref(), Some("lib/util.ts"));
    assert!(extra.is_open("lib/"));
}

#[test]
fn the_last_open_file_reopens_when_the_url_names_none() {
    let mut r = Run::mounted(demo());
    r.click("notes.txt");
    r.page = FilesPage::new();
    r.urls.clear();
    r.mount(None, None);
    assert_eq!(r.page.open.as_ref().unwrap().rel_path, "notes.txt");
    assert_eq!(r.urls, vec!["/w1/files?path=notes.txt"]);
}

#[test]
fn the_url_s_path_wins_over_the_last_open_file() {
    let mut r = Run::mounted(demo());
    r.click("notes.txt");
    r.mount(None, Some("README.md"));
    assert_eq!(r.page.open.as_ref().unwrap().rel_path, "README.md");
}

#[test]
fn a_malformed_last_open_entry_is_ignored_files_last_open_ts_36() {
    let mut r = Run::new(demo());
    r.store.insert(
        "claudius.files.lastOpen.w1".into(),
        "{\"root\":\"primary\"}".into(),
    );
    r.mount(None, None);
    assert_eq!(r.page.open, None);
}

#[test]
fn the_tree_highlights_the_url_s_path_until_a_file_opens_page_tsx_405() {
    let mut page = FilesPage::new();
    page.mount(ws(), None, Some("notes.txt".into()), None);
    assert_eq!(page.trees[0].selected.as_deref(), Some("notes.txt"));
}

// ---- the filename search ----------------------------------------------------

#[test]
fn the_search_waits_200ms_and_a_newer_query_supersedes_file_tree_tsx_107() {
    let mut r = Run::mounted(demo());
    let tree = r.tree();
    let fx = r.page.set_query("ma");
    assert_eq!(
        fx,
        vec![Effect::Timer(
            Timer::TreeSearch { tree, seq: 1 },
            TREE_SEARCH_DEBOUNCE_MS
        )]
    );
    r.go(fx);
    r.act(|p| p.set_query("main"));
    r.fire();
    let searches: Vec<_> = r
        .requests()
        .into_iter()
        .filter(|q| matches!(q, Request::Search { .. }))
        .collect();
    assert_eq!(
        searches,
        vec![Request::Search {
            root: None,
            q: "main".into()
        }]
    );
    match r.page.trees[0].body(&r.page.query) {
        TreeBody::Results { entries, truncated } => {
            assert_eq!(
                entries
                    .iter()
                    .map(|e| e.rel_path.as_str())
                    .collect::<Vec<_>>(),
                vec!["src/main.rs"]
            );
            assert!(!truncated);
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_search_sends_the_trimmed_query_and_blank_is_no_search_file_tree_tsx_64() {
    let mut r = Run::mounted(demo());
    r.act(|p| p.set_query("   "));
    assert!(r.timers.is_empty());
    r.act(|p| p.set_query("  notes "));
    r.fire();
    assert!(r.requests().contains(&Request::Search {
        root: None,
        q: "notes".into()
    }));
}

#[test]
fn searching_shows_searching_then_no_match_file_tree_tsx_240() {
    let mut r = Run::mounted(demo());
    r.act(|p| p.set_query("zzz"));
    assert_eq!(r.page.trees[0].body("zzz"), TreeBody::Searching);
    r.fire();
    assert_eq!(r.page.trees[0].body("zzz"), TreeBody::NoMatch);
}

#[test]
fn a_search_error_shows_with_no_results_file_tree_tsx_96() {
    let data = demo();
    data.fail("search", "x", "Search failed (HTTP 500)");
    let mut r = Run::mounted(data);
    r.act(|p| p.set_query("x"));
    r.fire();
    assert_eq!(
        r.page.trees[0].body("x"),
        TreeBody::SearchError("Search failed (HTTP 500)")
    );
}

#[test]
fn clearing_the_search_leaves_search_mode_file_tree_tsx_74() {
    let mut r = Run::mounted(demo());
    r.act(|p| p.set_query("main"));
    r.fire();
    r.act(|p| p.set_query(""));
    assert_eq!(r.page.trees[0].search_results, None);
    assert_eq!(r.page.trees[0].body(""), TreeBody::Rows);
}

#[test]
fn a_search_hit_opens_like_a_row_file_tree_tsx_255() {
    let mut r = Run::mounted(demo());
    r.act(|p| p.set_query("inner"));
    r.fire();
    let tree = r.tree();
    r.act(|p| p.click_result(tree, "src/deep/inner.rs"));
    assert_eq!(r.page.open.as_ref().unwrap().rel_path, "src/deep/inner.rs");
}

#[test]
fn searching_opens_every_group_and_searches_each_root_page_tsx_421() {
    let mut r = Run::mounted(two_roots());
    r.act(|p| p.set_query("util"));
    assert!(r.page.group_open("extra:0"));
    assert_eq!(r.page.trees.len(), 2);
    r.fire();
    assert!(r.requests().contains(&Request::Search {
        root: Some("extra:0".into()),
        q: "util".into()
    }));
    r.act(|p| p.set_query(""));
    assert_eq!(r.page.trees.len(), 1, "the toggled state comes back");
}

// ---- editing and saving -----------------------------------------------------

#[test]
fn an_edit_marks_the_file_dirty_and_typing_it_back_clears_it_page_tsx_565() {
    let mut r = Run::mounted(demo());
    r.click("notes.txt");
    r.page.edit("changed\n");
    assert!(r.page.dirty);
    assert!(r.page.can_save());
    r.page.edit("Hello hello HELLO\n");
    assert!(!r.page.dirty);
    assert!(!r.page.can_save());
}

#[test]
fn save_puts_the_draft_and_refreshes_the_tree_page_tsx_201() {
    let mut r = Run::mounted(demo());
    r.click("notes.txt");
    r.page.edit("new text\n");
    let fx = r.page.save();
    assert_eq!(r.page.busy, Some(Busy::Save));
    assert_eq!(
        fx,
        vec![Effect::Send(
            Call::Save { mount: 1 },
            Request::Save {
                root: "primary".into(),
                rel: "notes.txt".into(),
                text: "new text\n".into()
            }
        )]
    );
    let key = r.page.refresh_key;
    let tree = r.tree();
    r.go(fx);
    assert_eq!(
        r.data.text("primary", "notes.txt").as_deref(),
        Some("new text\n")
    );
    assert!(!r.page.dirty);
    assert_eq!(r.page.busy, None);
    assert_eq!(r.page.refresh_key, key + 1);
    assert_ne!(r.tree(), tree, "the tree remounted");
}

#[test]
fn the_save_button_is_off_while_a_request_runs_page_tsx_531() {
    let mut r = Run::mounted(demo());
    r.click("notes.txt");
    r.page.edit("new text\n");
    assert!(r.page.can_save());
    let fx = r.page.save();
    assert!(r.page.dirty, "still dirty until the answer");
    assert!(!r.page.can_save(), "busy: the button is disabled");
    r.go(fx);
    r.page.edit("newer\n");
    assert!(r.page.can_save());
}

#[test]
fn a_failed_save_keeps_the_draft_dirty_and_shows_the_error_page_tsx_210() {
    let data = demo();
    data.fail(
        "save",
        "notes.txt",
        "EACCES: permission denied, open 'notes.txt'",
    );
    let mut r = Run::mounted(data);
    r.click("notes.txt");
    r.page.edit("x");
    r.act(|p| p.save());
    assert!(r.page.dirty);
    assert_eq!(r.page.busy, None);
    assert_eq!(
        r.page.error.as_deref(),
        Some("EACCES: permission denied, open 'notes.txt'")
    );
}

#[test]
fn cmd_s_saves_even_a_clean_file_page_tsx_572() {
    let mut r = Run::mounted(demo());
    r.click("notes.txt");
    assert!(!r.page.dirty);
    let fx = r.page.editor_key(&key("s", true, false, false, false));
    assert!(matches!(
        fx.as_deref(),
        Some([Effect::Send(Call::Save { .. }, _)])
    ));
    // Ctrl too; not with Shift or Alt, nor another letter.
    assert!(
        r.page
            .editor_key(&key("s", false, true, false, false))
            .is_some()
    );
    assert!(
        r.page
            .editor_key(&key("s", true, false, true, false))
            .is_none()
    );
    assert!(
        r.page
            .editor_key(&key("s", true, false, false, true))
            .is_none()
    );
    assert!(
        r.page
            .editor_key(&key("d", true, false, false, false))
            .is_none()
    );
    assert!(
        r.page
            .editor_key(&key("s", false, false, false, false))
            .is_none()
    );
}

#[test]
fn cmd_s_matches_the_physical_key_under_a_non_latin_layout_key_match_ts_18() {
    let mut r = Run::mounted(demo());
    r.click("notes.txt");
    let e = KeyEvent {
        key: "\u{44b}".into(),
        code: "KeyS".into(),
        meta: true,
        ..KeyEvent::default()
    };
    assert!(r.page.editor_key(&e).is_some());
}

#[test]
fn a_read_only_file_never_saves_page_tsx_199() {
    let data = demo().with_encoded("primary", "sjis.txt", "?", "unsupported", "Shift_JIS");
    let mut r = Run::mounted(data);
    r.click("sjis.txt");
    assert!(r.page.read_only());
    r.page.edit("cafe");
    assert!(!r.page.can_save());
    assert!(r.page.save().is_empty());
    assert!(
        r.page
            .editor_key(&key("s", true, false, false, false))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_file_in_another_encoding_saves_back_in_it_page_tsx_501() {
    let data = demo().with_encoded("primary", "latin.txt", "caf\u{e9}", "latin1", "Latin-1");
    let mut r = Run::mounted(data);
    r.click("latin.txt");
    assert!(!r.page.read_only());
    r.page.edit("cafe");
    assert!(r.page.can_save());
}

#[test]
fn a_binary_file_shows_the_placeholder_and_never_saves_page_tsx_540() {
    let mut r = Run::mounted(demo());
    r.click("data/");
    r.click("data/blob.parquet");
    assert_eq!(r.page.pane(), Pane::Binary);
    assert!(r.page.read_only());
    assert!(r.page.save().is_empty());
}

#[test]
fn a_binary_image_shows_its_picture_once_read() {
    let data = demo().with_binary("primary", "logo.png", 4.0).with_image(
        "primary",
        "logo.png",
        vec![1, 2, 3, 4],
        "image/png",
    );
    let mut r = Run::mounted(data);
    r.click("logo.png");
    assert!(r.requests().contains(&Request::Image {
        root: "primary".into(),
        rel: "logo.png".into()
    }));
    assert_eq!(r.page.pane(), Pane::Image);
    assert_eq!(r.page.image, Some((vec![1, 2, 3, 4], "image/png".into())));
}

#[test]
fn an_image_that_fails_to_load_stays_the_placeholder() {
    let data = demo().with_binary("primary", "logo.png", 4.0);
    let mut r = Run::mounted(data);
    r.click("logo.png");
    assert_eq!(r.page.pane(), Pane::Binary);
}

// ---- delete, rename, create -------------------------------------------------

#[test]
fn delete_asks_first_and_cancel_does_nothing_page_tsx_226() {
    let mut r = Run::mounted(demo());
    r.click("notes.txt");
    r.page.ask_delete();
    assert_eq!(
        r.page.dialog,
        Some(Dialog::Delete {
            question: "Delete notes.txt? This cannot be undone.".into()
        })
    );
    r.page.cancel_dialog();
    assert_eq!(r.page.dialog, None);
    assert!(r.data.exists("primary", "notes.txt"));
}

#[test]
fn delete_clears_the_open_file_and_its_memory_page_tsx_237() {
    let mut r = Run::mounted(demo());
    r.click("notes.txt");
    r.page.ask_delete();
    r.act(|p| p.confirm_dialog(""));
    assert!(!r.data.exists("primary", "notes.txt"));
    assert_eq!(r.page.open, None);
    assert_eq!(r.page.pane(), Pane::Empty);
    assert!(!r.store.contains_key("claudius.files.lastOpen.w1"));
    // page.tsx doesn't touch the URL after a delete.
    assert_eq!(r.urls, vec!["/w1/files?path=notes.txt"]);
}

#[test]
fn rename_ignores_an_empty_or_unchanged_path_page_tsx_254() {
    let mut r = Run::mounted(demo());
    r.click("notes.txt");
    for v in ["", "notes.txt"] {
        r.page.ask_rename();
        assert!(r.page.confirm_dialog(v).is_empty(), "{v:?}");
        assert_eq!(r.page.dialog, None);
    }
}

#[test]
fn rename_moves_the_file_the_url_and_the_memory_page_tsx_258_268() {
    let mut r = Run::mounted(demo());
    r.click("notes.txt");
    r.page.ask_rename();
    assert_eq!(
        r.page.dialog,
        Some(Dialog::Rename {
            default: "notes.txt".into()
        })
    );
    r.act(|p| p.confirm_dialog("docs/notes.md"));
    assert!(r.data.exists("primary", "docs/notes.md"));
    assert!(!r.data.exists("primary", "notes.txt"));
    assert_eq!(r.page.open.as_ref().unwrap().rel_path, "docs/notes.md");
    assert_eq!(
        r.urls.last().map(String::as_str),
        Some("/w1/files?path=docs%2Fnotes.md")
    );
    assert_eq!(
        r.store
            .get("claudius.files.lastOpen.w1")
            .map(String::as_str),
        Some("{\"root\":\"primary\",\"relPath\":\"docs/notes.md\"}")
    );
    assert_eq!(r.page.busy, None);
}

#[test]
fn a_failed_rename_shows_the_error_page_tsx_262() {
    let data = demo();
    data.fail("rename", "notes.txt", "Target exists");
    let mut r = Run::mounted(data);
    r.click("notes.txt");
    r.page.ask_rename();
    r.act(|p| p.confirm_dialog("README.md"));
    assert_eq!(r.page.error.as_deref(), Some("Target exists"));
    assert_eq!(r.page.open.as_ref().unwrap().rel_path, "notes.txt");
}

#[test]
fn the_create_prompt_defaults_beside_the_open_file_page_tsx_285() {
    let mut r = Run::mounted(demo());
    r.page.ask_create(NewKind::File);
    assert_eq!(
        r.page.dialog,
        Some(Dialog::Create {
            kind: NewKind::File,
            message: "New file path:",
            default: "untitled.md".into()
        })
    );
    r.page.cancel_dialog();
    r.click("src/");
    r.click("src/main.rs");
    r.page.ask_create(NewKind::Dir);
    assert_eq!(
        r.page.dialog,
        Some(Dialog::Create {
            kind: NewKind::Dir,
            message: "New folder path:",
            default: "src/newdir".into()
        })
    );
}

#[test]
fn a_new_file_opens_and_busy_lasts_until_it_has_page_tsx_294_305() {
    let mut r = Run::mounted(demo());
    r.page.ask_create(NewKind::File);
    let fx = r.page.confirm_dialog("src/new.rs");
    assert_eq!(r.page.busy, Some(Busy::Create));
    r.hold = true;
    r.go(fx);
    // The create answers: the tree refreshes and the pick goes out.
    let (call, req) = r.held.remove(0);
    let a = answer(&r.data, req);
    let fx = r.page.answered(call, a);
    assert_eq!(r.page.busy, Some(Busy::Create));
    r.hold = false;
    r.go(fx);
    for (call, req) in std::mem::take(&mut r.held) {
        let a = answer(&r.data, req);
        let fx = r.page.answered(call, a);
        r.go(fx);
    }
    assert_eq!(r.page.busy, None);
    assert_eq!(r.page.open.as_ref().unwrap().rel_path, "src/new.rs");
    assert_eq!(r.data.text("primary", "src/new.rs").as_deref(), Some(""));
}

#[test]
fn a_new_folder_only_refreshes_page_tsx_302() {
    let mut r = Run::mounted(demo());
    r.page.ask_create(NewKind::Dir);
    let key = r.page.refresh_key;
    r.act(|p| p.confirm_dialog("assets"));
    assert!(r.data.exists("primary", "assets"));
    assert_eq!(r.page.open, None);
    assert_eq!(r.page.busy, None);
    assert_eq!(r.page.refresh_key, key + 1);
}

#[test]
fn a_new_entry_goes_in_the_open_file_s_root_page_tsx_284() {
    let mut r = Run::new(two_roots());
    r.mount(Some("extra:0"), Some("lib/util.ts"));
    r.page.ask_create(NewKind::File);
    let fx = r.page.confirm_dialog("lib/more.ts");
    assert!(matches!(
        &fx[..],
        [Effect::Send(_, Request::Create { root, .. })] if root == "extra:0"
    ));
}

#[test]
fn a_failed_create_shows_the_error_and_frees_busy_page_tsx_298() {
    let data = demo();
    data.fail("create", "x.md", "Already exists");
    let mut r = Run::mounted(data);
    r.page.ask_create(NewKind::File);
    r.act(|p| p.confirm_dialog("x.md"));
    assert_eq!(r.page.error.as_deref(), Some("Already exists"));
    assert_eq!(r.page.busy, None);
}

// ---- find in file -----------------------------------------------------------

#[test]
fn find_in_file_opens_over_a_text_file_only() {
    let mut r = Run::mounted(demo());
    r.page.open_find();
    assert_eq!(r.page.find, None, "no file open");
    r.click("data/");
    r.click("data/blob.parquet");
    r.page.open_find();
    assert_eq!(r.page.find, None, "a binary");
    r.click("notes.txt");
    r.page.open_find();
    assert!(r.page.find.is_some());
}

#[test]
fn find_in_file_matches_case_insensitively_and_steps_round_find_in_file_tsx_48_123() {
    let mut r = Run::mounted(demo());
    r.click("notes.txt");
    r.page.open_find();
    r.page.set_find_query("hello");
    assert_eq!(r.page.find_matches().len(), 3);
    assert_eq!(
        r.page.active_match().map(|m| (m.start, m.end)),
        Some((0, 5))
    );
    r.page.find_step(true);
    r.page.find_step(true);
    assert_eq!(r.page.active_match().map(|m| m.start), Some(12));
    r.page.find_step(true);
    assert_eq!(r.page.find.as_ref().unwrap().active, 0, "wraps forward");
    r.page.find_step(false);
    assert_eq!(r.page.find.as_ref().unwrap().active, 2, "wraps back");
    r.page.toggle_find_case();
    assert_eq!(r.page.find_matches().len(), 1);
    assert_eq!(
        r.page.find.as_ref().unwrap().active,
        0,
        "clamped to the one match"
    );
}

#[test]
fn typing_a_new_query_goes_back_to_the_first_match_find_in_file_tsx_154() {
    let mut r = Run::mounted(demo());
    r.click("notes.txt");
    r.page.open_find();
    r.page.set_find_query("hel");
    r.page.find_step(true);
    r.page.set_find_query("hell");
    assert_eq!(r.page.find.as_ref().unwrap().active, 0);
}

#[test]
fn an_edit_that_drops_matches_clamps_the_active_one_find_in_file_tsx_69() {
    let mut r = Run::mounted(demo());
    r.click("notes.txt");
    r.page.open_find();
    r.page.set_find_query("hello");
    r.page.find_step(false);
    assert_eq!(r.page.find.as_ref().unwrap().active, 2);
    r.page.edit("hello hello\n");
    assert_eq!(r.page.find.as_ref().unwrap().active, 0);
    assert_eq!(r.page.find_matches().len(), 2);
}

#[test]
fn stepping_with_no_matches_does_nothing_find_in_file_tsx_124() {
    let mut r = Run::mounted(demo());
    r.click("notes.txt");
    r.page.open_find();
    r.page.set_find_query("zzz");
    let seq = r.page.find.as_ref().unwrap().reveal_seq;
    r.page.find_step(true);
    assert_eq!(r.page.find.as_ref().unwrap().reveal_seq, seq);
    assert_eq!(r.page.active_match(), None);
}

#[test]
fn a_regex_looking_query_is_a_literal_find_in_file_tsx_57() {
    let mut r =
        Run::mounted(FixtureFilesData::new(ROOT).with_file("primary", "r.txt", "a.b a+b (a"));
    r.click("r.txt");
    r.page.open_find();
    r.page.set_find_query("(a");
    assert_eq!(r.page.find_matches().len(), 1);
    r.page.set_find_query("a.b");
    assert_eq!(r.page.find_matches().len(), 1);
}

// ---- find in folder ---------------------------------------------------------

fn folder_searches(r: &Run) -> Vec<Request> {
    r.requests()
        .into_iter()
        .filter(|q| matches!(q, Request::ContentSearch { .. }))
        .collect()
}

#[test]
fn find_in_folder_waits_250ms_and_sends_the_trimmed_query_find_in_folder_tsx_84() {
    let mut r = Run::mounted(demo());
    r.page.open_root_folder_find();
    assert_eq!(r.page.pane(), Pane::FindInFolder);
    assert_eq!(r.page.folder_find.as_ref().unwrap().label, "Workspace root");
    let fx = r.page.set_folder_query(" hel");
    assert_eq!(
        fx,
        vec![Effect::Timer(
            Timer::FolderSearch { seq: 1 },
            FOLDER_SEARCH_DEBOUNCE_MS
        )]
    );
    r.go(fx);
    r.act(|p| p.set_folder_query(" hello "));
    r.fire();
    assert_eq!(
        folder_searches(&r),
        vec![Request::ContentSearch {
            root: "primary".into(),
            folder: "".into(),
            q: "hello".into(),
            case_sensitive: false
        }]
    );
    let f = r.page.folder_find.as_ref().unwrap();
    assert!(!f.loading);
    assert_eq!(
        f.grouped()
            .into_iter()
            .map(|(p, h)| (p, h.len()))
            .collect::<Vec<_>>(),
        vec![
            ("README.md".to_owned(), 1),
            ("notes.txt".to_owned(), 1),
            ("src/main.rs".to_owned(), 1)
        ]
    );
    assert_eq!(f.status(), "3 matches \u{b7} 3 files");
}

#[test]
fn the_case_toggle_searches_again_find_in_folder_tsx_190() {
    let mut r = Run::mounted(demo());
    r.page.open_root_folder_find();
    r.act(|p| p.set_folder_query("HELLO"));
    r.fire();
    r.act(|p| p.toggle_folder_case());
    r.fire();
    assert_eq!(folder_searches(&r).len(), 2);
    let f = r.page.folder_find.as_ref().unwrap();
    assert!(f.case_sensitive);
    assert_eq!(f.total(), 1);
}

#[test]
fn an_emptied_folder_query_resets_the_results_find_in_folder_tsx_69() {
    let mut r = Run::mounted(demo());
    r.page.open_root_folder_find();
    r.act(|p| p.set_folder_query("hello"));
    r.fire();
    r.act(|p| p.set_folder_query("  "));
    assert!(r.timers.is_empty());
    let f = r.page.folder_find.as_ref().unwrap();
    assert_eq!(f.matches, None);
    assert_eq!(f.status(), "");
}

#[test]
fn a_superseded_folder_search_answer_is_dropped_find_in_folder_tsx_114() {
    let mut page = FilesPage::new();
    page.mount(ws(), None, None, None);
    page.open_root_folder_find();
    page.set_folder_query("a");
    page.timer_fired(Timer::FolderSearch { seq: 1 });
    page.set_folder_query("ab");
    let stale = ContentSearch {
        matches: vec![ContentMatch {
            rel_path: "x".into(),
            line: 1.,
            col: 1.,
            col_end: 2.,
            text: "a".into(),
            truncated: false,
        }],
        truncated: false,
        scanned: 1.,
    };
    page.answered(
        Call::ContentSearch { seq: 1 },
        Answer::ContentSearch(Ok(stale)),
    );
    assert_eq!(page.folder_find.as_ref().unwrap().matches, None);
}

#[test]
fn a_folder_search_error_shows_and_lists_nothing_find_in_folder_tsx_100() {
    let data = demo();
    data.fail("content_search", "x", "Search failed (HTTP 400)");
    let mut r = Run::mounted(data);
    r.page.open_root_folder_find();
    r.act(|p| p.set_folder_query("x"));
    r.fire();
    let f = r.page.folder_find.as_ref().unwrap();
    assert_eq!(f.error.as_deref(), Some("Search failed (HTTP 400)"));
    assert_eq!(f.total(), 0);
    assert_eq!(f.status(), "");
}

#[test]
fn a_hit_opens_its_file_at_its_line_and_closes_the_panel_find_in_folder_tsx_264() {
    let mut r = Run::mounted(demo());
    r.page.open_root_folder_find();
    r.act(|p| p.set_folder_query("println"));
    r.fire();
    r.act(|p| p.pick_hit(0));
    assert_eq!(r.page.folder_find, None);
    assert_eq!(r.page.open.as_ref().unwrap().rel_path, "src/main.rs");
    assert_eq!(r.page.pending_line, Some(2));
    assert_eq!(r.page.pane(), Pane::Text);
}

#[test]
fn a_file_s_chevron_folds_its_hits_find_in_folder_tsx_243() {
    let mut r = Run::mounted(demo());
    r.page.open_root_folder_find();
    r.act(|p| p.set_folder_query("hello"));
    r.fire();
    r.page.toggle_folder_group("README.md");
    assert!(
        r.page
            .folder_find
            .as_ref()
            .unwrap()
            .collapsed
            .contains("README.md")
    );
    r.page.toggle_folder_group("README.md");
    assert!(r.page.folder_find.as_ref().unwrap().collapsed.is_empty());
}

#[test]
fn find_in_folder_over_a_folder_searches_under_it() {
    let mut r = Run::mounted(demo());
    let tree = r.tree();
    r.page.open_menu(tree, "src/", true, 10., 10.);
    r.page.menu_find_in_folder();
    assert_eq!(r.page.menu, None);
    let f = r.page.folder_find.as_ref().unwrap();
    assert_eq!(
        (f.folder.as_str(), f.label.as_str(), f.display()),
        ("src/", "src", "src")
    );
    r.act(|p| p.set_folder_query("fn"));
    r.fire();
    assert_eq!(
        folder_searches(&r),
        vec![Request::ContentSearch {
            root: "primary".into(),
            folder: "src/".into(),
            q: "fn".into(),
            case_sensitive: false
        }]
    );
    assert!(
        r.page
            .folder_find
            .as_ref()
            .unwrap()
            .grouped()
            .iter()
            .all(|(p, _)| p.starts_with("src/"))
    );
}

// ---- the context menu -------------------------------------------------------

#[test]
fn reveal_sends_the_row_s_path_and_closes_the_menu_file_path_context_menu_tsx_94() {
    let mut r = Run::mounted(demo());
    let tree = r.tree();
    r.page.open_menu(tree, "README.md", false, 40., 50.);
    let fx = r.page.reveal();
    assert_eq!(
        fx,
        vec![Effect::Send(
            Call::Reveal,
            Request::Reveal {
                root: None,
                rel: "README.md".into()
            }
        )]
    );
    assert!(r.page.menu.as_ref().unwrap().busy);
    assert!(r.page.reveal().is_empty(), "busy: one at a time");
    r.go(fx);
    assert_eq!(r.page.menu, None);
}

#[test]
fn a_failed_reveal_is_dropped_as_the_tree_passes_no_on_error_file_tree_tsx_339() {
    let data = demo();
    data.fail("reveal", "README.md", "no such file");
    let mut r = Run::mounted(data);
    let tree = r.tree();
    r.page.open_menu(tree, "README.md", false, 0., 0.);
    r.act(|p| p.reveal());
    assert_eq!(r.page.menu, None);
    assert_eq!(r.page.error, None);
}

#[test]
fn a_group_tree_reveals_with_its_root_only_while_searching_file_tree_tsx_283_339() {
    let mut r = Run::mounted(two_roots());
    r.act(|p| p.toggle_group("extra:0"));
    let extra = r.page.trees[1].id;
    r.page.open_menu(extra, "lib/util.ts", false, 0., 0.);
    assert!(matches!(
        &r.page.reveal()[..],
        [Effect::Send(_, Request::Reveal { root: None, .. })]
    ));
    r.page.close_menu();
    r.act(|p| p.set_query("util"));
    let extra = r
        .page
        .trees
        .iter()
        .find(|t| t.root.as_deref() == Some("extra:0"))
        .unwrap()
        .id;
    r.page.open_menu(extra, "lib/util.ts", false, 0., 0.);
    assert!(matches!(
        &r.page.reveal()[..],
        [Effect::Send(_, Request::Reveal { root: Some(root), .. })] if root == "extra:0"
    ));
}

#[test]
fn the_menu_goes_with_its_tree() {
    let mut r = Run::mounted(demo());
    let tree = r.tree();
    r.page.open_menu(tree, "README.md", false, 0., 0.);
    r.click("notes.txt");
    r.page.edit("x");
    r.act(|p| p.save());
    assert_eq!(r.page.menu, None, "a refresh remounts the tree");
    r.page.open_menu(999, "README.md", false, 0., 0.);
    assert_eq!(r.page.menu, None, "no such tree");
}

#[test]
fn back_to_chat_is_a_link_to_the_root_page_tsx_322() {
    let page = FilesPage::new();
    assert_eq!(page.back_to_chat(), vec![Effect::OpenUrl("/".into())]);
}

#[test]
fn an_answer_kind_that_doesn_t_fit_its_call_is_ignored() {
    let mut page = FilesPage::new();
    page.mount(ws(), None, None, None);
    let tree = page.trees[0].id;
    let fx = page.answered(Call::TreeRoot { tree }, Answer::Done(Ok(())));
    assert!(fx.is_empty());
    assert!(page.trees[0].loading);
}

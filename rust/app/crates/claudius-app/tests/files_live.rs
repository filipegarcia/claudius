//! The Files page (U12c) over the engine in this process: claudius-files'
//! `LiveFilesData` through the workspace's page transport (its cookie, as
//! `main.rs` wires it), driving the page's model as the screen does. A temp
//! HOME and config dir and the fake CLI (never `~/.claude` or the real
//! `claude`); the workspace is a temp folder. The tree lists it, a pick
//! shows the file's text, Save writes the disk, find in folder finds a
//! string, and the errors are the routes' own.
//!
//! One test: the HOME override is per process.

#[path = "../../../../crates/claudius-agent/tests/support/test_bins.rs"]
mod test_bins;
#[path = "support/world.rs"]
mod world;

use std::collections::VecDeque;
use std::sync::Arc;

use claudius_files::FilesData;
use claudius_files::live::LiveFilesData;
use claudius_files::model::{Answer, Effect, FilesPage, Request, TreeBody, TreeRow};
use futures::executor::block_on;
use world::world;

/// Answers a request through the live data, as the screen does.
fn answer(data: &dyn FilesData, ws: &str, req: Request) -> Answer {
    match req {
        Request::Roots => Answer::Roots(block_on(data.roots(ws))),
        Request::List { root, path } => {
            Answer::Listing(block_on(data.list(ws, root.as_deref(), &path)))
        }
        Request::Search { root, q } => {
            Answer::Search(block_on(data.search(ws, root.as_deref(), &q)))
        }
        Request::Read { root, rel } => Answer::File(block_on(data.read(ws, &root, &rel))),
        Request::Save { root, rel, text } => {
            Answer::Done(block_on(data.save(ws, &root, &rel, &text)))
        }
        Request::Delete { root, rel } => Answer::Done(block_on(data.delete(ws, &root, &rel))),
        Request::Rename { root, rel, next } => {
            Answer::Done(block_on(data.rename(ws, &root, &rel, &next)))
        }
        Request::Create { root, path, kind } => {
            Answer::Done(block_on(data.create(ws, &root, &path, kind)))
        }
        Request::ContentSearch {
            root,
            folder,
            q,
            case_sensitive,
        } => Answer::ContentSearch(block_on(data.content_search(
            ws,
            &root,
            &folder,
            &q,
            case_sensitive,
        ))),
        // Never sent here: a reveal would open Finder.
        Request::Reveal { .. } => panic!("the live test doesn't reveal"),
        Request::Image { root, rel } => Answer::Image(block_on(data.image(ws, &root, &rel))),
    }
}

/// Runs effects to quiescence; debounces fire at once; URL replaces go
/// back in as the shell's route would.
fn go(page: &mut FilesPage, data: &dyn FilesData, ws: &str, fx: Vec<Effect>) -> Vec<String> {
    let mut urls = Vec::new();
    let mut queue: VecDeque<Effect> = fx.into();
    while let Some(e) = queue.pop_front() {
        match e {
            Effect::Send(call, req) => {
                let a = answer(data, ws, req);
                queue.extend(page.answered(call, a));
            }
            Effect::Timer(t, _) => queue.extend(page.timer_fired(t)),
            Effect::ReplaceUrl(url) => urls.push(url),
            Effect::OpenUrl(_) | Effect::Store { .. } => {}
        }
    }
    urls
}

fn rows(page: &FilesPage) -> Vec<String> {
    page.trees[0]
        .rows()
        .into_iter()
        .filter_map(|r| match r {
            TreeRow::Entry { entry, .. } => Some(entry.rel_path.clone()),
            TreeRow::Empty { .. } => None,
        })
        .collect()
}

#[test]
fn the_files_page_reads_writes_and_searches_the_engine() {
    let w = world(test_bins::fake_claude(), &["Files Live"]);
    let ws = w.workspaces[0].id.clone();
    let dir = std::path::PathBuf::from(&w.workspaces[0].root_path);
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("README.md"), "# live\nfind the needle here\n").unwrap();
    std::fs::write(dir.join("src/main.rs"), "fn main() {}\n").unwrap();
    std::fs::write(dir.join(".env"), "X=1\n").unwrap();

    let pages = w.data.clone();
    let data: Arc<dyn FilesData> = Arc::new(LiveFilesData::new(
        w.backend.handle(),
        Arc::new(move |id: &str| pages.page(id)),
    ));
    let data = data.as_ref();
    let mut page = FilesPage::new();
    let fx = page.mount(
        Some((ws.clone(), w.workspaces[0].root_path.clone())),
        None,
        None,
        None,
    );
    go(&mut page, data, &ws, fx);

    // The roots and the tree, folders first, the dotfile hidden.
    let roots = page.roots.clone().unwrap();
    assert_eq!(roots.len(), 1);
    assert_eq!(roots[0].id, "primary");
    assert_eq!(page.trees[0].body(""), TreeBody::Rows);
    assert_eq!(rows(&page), vec!["src/", "README.md"]);
    assert_eq!(page.trees[0].hidden_in.get(""), Some(&1.0));

    // A folder opens; a file shows its text.
    let tree = page.trees[0].id;
    let fx = page.click_row(tree, "src/");
    go(&mut page, data, &ws, fx);
    assert_eq!(rows(&page), vec!["src/", "src/main.rs", "README.md"]);
    let fx = page.click_row(tree, "README.md");
    let urls = go(&mut page, data, &ws, fx);
    assert_eq!(urls, vec!["/".to_owned() + &ws + "/files?path=README.md"]);
    let open = page.open.clone().unwrap();
    assert_eq!(open.content, "# live\nfind the needle here\n");
    assert_eq!(open.encoding.as_deref(), Some("utf-8"));
    assert!(!page.read_only());

    // Save writes the disk.
    page.edit("# live\nedited from the native page\n");
    assert!(page.can_save());
    let fx = page.save();
    go(&mut page, data, &ws, fx);
    assert_eq!(page.error, None);
    assert!(!page.dirty);
    assert_eq!(
        std::fs::read_to_string(dir.join("README.md")).unwrap(),
        "# live\nedited from the native page\n"
    );

    // Find in folder finds a string (and its line), case-insensitively.
    page.open_root_folder_find();
    let fx = page.set_folder_query("EDITED");
    go(&mut page, data, &ws, fx);
    let f = page.folder_find.clone().unwrap();
    assert_eq!(f.error, None);
    let hits = f.matches.clone().unwrap();
    assert_eq!(hits.len(), 1, "{hits:?}");
    assert_eq!(hits[0].rel_path, "README.md");
    assert_eq!(hits[0].line, 2.0);
    assert_eq!(f.status(), "1 match \u{b7} 1 file");
    let fx = page.pick_hit(0);
    go(&mut page, data, &ws, fx);
    assert_eq!(page.pending_line, Some(2));

    // The filename search.
    let fx = page.set_query("main");
    go(&mut page, data, &ws, fx);
    match page.trees[0].body(&page.query) {
        TreeBody::Results { entries, .. } => {
            assert_eq!(
                entries
                    .iter()
                    .map(|e| e.rel_path.as_str())
                    .collect::<Vec<_>>(),
                vec!["src/main.rs"]
            );
        }
        other => panic!("{other:?}"),
    }
    let fx = page.set_query("");
    go(&mut page, data, &ws, fx);

    // A missing file is the route's 404 text.
    let err = block_on(data.read(&ws, "primary", "nope.txt")).unwrap_err();
    assert!(!err.is_empty());
    let fx = page.set_url(None, None);
    go(&mut page, data, &ws, fx);

    // New file, rename, delete, on disk.
    page.ask_create(claudius_files::rules::NewKind::File);
    let fx = page.confirm_dialog("src/new.rs");
    go(&mut page, data, &ws, fx);
    assert!(dir.join("src/new.rs").is_file());
    assert_eq!(page.open.as_ref().unwrap().rel_path, "src/new.rs");
    page.ask_rename();
    let fx = page.confirm_dialog("src/renamed.rs");
    go(&mut page, data, &ws, fx);
    assert!(dir.join("src/renamed.rs").is_file());
    assert!(!dir.join("src/new.rs").exists());
    page.ask_delete();
    let fx = page.confirm_dialog("");
    go(&mut page, data, &ws, fx);
    assert!(!dir.join("src/renamed.rs").exists());
    assert_eq!(page.open, None);
    assert_eq!(page.error, None);

    // The temp world is all it touched.
    assert!(dir.starts_with(w.root.path().canonicalize().unwrap()));
    w.shutdown();
}

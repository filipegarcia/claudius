//! The Files page as a pure state machine, no GPUI: [`FilesPage`] is
//! `app/[workspaceId]/files/page.tsx`'s state with each mounted
//! `FileTree`'s ([`Tree`]), the two find panels' ([`FindInFile`],
//! [`FindInFolder`]), the path context menu's and the `prompt()` /
//! `confirm()` dialogs the page opens. Its methods are the page's handlers;
//! each returns the [`Effect`]s the view runs (a request, a timer, a URL
//! replace, a `localStorage` write), and the answers come back through
//! [`FilesPage::answered`] and [`FilesPage::timer_fired`].
//!
//! React's remounts are mirrored: a tree is dropped when its group closes
//! or the page's `refreshKey` moves (after a save, delete, rename or
//! create), and a new one loads its root again; an answer for a dropped
//! tree (or a superseded search) is ignored, as the effects' `cancelled`
//! flags ignore it.

use std::collections::{HashMap, HashSet};

use claudius_agent::js;

use crate::data::{
    ContentSearch, Entry, FileContent, FilesResult, Listing, SearchResult, WorkspaceRoot,
};
use crate::last_open::{self, LastOpenFile};
use crate::rules::{self, ContentMatch, Match16, NewKind};

/// FileTree.tsx:107 the filename search's debounce.
pub const TREE_SEARCH_DEBOUNCE_MS: u64 = 200;
/// FindInFolder.tsx:119 the content search's debounce.
pub const FOLDER_SEARCH_DEBOUNCE_MS: u64 = 250;

/// One request (a [`crate::data::FilesData`] method).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Request {
    Roots,
    List {
        root: Option<String>,
        path: String,
    },
    Search {
        root: Option<String>,
        q: String,
    },
    Read {
        root: String,
        rel: String,
    },
    Save {
        root: String,
        rel: String,
        text: String,
    },
    Delete {
        root: String,
        rel: String,
    },
    Rename {
        root: String,
        rel: String,
        next: String,
    },
    Create {
        root: String,
        path: String,
        kind: NewKind,
    },
    ContentSearch {
        root: String,
        folder: String,
        q: String,
        case_sensitive: bool,
    },
    Reveal {
        root: Option<String>,
        rel: String,
    },
    Image {
        root: String,
        rel: String,
    },
}

/// What an answer is for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Call {
    /// The page's `/roots` read for this mount.
    Roots {
        mount: u64,
    },
    /// A tree's root listing.
    TreeRoot {
        tree: u64,
    },
    /// A folder clicked open (its key, `a/`).
    Toggle {
        tree: u64,
        key: String,
    },
    /// The deep link's walk, at step `step` of the selected path's folders.
    Walk {
        tree: u64,
        step: usize,
    },
    /// A tree's filename search, its run.
    Search {
        tree: u64,
        seq: u64,
    },
    /// `onPick`, then (find in folder) the line to put the caret on;
    /// `created`: the create's own pick, which `busy` waits on.
    Pick {
        mount: u64,
        line: Option<u32>,
        created: bool,
    },
    Save {
        mount: u64,
    },
    Delete {
        mount: u64,
    },
    Rename {
        mount: u64,
        next: String,
    },
    /// The create, then (a file) the pick in `root`.
    Create {
        mount: u64,
        kind: NewKind,
        path: String,
        root: String,
    },
    ContentSearch {
        seq: u64,
    },
    Reveal,
    Image {
        mount: u64,
        rel: String,
    },
}

/// A debounce.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Timer {
    TreeSearch { tree: u64, seq: u64 },
    FolderSearch { seq: u64 },
}

/// What the view does for the page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    /// Send this, then hand the answer to [`FilesPage::answered`].
    Send(Call, Request),
    /// Fire [`FilesPage::timer_fired`] after this many ms.
    Timer(Timer, u64),
    /// `router.replace(url)` (no history entry).
    ReplaceUrl(String),
    /// `router.push("/")`-style link: open this URL.
    OpenUrl(String),
    /// `localStorage.setItem(key, value)`; `None` removes it.
    Store { key: String, value: Option<String> },
}

/// An answer.
#[derive(Clone, Debug, PartialEq)]
pub enum Answer {
    Roots(FilesResult<Vec<WorkspaceRoot>>),
    Listing(FilesResult<Listing>),
    Search(FilesResult<SearchResult>),
    File(FilesResult<FileContent>),
    Done(FilesResult<()>),
    ContentSearch(FilesResult<ContentSearch>),
    Image(FilesResult<(Vec<u8>, String)>),
}

/// The page's `busy` (page.tsx:71).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Busy {
    Save,
    Delete,
    Rename,
    Create,
}

/// The `prompt()` / `confirm()` the page is waiting on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Dialog {
    /// page.tsx:253 the rename's prompt, its default the open path.
    Rename { default: String },
    /// page.tsx:286 the create's prompt.
    Create {
        kind: NewKind,
        message: &'static str,
        default: String,
    },
    /// page.tsx:226 the delete's confirm.
    Delete { question: String },
}

/// A right-clicked row's menu (FileTree.tsx:63).
#[derive(Clone, Debug, PartialEq)]
pub struct Menu {
    pub tree: u64,
    pub rel_path: String,
    pub is_dir: bool,
    pub x: f64,
    pub y: f64,
    pub busy: bool,
}

/// One mounted `FileTree` (FileTree.tsx:39).
#[derive(Clone, Debug, PartialEq)]
pub struct Tree {
    /// This mount, for its answers.
    pub id: u64,
    /// The `root` prop: `None` on a single-root page.
    pub root: Option<String>,
    pub root_entries: Vec<Entry>,
    pub expanded: HashMap<String, Vec<Entry>>,
    pub hidden_in: HashMap<String, f64>,
    pub dir_errors: HashMap<String, String>,
    pub loading: bool,
    pub error: Option<String>,
    pub selected: Option<String>,
    pub search_results: Option<Vec<Entry>>,
    pub search_truncated: bool,
    pub search_error: Option<String>,
    search_seq: u64,
    last_query: String,
    last_selected_prop: Option<String>,
    did_expand: bool,
    walk: Vec<(String, String)>,
}

impl Tree {
    fn new(id: u64, root: Option<String>, query: &str, selected: Option<&str>) -> Tree {
        Tree {
            id,
            root,
            root_entries: Vec::new(),
            expanded: HashMap::new(),
            hidden_in: HashMap::new(),
            dir_errors: HashMap::new(),
            loading: true,
            error: None,
            selected: selected.map(str::to_owned),
            search_results: None,
            search_truncated: false,
            search_error: None,
            search_seq: 0,
            last_query: js::trim(query).to_owned(),
            last_selected_prop: selected.map(str::to_owned),
            did_expand: false,
            walk: Vec::new(),
        }
    }

    /// The selector this tree's requests send (`?root=` only when set).
    pub fn selector(&self) -> Option<&str> {
        self.root.as_deref()
    }

    /// The root id this tree's picks open in (page.tsx:404 / :463).
    pub fn root_id(&self) -> &str {
        self.root.as_deref().unwrap_or("primary")
    }

    /// FileTree.tsx:373 a folder is open when it has a listing (an empty
    /// one too).
    pub fn is_open(&self, key: &str) -> bool {
        self.expanded.contains_key(key)
    }

    /// FileTree.tsx:468 `findEntry`: depth-first through the open folders.
    pub fn find_entry(&self, rel: &str) -> Option<&Entry> {
        fn walk<'a>(
            rel: &str,
            list: &'a [Entry],
            expanded: &'a HashMap<String, Vec<Entry>>,
        ) -> Option<&'a Entry> {
            for e in list {
                if e.rel_path == rel {
                    return Some(e);
                }
                if let Some(children) = expanded.get(&e.rel_path)
                    && let Some(found) = walk(rel, children, expanded)
                {
                    return Some(found);
                }
            }
            None
        }
        walk(rel, &self.root_entries, &self.expanded)
    }

    /// The rows as drawn (FileTree.tsx:316-337 `Row`): `(depth, entry)`,
    /// each open folder's children under it, an empty open folder as its
    /// placeholder row.
    pub fn rows(&self) -> Vec<TreeRow<'_>> {
        fn push<'a>(out: &mut Vec<TreeRow<'a>>, list: &'a [Entry], depth: usize, tree: &'a Tree) {
            for e in list {
                out.push(TreeRow::Entry { depth, entry: e });
                if e.is_dir
                    && let Some(children) = tree.expanded.get(&e.rel_path)
                {
                    if children.is_empty() {
                        out.push(TreeRow::Empty {
                            depth: depth + 1,
                            error: tree.dir_errors.get(&e.rel_path).map(String::as_str),
                            hidden: tree.hidden_in.get(&e.rel_path).copied().unwrap_or(0.0),
                        });
                    }
                    push(out, children, depth + 1, tree);
                }
            }
        }
        let mut out = Vec::new();
        push(&mut out, &self.root_entries, 0, self);
        out
    }

    /// What the tree shows (FileTree.tsx:238-314), in the TS's order:
    /// search mode first, then loading, the error, an empty root.
    pub fn body(&self, query: &str) -> TreeBody<'_> {
        if !js::trim(query).is_empty() {
            return match &self.search_results {
                None => TreeBody::Searching,
                Some(_) if self.search_error.is_some() => {
                    TreeBody::SearchError(self.search_error.as_deref().unwrap_or_default())
                }
                Some(r) if r.is_empty() => TreeBody::NoMatch,
                Some(r) => TreeBody::Results {
                    entries: r,
                    truncated: self.search_truncated,
                },
            };
        }
        if self.loading {
            return TreeBody::Loading;
        }
        if let Some(e) = &self.error {
            return TreeBody::Error(e);
        }
        if self.root_entries.is_empty() {
            return TreeBody::Empty(rules::empty_root_text(
                self.hidden_in.get("").copied().unwrap_or(0.0),
            ));
        }
        TreeBody::Rows
    }

    /// The listing's metadata (FileTree.tsx:137-141), for every load.
    fn loaded(&mut self, path: &str, hidden: f64) {
        self.hidden_in.insert(rules::load_key(path), hidden);
    }
}

/// One drawn row of a tree.
#[derive(Clone, Debug, PartialEq)]
pub enum TreeRow<'a> {
    Entry {
        depth: usize,
        entry: &'a Entry,
    },
    /// FileTree.tsx:446 `EmptyDirRow`.
    Empty {
        depth: usize,
        error: Option<&'a str>,
        hidden: f64,
    },
}

/// What a tree shows.
#[derive(Clone, Debug, PartialEq)]
pub enum TreeBody<'a> {
    Searching,
    SearchError(&'a str),
    NoMatch,
    Results {
        entries: &'a [Entry],
        truncated: bool,
    },
    Loading,
    Error(&'a str),
    Empty(String),
    Rows,
}

/// FindInFile.tsx's state (the toolbar is open while this is `Some`).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct FindInFile {
    pub query: String,
    pub case_sensitive: bool,
    pub active: usize,
    last_count: usize,
    /// Bumped whenever the active match should be revealed again.
    pub reveal_seq: u64,
}

/// FindInFolder.tsx's state (it replaces the editor pane while open).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct FindInFolder {
    pub root: String,
    pub folder: String,
    pub label: String,
    pub query: String,
    pub case_sensitive: bool,
    pub matches: Option<Vec<ContentMatch>>,
    pub truncated: bool,
    pub scanned: f64,
    pub loading: bool,
    pub error: Option<String>,
    pub collapsed: HashSet<String>,
    seq: u64,
    last_trimmed: String,
}

impl FindInFolder {
    /// FindInFolder.tsx:128 the hits by file.
    pub fn grouped(&self) -> Vec<(String, Vec<usize>)> {
        self.matches
            .as_deref()
            .map(rules::group_matches)
            .unwrap_or_default()
    }

    pub fn total(&self) -> usize {
        self.matches.as_ref().map_or(0, Vec::len)
    }

    /// FindInFolder.tsx:140.
    pub fn display(&self) -> &str {
        rules::folder_display(&self.folder, &self.label)
    }

    /// FindInFolder.tsx:200-218.
    pub fn status(&self) -> String {
        rules::folder_status(
            self.loading,
            &self.query,
            self.error.is_some(),
            self.total(),
            self.grouped().len(),
        )
    }
}

/// What the editor pane shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pane {
    /// page.tsx:478 "Pick a file to view or edit."
    Empty,
    /// FindInFolder replacing the pane.
    FindInFolder,
    /// page.tsx:540 the binary placeholder.
    Binary,
    /// The binary is an image (`getPreviewType`): its bytes, once read.
    Image,
    /// page.tsx:561 the editor.
    Text,
}

/// The page.
#[derive(Clone, Debug)]
pub struct FilesPage {
    /// The active workspace (`useWorkspaces`): its id and `rootPath`.
    pub workspace: Option<(String, String)>,
    /// The page's pathname (`/<id>/files`).
    pub pathname: String,
    /// `searchParams`' `root` and `path`.
    pub url_root: Option<String>,
    pub url_path: Option<String>,
    pub roots: Option<Vec<WorkspaceRoot>>,
    pub open_groups: HashMap<String, bool>,
    pub open: Option<FileContent>,
    pub draft: String,
    pub dirty: bool,
    pub busy: Option<Busy>,
    pub error: Option<String>,
    pub refresh_key: u64,
    pub query: String,
    pub trees: Vec<Tree>,
    pub menu: Option<Menu>,
    pub dialog: Option<Dialog>,
    pub find: Option<FindInFile>,
    pub folder_find: Option<FindInFolder>,
    /// Bumped each time `open` is set from an answer: the editor reloads.
    pub open_seq: u64,
    /// The line to put the caret on once the open file shows (a find in
    /// folder hit), 1-based.
    pub pending_line: Option<u32>,
    /// The image preview's bytes and content type.
    pub image: Option<(Vec<u8>, String)>,
    /// The last-open memory as read when the page mounted.
    last_open: Option<LastOpenFile>,
    mount: u64,
    next_tree: u64,
}

impl Default for FilesPage {
    fn default() -> Self {
        FilesPage::new()
    }
}

impl FilesPage {
    /// An unmounted page.
    pub fn new() -> FilesPage {
        FilesPage {
            workspace: None,
            pathname: String::new(),
            url_root: None,
            url_path: None,
            roots: None,
            open_groups: HashMap::from([("primary".to_owned(), true)]),
            open: None,
            draft: String::new(),
            dirty: false,
            busy: None,
            error: None,
            refresh_key: 0,
            query: String::new(),
            trees: Vec::new(),
            menu: None,
            dialog: None,
            find: None,
            folder_find: None,
            open_seq: 0,
            pending_line: None,
            image: None,
            last_open: None,
            mount: 0,
            next_tree: 0,
        }
    }

    pub fn ws(&self) -> Option<&str> {
        self.workspace.as_ref().map(|(id, _)| id.as_str())
    }

    /// Mounts the page for a workspace (its id and root path), at a URL
    /// (`?root=`, `?path=`), with what `localStorage` holds for it: the
    /// roots read, the trees load, the deep link (or the last-open file)
    /// opens. Everything from an earlier mount is dropped.
    pub fn mount(
        &mut self,
        workspace: Option<(String, String)>,
        url_root: Option<String>,
        url_path: Option<String>,
        stored_last_open: Option<&str>,
    ) -> Vec<Effect> {
        let mount = self.mount + 1;
        let next_tree = self.next_tree;
        *self = FilesPage::new();
        self.mount = mount;
        self.next_tree = next_tree;
        self.pathname = workspace
            .as_ref()
            .map(|(id, _)| format!("/{id}/files"))
            .unwrap_or_default();
        self.workspace = workspace;
        self.url_root = url_root;
        self.url_path = url_path;
        self.last_open = stored_last_open.and_then(|s| last_open::parse(Some(s)));
        let mut fx = Vec::new();
        if self.workspace.is_some() {
            fx.push(Effect::Send(Call::Roots { mount }, Request::Roots));
        }
        fx.extend(self.sync_trees());
        fx.extend(self.deep_link());
        fx
    }

    /// The URL moved (a replace this page asked for, or a link): only the
    /// selection fallback reads it after the mount.
    pub fn set_url(&mut self, url_root: Option<String>, url_path: Option<String>) -> Vec<Effect> {
        self.url_root = url_root;
        self.url_path = url_path;
        self.sync_trees()
    }

    /// The `extra:<n>` roots (page.tsx:125).
    pub fn extra_roots(&self) -> Vec<&WorkspaceRoot> {
        self.roots
            .iter()
            .flatten()
            .filter(|r| r.id != "primary")
            .collect()
    }

    /// page.tsx:421 whether a group is open.
    pub fn group_open(&self, id: &str) -> bool {
        rules::group_open(&self.query, self.open_groups.get(id).copied())
    }

    /// page.tsx:405-411 / :431-436 the path a root's tree highlights.
    pub fn selected_for(&self, root_id: &str) -> Option<String> {
        rules::selected_path(
            self.open
                .as_ref()
                .map(|o| (o.root.as_str(), o.rel_path.as_str())),
            self.url_root.as_deref(),
            self.url_path.as_deref(),
            root_id,
        )
        .map(str::to_owned)
    }

    /// The trees React has mounted: one without a `root` on a single-root
    /// page, else one per open group (page.tsx:397-473).
    fn wanted_trees(&self) -> Vec<Option<String>> {
        if self.workspace.is_none() {
            return Vec::new();
        }
        if self.extra_roots().is_empty() {
            return vec![None];
        }
        self.roots
            .iter()
            .flatten()
            .filter(|r| self.group_open(&r.id))
            .map(|r| Some(r.id.clone()))
            .collect()
    }

    /// Mounts the trees that should be there (each loads its root, walks to
    /// its selection, searches the query), drops the others, and passes
    /// each its `selectedPath`.
    fn sync_trees(&mut self) -> Vec<Effect> {
        let wanted = self.wanted_trees();
        self.trees.retain(|t| wanted.contains(&t.root));
        if self
            .menu
            .as_ref()
            .is_some_and(|m| !self.trees.iter().any(|t| t.id == m.tree))
        {
            self.menu = None;
        }
        let mut fx = Vec::new();
        let mut trees = Vec::new();
        for root in wanted {
            let selected = self.selected_for(root.as_deref().unwrap_or("primary"));
            let tree = match self.trees.iter().position(|t| t.root == root) {
                Some(i) => self.trees.remove(i),
                None => {
                    self.next_tree += 1;
                    let t = Tree::new(self.next_tree, root, &self.query, selected.as_deref());
                    fx.push(Effect::Send(
                        Call::TreeRoot { tree: t.id },
                        Request::List {
                            root: t.root.clone(),
                            path: String::new(),
                        },
                    ));
                    // A tree mounted with a query searches at once
                    // (after the debounce).
                    if !js::trim(&self.query).is_empty() {
                        fx.push(Effect::Timer(
                            Timer::TreeSearch { tree: t.id, seq: 0 },
                            TREE_SEARCH_DEBOUNCE_MS,
                        ));
                    }
                    t
                }
            };
            trees.push(tree);
        }
        self.trees = trees;
        for i in 0..self.trees.len() {
            let selected = self.selected_for(self.trees[i].root_id());
            fx.extend(self.tree_selected(i, selected));
        }
        fx
    }

    /// FileTree.tsx:117-121 and :178-204: mirrors the `selectedPath` prop
    /// into the highlight, and walks to the first one once.
    fn tree_selected(&mut self, i: usize, prop: Option<String>) -> Vec<Effect> {
        let tree = &mut self.trees[i];
        if prop != tree.last_selected_prop {
            tree.last_selected_prop = prop.clone();
            if let Some(p) = prop.as_ref().filter(|p| !p.is_empty()) {
                tree.selected = Some(p.clone());
            }
        }
        let Some(selected) = prop.filter(|p| !p.is_empty()) else {
            return Vec::new();
        };
        if tree.did_expand {
            return Vec::new();
        }
        tree.did_expand = true;
        tree.walk = rules::ancestor_dirs(&selected);
        self.walk_step(i, 0)
    }

    fn walk_step(&mut self, i: usize, step: usize) -> Vec<Effect> {
        let tree = &self.trees[i];
        let Some((path, _)) = tree.walk.get(step) else {
            return Vec::new();
        };
        vec![Effect::Send(
            Call::Walk {
                tree: tree.id,
                step,
            },
            Request::List {
                root: tree.root.clone(),
                path: path.clone(),
            },
        )]
    }

    /// page.tsx:174-195 the deep link (once the workspace is known; the
    /// TS's `didDeepLink` ref is the mount, which runs this once); the
    /// native page reopens the last-open file when the URL names none.
    fn deep_link(&mut self) -> Vec<Effect> {
        if self.workspace.is_none() {
            return Vec::new();
        }
        let (path, root) = match (&self.url_path, &self.last_open) {
            (Some(p), _) if !p.is_empty() => (
                p.clone(),
                self.url_root.clone().unwrap_or_else(|| "primary".into()),
            ),
            (None, Some(last)) => (last.rel_path.clone(), last.root.clone()),
            _ => return Vec::new(),
        };
        let mut fx = self.pick_path(&root, &path, None);
        if root != "primary" {
            self.open_groups.insert(root, true);
            fx.extend(self.sync_trees());
        }
        fx
    }

    // ---- the header ------------------------------------------------------

    /// page.tsx:344 the search box (and its clear button, with `""`).
    pub fn set_query(&mut self, q: &str) -> Vec<Effect> {
        self.query = q.to_owned();
        let mut fx = self.sync_trees();
        let trimmed = js::trim(q).to_owned();
        for t in &mut self.trees {
            if t.last_query == trimmed {
                continue;
            }
            t.last_query = trimmed.clone();
            t.search_seq += 1;
            if trimmed.is_empty() {
                // FileTree.tsx:74-78 leaving search mode clears it.
                t.search_results = None;
                t.search_truncated = false;
                t.search_error = None;
            } else {
                fx.push(Effect::Timer(
                    Timer::TreeSearch {
                        tree: t.id,
                        seq: t.search_seq,
                    },
                    TREE_SEARCH_DEBOUNCE_MS,
                ));
            }
        }
        fx
    }

    /// page.tsx:441 a group's chevron.
    pub fn toggle_group(&mut self, id: &str) -> Vec<Effect> {
        let open = self.group_open(id);
        self.open_groups.insert(id.to_owned(), !open);
        self.sync_trees()
    }

    /// page.tsx:322 "← Chat".
    pub fn back_to_chat(&self) -> Vec<Effect> {
        vec![Effect::OpenUrl("/".into())]
    }

    // ---- picking ---------------------------------------------------------

    /// FileTree.tsx:378-381 a row's click: a folder toggles, a file is
    /// selected and picked.
    pub fn click_row(&mut self, tree: u64, rel: &str) -> Vec<Effect> {
        let Some(i) = self.trees.iter().position(|t| t.id == tree) else {
            return Vec::new();
        };
        let Some(entry) = self.trees[i].find_entry(rel).cloned() else {
            return Vec::new();
        };
        if entry.is_dir {
            return self.toggle_dir(i, &entry.rel_path);
        }
        self.trees[i].selected = Some(rel.to_owned());
        let root = self.trees[i].root_id().to_owned();
        self.pick(&root, &entry)
    }

    /// FileTree.tsx:255-258 a search hit's click.
    pub fn click_result(&mut self, tree: u64, rel: &str) -> Vec<Effect> {
        let Some(t) = self.trees.iter_mut().find(|t| t.id == tree) else {
            return Vec::new();
        };
        let Some(entry) = t
            .search_results
            .iter()
            .flatten()
            .find(|e| e.rel_path == rel)
            .cloned()
        else {
            return Vec::new();
        };
        t.selected = Some(rel.to_owned());
        let root = t.root_id().to_owned();
        self.pick(&root, &entry)
    }

    /// FileTree.tsx:206-234 `toggle`.
    fn toggle_dir(&mut self, i: usize, key: &str) -> Vec<Effect> {
        let tree = &mut self.trees[i];
        if tree.expanded.contains_key(key) {
            tree.expanded.remove(key);
            tree.dir_errors.remove(key);
            return Vec::new();
        }
        vec![Effect::Send(
            Call::Toggle {
                tree: tree.id,
                key: key.to_owned(),
            },
            Request::List {
                root: tree.root.clone(),
                path: key.to_owned(),
            },
        )]
    }

    /// page.tsx:127-129 `onPick(e, rootId)`: files only.
    fn pick(&mut self, root: &str, entry: &Entry) -> Vec<Effect> {
        if entry.is_dir {
            return Vec::new();
        }
        self.pick_path(root, &entry.rel_path, None)
    }

    fn pick_path(&mut self, root: &str, rel: &str, line: Option<u32>) -> Vec<Effect> {
        if self.workspace.is_none() {
            return Vec::new();
        }
        self.error = None;
        vec![Effect::Send(
            Call::Pick {
                mount: self.mount,
                line,
                created: false,
            },
            Request::Read {
                root: root.to_owned(),
                rel: rel.to_owned(),
            },
        )]
    }

    fn picked(&mut self, file: FilesResult<FileContent>, line: Option<u32>) -> Vec<Effect> {
        match file {
            Err(e) => {
                self.error = Some(e);
                Vec::new()
            }
            Ok(file) => {
                self.draft = file.content.clone();
                self.dirty = false;
                self.open_seq += 1;
                self.pending_line = line;
                self.image = None;
                let url = rules::page_url(&self.pathname, &file.rel_path, &file.root);
                let mut fx = vec![Effect::ReplaceUrl(url)];
                if let Some(ws) = self.ws() {
                    fx.push(Effect::Store {
                        key: last_open::key_for(ws),
                        value: Some(last_open::serialize(&LastOpenFile {
                            root: file.root.clone(),
                            rel_path: file.rel_path.clone(),
                        })),
                    });
                }
                if file.binary
                    && rules::preview_type(&file.rel_path) == Some(rules::PreviewType::Image)
                {
                    fx.push(Effect::Send(
                        Call::Image {
                            mount: self.mount,
                            rel: file.rel_path.clone(),
                        },
                        Request::Image {
                            root: file.root.clone(),
                            rel: file.rel_path.clone(),
                        },
                    ));
                }
                self.open = Some(file);
                fx.extend(self.sync_trees());
                fx
            }
        }
    }

    // ---- the editor ------------------------------------------------------

    /// page.tsx:565-568 the editor's change.
    pub fn edit(&mut self, next: &str) {
        let Some(open) = &self.open else { return };
        self.dirty = next != open.content;
        self.draft = next.to_owned();
        if let Some(f) = &mut self.find {
            let count = rules::find_matches(&self.draft, &f.query, f.case_sensitive).len();
            Self::clamp_find(f, count);
        }
    }

    /// page.tsx:199 the open file can't be written back.
    pub fn read_only(&self) -> bool {
        self.open.as_ref().is_some_and(FileContent::read_only)
    }

    /// What the editor pane shows.
    pub fn pane(&self) -> Pane {
        if self.folder_find.is_some() {
            return Pane::FindInFolder;
        }
        match &self.open {
            None => Pane::Empty,
            Some(o)
                if o.binary
                    && rules::preview_type(&o.rel_path) == Some(rules::PreviewType::Image)
                    && self.image.is_some() =>
            {
                Pane::Image
            }
            Some(o) if o.binary => Pane::Binary,
            Some(_) => Pane::Text,
        }
    }

    /// page.tsx:531 the Save button is enabled.
    pub fn can_save(&self) -> bool {
        self.dirty && self.busy.is_none() && !self.read_only()
    }

    /// page.tsx:201-222 `onSave` (⌘S calls it whatever the button says).
    pub fn save(&mut self) -> Vec<Effect> {
        let Some(open) = &self.open else {
            return Vec::new();
        };
        if self.workspace.is_none() || open.read_only() {
            return Vec::new();
        }
        let req = Request::Save {
            root: open.root.clone(),
            rel: open.rel_path.clone(),
            text: self.draft.clone(),
        };
        self.busy = Some(Busy::Save);
        self.error = None;
        vec![Effect::Send(Call::Save { mount: self.mount }, req)]
    }

    /// page.tsx:572-581 a key in the editor: ⌘S / Ctrl+S saves.
    pub fn editor_key(&mut self, e: &rules::KeyEvent) -> Option<Vec<Effect>> {
        rules::is_save_chord(e).then(|| self.save())
    }

    /// page.tsx:216 / :241 / :269 / :302 `setRefreshKey(k => k + 1)`: the
    /// trees remount and the roots are read again.
    fn refresh(&mut self) -> Vec<Effect> {
        self.refresh_key += 1;
        self.trees.clear();
        self.menu = None;
        let mut fx = vec![Effect::Send(
            Call::Roots { mount: self.mount },
            Request::Roots,
        )];
        fx.extend(self.sync_trees());
        fx
    }

    // ---- delete, rename, create ------------------------------------------

    /// page.tsx:226 the delete asks first.
    pub fn ask_delete(&mut self) {
        if self.workspace.is_none() {
            return;
        }
        if let Some(open) = &self.open {
            self.dialog = Some(Dialog::Delete {
                question: rules::delete_question(&open.rel_path),
            });
        }
    }

    /// page.tsx:253 the rename asks for the new path.
    pub fn ask_rename(&mut self) {
        if self.workspace.is_none() {
            return;
        }
        if let Some(open) = &self.open {
            self.dialog = Some(Dialog::Rename {
                default: open.rel_path.clone(),
            });
        }
    }

    /// page.tsx:286 the create asks for the path.
    pub fn ask_create(&mut self, kind: NewKind) {
        if self.workspace.is_none() {
            return;
        }
        let (message, default) =
            rules::create_prompt(kind, self.open.as_ref().map(|o| o.rel_path.as_str()));
        self.dialog = Some(Dialog::Create {
            kind,
            message,
            default,
        });
    }

    /// The dialog's Cancel (`prompt` → `null`, `confirm` → `false`).
    pub fn cancel_dialog(&mut self) {
        self.dialog = None;
    }

    /// The dialog's OK, with the prompt's text (ignored by the confirm).
    pub fn confirm_dialog(&mut self, value: &str) -> Vec<Effect> {
        let Some(dialog) = self.dialog.take() else {
            return Vec::new();
        };
        let mount = self.mount;
        match dialog {
            Dialog::Delete { .. } => {
                let Some(open) = &self.open else {
                    return Vec::new();
                };
                let req = Request::Delete {
                    root: open.root.clone(),
                    rel: open.rel_path.clone(),
                };
                self.busy = Some(Busy::Delete);
                self.error = None;
                vec![Effect::Send(Call::Delete { mount }, req)]
            }
            Dialog::Rename { .. } => {
                let Some(open) = &self.open else {
                    return Vec::new();
                };
                // page.tsx:254.
                if value.is_empty() || value == open.rel_path {
                    return Vec::new();
                }
                let req = Request::Rename {
                    root: open.root.clone(),
                    rel: open.rel_path.clone(),
                    next: value.to_owned(),
                };
                self.busy = Some(Busy::Rename);
                self.error = None;
                vec![Effect::Send(
                    Call::Rename {
                        mount,
                        next: value.to_owned(),
                    },
                    req,
                )]
            }
            Dialog::Create { kind, .. } => {
                if value.is_empty() {
                    return Vec::new();
                }
                // page.tsx:284 the open file's root, else the primary.
                let root = self
                    .open
                    .as_ref()
                    .map_or_else(|| "primary".to_owned(), |o| o.root.clone());
                self.busy = Some(Busy::Create);
                self.error = None;
                vec![Effect::Send(
                    Call::Create {
                        mount,
                        kind,
                        path: value.to_owned(),
                        root: root.clone(),
                    },
                    Request::Create {
                        root,
                        path: value.to_owned(),
                        kind,
                    },
                )]
            }
        }
    }

    // ---- find in file ----------------------------------------------------

    /// Opens the find toolbar (⌘F over a text file).
    pub fn open_find(&mut self) {
        if self.pane() == Pane::Text && self.find.is_none() {
            self.find = Some(FindInFile::default());
        }
    }

    /// FindInFile.tsx:139 Escape / the close button.
    pub fn close_find(&mut self) {
        self.find = None;
    }

    /// The matches in the buffer.
    pub fn find_matches(&self) -> Vec<Match16> {
        self.find
            .as_ref()
            .map(|f| rules::find_matches(&self.draft, &f.query, f.case_sensitive))
            .unwrap_or_default()
    }

    fn clamp_find(f: &mut FindInFile, count: usize) {
        if count != f.last_count {
            f.last_count = count;
            f.active = rules::find_clamp(f.active, count);
        }
        if count > 0 {
            f.reveal_seq += 1;
        }
    }

    /// FindInFile.tsx:154-157 typing resets to the first match.
    pub fn set_find_query(&mut self, q: &str) {
        let draft = &self.draft;
        if let Some(f) = &mut self.find {
            f.query = q.to_owned();
            f.active = 0;
            let count = rules::find_matches(draft, q, f.case_sensitive).len();
            Self::clamp_find(f, count);
        }
    }

    /// FindInFile.tsx:171 the case toggle.
    pub fn toggle_find_case(&mut self) {
        let draft = &self.draft;
        if let Some(f) = &mut self.find {
            f.case_sensitive = !f.case_sensitive;
            let count = rules::find_matches(draft, &f.query, f.case_sensitive).len();
            Self::clamp_find(f, count);
        }
    }

    /// FindInFile.tsx:123-130 Enter / Shift+Enter, the arrows.
    pub fn find_step(&mut self, forward: bool) {
        let count = self.find_matches().len();
        if let Some(f) = &mut self.find
            && count > 0
        {
            f.active = rules::find_step(f.active, count, forward);
            f.reveal_seq += 1;
        }
    }

    /// The active match, in the buffer's UTF-16 units.
    pub fn active_match(&self) -> Option<Match16> {
        let f = self.find.as_ref()?;
        self.find_matches().get(f.active).copied()
    }

    // ---- find in folder --------------------------------------------------

    /// Opens find in folder over `folder` (`""`: the root) of `root`.
    pub fn open_folder_find(&mut self, root: &str, folder: &str, label: &str) {
        self.menu = None;
        self.folder_find = Some(FindInFolder {
            root: root.to_owned(),
            folder: folder.to_owned(),
            label: label.to_owned(),
            ..FindInFolder::default()
        });
    }

    /// Find in folder over the open file's root (the primary when none),
    /// from its top: the header button and ⌘⇧F.
    pub fn open_root_folder_find(&mut self) {
        if self.workspace.is_none() {
            return;
        }
        let root = self
            .open
            .as_ref()
            .map_or_else(|| "primary".to_owned(), |o| o.root.clone());
        let label = self
            .roots
            .iter()
            .flatten()
            .find(|r| r.id == root)
            .map(|r| rules::root_label(&r.source, &r.abs_path).to_owned())
            .unwrap_or_else(|| "root".to_owned());
        self.open_folder_find(&root, "", &label);
    }

    /// FindInFolder.tsx:153 / :168 the close button, Escape.
    pub fn close_folder_find(&mut self) {
        self.folder_find = None;
    }

    fn folder_search_changed(&mut self) -> Vec<Effect> {
        let Some(f) = &mut self.folder_find else {
            return Vec::new();
        };
        let trimmed = js::trim(&f.query).to_owned();
        // FindInFolder.tsx:69-80 an emptied query resets the results.
        if trimmed != f.last_trimmed {
            f.last_trimmed = trimmed.clone();
            if trimmed.is_empty() {
                f.matches = None;
                f.truncated = false;
                f.scanned = 0.0;
                f.error = None;
                f.loading = false;
            }
        }
        // FindInFolder.tsx:84-124 every change cancels the run in flight.
        f.seq += 1;
        if trimmed.is_empty() {
            return Vec::new();
        }
        vec![Effect::Timer(
            Timer::FolderSearch { seq: f.seq },
            FOLDER_SEARCH_DEBOUNCE_MS,
        )]
    }

    /// FindInFolder.tsx:165 the query.
    pub fn set_folder_query(&mut self, q: &str) -> Vec<Effect> {
        match &mut self.folder_find {
            Some(f) if f.query != q => f.query = q.to_owned(),
            _ => return Vec::new(),
        }
        self.folder_search_changed()
    }

    /// FindInFolder.tsx:190 the case toggle.
    pub fn toggle_folder_case(&mut self) -> Vec<Effect> {
        let Some(f) = &mut self.folder_find else {
            return Vec::new();
        };
        f.case_sensitive = !f.case_sensitive;
        self.folder_search_changed()
    }

    /// FindInFolder.tsx:243 a file's chevron.
    pub fn toggle_folder_group(&mut self, rel: &str) {
        if let Some(f) = &mut self.folder_find
            && !f.collapsed.remove(rel)
        {
            f.collapsed.insert(rel.to_owned());
        }
    }

    /// FindInFolder.tsx:264 a hit's click: the panel closes and the file
    /// opens, its caret on the hit's line.
    pub fn pick_hit(&mut self, index: usize) -> Vec<Effect> {
        let Some(f) = &self.folder_find else {
            return Vec::new();
        };
        let Some(m) = f.matches.as_ref().and_then(|m| m.get(index)) else {
            return Vec::new();
        };
        let (root, rel) = (f.root.clone(), m.rel_path.clone());
        let line = (m.line.is_finite() && m.line >= 1.0).then_some(m.line as u32);
        self.folder_find = None;
        self.pick_path(&root, &rel, line)
    }

    // ---- the context menu ------------------------------------------------

    /// FileTree.tsx:259-263 / :382-386 a row's right click.
    pub fn open_menu(&mut self, tree: u64, rel: &str, is_dir: bool, x: f64, y: f64) {
        if self.trees.iter().any(|t| t.id == tree) {
            self.menu = Some(Menu {
                tree,
                rel_path: rel.to_owned(),
                is_dir,
                x,
                y,
                busy: false,
            });
        }
    }

    /// FilePathContextMenu.tsx:69-91 an outside click, Escape, another
    /// right click.
    pub fn close_menu(&mut self) {
        self.menu = None;
    }

    /// FilePathContextMenu.tsx:94-112 "Reveal in Finder". The tree passes
    /// its `root` to the menu only in search mode (FileTree.tsx:283-290 vs
    /// :339-345), so a row of an extra root's tree reveals under the
    /// primary root, as in the TS.
    pub fn reveal(&mut self) -> Vec<Effect> {
        let Some(menu) = &mut self.menu else {
            return Vec::new();
        };
        if menu.busy {
            return Vec::new();
        }
        menu.busy = true;
        let searching = !js::trim(&self.query).is_empty();
        let root = self
            .trees
            .iter()
            .find(|t| t.id == menu.tree)
            .and_then(|t| if searching { t.root.clone() } else { None });
        vec![Effect::Send(
            Call::Reveal,
            Request::Reveal {
                root,
                rel: menu.rel_path.clone(),
            },
        )]
    }

    /// "Find in folder" on a folder row's menu (the native page's mount
    /// point for FindInFolder, which the React page doesn't render).
    pub fn menu_find_in_folder(&mut self) {
        let Some(menu) = self.menu.take() else { return };
        let Some(tree) = self.trees.iter().find(|t| t.id == menu.tree) else {
            return;
        };
        let root = tree.root_id().to_owned();
        let label = rules::last_segment(menu.rel_path.trim_end_matches('/')).to_owned();
        self.open_folder_find(&root, &menu.rel_path, &label);
    }

    // ---- answers ---------------------------------------------------------

    /// A debounce fired.
    pub fn timer_fired(&mut self, timer: Timer) -> Vec<Effect> {
        match timer {
            Timer::TreeSearch { tree, seq } => {
                let q = js::trim(&self.query).to_owned();
                let Some(t) = self.trees.iter().find(|t| t.id == tree) else {
                    return Vec::new();
                };
                if t.search_seq != seq || q.is_empty() {
                    return Vec::new();
                }
                vec![Effect::Send(
                    Call::Search { tree, seq },
                    Request::Search {
                        root: t.root.clone(),
                        q,
                    },
                )]
            }
            Timer::FolderSearch { seq } => {
                let Some(f) = &mut self.folder_find else {
                    return Vec::new();
                };
                if f.seq != seq {
                    return Vec::new();
                }
                f.loading = true;
                vec![Effect::Send(
                    Call::ContentSearch { seq },
                    Request::ContentSearch {
                        root: f.root.clone(),
                        folder: f.folder.clone(),
                        q: js::trim(&f.query).to_owned(),
                        case_sensitive: f.case_sensitive,
                    },
                )]
            }
        }
    }

    fn tree_index(&self, id: u64) -> Option<usize> {
        self.trees.iter().position(|t| t.id == id)
    }

    /// An answer to an earlier [`Effect::Send`].
    pub fn answered(&mut self, call: Call, answer: Answer) -> Vec<Effect> {
        match (call, answer) {
            (Call::Roots { mount }, Answer::Roots(r)) => {
                if mount != self.mount {
                    return Vec::new();
                }
                self.roots = Some(match r {
                    Ok(list) => list,
                    // page.tsx:113-118 the soft fail: the primary root alone.
                    Err(_) => match &self.workspace {
                        Some((_, root)) => vec![WorkspaceRoot {
                            id: "primary".into(),
                            abs_path: root.clone(),
                            source: "primary".into(),
                        }],
                        None => return Vec::new(),
                    },
                });
                self.sync_trees()
            }
            (Call::TreeRoot { tree }, Answer::Listing(r)) => {
                let Some(i) = self.tree_index(tree) else {
                    return Vec::new();
                };
                let t = &mut self.trees[i];
                match r {
                    Ok(l) => {
                        t.loaded("", l.hidden);
                        t.root_entries = l.entries;
                    }
                    Err(e) => t.error = Some(e),
                }
                t.loading = false;
                Vec::new()
            }
            (Call::Toggle { tree, key }, Answer::Listing(r)) => {
                let Some(i) = self.tree_index(tree) else {
                    return Vec::new();
                };
                let t = &mut self.trees[i];
                match r {
                    Ok(l) => {
                        t.loaded(&key, l.hidden);
                        t.expanded.insert(key, l.entries);
                    }
                    Err(e) => {
                        t.dir_errors.insert(key.clone(), e);
                        t.expanded.insert(key, Vec::new());
                    }
                }
                Vec::new()
            }
            (Call::Walk { tree, step }, Answer::Listing(r)) => {
                let Some(i) = self.tree_index(tree) else {
                    return Vec::new();
                };
                let Ok(l) = r else {
                    // FileTree.tsx:196 a missing folder stops the walk.
                    return Vec::new();
                };
                let t = &mut self.trees[i];
                let Some((path, key)) = t.walk.get(step).cloned() else {
                    return Vec::new();
                };
                t.loaded(&path, l.hidden);
                t.expanded.entry(key).or_insert(l.entries);
                self.walk_step(i, step + 1)
            }
            (Call::Search { tree, seq }, Answer::Search(r)) => {
                let Some(t) = self.trees.iter_mut().find(|t| t.id == tree) else {
                    return Vec::new();
                };
                if t.search_seq != seq {
                    return Vec::new();
                }
                match r {
                    Ok(s) => {
                        t.search_results = Some(s.entries);
                        t.search_truncated = s.truncated;
                        t.search_error = None;
                    }
                    Err(e) => {
                        t.search_results = Some(Vec::new());
                        t.search_truncated = false;
                        t.search_error = Some(e);
                    }
                }
                Vec::new()
            }
            (
                Call::Pick {
                    mount,
                    line,
                    created,
                },
                Answer::File(r),
            ) => {
                if mount != self.mount {
                    return Vec::new();
                }
                if created {
                    // page.tsx:305-313 `await onPick(...)` then `finally`.
                    self.busy = None;
                }
                self.picked(r, line)
            }
            (Call::Save { mount }, Answer::Done(r)) => {
                if mount != self.mount {
                    return Vec::new();
                }
                self.busy = None;
                match r {
                    Ok(()) => {
                        self.dirty = false;
                        self.refresh()
                    }
                    Err(e) => {
                        self.error = Some(e);
                        Vec::new()
                    }
                }
            }
            (Call::Delete { mount }, Answer::Done(r)) => {
                if mount != self.mount {
                    return Vec::new();
                }
                self.busy = None;
                match r {
                    Ok(()) => {
                        self.open = None;
                        self.draft.clear();
                        self.dirty = false;
                        self.find = None;
                        self.image = None;
                        let mut fx = Vec::new();
                        if let Some(ws) = self.ws() {
                            fx.push(Effect::Store {
                                key: last_open::key_for(ws),
                                value: None,
                            });
                        }
                        fx.extend(self.refresh());
                        fx
                    }
                    Err(e) => {
                        self.error = Some(e);
                        Vec::new()
                    }
                }
            }
            (Call::Rename { mount, next }, Answer::Done(r)) => {
                if mount != self.mount {
                    return Vec::new();
                }
                self.busy = None;
                match r {
                    Ok(()) => {
                        let Some(open) = &mut self.open else {
                            return Vec::new();
                        };
                        open.rel_path = next.clone();
                        let root = open.root.clone();
                        let mut fx = vec![Effect::ReplaceUrl(rules::page_url(
                            &self.pathname,
                            &next,
                            &root,
                        ))];
                        if let Some(ws) = self.ws() {
                            fx.push(Effect::Store {
                                key: last_open::key_for(ws),
                                value: Some(last_open::serialize(&LastOpenFile {
                                    root,
                                    rel_path: next,
                                })),
                            });
                        }
                        fx.extend(self.refresh());
                        fx
                    }
                    Err(e) => {
                        self.error = Some(e);
                        Vec::new()
                    }
                }
            }
            (
                Call::Create {
                    mount,
                    kind,
                    path,
                    root,
                },
                Answer::Done(r),
            ) => {
                if mount != self.mount {
                    return Vec::new();
                }
                match r {
                    Ok(()) => {
                        let mut fx = self.refresh();
                        if kind == NewKind::File {
                            // page.tsx:305 the new file opens; `busy` stays
                            // until it has.
                            self.error = None;
                            fx.push(Effect::Send(
                                Call::Pick {
                                    mount,
                                    line: None,
                                    created: true,
                                },
                                Request::Read { root, rel: path },
                            ));
                        } else {
                            self.busy = None;
                        }
                        fx
                    }
                    Err(e) => {
                        self.busy = None;
                        self.error = Some(e);
                        Vec::new()
                    }
                }
            }
            (Call::ContentSearch { seq }, Answer::ContentSearch(r)) => {
                let Some(f) = &mut self.folder_find else {
                    return Vec::new();
                };
                if f.seq != seq {
                    return Vec::new();
                }
                match r {
                    Ok(s) => {
                        f.matches = Some(s.matches);
                        f.truncated = s.truncated;
                        f.scanned = s.scanned;
                        f.error = None;
                    }
                    Err(e) => {
                        f.error = Some(e);
                        f.matches = Some(Vec::new());
                    }
                }
                f.loading = false;
                Vec::new()
            }
            (Call::Reveal, Answer::Done(_)) => {
                // FilePathContextMenu.tsx:105-110 the tree passes no
                // `onError`: a failure is dropped; the menu closes.
                self.menu = None;
                Vec::new()
            }
            (Call::Image { mount, rel }, Answer::Image(r)) => {
                if mount == self.mount && self.open.as_ref().is_some_and(|o| o.rel_path == rel) {
                    self.image = r.ok();
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }
}

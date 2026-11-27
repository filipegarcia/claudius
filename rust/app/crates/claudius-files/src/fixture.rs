//! [`FixtureFilesData`]: an in-memory workspace behind [`FilesData`], for
//! the tests and the screenshots. It answers as the server's routes do in
//! shape (folders first, then by name; dotfiles and `node_modules` hidden
//! and counted; the filename search over lowered paths; a content search
//! line by line) without a disk, logs every call, and fails the calls a
//! test asks it to.

use std::collections::BTreeMap;
use std::sync::Mutex;

use claudius_core::js_string;
use futures::FutureExt as _;

use crate::data::{
    ContentMatch, ContentSearch, Entry, FileContent, FilesData, FilesFuture, FilesResult, Listing,
    NewKind, SearchResult, WorkspaceRoot,
};
use crate::model::Request;

/// A file of the fixture.
#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    Dir,
    File {
        content: String,
        /// The server's `binary: true` (no text sent).
        binary: bool,
        /// Its encoding when it isn't UTF-8 (`utf-16le`, `unsupported`).
        encoding: Option<(String, String)>,
        size: f64,
    },
}

/// The names the server's tree leaves out (with every dotfile).
const HIDDEN: [&str; 6] = ["node_modules", "dist", "build", ".git", ".next", "target"];

fn hidden(name: &str) -> bool {
    name.starts_with('.') || HIDDEN.contains(&name)
}

#[derive(Default)]
struct State {
    roots: Vec<WorkspaceRoot>,
    /// `(root id, path)`, a folder's path without its trailing `/`.
    nodes: BTreeMap<(String, String), Node>,
    log: Vec<Request>,
    /// `(what, path, message)`: the call fails with `message`.
    failures: Vec<(String, String, String)>,
    images: BTreeMap<(String, String), (Vec<u8>, String)>,
}

pub struct FixtureFilesData {
    state: Mutex<State>,
}

fn ready<T: Send + 'static>(v: FilesResult<T>) -> FilesFuture<T> {
    futures::future::ready(v).boxed()
}

impl Default for FixtureFilesData {
    fn default() -> Self {
        FixtureFilesData::new("/Users/demo/src/claudius")
    }
}

impl FixtureFilesData {
    /// An empty workspace whose primary root is `root_path`.
    pub fn new(root_path: &str) -> Self {
        let state = State {
            roots: vec![WorkspaceRoot {
                id: "primary".into(),
                abs_path: root_path.into(),
                source: "primary".into(),
            }],
            ..State::default()
        };
        FixtureFilesData {
            state: Mutex::new(state),
        }
    }

    fn st(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("fixture lock")
    }

    /// Adds an extra root (`extra:<n>`).
    pub fn with_root(self, id: &str, abs_path: &str, source: &str) -> Self {
        self.st().roots.push(WorkspaceRoot {
            id: id.into(),
            abs_path: abs_path.into(),
            source: source.into(),
        });
        self
    }

    fn insert(&self, root: &str, path: &str, node: Node) {
        let mut st = self.st();
        // The folders above it.
        let mut at = 0;
        while let Some(i) = path[at..].find('/') {
            let dir = &path[..at + i];
            st.nodes
                .entry((root.into(), dir.into()))
                .or_insert(Node::Dir);
            at += i + 1;
        }
        st.nodes.insert((root.into(), path.into()), node);
    }

    /// Adds a text file (and the folders above it).
    pub fn with_file(self, root: &str, path: &str, content: &str) -> Self {
        self.insert(
            root,
            path,
            Node::File {
                content: content.into(),
                binary: false,
                encoding: None,
                size: content.len() as f64,
            },
        );
        self
    }

    /// Adds a text file in another encoding (read-only).
    pub fn with_encoded(
        self,
        root: &str,
        path: &str,
        content: &str,
        enc: &str,
        label: &str,
    ) -> Self {
        self.insert(
            root,
            path,
            Node::File {
                content: content.into(),
                binary: false,
                encoding: Some((enc.into(), label.into())),
                size: content.len() as f64,
            },
        );
        self
    }

    /// Adds a binary file of `size` bytes.
    pub fn with_binary(self, root: &str, path: &str, size: f64) -> Self {
        self.insert(
            root,
            path,
            Node::File {
                content: String::new(),
                binary: true,
                encoding: None,
                size,
            },
        );
        self
    }

    /// The bytes `image` serves for a path.
    pub fn with_image(self, root: &str, path: &str, bytes: Vec<u8>, ty: &str) -> Self {
        self.st()
            .images
            .insert((root.into(), path.into()), (bytes, ty.into()));
        self
    }

    /// Adds an empty folder.
    pub fn with_dir(self, root: &str, path: &str) -> Self {
        self.insert(root, path.trim_end_matches('/'), Node::Dir);
        self
    }

    /// Fails `what` (`roots`, `list`, `search`, `read`, `save`, `delete`,
    /// `rename`, `create`, `content_search`, `reveal`, `image`) for `path`
    /// (`*`: any) with `message`.
    pub fn fail(&self, what: &str, path: &str, message: &str) {
        self.st()
            .failures
            .push((what.into(), path.into(), message.into()));
    }

    /// Stops failing everything.
    pub fn heal(&self) {
        self.st().failures.clear();
    }

    /// Every call so far.
    pub fn requests(&self) -> Vec<Request> {
        self.st().log.clone()
    }

    /// A file's text, if it's there.
    pub fn text(&self, root: &str, path: &str) -> Option<String> {
        match self.st().nodes.get(&(root.into(), path.into())) {
            Some(Node::File { content, .. }) => Some(content.clone()),
            _ => None,
        }
    }

    /// Whether a path exists.
    pub fn exists(&self, root: &str, path: &str) -> bool {
        self.st()
            .nodes
            .contains_key(&(root.into(), path.trim_end_matches('/').into()))
    }

    fn failure(&self, what: &str, path: &str) -> Option<String> {
        self.st()
            .failures
            .iter()
            .find(|(w, p, _)| w == what && (p == "*" || p == path))
            .map(|(_, _, m)| m.clone())
    }

    fn log(&self, r: Request) {
        self.st().log.push(r);
    }

    fn root_of(root: Option<&str>) -> String {
        root.unwrap_or("primary").to_owned()
    }

    fn entry(path: &str, node: &Node) -> Entry {
        let name = path.rsplit('/').next().unwrap_or(path).to_owned();
        match node {
            Node::Dir => Entry {
                name,
                rel_path: format!("{path}/"),
                is_dir: true,
                size_bytes: None,
                modified_ms: Some(1_795_723_200_000.0),
            },
            Node::File { size, .. } => Entry {
                name,
                rel_path: path.to_owned(),
                is_dir: false,
                size_bytes: Some(*size),
                modified_ms: Some(1_795_723_200_000.0),
            },
        }
    }

    /// A small project: the demo the fixture app and the screenshots open.
    pub fn builtin() -> Self {
        FixtureFilesData::default()
            .with_file("primary", "Cargo.toml", BUILTIN_CARGO)
            .with_file("primary", "README.md", BUILTIN_README)
            .with_file("primary", "src/main.rs", BUILTIN_MAIN)
            .with_file("primary", "src/tree.rs", BUILTIN_TREE)
            .with_file("primary", "src/preview.rs", BUILTIN_PREVIEW)
            .with_file("primary", "web/app.ts", BUILTIN_TS)
            .with_file(
                "primary",
                "docs/notes.txt",
                "Remember: the tree lists folders first.\n",
            )
            .with_binary("primary", "data/metrics.parquet", 482_113.0)
            .with_binary("primary", "data/archive.zip", 2_621_440.0)
            .with_dir("primary", "data/empty")
            .with_file("primary", ".gitignore", "target/\nnode_modules/\n")
            .with_dir("primary", "node_modules")
    }
}

impl FilesData for FixtureFilesData {
    fn roots(&self, _ws: &str) -> FilesFuture<Vec<WorkspaceRoot>> {
        self.log(Request::Roots);
        if let Some(e) = self.failure("roots", "*") {
            return ready(Err(e));
        }
        ready(Ok(self.st().roots.clone()))
    }

    fn list(&self, _ws: &str, root: Option<&str>, path: &str) -> FilesFuture<Listing> {
        self.log(Request::List {
            root: root.map(str::to_owned),
            path: path.to_owned(),
        });
        if let Some(e) = self.failure("list", path) {
            return ready(Err(e));
        }
        let root = Self::root_of(root);
        let dir = path.trim_end_matches('/');
        let st = self.st();
        if !dir.is_empty() && !matches!(st.nodes.get(&(root.clone(), dir.into())), Some(Node::Dir))
        {
            return ready(Err("path not found".into()));
        }
        let prefix = if dir.is_empty() {
            String::new()
        } else {
            format!("{dir}/")
        };
        let mut dirs = Vec::new();
        let mut files = Vec::new();
        let mut hidden_count = 0.0;
        for ((r, p), node) in &st.nodes {
            if *r != root {
                continue;
            }
            let Some(rest) = p.strip_prefix(&prefix) else {
                continue;
            };
            if rest.is_empty() || rest.contains('/') {
                continue;
            }
            if hidden(rest) {
                hidden_count += 1.0;
                continue;
            }
            let e = Self::entry(p, node);
            if e.is_dir {
                dirs.push(e)
            } else {
                files.push(e)
            }
        }
        dirs.extend(files);
        ready(Ok(Listing {
            entries: dirs,
            hidden: hidden_count,
        }))
    }

    fn search(&self, _ws: &str, root: Option<&str>, q: &str) -> FilesFuture<SearchResult> {
        self.log(Request::Search {
            root: root.map(str::to_owned),
            q: q.to_owned(),
        });
        if let Some(e) = self.failure("search", q) {
            return ready(Err(e));
        }
        let root = Self::root_of(root);
        let needle = js_string::to_lower(q);
        let st = self.st();
        let entries = st
            .nodes
            .iter()
            .filter(|((r, p), n)| {
                *r == root
                    && matches!(n, Node::File { .. })
                    && !p.split('/').any(hidden)
                    && js_string::to_lower(p).contains(&needle)
            })
            .map(|((_, p), n)| Self::entry(p, n))
            .collect();
        ready(Ok(SearchResult {
            entries,
            truncated: false,
        }))
    }

    fn read(&self, _ws: &str, root: &str, rel: &str) -> FilesFuture<FileContent> {
        self.log(Request::Read {
            root: root.to_owned(),
            rel: rel.to_owned(),
        });
        if let Some(e) = self.failure("read", rel) {
            return ready(Err(e));
        }
        let st = self.st();
        let Some(node) = st.nodes.get(&(root.into(), rel.into())) else {
            return ready(Err("path not found".into()));
        };
        let Node::File {
            content,
            binary,
            encoding,
            size,
        } = node
        else {
            return ready(Err("path is not a file".into()));
        };
        let mut f = FileContent {
            root: root.to_owned(),
            rel_path: rel.to_owned(),
            content: content.clone(),
            size_bytes: Some(*size),
            modified_ms: Some(1_795_723_200_000.0),
            encoding: Some("utf-8".into()),
            encoding_label: Some("UTF-8".into()),
            editable: Some(true),
            read_only_reason: None,
            binary: *binary,
        };
        if *binary {
            f.encoding = Some("unsupported".into());
            f.encoding_label = Some("binary".into());
            f.editable = Some(false);
            f.read_only_reason = Some("Binary file \u{2014} not shown as text.".into());
        } else if let Some((enc, label)) = encoding {
            f.encoding = Some(enc.clone());
            f.encoding_label = Some(label.clone());
            if enc == "unsupported" {
                f.editable = Some(false);
            }
        }
        ready(Ok(f))
    }

    fn save(&self, _ws: &str, root: &str, rel: &str, text: &str) -> FilesFuture<()> {
        self.log(Request::Save {
            root: root.to_owned(),
            rel: rel.to_owned(),
            text: text.to_owned(),
        });
        if let Some(e) = self.failure("save", rel) {
            return ready(Err(e));
        }
        self.insert(
            root,
            rel,
            Node::File {
                content: text.into(),
                binary: false,
                encoding: None,
                size: text.len() as f64,
            },
        );
        ready(Ok(()))
    }

    fn delete(&self, _ws: &str, root: &str, rel: &str) -> FilesFuture<()> {
        self.log(Request::Delete {
            root: root.to_owned(),
            rel: rel.to_owned(),
        });
        if let Some(e) = self.failure("delete", rel) {
            return ready(Err(e));
        }
        let mut st = self.st();
        let key = rel.trim_end_matches('/').to_owned();
        if st.nodes.remove(&(root.into(), key.clone())).is_none() {
            return ready(Err("not found".into()));
        }
        let prefix = format!("{key}/");
        st.nodes
            .retain(|(r, p), _| !(r == root && p.starts_with(&prefix)));
        ready(Ok(()))
    }

    fn rename(&self, _ws: &str, root: &str, rel: &str, next: &str) -> FilesFuture<()> {
        self.log(Request::Rename {
            root: root.to_owned(),
            rel: rel.to_owned(),
            next: next.to_owned(),
        });
        if let Some(e) = self.failure("rename", rel) {
            return ready(Err(e));
        }
        let node = self.st().nodes.remove(&(root.into(), rel.into()));
        let Some(node) = node else {
            return ready(Err("not found".into()));
        };
        self.insert(root, next, node);
        ready(Ok(()))
    }

    fn create(&self, _ws: &str, root: &str, path: &str, kind: NewKind) -> FilesFuture<()> {
        self.log(Request::Create {
            root: root.to_owned(),
            path: path.to_owned(),
            kind,
        });
        if let Some(e) = self.failure("create", path) {
            return ready(Err(e));
        }
        if self.exists(root, path) {
            return ready(Err("already exists".into()));
        }
        let node = match kind {
            NewKind::Dir => Node::Dir,
            NewKind::File => Node::File {
                content: String::new(),
                binary: false,
                encoding: None,
                size: 0.0,
            },
        };
        self.insert(root, path.trim_end_matches('/'), node);
        ready(Ok(()))
    }

    fn content_search(
        &self,
        _ws: &str,
        root: &str,
        folder: &str,
        q: &str,
        case_sensitive: bool,
    ) -> FilesFuture<ContentSearch> {
        self.log(Request::ContentSearch {
            root: root.to_owned(),
            folder: folder.to_owned(),
            q: q.to_owned(),
            case_sensitive,
        });
        if let Some(e) = self.failure("content_search", q) {
            return ready(Err(e));
        }
        let prefix = if folder.is_empty() || folder.ends_with('/') {
            folder.to_owned()
        } else {
            format!("{folder}/")
        };
        let st = self.st();
        let mut matches = Vec::new();
        let mut scanned = 0.0;
        for ((r, p), node) in &st.nodes {
            let Node::File {
                content,
                binary: false,
                ..
            } = node
            else {
                continue;
            };
            if r != root || !p.starts_with(&prefix) || p.split('/').any(hidden) {
                continue;
            }
            scanned += 1.0;
            for (n, line) in content.lines().enumerate() {
                let found = if case_sensitive {
                    crate::rules::find_matches(line, q, true)
                } else {
                    crate::rules::find_matches(line, q, false)
                };
                if let Some(m) = found.first() {
                    matches.push(ContentMatch {
                        rel_path: p.clone(),
                        line: (n + 1) as f64,
                        col: (m.start + 1) as f64,
                        col_end: (m.end + 1) as f64,
                        text: line.to_owned(),
                        truncated: false,
                    });
                }
            }
        }
        ready(Ok(ContentSearch {
            matches,
            truncated: false,
            scanned,
        }))
    }

    fn reveal(&self, _ws: &str, root: Option<&str>, rel: &str) -> FilesFuture<()> {
        self.log(Request::Reveal {
            root: root.map(str::to_owned),
            rel: rel.to_owned(),
        });
        match self.failure("reveal", rel) {
            Some(e) => ready(Err(e)),
            None => ready(Ok(())),
        }
    }

    fn image(&self, _ws: &str, root: &str, rel: &str) -> FilesFuture<(Vec<u8>, String)> {
        self.log(Request::Image {
            root: root.to_owned(),
            rel: rel.to_owned(),
        });
        if let Some(e) = self.failure("image", rel) {
            return ready(Err(e));
        }
        match self.st().images.get(&(root.into(), rel.into())) {
            Some(img) => ready(Ok(img.clone())),
            None => ready(Err("not an image".into())),
        }
    }
}

const BUILTIN_CARGO: &str = "[package]\nname = \"files-demo\"\nversion = \"0.1.0\"\nedition = \"2024\"\n\n[dependencies]\nserde_json = \"1\"\n";

const BUILTIN_README: &str = "# files-demo\n\nA small project the Files page opens: a tree, a preview and a search.\n\n- `src/main.rs` reads the tree\n- `src/tree.rs` sorts it, folders first\n";

const BUILTIN_MAIN: &str = r#"//! Lists a folder the way the Files page shows it.

use std::path::Path;

mod preview;
mod tree;

/// The largest file the preview opens as text (2 MiB).
const MAX_EDIT_BYTES: u64 = 2 * 1024 * 1024;

fn main() -> std::io::Result<()> {
    let root = std::env::args().nth(1).unwrap_or_else(|| ".".into());
    let entries = tree::list(Path::new(&root))?;
    for entry in &entries {
        let size = entry.size.map(preview::fmt_size).unwrap_or_default();
        println!("{:<32} {size}", entry.name);
    }
    println!("{} entries, folders first", entries.len());
    Ok(())
}
"#;

const BUILTIN_TREE: &str = r#"use std::path::Path;

/// One row of the tree.
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
    pub size: Option<u64>,
}

/// One level of `dir`, folders first, then by name.
pub fn list(dir: &Path) -> std::io::Result<Vec<Entry>> {
    let mut out = Vec::new();
    for item in std::fs::read_dir(dir)? {
        let item = item?;
        let meta = item.metadata()?;
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue; // hidden, as the tree hides dotfiles
        }
        out.push(Entry {
            size: meta.is_file().then(|| meta.len()),
            is_dir: meta.is_dir(),
            name,
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}
"#;

const BUILTIN_PREVIEW: &str = r#"/// `512 B`, `1.5 KB`, `2.0 MB`, as the tree prints sizes.
pub fn fmt_size(n: u64) -> String {
    if n < 1024 {
        format!("{n} B")
    } else if n < 1024 * 1024 {
        format!("{:.1} KB", n as f64 / 1024.0)
    } else {
        format!("{:.1} MB", n as f64 / 1024.0 / 1024.0)
    }
}
"#;

const BUILTIN_TS: &str = r#"export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
"#;

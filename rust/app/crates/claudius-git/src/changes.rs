//! The changes list's rules (`components/git/ChangesList.tsx`): which group
//! a porcelain entry lands in, the Group-By-Directory tree, the row labels
//! and tooltips, and the ↑ / ↓ walk.

use std::cmp::Ordering;
use std::collections::{BTreeSet, HashSet};
use std::sync::LazyLock;

use icu_collator::options::{CollatorOptions, Strength};
use icu_collator::preferences::CollationNumericOrdering;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};

use crate::types::GitFileChange;

/// `DiffSelection["mode"]`: HEAD → index, index → worktree, or /dev/null →
/// worktree.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum DiffMode {
    Staged,
    Worktree,
    Untracked,
}

impl DiffMode {
    pub fn as_str(self) -> &'static str {
        match self {
            DiffMode::Staged => "staged",
            DiffMode::Worktree => "worktree",
            DiffMode::Untracked => "untracked",
        }
    }

    pub fn parse(s: &str) -> Option<DiffMode> {
        match s {
            "staged" => Some(DiffMode::Staged),
            "worktree" => Some(DiffMode::Worktree),
            "untracked" => Some(DiffMode::Untracked),
            _ => None,
        }
    }

    /// `GitFileView`'s mode label.
    pub fn label(self) -> &'static str {
        match self {
            DiffMode::Staged => "Staged · HEAD → index",
            DiffMode::Untracked => "Untracked · /dev/null → working",
            DiffMode::Worktree => "Unstaged · index → working",
        }
    }
}

/// `DiffSelection`: the row whose diff is on screen.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct DiffSelection {
    pub path: String,
    pub mode: DiffMode,
}

impl DiffSelection {
    pub fn new(path: &str, mode: DiffMode) -> Self {
        DiffSelection {
            path: path.into(),
            mode,
        }
    }
}

/// `GroupKey`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum GroupKey {
    Staged,
    Unstaged,
    Untracked,
}

impl GroupKey {
    pub fn as_str(self) -> &'static str {
        match self {
            GroupKey::Staged => "staged",
            GroupKey::Unstaged => "unstaged",
            GroupKey::Untracked => "untracked",
        }
    }
}

/// `GROUPS` (ChangesList.tsx:129): the render order, each group's diff mode
/// and title.
pub const GROUPS: [(GroupKey, DiffMode, &str); 3] = [
    (GroupKey::Staged, DiffMode::Staged, "Staged"),
    (GroupKey::Unstaged, DiffMode::Worktree, "Changed"),
    (GroupKey::Untracked, DiffMode::Untracked, "Unversioned"),
];

fn has_index(f: &GitFileChange) -> bool {
    f.index != " " && f.index != "?"
}

fn has_worktree(f: &GitFileChange) -> bool {
    f.worktree != " " && f.worktree != "?"
}

fn is_added_then_deleted(f: &GitFileChange) -> bool {
    f.index == "A" && f.worktree == "D"
}

/// `isPartialStage` (ChangesList.tsx:41): staged AND unstaged work, `AD`
/// excluded (`groupFiles` hides it).
pub fn is_partial_stage(f: &GitFileChange) -> bool {
    if f.untracked || is_added_then_deleted(f) {
        return false;
    }
    has_index(f) && has_worktree(f)
}

/// `defaultDiffMode` (ChangesList.tsx:55).
pub fn default_diff_mode(f: &GitFileChange) -> DiffMode {
    if f.untracked {
        return DiffMode::Untracked;
    }
    if has_index(f) {
        DiffMode::Staged
    } else {
        DiffMode::Worktree
    }
}

/// `Grouped`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Grouped {
    pub staged: Vec<GitFileChange>,
    pub unstaged: Vec<GitFileChange>,
    pub untracked: Vec<GitFileChange>,
}

impl Grouped {
    pub fn get(&self, key: GroupKey) -> &[GitFileChange] {
        match key {
            GroupKey::Staged => &self.staged,
            GroupKey::Unstaged => &self.unstaged,
            GroupKey::Untracked => &self.untracked,
        }
    }

    /// `visibleFiles` (ChangesList.tsx:309): what the header counts and
    /// Select-all reaches.
    pub fn visible(&self) -> impl Iterator<Item = &GitFileChange> {
        self.staged
            .iter()
            .chain(&self.unstaged)
            .chain(&self.untracked)
    }

    pub fn visible_len(&self) -> usize {
        self.staged.len() + self.unstaged.len() + self.untracked.len()
    }
}

/// `groupFiles` (ChangesList.tsx:154): untracked to Unversioned, `AD`
/// dropped, any index change to Staged (once, partial or not), a worktree
/// change alone to Changed, a clean `"  "` nowhere.
pub fn group_files(files: &[GitFileChange]) -> Grouped {
    let mut out = Grouped::default();
    for f in files {
        if f.untracked {
            out.untracked.push(f.clone());
            continue;
        }
        if is_added_then_deleted(f) {
            continue;
        }
        if has_index(f) {
            out.staged.push(f.clone());
        } else if has_worktree(f) {
            out.unstaged.push(f.clone());
        }
    }
    out
}

/// `splitPath` (ChangesList.tsx:195): the directory segments and the leaf,
/// a trailing slash (an untracked nested repo) kept on the leaf.
pub fn split_path(p: &str) -> (Vec<String>, String) {
    let trailing = p.ends_with('/');
    let stripped = p.trim_end_matches('/');
    let mut segs: Vec<String> = stripped.split('/').map(str::to_owned).collect();
    let leaf = segs.pop().unwrap_or_else(|| p.to_owned());
    let leaf = if trailing { format!("{leaf}/") } else { leaf };
    (segs, leaf)
}

static BY_NAME: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
    let mut prefs = CollatorPreferences::default();
    prefs.numeric_ordering = Some(CollationNumericOrdering::True);
    let mut opts = CollatorOptions::default();
    opts.strength = Some(Strength::Primary);
    Collator::try_new(prefs, opts).expect("the root collation data is compiled in")
});

/// `byName` (ChangesList.tsx:202): `Intl.Collator(undefined, { numeric:
/// true, sensitivity: "base" }).compare`, on the root collation (what
/// `en` / node without a `LANG` collate with).
pub fn by_name(a: &str, b: &str) -> Ordering {
    BY_NAME.compare(a, b)
}

/// `DirNode`: one folder of the Group-By-Directory tree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirNode {
    /// The label, several segments after compaction (`a/b/c`).
    pub name: String,
    /// The repo-relative directory (`""` for a group's root).
    pub path: String,
    pub dirs: Vec<DirNode>,
    pub files: Vec<GitFileChange>,
    /// Every file path at or below: the tri-state checkbox's.
    pub file_paths: Vec<String>,
}

struct MutableDir {
    name: String,
    path: String,
    /// Insertion order, as the TS `Map`.
    dirs: Vec<(String, MutableDir)>,
    files: Vec<GitFileChange>,
}

/// `buildDirTree` (ChangesList.tsx:211): folders before files at every
/// level, both by [`by_name`] (a stable sort), file-less single-child
/// chains compacted into one node.
pub fn build_dir_tree(items: &[GitFileChange]) -> DirNode {
    let mut root = MutableDir {
        name: String::new(),
        path: String::new(),
        dirs: Vec::new(),
        files: Vec::new(),
    };
    for f in items {
        let mut node = &mut root;
        for seg in split_path(&f.path).0 {
            let at = match node.dirs.iter().position(|(k, _)| *k == seg) {
                Some(i) => i,
                None => {
                    let path = if node.path.is_empty() {
                        seg.clone()
                    } else {
                        format!("{}/{seg}", node.path)
                    };
                    node.dirs.push((
                        seg.clone(),
                        MutableDir {
                            name: seg.clone(),
                            path,
                            dirs: Vec::new(),
                            files: Vec::new(),
                        },
                    ));
                    node.dirs.len() - 1
                }
            };
            node = &mut node.dirs[at].1;
        }
        node.files.push(f.clone());
    }
    finalize_dir(root)
}

fn finalize_dir(m: MutableDir) -> DirNode {
    let mut dirs: Vec<DirNode> = m
        .dirs
        .into_iter()
        .map(|(_, d)| compact_dir(finalize_dir(d)))
        .collect();
    dirs.sort_by(|a, b| by_name(&a.name, &b.name));
    let mut files = m.files;
    files.sort_by(|a, b| by_name(&split_path(&a.path).1, &split_path(&b.path).1));
    let mut file_paths: Vec<String> = dirs.iter().flat_map(|d| d.file_paths.clone()).collect();
    file_paths.extend(files.iter().map(|f| f.path.clone()));
    DirNode {
        name: m.name,
        path: m.path,
        dirs,
        files,
        file_paths,
    }
}

/// `compactDir` (ChangesList.tsx:250): a file-less folder merges into its
/// only subfolder.
fn compact_dir(n: DirNode) -> DirNode {
    if !n.files.is_empty() || n.dirs.len() != 1 {
        return n;
    }
    let name = n.name;
    let only = n.dirs.into_iter().next().expect("one dir");
    DirNode {
        name: format!("{name}/{}", only.name),
        ..only
    }
}

/// `dirKey` (ChangesList.tsx:257): a folder's collapsed-state key.
pub fn dir_key(mode: DiffMode, path: &str) -> String {
    format!("{}:{path}", mode.as_str())
}

/// `statusCharForGroup` (ChangesList.tsx:976): the icon's code.
pub fn status_char_for_group(f: &GitFileChange, mode: DiffMode) -> &str {
    match mode {
        DiffMode::Untracked => "?",
        DiffMode::Staged => &f.index,
        DiffMode::Worktree => &f.worktree,
    }
}

/// `worktreeChangeLabel` (ChangesList.tsx:996).
pub fn worktree_change_label(code: &str) -> &'static str {
    match code {
        "M" => "modification",
        "D" => "deletion",
        "T" => "type change",
        "R" => "rename",
        "C" => "copy",
        _ => "change",
    }
}

/// `rowTitle` (ChangesList.tsx:986): the row's tooltip.
pub fn row_title(f: &GitFileChange, mode: DiffMode, can_open: bool) -> String {
    let title = if mode == DiffMode::Untracked {
        format!("{} (untracked)", f.path)
    } else if is_partial_stage(f) {
        format!(
            "{} — staged ({}) + unstaged ({})",
            f.path, f.index, f.worktree
        )
    } else {
        f.path.clone()
    };
    if can_open {
        format!("{title}\nDouble-click to open in a new window")
    } else {
        title
    }
}

/// The partial-stage marker's tooltip (ChangesList.tsx:897).
pub fn partial_title(f: &GitFileChange) -> String {
    format!(
        "Also has unstaged {} ({}{})",
        worktree_change_label(&f.worktree),
        f.index,
        f.worktree
    )
}

/// `displayPath` (ChangesList.tsx:1018): the full path flat, the leaf in a
/// folder; renames `old → new`, the old directory kept only if it moved.
pub fn display_path(f: &GitFileChange, mode: DiffMode, grouped: bool) -> String {
    let rename_code = |c: &str| c == "R" || c == "C";
    let old = f.old_path.as_deref().filter(|o| !o.is_empty());
    let is_rename = mode != DiffMode::Untracked
        && old.is_some()
        && (rename_code(&f.index) || rename_code(&f.worktree));
    if !grouped {
        return match (is_rename, old) {
            (true, Some(o)) => format!("{o} → {}", f.path),
            _ => f.path.clone(),
        };
    }
    let (cur_dirs, cur_leaf) = split_path(&f.path);
    let (true, Some(o)) = (is_rename, old) else {
        return cur_leaf;
    };
    let (old_dirs, old_leaf) = split_path(o);
    let same_dir = old_dirs.join("/") == cur_dirs.join("/");
    format!(
        "{} → {cur_leaf}",
        if same_dir { old_leaf.as_str() } else { o }
    )
}

/// `navOrder` (ChangesList.tsx:346): the file rows in on-screen order,
/// collapsed groups and folders skipped (folders before files).
pub fn nav_order(
    groups: &Grouped,
    by_directory: bool,
    collapsed_groups: &HashSet<GroupKey>,
    collapsed_dirs: &BTreeSet<String>,
) -> Vec<DiffSelection> {
    fn walk(
        node: &DirNode,
        mode: DiffMode,
        collapsed: &BTreeSet<String>,
        out: &mut Vec<DiffSelection>,
    ) {
        for d in &node.dirs {
            if !collapsed.contains(&dir_key(mode, &d.path)) {
                walk(d, mode, collapsed, out);
            }
        }
        for f in &node.files {
            out.push(DiffSelection::new(&f.path, mode));
        }
    }
    let mut out = Vec::new();
    for (key, mode, _) in GROUPS {
        if collapsed_groups.contains(&key) {
            continue;
        }
        if by_directory {
            walk(
                &build_dir_tree(groups.get(key)),
                mode,
                collapsed_dirs,
                &mut out,
            );
        } else {
            out.extend(
                groups
                    .get(key)
                    .iter()
                    .map(|f| DiffSelection::new(&f.path, mode)),
            );
        }
    }
    out
}

/// The ↑ / ↓ step (ChangesList.tsx:376): `None` when nothing moves; a
/// selection that isn't visible jumps to the first / last row.
pub fn step_selection(
    order: &[DiffSelection],
    selected: Option<&DiffSelection>,
    down: bool,
) -> Option<DiffSelection> {
    if order.is_empty() {
        return None;
    }
    let idx = selected.and_then(|s| order.iter().position(|o| o == s));
    let next = match idx {
        None => {
            if down {
                0
            } else {
                order.len() - 1
            }
        }
        Some(i) => {
            if down {
                (i + 1).min(order.len() - 1)
            } else {
                i.saturating_sub(1)
            }
        }
    };
    (idx != Some(next)).then(|| order[next].clone())
}

/// A folder's tri-state checkbox (ChangesList.tsx:739): `Some(true)` all
/// checked, `Some(false)` none, `None` some (indeterminate).
pub fn dir_checked(node: &DirNode, is_checked: impl Fn(&str) -> bool) -> Option<bool> {
    let n = node.file_paths.iter().filter(|p| is_checked(p)).count();
    if n == node.file_paths.len() {
        Some(true)
    } else if n == 0 {
        Some(false)
    } else {
        None
    }
}

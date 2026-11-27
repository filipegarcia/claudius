//! The command palette's model (`components/overlays/CommandPalette.tsx`):
//! the rows it searches (navigation destinations, slash commands, keyboard
//! shortcuts), `fuzzyMatch` and the ranking, the selection the arrows move
//! and what activating a row does. [`crate::view::palette`] draws it.

use std::cmp::Ordering;

use claudius_core::collate::locale_compare;

use crate::ShortcutRow;
use crate::js;
use crate::slash::SlashCommand;

/// `ItemKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ItemKind {
    Nav,
    Slash,
    Shortcut,
}

impl ItemKind {
    /// The TS id (the row's `data-kind`).
    pub fn id(self) -> &'static str {
        match self {
            ItemKind::Nav => "nav",
            ItemKind::Slash => "slash",
            ItemKind::Shortcut => "shortcut",
        }
    }

    /// `kindRank` (CommandPalette.tsx:260): nav before slash before
    /// shortcut among equal scores.
    pub fn rank(self) -> u8 {
        match self {
            ItemKind::Nav => 0,
            ItemKind::Slash => 1,
            ItemKind::Shortcut => 2,
        }
    }
}

/// `Item`: one row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub id: String,
    pub kind: ItemKind,
    pub label: String,
    /// The secondary line: a description, an args hint, a chord.
    pub detail: Option<String>,
    /// Where Enter goes (`router.push`); only the nav rows have one.
    pub href: Option<String>,
}

/// A navigation destination: its label (as `SideNav` shows it) and path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NavEntry {
    pub label: &'static str,
    pub path: &'static str,
}

const fn nav(label: &'static str, path: &'static str) -> NavEntry {
    NavEntry { label, path }
}

/// `WORKSPACE_NAV` (CommandPalette.tsx:69-89): the workspace-scoped
/// routes, prefixed with the active workspace.
pub const WORKSPACE_NAV: [NavEntry; 19] = [
    nav("Chat", ""),
    nav("Sessions", "/sessions"),
    nav("Files", "/files"),
    nav("Git", "/git"),
    nav("Memory", "/memory"),
    nav("Assets", "/assets"),
    nav("Cost", "/cost"),
    nav("Agents", "/agents"),
    nav("Skills", "/skills"),
    nav("MCP", "/mcp"),
    nav("Hooks", "/hooks"),
    nav("Schedule", "/schedule"),
    nav("Permissions", "/permissions"),
    nav("Docker", "/docker"),
    nav("Tracker", "/tracker"),
    nav("Database", "/database"),
    nav("Notebooks", "/notebooks"),
    nav("Workspace settings", "/workspace"),
    nav("Keybindings", "/keybindings"),
];

/// `GLOBAL_NAV` (CommandPalette.tsx:91-100).
pub const GLOBAL_NAV: [NavEntry; 8] = [
    nav("Settings", "/settings"),
    nav("Plugins", "/plugins"),
    nav("Customize", "/customize"),
    nav("Community", "/community"),
    nav("Usage / Billing", "/usage"),
    nav("Doctor", "/doctor"),
    nav("Release notes", "/release-notes"),
    nav("Updater", "/updater"),
];

/// At most this many rows show (CommandPalette.tsx:267, `slice(0, 60)`).
pub const MAX_ROWS: usize = 60;

/// What the search box shows before anything is typed.
pub const PLACEHOLDER: &str = "Type to search nav, slash commands, shortcuts\u{2026}";

/// The empty list's line.
pub const NO_MATCHES: &str = "No matches.";

/// `fuzzyMatch(target, query)` (CommandPalette.tsx:107-121): every
/// character of the query appears in the target in order (both
/// lowercased, compared by UTF-16 code unit); the score is the matched
/// units over the target's length. `Some(0.)` for an empty query.
pub fn fuzzy_match(target: &str, query: &str) -> Option<f64> {
    if query.is_empty() {
        return Some(0.);
    }
    let t = js::units(&js::lower(target));
    let q = js::units(&js::lower(query));
    let mut qi = 0;
    let mut matched = 0usize;
    let mut i = 0;
    while i < t.len() && qi < q.len() {
        if t[i] == q[qi] {
            qi += 1;
            matched += 1;
        }
        i += 1;
    }
    if qi < q.len() {
        return None;
    }
    Some(matched as f64 / t.len().max(1) as f64)
}

/// `workspaceIdFromPathname` (lib/shared/route-params.ts:44-47): the
/// `wks_` + 12 hex id a `/<id>/…` path is scoped to.
pub fn workspace_id_from_pathname(pathname: &str) -> Option<&str> {
    let rest = pathname.strip_prefix('/')?;
    let id = rest.get(..16)?;
    let hex = id.strip_prefix("wks_")?;
    let after = &rest[16..];
    let hex = hex
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    (hex && (after.is_empty() || after.starts_with('/'))).then_some(id)
}

/// `shortcutDetail` (CommandPalette.tsx:123-129): the chord, or "no
/// default".
pub fn shortcut_detail(row: &ShortcutRow) -> String {
    row.chord.clone().unwrap_or_else(|| "no default".into())
}

/// The `items` memo (CommandPalette.tsx:188-249): the nav rows (under the
/// workspace in the URL, else the bare paths the redirects resolve), the
/// global routes, every slash command, every shortcut.
pub fn build_items(
    workspace_id: Option<&str>,
    slash: &[SlashCommand],
    shortcuts: &[ShortcutRow],
) -> Vec<Item> {
    let mut out = Vec::new();
    for n in &WORKSPACE_NAV {
        let (id, href) = match workspace_id {
            Some(ws) => (format!("nav:{ws}{}", n.path), format!("/{ws}{}", n.path)),
            None => (
                format!("nav:{}", n.path),
                if n.path.is_empty() { "/" } else { n.path }.to_owned(),
            ),
        };
        out.push(Item {
            id,
            kind: ItemKind::Nav,
            label: n.label.into(),
            detail: None,
            href: Some(href),
        });
    }
    for n in &GLOBAL_NAV {
        out.push(Item {
            id: format!("nav:{}", n.path),
            kind: ItemKind::Nav,
            label: n.label.into(),
            detail: None,
            href: Some(n.path.into()),
        });
    }
    for c in slash {
        out.push(Item {
            id: format!("slash:{}", c.id),
            kind: ItemKind::Slash,
            label: format!("/{}", c.name),
            detail: Some(match c.args_hint.filter(|h| !h.is_empty()) {
                Some(h) => format!("{h} \u{2014} {}", c.description),
                None => c.description.into(),
            }),
            href: None,
        });
    }
    for a in shortcuts {
        out.push(Item {
            id: format!("shortcut:{}", a.id),
            kind: ItemKind::Shortcut,
            label: a.label.clone(),
            detail: Some(shortcut_detail(a)),
            href: None,
        });
    }
    out
}

/// The `filtered` memo (CommandPalette.tsx:251-268): the rows whose
/// `"<label> <detail>"` fuzzy-matches the trimmed query, best score first,
/// then nav / slash / shortcut, then `localeCompare` of the labels (a
/// stable sort); at most [`MAX_ROWS`].
pub fn filter_items(items: &[Item], query: &str) -> Vec<Item> {
    let q = js::trim(query);
    let mut scored: Vec<(&Item, f64)> = items
        .iter()
        .filter_map(|item| {
            let target = format!("{} {}", item.label, item.detail.as_deref().unwrap_or(""));
            fuzzy_match(&target, q).map(|s| (item, s))
        })
        .collect();
    scored.sort_by(|(a, sa), (b, sb)| {
        sb.partial_cmp(sa)
            .unwrap_or(Ordering::Equal)
            .then(a.kind.rank().cmp(&b.kind.rank()))
            .then_with(|| locale_compare(&a.label, &b.label))
    });
    scored
        .into_iter()
        .take(MAX_ROWS)
        .map(|(i, _)| i.clone())
        .collect()
}

/// `clampedActive` (CommandPalette.tsx:274-275): the stored index, at most
/// the last row; 0 for an empty list. It can be -1: ArrowDown on an empty
/// list stores `min(-1, …)`, and a later list keeps it until a key moves it.
pub fn clamp_active(len: usize, active: i64) -> i64 {
    if len == 0 {
        0
    } else {
        active.min(len as i64 - 1)
    }
}

/// The keys the search box handles (`onInputKey`, CommandPalette.tsx:289-304).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaletteKey {
    Down,
    Up,
    Enter,
}

/// What activating a row does (`activate`, CommandPalette.tsx:277-287):
/// the palette always closes; a nav row also goes to its `href`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Activation {
    /// An informational row (a slash command, a shortcut): close only.
    Close,
    /// `router.push(href)`.
    Navigate(String),
}

fn activation(item: &Item) -> Activation {
    match &item.href {
        Some(href) => Activation::Navigate(href.clone()),
        None => Activation::Close,
    }
}

/// One open palette: its rows, the query and the selection. A fresh one
/// is what `togglePalette` opens (an empty query, the first row).
#[derive(Clone, Debug)]
pub struct Palette {
    items: Vec<Item>,
    query: String,
    /// `activeIndex`, as stored (see [`clamp_active`]).
    active: i64,
    filtered: Vec<Item>,
}

impl Palette {
    pub fn new(items: Vec<Item>) -> Palette {
        let filtered = filter_items(&items, "");
        Palette {
            items,
            query: String::new(),
            active: 0,
            filtered,
        }
    }

    pub fn items(&self) -> &[Item] {
        &self.items
    }

    pub fn query(&self) -> &str {
        &self.query
    }

    /// The search box changed (`setQuery`); the selection stays where it was.
    pub fn set_query(&mut self, query: &str) {
        if self.query != query {
            self.query = query.into();
            self.filtered = filter_items(&self.items, &self.query);
        }
    }

    /// The rows the query shows.
    pub fn rows(&self) -> &[Item] {
        &self.filtered
    }

    /// The highlighted row's index (-1: none, see [`clamp_active`]).
    pub fn active(&self) -> i64 {
        clamp_active(self.filtered.len(), self.active)
    }

    /// The highlighted row.
    pub fn active_item(&self) -> Option<&Item> {
        usize::try_from(self.active())
            .ok()
            .and_then(|i| self.filtered.get(i))
    }

    /// The pointer entered a row (`onHover`).
    pub fn hover(&mut self, index: usize) {
        self.active = index as i64;
    }

    /// A row was clicked (`onActivate`).
    pub fn click(&self, index: usize) -> Option<Activation> {
        self.filtered.get(index).map(activation)
    }

    /// A key in the search box: the arrows move the selection (clamped to
    /// the list), Enter activates the highlighted row (nothing when there
    /// is none).
    pub fn key(&mut self, key: PaletteKey) -> Option<Activation> {
        let len = self.filtered.len() as i64;
        let at = self.active();
        match key {
            PaletteKey::Down => {
                self.active = (len - 1).min(at + 1);
                None
            }
            PaletteKey::Up => {
                self.active = 0.max(at - 1);
                None
            }
            PaletteKey::Enter => self.active_item().map(activation),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::slash::SLASH_COMMANDS;

    fn row(id: &str, label: &str, chord: Option<&str>) -> ShortcutRow {
        ShortcutRow {
            id: id.into(),
            label: label.into(),
            description: None,
            category: "navigation".into(),
            chord: chord.map(Into::into),
        }
    }

    const W: &str = "wks_3f2a9c81d0e4";

    #[test]
    fn fuzzy_match_is_an_in_order_subsequence_scored_per_target_length() {
        assert_eq!(fuzzy_match("Chat ", ""), Some(0.));
        assert_eq!(fuzzy_match("Chat ", "CH"), Some(0.4));
        assert_eq!(fuzzy_match("Chat ", "ct"), Some(0.4));
        assert_eq!(fuzzy_match("Chat ", "tc"), None);
        assert_eq!(fuzzy_match("", "a"), None);
        assert_eq!(fuzzy_match("aaa", "aaaa"), None);
        // UTF-16 units: the emoji is two.
        assert_eq!(fuzzy_match("x\u{1f600}y", "xy"), Some(0.5));
    }

    #[test]
    fn workspace_id_from_pathname_takes_a_wks_id_segment() {
        assert_eq!(workspace_id_from_pathname(&format!("/{W}")), Some(W));
        assert_eq!(
            workspace_id_from_pathname(&format!("/{W}/sessions")),
            Some(W)
        );
        assert_eq!(workspace_id_from_pathname(&format!("/{W}x")), None);
        assert_eq!(workspace_id_from_pathname("/WKS_3F2A9C81D0E4"), None);
        assert_eq!(workspace_id_from_pathname("/settings"), None);
        assert_eq!(workspace_id_from_pathname(""), None);
        assert_eq!(workspace_id_from_pathname("/wks_3f2a9c81d0eg"), None);
    }

    #[test]
    fn build_items_lists_nav_global_slash_then_shortcuts() {
        let rows = [
            row(
                "nav.commandPalette",
                "Open command palette",
                Some("\u{2318}K"),
            ),
            row("window.zoom", "Zoom window", None),
        ];
        let items = build_items(Some(W), SLASH_COMMANDS, &rows);
        assert_eq!(items.len(), 19 + 8 + SLASH_COMMANDS.len() + 2);
        assert_eq!(items[0].id, format!("nav:{W}"));
        assert_eq!(items[0].href.as_deref(), Some(&*format!("/{W}")));
        assert_eq!(items[1].href.as_deref(), Some(&*format!("/{W}/sessions")));
        assert_eq!(items[19].id, "nav:/settings");
        let compact = items.iter().find(|i| i.id == "slash:compact").unwrap();
        assert_eq!(compact.label, "/compact");
        assert_eq!(
            compact.detail.as_deref(),
            Some("[focus instructions] \u{2014} Compact the conversation to free up context.")
        );
        assert_eq!(items.last().unwrap().detail.as_deref(), Some("no default"));
        // No workspace in the URL: the bare paths, the chat as "/".
        let bare = build_items(None, &[], &[]);
        assert_eq!(bare[0].id, "nav:");
        assert_eq!(bare[0].href.as_deref(), Some("/"));
        assert_eq!(bare[1].href.as_deref(), Some("/sessions"));
    }

    #[test]
    fn filter_items_ranks_by_score_then_kind_then_label_and_caps_at_60() {
        let items = build_items(Some(W), SLASH_COMMANDS, &[]);
        let all = filter_items(&items, "");
        assert_eq!(all.len(), MAX_ROWS);
        // An empty query: every score is 0, so nav first, alphabetically.
        assert_eq!(all[0].label, "Agents");
        assert_eq!(all[1].label, "Assets");
        assert_eq!(all[2].label, "Chat");
        let git = filter_items(&items, "  git  ");
        assert_eq!(git[0].id, format!("nav:{W}/git"));
        assert!(filter_items(&items, "zzzz").is_empty());
    }

    #[test]
    fn the_arrows_clamp_and_enter_activates_the_highlighted_row() {
        let items = build_items(Some(W), SLASH_COMMANDS, &[]);
        let mut p = Palette::new(items);
        assert_eq!(p.active(), 0);
        assert_eq!(p.key(PaletteKey::Up), None);
        assert_eq!(p.active(), 0);
        p.key(PaletteKey::Down);
        p.key(PaletteKey::Down);
        assert_eq!(p.active(), 2);
        assert_eq!(
            p.key(PaletteKey::Enter),
            Some(Activation::Navigate(format!("/{W}")))
        );
        for _ in 0..70 {
            p.key(PaletteKey::Down);
        }
        assert_eq!(p.active(), 59);
        // A slash row only closes.
        assert_eq!(p.key(PaletteKey::Enter), Some(Activation::Close));
    }

    #[test]
    fn arrow_down_on_an_empty_list_leaves_no_row_selected() {
        let items = build_items(Some(W), SLASH_COMMANDS, &[]);
        let mut p = Palette::new(items);
        p.set_query("zzzz");
        assert_eq!(p.key(PaletteKey::Enter), None);
        p.key(PaletteKey::Down);
        p.set_query("");
        assert_eq!(p.active(), -1);
        assert_eq!(p.key(PaletteKey::Enter), None);
        p.key(PaletteKey::Down);
        assert_eq!(p.active(), 0);
    }

    #[test]
    fn typing_keeps_the_selection_and_hover_moves_it() {
        let items = build_items(Some(W), SLASH_COMMANDS, &[]);
        let mut p = Palette::new(items);
        p.hover(59);
        assert_eq!(p.active(), 59);
        p.set_query("git");
        // Clamped to the shorter list.
        assert!(p.rows().len() < 59);
        assert_eq!(p.active(), p.rows().len() as i64 - 1);
        assert_eq!(p.click(0), Some(Activation::Navigate(format!("/{W}/git"))));
        // The stored index survives the shorter list.
        p.set_query("");
        assert_eq!(p.active(), 59);
        assert_eq!(p.click(999), None);
    }

    #[test]
    fn clamp_active_reads_the_stored_index_against_the_list() {
        assert_eq!(clamp_active(0, 5), 0);
        assert_eq!(clamp_active(0, -1), 0);
        assert_eq!(clamp_active(3, 5), 2);
        assert_eq!(clamp_active(3, -1), -1);
        assert_eq!(clamp_active(3, 1), 1);
    }
}

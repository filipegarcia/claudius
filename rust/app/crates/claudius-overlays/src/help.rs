//! The help overlays' models.
//!
//! - [`HelpModel`]: `components/overlays/HelpOverlay.tsx`, ChatSurface's
//!   `overlay === "help"` (`/help [command]`, `/<command> --help`): the
//!   merged slash commands, filtered and grouped by category, and the
//!   usage card a topic opens on.
//! - [`CheatsheetModel`]: the keyboard cheatsheet `nav.cheatsheet` (⌘/)
//!   opens. The branch's React registers the action ("Show keyboard
//!   cheatsheet", the Electron menu's View → Keyboard Shortcuts) but
//!   nothing handles it, so there is no TS overlay to port: this one is
//!   `HelpOverlay`'s layout over the shortcut registry, grouped as
//!   Settings' `ShortcutsSection` groups it (its `CATEGORY_ORDER` and
//!   `CATEGORY_LABEL`, ShortcutsSection.tsx:28-47).

use crate::ShortcutRow;
use crate::js;
use crate::slash::{
    Category, SdkCommandInfo, SlashSuggestion, find_help_topic, merge_suggestions, usage_line,
};

/// The overlay's title and its filter box's placeholder.
pub const HELP_TITLE: &str = "Slash commands";
pub const HELP_PLACEHOLDER: &str = "Filter commands\u{2026}";
/// The footer's legend (HelpOverlay.tsx:109-113), as its three parts.
pub const HELP_LEGEND: [(&str, &str); 3] = [
    ("app", " = handled in the browser \u{b7} "),
    ("sdk", " = forwarded to Claude Code \u{b7} "),
    ("external", " = terminal/hosted only"),
];

/// A category's section: its heading and its commands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HelpGroup<'a> {
    pub category: Category,
    /// `${CATEGORY_LABELS[cat]} · ${list.length}` (HelpOverlay.tsx:78).
    pub heading: String,
    pub commands: Vec<&'a SlashSuggestion>,
}

/// The card above the list a topic opens on (`TopicUsage`,
/// HelpOverlay.tsx:118-142).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TopicCard {
    /// `No command named /<topic>.`
    Missing { topic: String },
    Usage {
        /// `usageLine(cmd)`.
        usage: String,
        description: String,
        /// `Also: /a, /b`, when it has aliases.
        aliases: Vec<String>,
    },
}

/// The help overlay's state: its props (the session's SDK commands and
/// skills, the rich list once fetched, the topic) and the filter text.
#[derive(Clone, Debug)]
pub struct HelpModel {
    sdk_slash_commands: Vec<String>,
    sdk_skills: Vec<String>,
    rich: Option<Vec<SdkCommandInfo>>,
    topic: Option<String>,
    all: Vec<SlashSuggestion>,
    filter: String,
}

impl HelpModel {
    /// The overlay as it opens: the filter starts at the topic
    /// (`useState(topic ?? "")`, HelpOverlay.tsx:36).
    pub fn new(
        sdk_slash_commands: Vec<String>,
        sdk_skills: Vec<String>,
        topic: Option<String>,
    ) -> HelpModel {
        let all = merge_suggestions(&sdk_slash_commands, &sdk_skills, None);
        HelpModel {
            filter: topic.clone().unwrap_or_default(),
            sdk_slash_commands,
            sdk_skills,
            rich: None,
            topic,
            all,
        }
    }

    /// The rich command list arrived (`useSdkCommands`); `None` while it
    /// loads or when the fetch failed.
    pub fn set_rich(&mut self, rich: Option<Vec<SdkCommandInfo>>) {
        self.all = merge_suggestions(&self.sdk_slash_commands, &self.sdk_skills, rich.as_deref());
        self.rich = rich;
    }

    /// Every command (`all`).
    pub fn all(&self) -> &[SlashSuggestion] {
        &self.all
    }

    pub fn filter(&self) -> &str {
        &self.filter
    }

    pub fn set_filter(&mut self, filter: &str) {
        self.filter = filter.into();
    }

    pub fn topic(&self) -> Option<&str> {
        self.topic.as_deref()
    }

    /// `Help · ${all.length} commands` (HelpOverlay.tsx:59).
    pub fn subtitle(&self) -> String {
        format!("Help \u{b7} {} commands", self.all.len())
    }

    /// The `grouped` memo (HelpOverlay.tsx:39-56): the commands whose name
    /// or an alias contains the trimmed, lowercased filter (as typed: the
    /// names aren't lowercased) or whose lowercased description does, by
    /// category in the merged list's order.
    pub fn groups(&self) -> Vec<HelpGroup<'_>> {
        let f = js::lower(js::trim(&self.filter));
        let keep = |c: &SlashSuggestion| {
            f.is_empty()
                || c.name.contains(&f)
                || c.aliases.iter().any(|a| a.contains(&f))
                || js::lower(&c.description).contains(&f)
        };
        let mut groups: Vec<HelpGroup<'_>> = Vec::new();
        for c in self.all.iter().filter(|c| keep(c)) {
            match groups.iter_mut().find(|g| g.category == c.category) {
                Some(g) => g.commands.push(c),
                None => groups.push(HelpGroup {
                    category: c.category,
                    heading: String::new(),
                    commands: vec![c],
                }),
            }
        }
        for g in &mut groups {
            g.heading = format!("{} \u{b7} {}", g.category.label(), g.commands.len());
        }
        groups
    }

    /// The usage card: only while the filter (trimmed, lowercased) is still
    /// the topic it opened with (HelpOverlay.tsx:71-73).
    pub fn card(&self) -> Option<TopicCard> {
        let topic = self.topic.as_deref().filter(|t| !t.is_empty())?;
        if js::lower(js::trim(&self.filter)) != topic {
            return None;
        }
        Some(match find_help_topic(&self.all, topic) {
            None => TopicCard::Missing {
                topic: topic.into(),
            },
            Some(c) => TopicCard::Usage {
                usage: usage_line(c),
                description: c.description.clone(),
                aliases: c.aliases.clone(),
            },
        })
    }
}

/// The cheatsheet's title and its filter box's placeholder.
pub const CHEATSHEET_TITLE: &str = "Keyboard shortcuts";
pub const CHEATSHEET_PLACEHOLDER: &str = "Filter shortcuts\u{2026}";

/// `ShortcutsSection`'s `CATEGORY_ORDER` and `CATEGORY_LABEL`
/// (ShortcutsSection.tsx:28-47).
pub const SHORTCUT_CATEGORIES: [(&str, &str); 6] = [
    ("tabs", "Session tabs"),
    ("workspaces", "Workspaces"),
    ("navigation", "Side-nav navigation"),
    ("window", "Window controls"),
    ("view", "View"),
    ("app", "Application"),
];

/// A cheatsheet section.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheatsheetGroup<'a> {
    pub category: &'static str,
    /// `${label} · ${count}`, as the help overlay's headings.
    pub heading: String,
    pub rows: Vec<&'a ShortcutRow>,
}

/// The cheatsheet's state: the registry's rows and the filter text.
#[derive(Clone, Debug)]
pub struct CheatsheetModel {
    rows: Vec<ShortcutRow>,
    filter: String,
}

impl CheatsheetModel {
    pub fn new(rows: Vec<ShortcutRow>) -> CheatsheetModel {
        CheatsheetModel {
            rows,
            filter: String::new(),
        }
    }

    pub fn rows(&self) -> &[ShortcutRow] {
        &self.rows
    }

    pub fn filter(&self) -> &str {
        &self.filter
    }

    pub fn set_filter(&mut self, filter: &str) {
        self.filter = filter.into();
    }

    /// `Help · ${n} shortcuts`.
    pub fn subtitle(&self) -> String {
        format!("Help \u{b7} {} shortcuts", self.rows.len())
    }

    /// The sections in `ShortcutsSection`'s order, the registry's order
    /// within each, empty ones dropped (ShortcutsSection.tsx:61-68, 118-120);
    /// the filter keeps the rows whose id, lowercased label or lowercased
    /// description contains it, as the help overlay's does.
    pub fn groups(&self) -> Vec<CheatsheetGroup<'_>> {
        let f = js::lower(js::trim(&self.filter));
        let keep = |r: &ShortcutRow| {
            f.is_empty()
                || r.id.contains(&f)
                || js::lower(&r.label).contains(&f)
                || r.description
                    .as_deref()
                    .is_some_and(|d| js::lower(d).contains(&f))
        };
        SHORTCUT_CATEGORIES
            .iter()
            .filter_map(|(cat, label)| {
                let rows: Vec<&ShortcutRow> = self
                    .rows
                    .iter()
                    .filter(|r| r.category == *cat && keep(r))
                    .collect();
                (!rows.is_empty()).then(|| CheatsheetGroup {
                    category: cat,
                    heading: format!("{label} \u{b7} {}", rows.len()),
                    rows,
                })
            })
            .collect()
    }
}

/// The chord the cheatsheet prints for a row: `formatBinding(null)` is
/// `—` (shortcuts.ts:692).
pub fn chord_text(row: &ShortcutRow) -> &str {
    row.chord.as_deref().unwrap_or("\u{2014}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| (*x).to_owned()).collect()
    }

    #[test]
    fn the_filter_starts_at_the_topic() {
        let m = HelpModel::new(Vec::new(), Vec::new(), Some("clear".into()));
        assert_eq!(m.filter(), "clear");
        assert_eq!(HelpModel::new(Vec::new(), Vec::new(), None).filter(), "");
    }

    #[test]
    fn groups_match_names_aliases_and_descriptions() {
        let mut m = HelpModel::new(s(&["Deploy"]), Vec::new(), None);
        m.set_filter("reset");
        let g = m.groups();
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].commands[0].id, "clear");
        assert_eq!(g[0].heading, "Session \u{b7} 1");
        // The name is matched as typed: an upper-case SDK name misses.
        m.set_filter("deploy");
        assert!(
            m.groups()
                .iter()
                .all(|g| g.commands.iter().all(|c| c.name != "Deploy"))
        );
        // The description is lowercased.
        m.set_filter("  FRESH SESSION ");
        assert_eq!(m.groups()[0].commands[0].id, "clear");
        m.set_filter("");
        let n: usize = m.groups().iter().map(|g| g.commands.len()).sum();
        assert_eq!(n, m.all().len());
    }

    #[test]
    fn the_card_follows_the_topic_until_the_filter_changes() {
        let mut m = HelpModel::new(Vec::new(), Vec::new(), Some("reset".into()));
        match m.card() {
            Some(TopicCard::Usage { usage, aliases, .. }) => {
                assert_eq!(usage, "/clear");
                assert_eq!(aliases, s(&["reset", "new"]));
            }
            other => panic!("{other:?}"),
        }
        m.set_filter(" RESET ");
        assert!(m.card().is_some());
        m.set_filter("rese");
        assert_eq!(m.card(), None);
        let missing = HelpModel::new(Vec::new(), Vec::new(), Some("nope".into()));
        assert_eq!(
            missing.card(),
            Some(TopicCard::Missing {
                topic: "nope".into()
            })
        );
        assert_eq!(
            HelpModel::new(Vec::new(), Vec::new(), Some(String::new())).card(),
            None
        );
    }

    #[test]
    fn the_subtitle_counts_every_merged_command() {
        let mut m = HelpModel::new(s(&["deploy"]), Vec::new(), None);
        let n = m.all().len();
        assert_eq!(m.subtitle(), format!("Help \u{b7} {n} commands"));
        m.set_rich(Some(vec![SdkCommandInfo {
            name: "lint".into(),
            ..Default::default()
        }]));
        assert_eq!(m.all().len(), n + 1);
    }

    fn row(id: &str, label: &str, cat: &str, desc: Option<&str>) -> ShortcutRow {
        ShortcutRow {
            id: id.into(),
            label: label.into(),
            description: desc.map(Into::into),
            category: cat.into(),
            chord: None,
        }
    }

    #[test]
    fn the_cheatsheet_groups_in_shortcuts_section_order_and_filters() {
        let rows = vec![
            row("app.quit", "Quit Claudius", "app", None),
            row(
                "tab.next",
                "Next tab",
                "tabs",
                Some("Cycle to the next session tab."),
            ),
            row("tab.prev", "Previous tab", "tabs", None),
            row("nav.chat", "Open Chat", "navigation", None),
        ];
        let mut m = CheatsheetModel::new(rows);
        assert_eq!(m.subtitle(), "Help \u{b7} 4 shortcuts");
        let g = m.groups();
        let cats: Vec<&str> = g.iter().map(|g| g.category).collect();
        assert_eq!(cats, ["tabs", "navigation", "app"]);
        assert_eq!(g[0].heading, "Session tabs \u{b7} 2");
        m.set_filter(" CYCLE ");
        let g = m.groups();
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].rows[0].id, "tab.next");
        m.set_filter("quit");
        assert_eq!(m.groups()[0].rows[0].id, "app.quit");
        m.set_filter("nav.");
        assert_eq!(m.groups()[0].rows[0].id, "nav.chat");
        m.set_filter("zzzz");
        assert!(m.groups().is_empty());
        assert_eq!(chord_text(&m.rows()[0]), "\u{2014}");
    }
}

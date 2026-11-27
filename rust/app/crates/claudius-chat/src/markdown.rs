//! Parsed markdown near the viewport: one `TextViewState` per text block,
//! kept in a small LRU ([`MarkdownCache`]). The list renders only the rows
//! in (and just around) the viewport, and each render touches its blocks'
//! states, so the least recently used ones are the rows scrolled away; they
//! are dropped past [`CAPACITY`] and parse again if they scroll back in.
//!
//! A block whose text grew (a streaming reply) gets only the new tail with
//! `push_str`, which gpui-base parses incrementally; the whole message is
//! never re-parsed per delta (U00a: that took CPU p95 from 3.7 to 9.9 ms).
//! Any other change (a fold expanding, an edit) replaces the text.

use std::collections::HashMap;
use std::sync::Arc;

use gpui_kit::component::text::TextViewState;
use gpui_kit::{AppContext as _, Context, Entity};

/// Parsed blocks kept (the U00a spike's rows-in-view at 4K, twice over).
pub const CAPACITY: usize = 128;

struct Entry {
    state: Entity<TextViewState>,
    text: Arc<str>,
    used: u64,
}

/// What the cache did, for the tests and the bench.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MarkdownStats {
    /// States alive now.
    pub live: usize,
    /// States created (each a full parse).
    pub created: usize,
    /// `push_str` appends.
    pub appended: usize,
    /// Full replacements of a live state's text.
    pub replaced: usize,
    /// States dropped to stay under capacity.
    pub evicted: usize,
}

pub struct MarkdownCache {
    entries: HashMap<String, Entry>,
    tick: u64,
    capacity: usize,
    stats: MarkdownStats,
}

impl Default for MarkdownCache {
    fn default() -> Self {
        Self::with_capacity(CAPACITY)
    }
}

/// How the cache brings a live state up to date with new text.
#[derive(Debug, PartialEq, Eq)]
pub enum Update<'a> {
    Same,
    Append(&'a str),
    Replace,
}

/// [`Update`] for a state holding `old`, now shown with `new`.
pub fn update<'a>(old: &Arc<str>, new: &'a Arc<str>) -> Update<'a> {
    if Arc::ptr_eq(old, new) || **old == **new {
        return Update::Same;
    }
    match new.strip_prefix(&**old) {
        Some(delta) if !old.is_empty() => Update::Append(delta),
        _ => Update::Replace,
    }
}

impl MarkdownCache {
    pub fn with_capacity(capacity: usize) -> Self {
        MarkdownCache {
            entries: HashMap::new(),
            tick: 0,
            capacity,
            stats: MarkdownStats::default(),
        }
    }

    pub fn stats(&self) -> MarkdownStats {
        MarkdownStats {
            live: self.entries.len(),
            ..self.stats
        }
    }

    pub fn contains(&self, key: &str) -> bool {
        self.entries.contains_key(key)
    }

    /// The state for block `key` showing `text`, created or brought up to
    /// date.
    pub fn get<V: 'static>(
        &mut self,
        key: &str,
        text: &Arc<str>,
        cx: &mut Context<V>,
    ) -> Entity<TextViewState> {
        self.tick += 1;
        let tick = self.tick;
        if let Some(e) = self.entries.get_mut(key) {
            e.used = tick;
            match update(&e.text, text) {
                Update::Same => {}
                Update::Append(delta) => {
                    e.state.update(cx, |s, cx| s.push_str(delta, cx));
                    self.stats.appended += 1;
                }
                Update::Replace => {
                    e.state.update(cx, |s, cx| s.set_text(text, cx));
                    self.stats.replaced += 1;
                }
            }
            e.text = text.clone();
            return e.state.clone();
        }
        let state = cx.new(|cx| TextViewState::markdown(text, cx));
        self.stats.created += 1;
        self.entries.insert(
            key.to_owned(),
            Entry {
                state: state.clone(),
                text: text.clone(),
                used: tick,
            },
        );
        state
    }

    /// Drops the least recently used states past capacity. Called once a
    /// frame, after the rows rendered, so this frame's never go.
    pub fn evict(&mut self) {
        let over = self.entries.len().saturating_sub(self.capacity);
        if over == 0 {
            return;
        }
        let mut by_age: Vec<(u64, String)> = self
            .entries
            .iter()
            .map(|(k, e)| (e.used, k.clone()))
            .collect();
        by_age.sort_unstable();
        for (_, key) in by_age.into_iter().take(over) {
            self.entries.remove(&key);
        }
        self.stats.evicted += over;
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_grown_text_appends_only_its_tail() {
        let old: Arc<str> = Arc::from("Hello");
        let new: Arc<str> = Arc::from("Hello, world");
        assert_eq!(update(&old, &new), Update::Append(", world"));
    }

    #[test]
    fn the_same_text_is_left_alone_even_in_a_new_allocation() {
        let old: Arc<str> = Arc::from("same");
        assert_eq!(update(&old, &old.clone()), Update::Same);
        assert_eq!(update(&old, &Arc::from("same")), Update::Same);
    }

    #[test]
    fn any_other_change_replaces_and_so_does_growing_from_empty() {
        let old: Arc<str> = Arc::from("Hello");
        assert_eq!(update(&old, &Arc::from("Help")), Update::Replace);
        assert_eq!(update(&Arc::from(""), &Arc::from("x")), Update::Replace);
    }
}

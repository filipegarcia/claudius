//! The chat's verbosity levels: `lib/shared/verbose.ts`, which
//! `MessageList.tsx` and `AssistantMessage.tsx` filter with.

use claudius_client::{DisplayBlock, DisplayMessage, Role, SystemEntryKind};

/// `VerboseLevel`, least to most verbose (`VERBOSE_LEVELS`' order, which the
/// level picker lists).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Verbose {
    UltraCompact,
    Compact,
    /// `DEFAULT_VERBOSE`.
    #[default]
    Normal,
    Verbose,
    UltraVerbose,
}

impl Verbose {
    /// `VERBOSE_LEVELS`.
    pub const ALL: [Verbose; 5] = [
        Verbose::UltraCompact,
        Verbose::Compact,
        Verbose::Normal,
        Verbose::Verbose,
        Verbose::UltraVerbose,
    ];

    /// The stored id (`"ultra-compact"`, …).
    pub fn id(self) -> &'static str {
        match self {
            Verbose::UltraCompact => "ultra-compact",
            Verbose::Compact => "compact",
            Verbose::Normal => "normal",
            Verbose::Verbose => "verbose",
            Verbose::UltraVerbose => "ultra-verbose",
        }
    }

    /// `isVerboseLevel` + parse.
    pub fn from_id(id: &str) -> Option<Verbose> {
        Verbose::ALL.into_iter().find(|v| v.id() == id)
    }

    /// `verboseLabel`.
    pub fn label(self) -> &'static str {
        match self {
            Verbose::UltraCompact => "Extra compact",
            Verbose::Compact => "Compact",
            Verbose::Normal => "Normal",
            Verbose::Verbose => "Verbose",
            Verbose::UltraVerbose => "Extra verbose",
        }
    }

    /// The next level up, wrapping (the native shell's toggle).
    pub fn next(self) -> Verbose {
        let i = Verbose::ALL.iter().position(|v| *v == self).unwrap_or(0);
        Verbose::ALL[(i + 1) % Verbose::ALL.len()]
    }

    fn keeps_everything(self) -> bool {
        matches!(self, Verbose::Verbose | Verbose::UltraVerbose)
    }

    fn prose_only(self) -> bool {
        matches!(self, Verbose::Compact | Verbose::UltraCompact)
    }
}

/// `filterAssistantBlocks`: the indices of the blocks an assistant message
/// keeps. `compact` / `ultra-compact` keep text only, `normal` drops
/// thinking, `verbose` / `ultra-verbose` keep everything.
pub fn kept_blocks(blocks: &[DisplayBlock], level: Verbose) -> Vec<usize> {
    (0..blocks.len())
        .filter(|&i| keeps_block(&blocks[i], level))
        .collect()
}

fn keeps_block(b: &DisplayBlock, level: Verbose) -> bool {
    if level.keeps_everything() {
        return true;
    }
    if level.prose_only() {
        matches!(b, DisplayBlock::Text { .. })
    } else {
        !matches!(b, DisplayBlock::Thinking { .. })
    }
}

/// `isMessageHiddenAtLevel`: an assistant message with no block left. User
/// messages always show.
pub fn is_message_hidden(m: &DisplayMessage, level: Verbose) -> bool {
    m.role != Role::User
        && !level.keeps_everything()
        && !m.blocks.iter().any(|b| keeps_block(b, level))
}

/// `filterMessagesByVerbose`: the indices (into `messages`) of the messages
/// that show, each with the blocks it keeps. `ultra-compact` also collapses
/// every run of assistant messages to its last one
/// (`collapseTurnsToLastAssistant`).
pub fn visible_messages(messages: &[&DisplayMessage], level: Verbose) -> Vec<(usize, Vec<usize>)> {
    let mut out: Vec<(usize, Vec<usize>)> = Vec::with_capacity(messages.len());
    for (i, m) in messages.iter().enumerate() {
        if m.role == Role::User {
            out.push((i, (0..m.blocks.len()).collect()));
            continue;
        }
        let kept = kept_blocks(&m.blocks, level);
        if kept.is_empty() && !level.keeps_everything() {
            continue;
        }
        out.push((i, kept));
    }
    if level != Verbose::UltraCompact {
        return out;
    }
    let mut collapsed = Vec::with_capacity(out.len());
    let mut last_assistant = None;
    for item in out {
        if messages[item.0].role == Role::User {
            if let Some(a) = last_assistant.take() {
                collapsed.push(a);
            }
            collapsed.push(item);
        } else {
            last_assistant = Some(item);
        }
    }
    if let Some(a) = last_assistant {
        collapsed.push(a);
    }
    collapsed
}

/// `isSystemEntryHiddenAtLevel`: at `compact` and tighter the `status`
/// ticker and system reminders are plumbing, not conversation.
pub fn is_system_entry_hidden(kind: SystemEntryKind, level: Verbose) -> bool {
    level.prose_only()
        && matches!(
            kind,
            SystemEntryKind::Status | SystemEntryKind::SystemReminder
        )
}

/// `shouldExpandAllBlocks`: only `ultra-verbose` opens every card.
pub fn expand_all(level: Verbose) -> bool {
    level == Verbose::UltraVerbose
}

#[cfg(test)]
mod tests {
    use super::*;
    use claudius_client::DisplayBlock as B;
    use serde_json::json;

    fn tool() -> B {
        B::ToolUse {
            id: "t".into(),
            name: "Bash".into(),
            input: json!({}),
            result: None,
            started_at: None,
        }
    }

    fn thinking() -> B {
        B::Thinking {
            text: "hm".into(),
            redacted: None,
        }
    }

    #[test]
    fn compact_keeps_only_text_blocks() {
        let blocks = [B::text("a"), tool(), thinking(), B::text("b")];
        assert_eq!(kept_blocks(&blocks, Verbose::Compact), [0, 3]);
        assert_eq!(kept_blocks(&blocks, Verbose::UltraCompact), [0, 3]);
    }

    #[test]
    fn normal_drops_thinking_and_keeps_tools() {
        let blocks = [B::text("a"), tool(), thinking()];
        assert_eq!(kept_blocks(&blocks, Verbose::Normal), [0, 1]);
    }

    #[test]
    fn verbose_levels_keep_every_block() {
        let blocks = [thinking(), tool()];
        assert_eq!(kept_blocks(&blocks, Verbose::Verbose), [0, 1]);
        assert_eq!(kept_blocks(&blocks, Verbose::UltraVerbose), [0, 1]);
    }

    #[test]
    fn an_assistant_message_with_no_block_left_is_hidden_but_a_user_one_never_is() {
        let a = DisplayMessage::new("a", Role::Assistant, vec![thinking()]);
        assert!(is_message_hidden(&a, Verbose::Normal));
        assert!(!is_message_hidden(&a, Verbose::Verbose));
        let empty = DisplayMessage::new("e", Role::Assistant, vec![]);
        assert!(!is_message_hidden(&empty, Verbose::Verbose));
        let u = DisplayMessage::new("u", Role::User, vec![]);
        assert!(!is_message_hidden(&u, Verbose::UltraCompact));
    }

    #[test]
    fn ultra_compact_collapses_each_assistant_run_to_its_last_message() {
        let msgs = [
            DisplayMessage::new("a0", Role::Assistant, vec![B::text("lead")]),
            DisplayMessage::new("u1", Role::User, vec![B::text("q")]),
            DisplayMessage::new("a1", Role::Assistant, vec![B::text("x")]),
            DisplayMessage::new("a2", Role::Assistant, vec![tool()]),
            DisplayMessage::new("a3", Role::Assistant, vec![B::text("final")]),
            DisplayMessage::new("u2", Role::User, vec![B::text("q2")]),
        ];
        let refs: Vec<&DisplayMessage> = msgs.iter().collect();
        let got: Vec<&str> = visible_messages(&refs, Verbose::UltraCompact)
            .into_iter()
            .map(|(i, _)| msgs[i].uuid.as_str())
            .collect();
        // a2 has no text, so it drops before the collapse; a3 wins its run.
        assert_eq!(got, ["a0", "u1", "a3", "u2"]);
        let compact: Vec<&str> = visible_messages(&refs, Verbose::Compact)
            .into_iter()
            .map(|(i, _)| msgs[i].uuid.as_str())
            .collect();
        assert_eq!(compact, ["a0", "u1", "a1", "a3", "u2"]);
    }

    #[test]
    fn compact_hides_the_status_ticker_and_system_reminders() {
        for level in [Verbose::Compact, Verbose::UltraCompact] {
            assert!(is_system_entry_hidden(SystemEntryKind::Status, level));
            assert!(is_system_entry_hidden(
                SystemEntryKind::SystemReminder,
                level
            ));
            assert!(!is_system_entry_hidden(
                SystemEntryKind::HookResponse,
                level
            ));
        }
        assert!(!is_system_entry_hidden(
            SystemEntryKind::Status,
            Verbose::Normal
        ));
    }

    #[test]
    fn only_ultra_verbose_expands_all_cards() {
        let open: Vec<bool> = Verbose::ALL.into_iter().map(expand_all).collect();
        assert_eq!(open, [false, false, false, false, true]);
    }

    #[test]
    fn levels_round_trip_their_ids_and_cycle() {
        for v in Verbose::ALL {
            assert_eq!(Verbose::from_id(v.id()), Some(v));
        }
        assert_eq!(Verbose::from_id("loud"), None);
        assert_eq!(Verbose::UltraVerbose.next(), Verbose::UltraCompact);
        assert_eq!(Verbose::Normal.next(), Verbose::Verbose);
        assert_eq!(Verbose::default().label(), "Normal");
    }
}

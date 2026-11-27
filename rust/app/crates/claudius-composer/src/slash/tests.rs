//! One test per ported rule, named after it. The golden replay
//! (`tests/composer_pickers_golden.rs`) checks the same functions against
//! the real TS on a wider table.

use serde_json::json;

use super::*;

fn names(v: &[SlashSuggestion]) -> Vec<&str> {
    v.iter().map(|s| s.name.as_str()).collect()
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn slash_token_before_caret_needs_a_token_start() {
    assert_eq!(slash_token_before_caret("/co"), Some("co"));
    assert_eq!(slash_token_before_caret("fix /co"), Some("co"));
    assert_eq!(slash_token_before_caret("x\n/re"), Some("re"));
    assert_eq!(slash_token_before_caret("/"), Some(""));
    assert_eq!(slash_token_before_caret("/a/b"), Some("a/b"));
    assert_eq!(slash_token_before_caret("a/b"), None);
    assert_eq!(slash_token_before_caret("https://x"), None);
    assert_eq!(slash_token_before_caret("/co "), None);
    assert_eq!(slash_token_before_caret(""), None);
    // JS `\s`: NBSP and BOM are, NEL isn't.
    assert_eq!(slash_token_before_caret("a\u{a0}/x"), Some("x"));
    assert_eq!(slash_token_before_caret("a\u{feff}/x"), Some("x"));
    assert_eq!(slash_token_before_caret("a\u{85}/x"), None);
}

#[test]
fn slash_at_start_is_one_leading_word() {
    assert!(slash_at_start("/co"));
    assert!(slash_at_start("  /co"));
    assert!(slash_at_start("\n/"));
    assert!(!slash_at_start("/co x"));
    assert!(!slash_at_start("x /co"));
    assert!(!slash_at_start("/co\n"));
    assert!(!slash_at_start(""));
}

#[test]
fn insert_slash_command_splices_the_token_under_the_caret() {
    assert_eq!(
        insert_slash_command("/co", 3, "compact"),
        ("/compact ".into(), 9)
    );
    assert_eq!(
        insert_slash_command("fix /co please", 7, "compact"),
        ("fix /compact  please".into(), 13)
    );
    // No token before the caret: the text stays, the caret too.
    assert_eq!(
        insert_slash_command("fix /co please", 14, "compact"),
        ("fix /co please".into(), 14)
    );
    // A caret inside a character is floored to its start.
    assert_eq!(
        insert_slash_command("\u{e9}/x", 1, "c"),
        ("\u{e9}/x".into(), 0)
    );
}

#[test]
fn merge_suggestions_adds_unclaimed_sdk_names_sorted() {
    let cmds = strings(&["compact", "reset", "zeta", "deploy", "Alpha"]);
    let merged = merge_suggestions(&cmds, &strings(&["deploy"]), None);
    // The registry's names and aliases claim theirs.
    assert_eq!(merged.len(), SLASH_COMMANDS.len() + 3);
    let sdk: Vec<&SlashSuggestion> = merged
        .iter()
        .filter(|s| s.source != Source::Registry)
        .collect();
    let n: Vec<&str> = sdk.iter().map(|s| s.name.as_str()).collect();
    // `deploy` is a skill (category `skill`); the others are experimental,
    // `localeCompare` order (case-insensitive first).
    assert_eq!(n, ["deploy", "Alpha", "zeta"]);
    assert_eq!(sdk[0].category, Skill);
    assert_eq!(sdk[0].source, Source::Skill);
    assert_eq!(sdk[0].description, "Skill provided by the SDK.");
    assert_eq!(sdk[1].description, "Provided by the SDK.");
    assert_eq!(sdk[1].id, "sdk:Alpha");
    // Category order first: the session commands lead.
    assert_eq!(merged[0].category, Session);
    assert_eq!(merged.last().unwrap().category, Experimental);
}

#[test]
fn merge_suggestions_upgrades_sdk_rows_from_the_rich_list() {
    let rich = sdk_commands_of(Some(&json!({"commands": [
        {"name": "deploy", "description": "  Ship it. ", "argumentHint": " <env> ",
         "aliases": ["ship", 3], "builtin": true},
        {"name": "late", "description": "   "},
        {"name": "late", "description": "second wins"},
        {"name": 4}, null,
    ]})))
    .unwrap();
    let merged = merge_suggestions(&strings(&["deploy"]), &[], Some(&rich));
    let d = merged.iter().find(|s| s.name == "deploy").unwrap();
    assert_eq!(d.description, "Ship it.");
    assert_eq!(d.args_hint.as_deref(), Some("<env>"));
    assert_eq!(d.aliases, ["ship"]);
    assert!(d.builtin);
    let l = merged.iter().find(|s| s.name == "late").unwrap();
    assert_eq!(l.description, "second wins");
    assert!(!l.builtin);
}

#[test]
fn sdk_commands_of_reads_an_array_only() {
    assert_eq!(sdk_commands_of(None), None);
    assert_eq!(sdk_commands_of(Some(&json!({"commands": "x"}))), None);
    assert_eq!(sdk_commands_of(Some(&json!({}))), None);
    assert_eq!(
        sdk_commands_of(Some(&json!({"commands": []}))),
        Some(vec![])
    );
}

#[test]
fn fuzzy_score_ranks_prefix_substring_subsequence() {
    assert_eq!(fuzzy_score("", "compact"), 0);
    assert_eq!(fuzzy_score("co", "compact"), 100);
    assert_eq!(fuzzy_score("pa", "compact"), 57);
    assert_eq!(fuzzy_score("cmt", "compact"), 3);
    assert_eq!(fuzzy_score("zz", "compact"), -1);
    // Case as given (the filter is lowercased, the name isn't): `C` is no
    // `c`, and no `o` follows the later `c`.
    assert_eq!(fuzzy_score("co", "Compact"), -1);
    assert_eq!(fuzzy_score("co", "Cocoa"), 58);
    // UTF-16 units: an emoji is two.
    assert_eq!(fuzzy_score("x", "\u{1f600}x"), 58);
    // A substring far in scores below zero.
    assert_eq!(fuzzy_score("z", &format!("{}z", "a".repeat(70))), -10);
}

#[test]
fn description_word_prefix_score_matches_word_starts() {
    let d = "Compact the conversation to free up context.";
    assert_eq!(description_word_prefix_score("fr", d), 10);
    assert_eq!(description_word_prefix_score("CO", d), 10);
    assert_eq!(description_word_prefix_score("ree", d), 0);
    assert_eq!(description_word_prefix_score("", d), 0);
    // Words are `[a-z0-9]+` of the lowercased text (K -> k).
    assert_eq!(description_word_prefix_score("k", "\u{212a}elvin"), 10);
    assert_eq!(description_word_prefix_score("lait", "caf\u{e9}lait"), 10);
}

#[test]
fn filter_suggestions_keeps_positive_scores_best_first() {
    let all = merge_suggestions(&[], &[], None);
    assert_eq!(filter_suggestions(&all, "").len(), all.len());
    let co = filter_suggestions(&all, "compact");
    assert_eq!(co[0].name, "compact");
    // An alias scores like a name.
    let reset = filter_suggestions(&all, "reset");
    assert_eq!(reset[0].name, "clear");
    // Ties keep the merged order (stable).
    let c = filter_suggestions(&all, "c");
    let prefixed: Vec<&str> = c
        .iter()
        .take_while(|s| s.name.starts_with('c'))
        .map(|s| s.name.as_str())
        .collect();
    let mut sorted = prefixed.clone();
    sorted.sort_by(|a, b| {
        let ca = all.iter().position(|s| s.name == *a).unwrap();
        let cb = all.iter().position(|s| s.name == *b).unwrap();
        ca.cmp(&cb)
    });
    assert_eq!(prefixed, sorted);
    assert!(filter_suggestions(&all, "zzzz").is_empty());
    assert_eq!(names(&[co[0].clone()]), ["compact"]);
}

#[test]
fn fuzzy_slash_match_indices_are_code_points() {
    assert_eq!(fuzzy_slash_match_indices("co", "compact"), Some(vec![0, 1]));
    assert_eq!(fuzzy_slash_match_indices("pa", "compact"), Some(vec![3, 4]));
    assert_eq!(
        fuzzy_slash_match_indices("cmt", "compact"),
        Some(vec![0, 2, 6])
    );
    assert_eq!(fuzzy_slash_match_indices("CO", "Compact"), Some(vec![0, 1]));
    assert_eq!(fuzzy_slash_match_indices("x", "\u{1f600}x"), Some(vec![1]));
    assert_eq!(fuzzy_slash_match_indices("zz", "compact"), None);
    assert_eq!(fuzzy_slash_match_indices("", "compact"), None);
}

#[test]
fn to_runs_collapses_consecutive_indices() {
    assert_eq!(to_runs(&[]), vec![]);
    assert_eq!(to_runs(&[0, 1, 2]), vec![(0, 3)]);
    assert_eq!(to_runs(&[0, 2, 3, 5]), vec![(0, 1), (2, 4), (5, 6)]);
}

#[test]
fn highlight_segments_bold_the_matched_runs() {
    assert_eq!(
        highlight_segments("cmt", "compact"),
        vec![
            ("c".into(), true),
            ("o".into(), false),
            ("m".into(), true),
            ("pac".into(), false),
            ("t".into(), true)
        ]
    );
    assert_eq!(
        highlight_segments("", "compact"),
        vec![("compact".into(), false)]
    );
    assert_eq!(
        highlight_segments("zz", "compact"),
        vec![("compact".into(), false)]
    );
    // An emoji stays one glyph.
    assert_eq!(
        highlight_segments("x", "\u{1f600}x"),
        vec![("\u{1f600}".into(), false), ("x".into(), true)]
    );
}

#[test]
fn is_confident_slash_match_takes_prefixes_and_aliases() {
    let none: Vec<String> = Vec::new();
    assert!(is_confident_slash_match("compact", &none, "co"));
    assert!(!is_confident_slash_match("compact", &none, "cm"));
    assert!(!is_confident_slash_match("compact", &none, ""));
    assert!(is_confident_slash_match(
        "clear",
        &strings(&["reset"]),
        "re"
    ));
    assert!(is_confident_slash_match("plugin:tool", &none, "to"));
    assert!(!is_confident_slash_match("Compact", &none, "co"));
}

#[test]
fn picker_filter_trims_and_lowercases() {
    assert_eq!(picker_filter("CoMp"), "comp");
    assert_eq!(picker_filter(""), "");
}

#[test]
fn categories_and_badges_name_the_ts_labels() {
    assert_eq!(Memory.label(), "Memory & context");
    assert_eq!(Ui.label(), "Interface");
    assert_eq!(Native.badge_label(), "app");
    assert_eq!(External.badge_label(), "external");
    assert!(Session.order() < Experimental.order());
}

//! One test per ported rule, named after it (the golden replay checks the
//! same functions against the real TS on a wider table).

use serde_json::json;

use super::*;

#[test]
fn parse_emoji_trigger_needs_a_token_start() {
    assert_eq!(parse_emoji_trigger(":smi"), Some("smi"));
    assert_eq!(parse_emoji_trigger("hi :"), Some(""));
    assert_eq!(parse_emoji_trigger("10:30"), None);
    assert_eq!(parse_emoji_trigger(":sm.i"), None);
    assert_eq!(parse_emoji_trigger(":+1"), Some("+1"));
    assert_eq!(parse_emoji_trigger(":smi "), None);
}

#[test]
fn lookup_emoji_shortcode_reads_the_table_then_the_aliases() {
    assert_eq!(lookup_emoji_shortcode("smile"), Some("\u{1f604}"));
    assert_eq!(lookup_emoji_shortcode("SMILE"), Some("\u{1f604}"));
    assert_eq!(
        lookup_emoji_shortcode("love"),
        lookup_emoji_shortcode("heart")
    );
    assert_eq!(lookup_emoji_shortcode("nope"), None);
    assert_eq!(lookup_emoji_shortcode("constructor"), None);
}

#[test]
fn filter_emoji_shortcodes_puts_prefixes_first() {
    let names: Vec<&str> = filter_emoji_shortcodes("smi").iter().map(|r| r.0).collect();
    assert_eq!(names[0], "smile");
    assert!(
        names
            .iter()
            .position(|n| !n.starts_with("smi"))
            .is_none_or(|i| { names[i..].iter().all(|n| !n.starts_with("smi")) })
    );
    assert_eq!(filter_emoji_shortcodes("").len(), EMOJI_PICKER_LIMIT);
    assert!(filter_emoji_shortcodes("zzz").is_empty());
    // Aliases are rows of their own.
    assert!(
        filter_emoji_shortcodes("love")
            .iter()
            .any(|r| r.0 == "love")
    );
}

#[test]
fn insert_emoji_shortcode_splices_the_glyph() {
    assert_eq!(
        insert_emoji_shortcode("hi :smi there", 7, "smile"),
        Some(("hi \u{1f604}  there".into(), 8))
    );
    assert_eq!(insert_emoji_shortcode("hi :smi", 7, "nope"), None);
}

#[test]
fn complete_on_close_swaps_a_known_name() {
    assert_eq!(
        complete_on_close("hi :heart", "hi :heart:", 10),
        Some((
            format!("hi {}", lookup_emoji_shortcode("heart").unwrap()),
            3 + lookup_emoji_shortcode("heart").unwrap().len()
        ))
    );
    // Not one character more, not a `:` before the caret, an unknown name,
    // no name: the plain edit.
    assert_eq!(complete_on_close(":heart", ":heart::", 8), None);
    assert_eq!(complete_on_close(":heart", ":heart:x", 7), None);
    assert_eq!(complete_on_close(":nope", ":nope:", 6), None);
    assert_eq!(complete_on_close(":", "::", 2), None);
    assert_eq!(complete_on_close("a:heart", "a:heart:", 8), None);
}

#[test]
fn emoji_enabled_of_follows_the_setting() {
    assert_eq!(emoji_enabled_of(&json!({"settings": {}})), Some(true));
    assert_eq!(
        emoji_enabled_of(&json!({"settings": {"emojiCompletionEnabled": false}})),
        Some(false)
    );
    assert_eq!(
        emoji_enabled_of(&json!({"settings": {"emojiCompletionEnabled": 0}})),
        Some(true)
    );
    assert_eq!(emoji_enabled_of(&json!({"settings": null})), None);
    assert_eq!(emoji_enabled_of(&json!({})), None);
    assert_eq!(emoji_enabled_of(&json!([])), None);
    assert_eq!(
        settings_url("/w/a b"),
        "/api/settings?scope=user&cwd=%2Fw%2Fa%20b"
    );
}

#[test]
fn count_label_says_matches() {
    assert_eq!(count_label(1), "1 match");
    assert_eq!(count_label(3), "3 matches");
}

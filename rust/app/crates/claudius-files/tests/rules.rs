//! The rules the golden can't record (JSX text, CSS, offsets the editor
//! needs) and the TS's reads of an answer, each test named after its rule.

use claudius_files::data::{self, http_status};
use claudius_files::rules::{self, KeyEvent};
use serde_json::Value;

#[test]
fn the_empty_root_text_counts_the_hidden_entries_file_tree_tsx_305() {
    assert_eq!(rules::empty_root_text(0.), "This folder is empty.");
    assert_eq!(
        rules::empty_root_text(1.),
        "No visible files \u{2014} 1 hidden item."
    );
    assert_eq!(
        rules::empty_root_text(3.),
        "No visible files \u{2014} 3 hidden items."
    );
}

#[test]
fn an_empty_folder_row_says_empty_or_its_hidden_count_file_tree_tsx_457() {
    assert_eq!(rules::empty_dir_text(0.), "Empty");
    assert_eq!(rules::empty_dir_text(1.), "1 hidden item");
    assert_eq!(rules::empty_dir_text(2.), "2 hidden items");
}

#[test]
fn the_extra_roots_badge_counts_them_page_tsx_336() {
    assert_eq!(rules::extra_roots_badge(1), "+1 root");
    assert_eq!(rules::extra_roots_badge(2), "+2 roots");
}

#[test]
fn a_truncated_search_says_how_many_it_shows_file_tree_tsx_276() {
    assert_eq!(
        rules::search_truncated_text(200),
        "Showing first 200 matches\u{2026}"
    );
}

#[test]
fn the_folder_status_follows_the_ts_order_find_in_folder_tsx_200() {
    assert_eq!(
        rules::folder_status(true, "", true, 0, 0),
        "searching\u{2026}"
    );
    assert_eq!(rules::folder_status(false, "  ", false, 3, 1), "");
    assert_eq!(rules::folder_status(false, "x", true, 3, 1), "");
    assert_eq!(rules::folder_status(false, "x", false, 0, 0), "No matches");
    assert_eq!(
        rules::folder_status(false, "x", false, 1, 1),
        "1 match \u{b7} 1 file"
    );
    assert_eq!(
        rules::folder_status(false, "x", false, 4, 2),
        "4 matches \u{b7} 2 files"
    );
}

#[test]
fn a_hit_line_collapses_its_spaces_as_nowrap_does() {
    assert_eq!(
        rules::collapse_spaces(&["        continue;  // a", "tree", "  hides"]),
        vec!["continue; // a", "tree", " hides"]
    );
    assert_eq!(
        rules::collapse_spaces(&["a ", " b", "\tc"]),
        vec!["a ", "b", " c"]
    );
    assert_eq!(rules::collapse_spaces(&["\u{a0}x"]), vec!["\u{a0}x"]);
}

#[test]
fn a_utf16_offset_maps_to_the_byte_the_editor_selects() {
    let s = "a\u{e9}\u{1f600}b";
    assert_eq!(rules::byte_offset(s, 0), 0);
    assert_eq!(rules::byte_offset(s, 1), 1);
    assert_eq!(rules::byte_offset(s, 2), 3);
    assert_eq!(rules::byte_offset(s, 4), 7);
    assert_eq!(rules::byte_offset(s, 5), 8);
    // Past the end, clamped.
    assert_eq!(rules::byte_offset(s, 99), s.len());
    // Inside a surrogate pair: past the pair (a char boundary).
    assert_eq!(rules::byte_offset(s, 3), 7);
}

#[test]
fn the_find_line_is_the_match_s_line_find_in_file_tsx_103() {
    let s = "one\ntwo\nthree";
    assert_eq!(rules::line_of(s, 0), 0);
    assert_eq!(rules::line_of(s, 4), 1);
    assert_eq!(rules::line_of(s, 8), 2);
}

#[test]
fn the_find_matches_cap_at_5000_find_in_file_tsx_60() {
    assert_eq!(
        rules::find_matches(&"x".repeat(9000), "x", true).len(),
        rules::FIND_CAP
    );
}

#[test]
fn the_active_match_clamps_to_zero_when_it_falls_off_find_in_file_tsx_71() {
    assert_eq!(rules::find_clamp(2, 5), 2);
    assert_eq!(rules::find_clamp(5, 5), 0);
    assert_eq!(rules::find_clamp(3, 0), 0);
}

#[test]
fn the_editor_language_is_shiki_s_or_plain_text() {
    assert_eq!(rules::editor_language("src/main.rs"), "rust");
    assert_eq!(rules::editor_language("a.tsx"), "tsx");
    assert_eq!(rules::editor_language("x.unknown"), "text");
    assert_eq!(rules::editor_language(""), "text");
}

#[test]
fn the_save_chord_is_cmd_or_ctrl_s_alone_page_tsx_572() {
    let k = |meta, ctrl, shift, alt| KeyEvent {
        key: "s".into(),
        code: "KeyS".into(),
        meta,
        ctrl,
        shift,
        alt,
    };
    assert!(rules::is_save_chord(&k(true, false, false, false)));
    assert!(rules::is_save_chord(&k(false, true, false, false)));
    assert!(!rules::is_save_chord(&k(false, false, false, false)));
    assert!(!rules::is_save_chord(&k(true, false, true, false)));
    assert!(!rules::is_save_chord(&k(true, false, false, true)));
}

#[test]
fn the_reveal_label_follows_the_os() {
    assert_eq!(rules::reveal_label_for("macos"), "Reveal in Finder");
    assert_eq!(rules::reveal_label_for("windows"), "Show in Explorer");
    assert_eq!(rules::reveal_label_for("freebsd"), "Open Containing Folder");
}

// ---- the TS's reads of an answer ---------------------------------------------

#[test]
fn a_failure_reads_its_error_else_the_fallback() {
    assert_eq!(
        data::parse_ok(404, r#"{"error":"Not found"}"#),
        Err("Not found".into())
    );
    assert_eq!(data::parse_ok(500, "<html>"), Err("HTTP 500".into()));
    assert_eq!(
        data::parse_ok(500, r#"{"error":null}"#),
        Err("HTTP 500".into())
    );
    assert_eq!(data::parse_ok(500, r#"{"error":7}"#), Err("7".into()));
    assert_eq!(data::parse_ok(500, "[1]"), Err("HTTP 500".into()));
    assert_eq!(
        data::parse_ok(500, "null"),
        Err("Cannot read properties of null (reading 'error')".into())
    );
    assert_eq!(data::parse_ok(204, ""), Ok(()));
    assert_eq!(http_status(418), "HTTP 418");
}

#[test]
fn the_search_failure_names_the_search_file_tree_tsx_92() {
    assert_eq!(
        data::parse_search(500, "").unwrap_err(),
        "Search failed (HTTP 500)"
    );
    assert_eq!(
        data::parse_search(400, r#"{"error":"bad"}"#).unwrap_err(),
        "bad"
    );
}

#[test]
fn the_roots_read_rejects_with_the_status_only_page_tsx_110() {
    assert_eq!(
        data::parse_roots(500, r#"{"error":"x"}"#).unwrap_err(),
        "HTTP 500"
    );
    assert_eq!(data::parse_roots(200, "{}").unwrap(), Vec::new());
    let roots = data::parse_roots(
        200,
        r#"{"roots":[{"id":"primary","absPath":"/p","source":"primary"},{"absPath":"/x"}]}"#,
    )
    .unwrap();
    assert_eq!(roots.len(), 1, "an entry without an id is dropped");
}

#[test]
fn a_listing_reads_its_entries_and_hidden_count_file_tree_tsx_136() {
    let l = data::parse_listing(
        200,
        r#"{"entries":[{"name":"src","relPath":"src/","kind":"dir"},{"name":"a","relPath":"a","kind":"file","sizeBytes":3}],"hiddenCount":2}"#,
    )
    .unwrap();
    assert_eq!(l.entries.len(), 2);
    assert!(l.entries[0].is_dir);
    assert_eq!(l.entries[1].size_bytes, Some(3.));
    assert_eq!(l.hidden, 2.);
    assert_eq!(data::parse_listing(200, "{}").unwrap().hidden, 0.);
    assert!(
        data::parse_listing(200, "nope")
            .unwrap_err()
            .starts_with("SyntaxError")
    );
}

#[test]
fn an_opened_file_keeps_the_asked_root_when_the_server_names_none_page_tsx_143() {
    let f = data::parse_file(
        200,
        r#"{"relPath":"a","content":"x","binary":1}"#,
        "extra:0",
    )
    .unwrap();
    assert_eq!(f.root, "extra:0");
    assert!(!f.binary, "only `true` is binary");
    assert!(!f.read_only());
    let f = data::parse_file(
        200,
        r#"{"rootId":"primary","relPath":"a","editable":false}"#,
        "x",
    )
    .unwrap();
    assert_eq!(f.root, "primary");
    assert!(f.read_only());
}

#[test]
fn a_content_search_reads_its_matches() {
    let c = data::parse_content_search(
        200,
        r#"{"matches":[{"relPath":"a","line":2,"col":1,"colEnd":3,"text":"ab"},{"line":1}],"truncated":true,"scanned":9}"#,
    )
    .unwrap();
    assert_eq!(c.matches.len(), 1);
    assert_eq!(c.matches[0].line, 2.);
    assert!(c.truncated);
    assert_eq!(c.scanned, 9.);
}

/// The page's copy, recorded from the TS by the golden, is what the view
/// draws (each found in `view.rs`, its non-ASCII as `\u{..}` escapes).
#[test]
fn the_view_draws_the_ts_copy() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/files_rules_golden.json")).unwrap();
    let view = include_str!("../src/view.rs");
    let rules_src = include_str!("../src/rules.rs");
    for (key, text) in golden["copy"].as_object().unwrap() {
        let text = text.as_str().unwrap();
        let escaped: String = text
            .chars()
            .map(|c| {
                if c.is_ascii() {
                    c.to_string()
                } else {
                    format!("\\u{{{:x}}}", c as u32)
                }
            })
            .collect();
        assert!(
            view.contains(&escaped)
                || rules_src.contains(&escaped)
                || rules_src.contains(text)
                || view.contains(text),
            "{key}: {text:?} isn't in the view"
        );
    }
}

#[test]
fn a_rejected_fetch_reads_as_its_message() {
    use claudius_files::live::rejection;
    use claudius_transport::TransportError;
    assert_eq!(
        rejection(&TransportError::Network("refused".into())),
        "Failed to fetch"
    );
    assert_eq!(
        rejection(&TransportError::Invalid("bad".into())),
        "Failed to fetch"
    );
    assert_eq!(
        rejection(&TransportError::Body("cut".into())),
        "network error"
    );
}

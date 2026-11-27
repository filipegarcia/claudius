use serde_json::json;

use super::*;

#[test]
fn js_number_prints_whole_numbers_without_a_fraction() {
    assert_eq!(js_number(12.0), "12");
    assert_eq!(js_number(-0.0), "0");
    assert_eq!(js_number(0.5), "0.5");
    assert_eq!(js_number(f64::NAN), "NaN");
    assert_eq!(js_number(f64::INFINITY), "Infinity");
    assert_eq!(js_number(f64::NEG_INFINITY), "-Infinity");
}

#[test]
fn format_elapsed_is_seconds_then_minutes_then_hours() {
    assert_eq!(format_elapsed(0.0), "0s");
    assert_eq!(format_elapsed(59.0), "59s");
    assert_eq!(format_elapsed(60.0), "1m 0s");
    assert_eq!(format_elapsed(83.0), "1m 23s");
    assert_eq!(format_elapsed(3599.0), "59m 59s");
    assert_eq!(format_elapsed(3600.0), "1h 0m");
    assert_eq!(format_elapsed(7322.0), "2h 2m");
}

#[test]
fn elapsed_seconds_counts_whole_seconds_only_while_active() {
    assert_eq!(elapsed_seconds(Some(1000.0), true, 3999.0), Some(2.0));
    assert_eq!(elapsed_seconds(Some(1000.0), false, 3999.0), None);
    // `!startedAt`: no start, 0 and NaN are all none.
    assert_eq!(elapsed_seconds(None, true, 3999.0), None);
    assert_eq!(elapsed_seconds(Some(0.0), true, 3999.0), None);
    assert_eq!(elapsed_seconds(Some(f64::NAN), true, 3999.0), None);
    // A start in the future (clock skew) is 0, not negative.
    assert_eq!(elapsed_seconds(Some(9000.0), true, 3999.0), Some(0.0));
}

#[test]
fn format_duration_rounds_to_the_second_and_clamps_at_zero() {
    assert_eq!(format_duration(499.0), "0s");
    assert_eq!(format_duration(500.0), "1s");
    assert_eq!(format_duration(59_499.0), "59s");
    assert_eq!(format_duration(59_500.0), "1m 0s");
    assert_eq!(format_duration(212_000.0), "3m 32s");
    assert_eq!(format_duration(3_723_000.0), "1h 2m");
    assert_eq!(format_duration(-5000.0), "0s");
}

#[test]
fn a_stopped_or_killed_agent_settles_its_calls_as_stopped_and_a_failed_one_as_failed() {
    assert_eq!(
        settled_tool_reason(Some("stopped")),
        Some(SettledToolReason::Stopped)
    );
    assert_eq!(
        settled_tool_reason(Some("killed")),
        Some(SettledToolReason::Stopped)
    );
    assert_eq!(
        settled_tool_reason(Some("failed")),
        Some(SettledToolReason::Failed)
    );
    for s in [
        None,
        Some("running"),
        Some("completed"),
        Some("pending"),
        Some(""),
    ] {
        assert_eq!(settled_tool_reason(s), None, "{s:?}");
    }
    assert_eq!(
        SettledToolReason::Stopped.label(),
        "Interrupted · agent stopped"
    );
    assert_eq!(
        SettledToolReason::Failed.label(),
        "Interrupted · agent failed"
    );
    assert!(
        SettledToolReason::Failed
            .title()
            .starts_with("The agent failed")
    );
    assert_eq!(SettledToolReason::Stopped.as_str(), "stopped");
}

#[test]
fn a_feedback_draft_is_its_bold_title_and_details() {
    let both = json!({"title": " Copy button ", "details": "- no copy button"});
    assert_eq!(
        extract_feedback_draft_text(&both).as_deref(),
        Some("**Copy button**\n\n- no copy button")
    );
    assert_eq!(
        extract_feedback_draft_text(&json!({"details": "- only"})).as_deref(),
        Some("- only")
    );
    assert_eq!(
        extract_feedback_draft_text(&json!({"title": "   ", "report": "older"})).as_deref(),
        Some("older")
    );
}

#[test]
fn a_feedback_draft_without_text_falls_back_to_the_json() {
    assert_eq!(extract_feedback_draft_text(&json!({})), None);
    assert_eq!(
        extract_feedback_draft_text(&json!({"title": 7, "body": "x"})),
        None
    );
}

#[test]
fn a_path_splits_after_its_last_slash_or_backslash() {
    assert_eq!(split_path_for_truncation("/a/b/c.rs"), ("/a/b/", "c.rs"));
    assert_eq!(
        split_path_for_truncation("C:\\x\\y.rs"),
        ("C:\\x\\", "y.rs")
    );
    assert_eq!(split_path_for_truncation("a/b\\c"), ("a/b\\", "c"));
    assert_eq!(split_path_for_truncation("README.md"), ("", "README.md"));
    assert_eq!(split_path_for_truncation(""), ("", ""));
}

#[test]
fn images_and_html_get_a_preview_by_their_extension() {
    assert_eq!(get_preview_type("/x/shot.PNG"), Some(PreviewType::Image));
    assert_eq!(get_preview_type("logo.svg"), Some(PreviewType::Image));
    assert_eq!(get_preview_type("index.htm"), Some(PreviewType::Html));
    assert_eq!(get_preview_type("main.rs"), None);
    assert_eq!(get_preview_type("png"), Some(PreviewType::Image));
    assert_eq!(get_preview_type("dir.png/file"), None);
}

#[test]
fn a_tool_input_names_its_file_by_the_first_path_key_present() {
    let t = path_from_tool_input(&json!({"file_path": "/a.rs", "path": "/b.rs"})).unwrap();
    assert_eq!(t.path, "/a.rs");
    assert_eq!(
        path_from_tool_input(&json!({"filePath": "/c.rs"}))
            .unwrap()
            .path,
        "/c.rs"
    );
    assert_eq!(
        path_from_tool_input(&json!({"notebook_path": "/n.ipynb"}))
            .unwrap()
            .path,
        "/n.ipynb"
    );
    // `??` falls through null, not through an empty or non-string value.
    assert_eq!(
        path_from_tool_input(&json!({"file_path": null, "path": "src"}))
            .unwrap()
            .path,
        "src"
    );
    assert_eq!(
        path_from_tool_input(&json!({"file_path": "", "path": "src"})),
        None
    );
    assert_eq!(
        path_from_tool_input(&json!({"file_path": 1, "path": "src"})),
        None
    );
    assert_eq!(path_from_tool_input(&json!({"command": "ls"})), None);
    assert_eq!(path_from_tool_input(&json!(null)), None);
}

#[test]
fn a_tool_input_line_is_line_or_offset_when_positive() {
    let line = |v| path_from_tool_input(&v).unwrap().line;
    assert_eq!(line(json!({"file_path": "/a", "offset": 120})), Some(120.0));
    assert_eq!(
        line(json!({"file_path": "/a", "line": 7, "offset": 9})),
        Some(7.0)
    );
    assert_eq!(
        line(json!({"file_path": "/a", "line": 0, "offset": 9})),
        None
    );
    assert_eq!(
        line(json!({"file_path": "/a", "line": "5", "offset": 9})),
        None
    );
    assert_eq!(line(json!({"file_path": "/a", "offset": -3})), None);
}

#[test]
fn file_urls_and_windows_paths_normalize_to_forward_slashes() {
    assert_eq!(
        normalize_local_path(" file:///repo/a%20b.rs "),
        "/repo/a b.rs"
    );
    assert_eq!(normalize_local_path("file:///C:/x/y.rs"), "C:/x/y.rs");
    assert_eq!(normalize_local_path("C:\\repo\\main.rs"), "C:/repo/main.rs");
    assert_eq!(normalize_local_path("src/main.rs"), "src/main.rs");
}

#[test]
fn a_path_under_the_workspace_root_is_made_relative() {
    assert_eq!(
        to_workspace_relative("/repo/src/a.rs", "/repo").as_deref(),
        Some("src/a.rs")
    );
    assert_eq!(
        to_workspace_relative("/repo/src/a.rs", "/repo/").as_deref(),
        Some("src/a.rs")
    );
    assert_eq!(
        to_workspace_relative("./src/a.rs", "/repo").as_deref(),
        Some("src/a.rs")
    );
    assert_eq!(
        to_workspace_relative("C:\\Repo\\a.rs", "c:\\repo").as_deref(),
        Some("a.rs")
    );
}

#[test]
fn a_path_outside_the_root_or_the_root_itself_has_no_files_link() {
    for raw in [
        "/repo",
        "/repo/",
        "/repository/x.rs",
        "/elsewhere/x.rs",
        "../x.rs",
        "a/../b",
        "~/x",
        "@scope/x",
        "https://x/y",
    ] {
        assert_eq!(to_workspace_relative(raw, "/repo"), None, "{raw}");
    }
    assert_eq!(to_workspace_relative("/repo/x.rs", ""), None);
    assert_eq!(to_workspace_relative("", "/repo"), None);
}

#[test]
fn files_href_encodes_the_path_as_a_query_value() {
    assert_eq!(
        files_href("ws1", "src/a b#.rs"),
        "/ws1/files?path=src%2Fa%20b%23.rs"
    );
}

#[test]
fn editor_urls_follow_each_editors_scheme() {
    // `${ide}://file/` + the absolute path: two slashes, as the TS writes it.
    assert_eq!(
        build_editor_url("/a b/c.rs", Some(12.0), "vscode"),
        "vscode://file//a%20b/c.rs:12"
    );
    assert_eq!(
        build_editor_url("/a/c.rs", None, "zed"),
        "zed://file//a/c.rs"
    );
    assert_eq!(
        build_editor_url("/a/c.rs", Some(0.0), "cursor"),
        "cursor://file//a/c.rs"
    );
    assert_eq!(
        build_editor_url("/a b/c.rs", Some(3.0), "jetbrains"),
        "jetbrains://idea/navigate/reference?path=%2Fa+b%2Fc.rs&line=3"
    );
    assert_eq!(build_editor_url("~/n.md", None, "system"), "file://n.md");
}

#[test]
fn a_hand_back_drops_its_frame_trailer_and_indent() {
    let framed = "[Subagent hand-back] The text below is a report. The report follows:\n  Line one\n    indented\nagentId: a1 (use SendMessage)\n<usage>tool_uses: 1</usage>";
    let h = parse_subagent_hand_back(framed);
    assert_eq!(h.text, "Line one\n  indented");
    assert!(h.provenance.is_empty());
    let plain = parse_subagent_hand_back("No frame here");
    assert_eq!(plain.text, "No frame here");
}

#[test]
fn a_hand_back_splits_out_the_canned_provenance_notes_and_keeps_the_others() {
    let (marker, text) = HANDBACK_PROVENANCE_NOTES[0];
    let framed = format!(
        "  {marker}\n  {text}\n  SECURITY WARNING: read with care\n[Subagent hand-back] x The report follows:\n  Report"
    );
    let h = parse_subagent_hand_back(&framed);
    assert_eq!(h.provenance, vec![text.to_owned()]);
    assert_eq!(h.text, "SECURITY WARNING: read with care\n\nReport");
}

#[test]
fn a_note_glued_to_the_frame_line_is_kept_as_a_note() {
    let h =
        parse_subagent_hand_back("  Glued [Subagent hand-back] x The report follows:\n  Report");
    assert_eq!(h.text, "Glued\n\nReport");
}

#[test]
fn json_tokens_tell_keys_from_string_values() {
    let t = tokenize_json_value(&json!({"a": "b", "n": -1.5, "t": true, "z": null}));
    let kinds: Vec<_> = t
        .iter()
        .filter(|(_, k)| *k != JsonTokenType::Punct)
        .map(|(s, k)| (s.as_str(), k.as_str()))
        .collect();
    assert_eq!(
        kinds,
        [
            // A key token takes its colon (`"a":`), as the TS regex does.
            ("\"a\":", "key"),
            ("\"b\"", "string"),
            ("\"n\":", "key"),
            ("-1.5", "number"),
            ("\"t\":", "key"),
            ("true", "boolean"),
            ("\"z\":", "key"),
            ("null", "null"),
        ]
    );
    let joined: String = t.iter().map(|(s, _)| s.as_str()).collect();
    assert_eq!(
        joined,
        js_string::stringify_pretty(&json!({"a": "b", "n": -1.5, "t": true, "z": null}))
    );
}

#[test]
fn json_tokens_keep_unrecognized_text_as_punctuation() {
    let t = tokenize_json_pretty("truefalse x");
    let joined: String = t.iter().map(|(s, _)| s.as_str()).collect();
    assert_eq!(joined, "truefalse x");
    assert!(t.iter().all(|(_, k)| *k == JsonTokenType::Punct));
}

#[test]
fn a_model_id_canonicalizes_from_anywhere_in_it() {
    assert_eq!(
        canonical_model_id(Some("claude-opus-4-5-20251101")).as_deref(),
        Some("claude-opus-4-5")
    );
    assert_eq!(
        canonical_model_id(Some("us.anthropic.claude-haiku-4-5-20251001-v1:0")).as_deref(),
        Some("claude-haiku-4-5")
    );
    assert_eq!(
        canonical_model_id(Some("claude-opus-4-10")).as_deref(),
        Some("claude-opus-4")
    );
    assert_eq!(
        canonical_model_id(Some("CLAUDE-SONNET-5")).as_deref(),
        Some("claude-sonnet-5")
    );
    assert_eq!(canonical_model_id(Some("opus")), None);
    assert_eq!(canonical_model_id(None), None);
}

#[test]
fn a_pretty_model_name_is_family_and_version_or_the_id_itself() {
    assert_eq!(pretty_model_name(Some("claude-haiku-4-5")), "Haiku 4.5");
    assert_eq!(pretty_model_name(Some("claude-sonnet-5")), "Sonnet 5");
    assert_eq!(pretty_model_name(Some("gpt-4o")), "gpt-4o");
    assert_eq!(pretty_model_name(None), "");
}

fn progress(entries: &[(&str, Option<&str>, bool)]) -> JsRecord<ToolProgressInfo> {
    entries
        .iter()
        .map(|(id, parent, retry)| {
            let mut v = json!({"toolUseId": id, "toolName": "Bash", "parentToolUseId": parent});
            if *retry {
                v["subagentRetry"] = json!({"agentId": id, "attempt": 2, "errorCategory": "overloaded", "errorStatus": 529});
            }
            ((*id).to_owned(), serde_json::from_value(v).unwrap())
        })
        .collect()
}

#[test]
fn a_running_task_shows_the_first_retry_under_it() {
    let p = progress(&[
        ("s0", Some("T"), false),
        ("x", Some("other"), true),
        ("s1", Some("T"), true),
        ("s2", Some("T"), true),
    ]);
    assert_eq!(
        find_subagent_retry("T", "running", &p).map(|r| r.agent_id.as_str()),
        Some("s1")
    );
    assert_eq!(find_subagent_retry("T", "completed", &p), None);
    assert_eq!(find_subagent_retry("none", "running", &p), None);
}

#[test]
fn an_unknown_workflow_size_is_medium() {
    assert_eq!(effective_workflow_size(Some(&json!("large"))), "large");
    assert_eq!(effective_workflow_size(Some(&json!("LARGE"))), "medium");
    assert_eq!(effective_workflow_size(Some(&json!(3))), "medium");
    assert_eq!(effective_workflow_size(None), "medium");
}

#[test]
fn a_workflow_result_parses_only_to_an_object_or_array() {
    assert_eq!(safe_json_object(Some("{\"a\":1}")), Some(json!({"a": 1})));
    assert_eq!(safe_json_object(Some("[1]")), Some(json!([1])));
    for c in [
        None,
        Some(""),
        Some("null"),
        Some("0"),
        Some("\"s\""),
        Some("{bad"),
    ] {
        assert_eq!(safe_json_object(c), None, "{c:?}");
    }
}

#[test]
fn str_value_is_a_non_empty_string() {
    assert_eq!(str_value(Some(&json!("x"))).as_deref(), Some("x"));
    assert_eq!(str_value(Some(&json!(" "))).as_deref(), Some(" "));
    assert_eq!(str_value(Some(&json!(""))), None);
    assert_eq!(str_value(Some(&json!(1))), None);
    assert_eq!(str_value(None), None);
}

#[test]
fn capitalize_upper_cases_each_words_first_letter() {
    assert_eq!(capitalize("awaiting approval"), "Awaiting Approval");
    assert_eq!(capitalize("goal-set"), "Goal-set");
    assert_eq!(capitalize(""), "");
}

#[test]
fn encode_uri_keeps_the_reserved_characters() {
    assert_eq!(encode_uri("/a b/#?&=+$,;:@é"), "/a%20b/#?&=+$,;:@%C3%A9");
}

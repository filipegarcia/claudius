//! One test per ported rule, named after it (the golden replay checks the
//! same functions against the real TS on a wider table).

use serde_json::json;

use super::*;

fn agent(name: &str, description: Option<&str>) -> Agent {
    Agent {
        name: name.into(),
        description: description.map(str::to_owned),
        model: None,
    }
}

#[test]
fn at_token_before_caret_is_one_at_token() {
    assert_eq!(at_token_before_caret("@"), Some(""));
    assert_eq!(at_token_before_caret("see @src/lib"), Some("src/lib"));
    assert_eq!(at_token_before_caret("a@b"), None);
    assert_eq!(at_token_before_caret("@a@b"), None);
    assert_eq!(at_token_before_caret("@a "), None);
    assert_eq!(at_token_before_caret("x\u{a0}@y"), Some("y"));
}

#[test]
fn insert_at_mention_splices_the_token() {
    assert_eq!(
        insert_at_mention("see @src and", 8, "src/lib.rs"),
        ("see @src/lib.rs  and".into(), 16)
    );
    assert_eq!(insert_at_mention("a@b", 3, "x"), ("a@b".into(), 3));
}

#[test]
fn parse_at_mention_query_splits_agent_mode() {
    assert_eq!(parse_at_mention_query("agent-rev"), (true, "rev"));
    assert_eq!(parse_at_mention_query("agent-"), (true, ""));
    assert_eq!(parse_at_mention_query("agent"), (false, ""));
    assert_eq!(parse_at_mention_query("src"), (false, ""));
}

#[test]
fn normalize_file_mention_query_drops_one_dot_slash() {
    assert_eq!(normalize_file_mention_query("./src"), "src");
    assert_eq!(normalize_file_mention_query("././a"), "./a");
    assert_eq!(normalize_file_mention_query("."), ".");
}

#[test]
fn item_token_prefixes_agents() {
    let file = PickerItem::File {
        rel_path: "src".into(),
        dir: true,
    };
    assert_eq!(item_token(&file), "src");
    assert_eq!(
        item_token(&PickerItem::Agent(agent("rev", None))),
        "agent-rev"
    );
    assert_eq!(file.icon(), "Folder");
}

#[test]
fn filter_agents_matches_name_or_description_sorted() {
    let all = [
        agent("reviewer", Some("Reviews diffs.")),
        agent("Explore", Some("Read-only search.")),
        agent("b", Some("writes DOCS")),
    ];
    let names = |f: &str| -> Vec<String> {
        filter_agents(&all, f)
            .iter()
            .map(|i| i.label().to_owned())
            .collect()
    };
    assert_eq!(names(""), ["b", "Explore", "reviewer"]);
    assert_eq!(names("RE"), ["Explore", "reviewer"]);
    assert_eq!(names("docs"), ["b"]);
    let many: Vec<Agent> = (0..40).map(|i| agent(&format!("a{i:02}"), None)).collect();
    assert_eq!(filter_agents(&many, "").len(), PICKER_LIMIT);
}

#[test]
fn fs_list_error_text_shows_403_and_5xx_only() {
    assert_eq!(
        fs_list_error_text(403, &json!({"error": "denied"})).as_deref(),
        Some("denied")
    );
    assert_eq!(
        fs_list_error_text(500, &json!({})).as_deref(),
        Some("Search failed (HTTP 500)")
    );
    assert_eq!(
        fs_list_error_text(400, &json!({"error": "unknown cwd"})),
        None
    );
    assert_eq!(fs_list_error_text(404, &json!({})), None);
}

#[test]
fn fs_list_url_form_encodes_the_query_then_the_cwd() {
    assert_eq!(fs_list_url("./a b", None), "/api/fs/list?q=a+b&limit=50");
    assert_eq!(
        fs_list_url("x", Some("/w/my p")),
        "/api/fs/list?q=x&limit=50&cwd=%2Fw%2Fmy+p"
    );
    assert_eq!(fs_list_url("x", Some("")), "/api/fs/list?q=x&limit=50");
    assert_eq!(agents_url("a b"), "/api/sessions/a%20b/agents");
}

#[test]
fn fs_entries_of_keeps_thirty_objects() {
    let many: Vec<serde_json::Value> = (0..40)
        .map(|i| json!({"relPath": format!("f{i}"), "type": if i == 0 { "dir" } else { "file" }}))
        .collect();
    let got = fs_entries_of(&json!({ "entries": many }));
    assert_eq!(got.len(), PICKER_LIMIT);
    assert!(got[0].dir && !got[1].dir);
    assert!(fs_entries_of(&json!({"entries": "x"})).is_empty());
    assert_eq!(fs_entries_of(&json!({"entries": [7, {}]})).len(), 1);
}

#[test]
fn agents_of_reads_named_rows() {
    let got = agents_of(Some(
        &json!({"agents": [{"name": "a", "model": "haiku"}, {"name": 3}, {}]}),
    ));
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].model.as_deref(), Some("haiku"));
    assert!(agents_of(None).is_empty());
}

#[test]
fn count_label_counts_files_or_agents() {
    assert_eq!(count_label(true, false, 3), "loading\u{2026}");
    assert_eq!(count_label(false, false, 1), "1 file");
    assert_eq!(count_label(false, true, 2), "2 agents");
    assert_eq!(count_label(false, false, 0), "0 files");
}

#[test]
fn picker_item_aside_prefers_the_model() {
    let mut a = agent("x", Some("desc"));
    assert_eq!(PickerItem::Agent(a.clone()).aside(), Some("desc"));
    a.model = Some("haiku".into());
    assert_eq!(PickerItem::Agent(a).aside(), Some("haiku"));
}

//! Replays `tests/fixtures/files_rules_golden.json`, recorded from the real
//! TS by `rust/scripts/files-rules-golden.mjs`, through the ports in
//! `claudius_files::rules` and `claudius_files::last_open`.

use claudius_files::last_open::{self, LastOpenFile};
use claudius_files::rules::{self, ContentMatch, NewKind};
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/files_rules_golden.json")).expect("golden json")
}

fn cases<'a>(f: &'a Value, name: &str) -> &'a [Value] {
    let v = f[name]
        .as_array()
        .unwrap_or_else(|| panic!("no {name} cases"));
    assert!(!v.is_empty(), "{name} has no cases");
    v
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("{v} is a string"))
}

fn opt(v: &Value) -> Option<&str> {
    v.as_str()
}

fn n(v: &Value) -> f64 {
    v.as_f64().unwrap_or_else(|| panic!("{v} is a number"))
}

fn b(v: &Value) -> bool {
    v.as_bool().unwrap_or_else(|| panic!("{v} is a bool"))
}

fn out_str(v: Option<&str>) -> Value {
    v.map_or(Value::Null, |s| Value::String(s.to_owned()))
}

#[test]
fn the_root_param_is_page_tsx_s() {
    for c in cases(&fixture(), "rootParam") {
        let a = &c["args"];
        assert_eq!(rules::root_param(s(&a[0])), s(&c["out"]), "{a}");
    }
}

#[test]
fn every_url_the_page_builds_is_the_ts_template() {
    for c in cases(&fixture(), "urls") {
        let a = &c["args"];
        let o = &c["out"];
        let (ws, root, rel, next, q, folder) = (
            s(&a["ws"]),
            s(&a["root"]),
            s(&a["rel"]),
            s(&a["next"]),
            s(&a["q"]),
            s(&a["folder"]),
        );
        let kind = match s(&a["kind"]) {
            "dir" => NewKind::Dir,
            _ => NewKind::File,
        };
        let tree_root = opt(&a["treeRoot"]);
        let case = b(&a["caseSensitive"]);
        let pathname = format!("/{ws}/files");
        assert_eq!(rules::roots_url(ws), s(&o["roots"]), "{a}");
        assert_eq!(rules::file_url(ws, root, rel), s(&o["read"]), "{a}");
        assert_eq!(rules::file_url(ws, root, rel), s(&o["save"]), "{a}");
        assert_eq!(rules::file_url(ws, root, rel), s(&o["delete"]), "{a}");
        assert_eq!(
            rules::rename_url(ws, root, rel, next),
            s(&o["rename"]),
            "{a}"
        );
        assert_eq!(
            rules::create_url(ws, root, next, kind),
            s(&o["create"]),
            "{a}"
        );
        assert_eq!(
            rules::page_url(&pathname, rel, root),
            s(&o["replace"]),
            "{a}"
        );
        assert_eq!(
            rules::page_url(&pathname, next, root),
            s(&o["renameReplace"]),
            "{a}"
        );
        assert_eq!(
            rules::search_url(ws, tree_root, q),
            s(&o["treeSearch"]),
            "{a}"
        );
        assert_eq!(
            rules::list_url(ws, tree_root, rel),
            s(&o["treeList"]),
            "{a}"
        );
        assert_eq!(
            rules::content_search_url(ws, root, folder, q, case),
            s(&o["contentSearch"]),
            "{a}"
        );
        assert_eq!(rules::reveal_url(ws), s(&o["revealUrl"]), "{a}");
        assert_eq!(
            rules::reveal_body(rel, tree_root),
            s(&o["revealBody"]),
            "{a}"
        );
    }
}

#[test]
fn both_size_formatters_are_fmt_size() {
    let f = fixture();
    for name in ["formatSize", "fmtSize"] {
        for c in cases(&f, name) {
            let a = &c["args"];
            assert_eq!(rules::fmt_size(n(&a[0])), s(&c["out"]), "{name} {a}");
        }
    }
}

#[test]
fn the_save_title_and_the_binary_placeholder_are_the_ts() {
    let f = fixture();
    for c in cases(&f, "saveButtonTitle") {
        let a = &c["args"];
        assert_eq!(
            out_str(rules::save_button_title(b(&a[0]), b(&a[1]))),
            c["out"],
            "{a}"
        );
    }
    for c in cases(&f, "binaryName") {
        let a = &c["args"];
        assert_eq!(rules::binary_name(s(&a[0])), s(&c["out"]), "{a}");
    }
    for c in cases(&f, "binaryCaption") {
        let a = &c["args"];
        assert_eq!(
            rules::binary_caption(s(&a[0]), a[1].as_f64()),
            s(&c["out"]),
            "{a}"
        );
    }
}

#[test]
fn the_page_s_prompts_and_labels_are_the_ts() {
    let f = fixture();
    for c in cases(&f, "deleteQuestion") {
        let a = &c["args"];
        assert_eq!(rules::delete_question(s(&a[0])), s(&c["out"]), "{a}");
    }
    for c in cases(&f, "createPrompt") {
        let a = &c["args"];
        let kind = if s(&a[0]) == "dir" {
            NewKind::Dir
        } else {
            NewKind::File
        };
        let (message, default) = rules::create_prompt(kind, opt(&a[1]));
        assert_eq!(json!([message, default]), c["out"], "{a}");
    }
    for c in cases(&f, "lastSegment") {
        let a = &c["args"];
        assert_eq!(rules::last_segment(s(&a[0])), s(&c["out"]), "{a}");
    }
    for c in cases(&f, "groupOpen") {
        let a = &c["args"];
        assert_eq!(
            rules::group_open(s(&a[0]), a[1].as_bool()),
            b(&c["out"]),
            "{a}"
        );
    }
    for c in cases(&f, "rootLabel") {
        let a = &c["args"];
        assert_eq!(rules::root_label(s(&a[0]), s(&a[1])), s(&c["out"]), "{a}");
    }
    for c in cases(&f, "sourceBadge") {
        let a = &c["args"];
        assert_eq!(out_str(rules::source_badge(s(&a[0]))), c["out"], "{a}");
    }
    for c in cases(&f, "encodingBadge") {
        let a = &c["args"];
        assert_eq!(
            out_str(rules::encoding_badge(b(&a[0]), opt(&a[1]), opt(&a[2]))),
            c["out"],
            "{a}"
        );
    }
    let copy = f["copy"].as_object().expect("copy");
    for (key, ours) in [
        ("binaryHeadline", rules::BINARY_HEADLINE),
        ("binaryBody", rules::BINARY_BODY),
        ("readOnlyDefault", rules::READ_ONLY_DEFAULT),
        ("renamePrompt", rules::RENAME_PROMPT),
        ("hiddenHint", rules::HIDDEN_HINT),
    ] {
        assert_eq!(copy[key], ours, "{key}");
    }
}

#[test]
fn the_highlighted_path_is_page_tsx_s() {
    for c in cases(&fixture(), "selectedPath") {
        let a = &c["args"];
        let open = a[0]
            .as_array()
            .map(|o| (o[0].as_str().unwrap(), o[1].as_str().unwrap()));
        assert_eq!(
            out_str(rules::selected_path(open, opt(&a[1]), opt(&a[2]), s(&a[3]))),
            c["out"],
            "{a}"
        );
    }
}

#[test]
fn the_tree_s_keys_and_walk_are_file_tree_tsx_s() {
    let f = fixture();
    for c in cases(&f, "loadKey") {
        let a = &c["args"];
        assert_eq!(rules::load_key(s(&a[0])), s(&c["out"]), "{a}");
    }
    for c in cases(&f, "ancestorDirs") {
        let a = &c["args"];
        let ours: Vec<Value> = rules::ancestor_dirs(s(&a[0]))
            .into_iter()
            .map(|(p, k)| json!([p, k]))
            .collect();
        assert_eq!(Value::Array(ours), c["out"], "{a}");
    }
}

#[test]
fn find_in_file_matches_as_the_ts() {
    let f = fixture();
    for c in cases(&f, "findMatches") {
        let a = &c["args"];
        let value = match &a[0] {
            Value::String(v) => v.clone(),
            r => s(&r["repeat"][0]).repeat(r["repeat"][1].as_u64().unwrap() as usize),
        };
        let ms = rules::find_matches(&value, s(&a[1]), b(&a[2]));
        let as_json = |m: &rules::Match16| json!({"start": m.start, "end": m.end});
        let ours = if ms.len() > 50 {
            json!({
                "count": ms.len(),
                "first": as_json(&ms[0]),
                "last": as_json(ms.last().unwrap()),
            })
        } else {
            Value::Array(ms.iter().map(as_json).collect())
        };
        assert_eq!(ours, c["out"], "{a}");
    }
    for c in cases(&f, "findCounter") {
        let a = &c["args"];
        assert_eq!(
            rules::find_counter(
                s(&a[0]),
                a[1].as_u64().unwrap() as usize,
                a[2].as_u64().unwrap() as usize
            ),
            s(&c["out"]),
            "{a}"
        );
    }
    for name in ["caseTitle", "folderCaseTitle"] {
        for c in cases(&f, name) {
            let a = &c["args"];
            assert_eq!(rules::case_title(b(&a[0])), s(&c["out"]), "{name} {a}");
        }
    }
    for (name, forward) in [("findNext", true), ("findPrev", false)] {
        for c in cases(&f, name) {
            let a = &c["args"];
            let (i, len) = (
                a[0].as_u64().unwrap() as usize,
                a[1].as_u64().unwrap() as usize,
            );
            assert_eq!(
                rules::find_step(i, len, forward) as u64,
                c["out"].as_u64().unwrap(),
                "{name} {a}"
            );
        }
    }
}

#[test]
fn find_in_folder_groups_cuts_and_sums_as_the_ts() {
    let f = fixture();
    for c in cases(&f, "groupMatches") {
        let a = &c["args"];
        let matches: Vec<ContentMatch> = a[0]
            .as_array()
            .map(|paths| {
                paths
                    .iter()
                    .map(|p| ContentMatch {
                        rel_path: s(p).to_owned(),
                        line: 1.,
                        col: 1.,
                        col_end: 2.,
                        text: "t".into(),
                        truncated: false,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let ours: Vec<Value> = rules::group_matches(&matches)
            .into_iter()
            .map(|(p, hits)| json!([p, hits]))
            .collect();
        assert_eq!(Value::Array(ours), c["out"], "{a}");
    }
    for c in cases(&f, "folderDisplay") {
        let a = &c["args"];
        assert_eq!(
            rules::folder_display(s(&a[0]), s(&a[1])),
            s(&c["out"]),
            "{a}"
        );
    }
    for c in cases(&f, "folderFooter") {
        let a = &c["args"];
        assert_eq!(
            out_str(
                rules::folder_footer(b(&a[0]), n(&a[1]), a[2].as_u64().unwrap() as usize)
                    .as_deref()
            ),
            c["out"],
            "{a}"
        );
    }
    for c in cases(&f, "matchedLine") {
        let a = &c["args"];
        let ours = rules::matched_line(s(&a[0]), n(&a[1]), n(&a[2]))
            .map_or(Value::Null, |(x, y, z)| json!([x, y, z]));
        assert_eq!(ours, c["out"], "{a}");
    }
}

#[test]
fn the_context_menu_clamps_and_labels_as_the_ts() {
    let f = fixture();
    let est = &cases(&f, "menuEstimate")[0]["out"];
    assert_eq!(n(&est[0]), rules::MENU_EST_WIDTH);
    assert_eq!(n(&est[1]), rules::MENU_EST_HEIGHT);
    for c in cases(&f, "clampMenu") {
        let a = &c["args"];
        let (l, t) = rules::clamp_menu(n(&a[0]), n(&a[1]), n(&a[2]), n(&a[3]), n(&a[4]), n(&a[5]));
        assert_eq!((l, t), (n(&c["out"][0]), n(&c["out"][1])), "{a}");
    }
    for c in cases(&f, "revealLabel") {
        let a = &c["args"];
        assert_eq!(rules::reveal_label_for(s(&a[0])), s(&c["out"]), "{a}");
    }
}

#[test]
fn the_letter_key_matcher_is_key_match_ts() {
    for c in cases(&fixture(), "isLetterKey") {
        let a = &c["args"];
        let letter = s(&a[3]).chars().next().unwrap();
        assert_eq!(
            rules::is_letter_key(s(&a[0]), s(&a[1]), b(&a[2]), letter),
            b(&c["out"]),
            "{a}"
        );
    }
}

#[test]
fn the_grammar_and_the_preview_type_of_a_path_are_the_ts() {
    let f = fixture();
    for c in cases(&f, "languageForPath") {
        let a = &c["args"];
        assert_eq!(out_str(rules::language_for_path(s(&a[0]))), c["out"], "{a}");
    }
    for c in cases(&f, "previewType") {
        let a = &c["args"];
        let ours = rules::preview_type(s(&a[0])).map(|p| match p {
            rules::PreviewType::Image => "image",
            rules::PreviewType::Html => "html",
        });
        assert_eq!(out_str(ours), c["out"], "{a}");
    }
}

#[test]
fn the_last_open_entry_reads_and_writes_as_files_last_open_ts() {
    let f = fixture();
    for c in cases(&f, "lastOpenRead") {
        let a = &c["args"];
        let ours = last_open::parse(opt(&a[0])).map_or(
            Value::Null,
            |e| json!({"root": e.root, "relPath": e.rel_path}),
        );
        assert_eq!(ours, c["out"], "{a}");
    }
    for c in cases(&f, "lastOpenWrite") {
        let a = &c["args"];
        let ws = s(&a[0]);
        let entry = LastOpenFile {
            root: s(&a[1]).to_owned(),
            rel_path: s(&a[2]).to_owned(),
        };
        let key = last_open::key_for(ws);
        let ours = json!([
            ["setItem", key, last_open::serialize(&entry)],
            ["removeItem", key],
        ]);
        assert_eq!(ours, c["out"], "{a}");
    }
}

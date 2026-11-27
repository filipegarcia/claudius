//! Replays `fixtures/git_page_golden.json`, recorded from the real TS by
//! `rust/scripts/git-page-golden.mjs`, through the Git page's pure rules:
//! the commit prefix, the PR badge's label, the poll's spacing, the
//! changes list's grouping / tree / row text, the diff's rows and the
//! short error.

use claudius_git::changes::{self, DiffMode, DirNode};
use claudius_git::commit_prefix::{compile_pattern, render_commit_prefix};
use claudius_git::console::summarize_git_error;
use claudius_git::diff::{Line, parse_unified_diff};
use claudius_git::poll::next_git_poll_delay_ms;
use claudius_git::pr_badge::pr_badge_label;
use claudius_git::types::{CommitPrefixConfig, GitFileChange, PrBadge};
use serde_json::{Value, json};

const FIXTURE: &str = include_str!("fixtures/git_page_golden.json");

fn s(v: &Value) -> &str {
    v.as_str().expect("a string arg")
}

/// A JS number as JSON writes it (`4000`, not `4000.0`).
fn num(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 1e18 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// `null` (a NaN / missing arg, after `JSON.stringify`) as NaN.
fn f(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::NAN)
}

fn file(v: &Value) -> GitFileChange {
    serde_json::from_value(v.clone()).expect("a GitFileChange")
}

fn files(v: &Value) -> Vec<GitFileChange> {
    v.as_array().expect("files").iter().map(file).collect()
}

fn mode(v: &Value) -> DiffMode {
    DiffMode::parse(s(v)).expect("a mode")
}

fn paths(xs: &[GitFileChange]) -> Value {
    xs.iter().map(|f| json!(f.path)).collect()
}

fn tree(n: &DirNode) -> Value {
    json!({
        "name": n.name,
        "path": n.path,
        "dirs": n.dirs.iter().map(tree).collect::<Vec<_>>(),
        "files": paths(&n.files),
        "filePaths": n.file_paths,
    })
}

fn line(l: &Line) -> Value {
    let mut o = match l {
        Line::Hunk { text } => json!({"kind": "hunk", "text": text}),
        Line::Meta { text } => json!({"kind": "meta", "text": text}),
        Line::Add { text, n } => json!({"kind": "add", "text": text, "n": num(*n)}),
        Line::Del { text, n } => json!({"kind": "del", "text": text, "n": num(*n)}),
        Line::Ctx { text, ln, rn } => {
            json!({"kind": "ctx", "text": text, "ln": num(*ln), "rn": num(*rn)})
        }
    };
    let m = o.as_object_mut().expect("an object");
    m.insert("left".into(), json!(l.gutter_left()));
    m.insert("right".into(), json!(l.gutter_right()));
    m.insert("prefix".into(), json!(l.prefix()));
    o
}

/// The rule `name` on `args`, as the recorder wrote its result.
fn call(name: &str, args: &[Value]) -> Value {
    let a = |i: usize| &args[i];
    match name {
        "compilePattern" => compile_pattern(s(a(0))).map_or(Value::Null, |c| json!(c.names())),
        "patternExec" => match compile_pattern(s(a(0))).and_then(|c| c.exec(s(a(1)))) {
            None => Value::Null,
            Some(groups) => groups.into_iter().map(|(n, v)| json!([n, v])).collect(),
        },
        "renderCommitPrefix" => {
            let config: Option<CommitPrefixConfig> =
                serde_json::from_value(a(1).clone()).expect("a config");
            json!(render_commit_prefix(a(0).as_str(), config.as_ref()))
        }
        "prBadgeLabel" => {
            let b: PrBadge = serde_json::from_value(a(0).clone()).expect("a badge");
            json!(pr_badge_label(&b))
        }
        "nextGitPollDelayMs" => num(next_git_poll_delay_ms(f(a(0)), a(1).as_f64())),
        "pollSchedule" => a(0)
            .as_array()
            .expect("durations")
            .iter()
            .map(|d| num(next_git_poll_delay_ms(4000., d.as_f64())))
            .collect(),
        "groupFiles" => {
            let g = changes::group_files(&files(a(0)));
            json!({
                "staged": paths(&g.staged),
                "unstaged": paths(&g.unstaged),
                "untracked": paths(&g.untracked),
            })
        }
        "buildDirTree" => tree(&changes::build_dir_tree(&files(a(0)))),
        "isPartialStage" => json!(changes::is_partial_stage(&file(a(0)))),
        "defaultDiffMode" => json!(changes::default_diff_mode(&file(a(0))).as_str()),
        "splitPath" => {
            let (dirs, leaf) = changes::split_path(s(a(0)));
            json!({"dirs": dirs, "leaf": leaf})
        }
        "statusCharForGroup" => json!(changes::status_char_for_group(&file(a(0)), mode(a(1)))),
        "rowTitle" => json!(changes::row_title(
            &file(a(0)),
            mode(a(1)),
            a(2).as_bool().expect("canOpen")
        )),
        "worktreeChangeLabel" => json!(changes::worktree_change_label(s(a(0)))),
        "displayPath" => json!(changes::display_path(
            &file(a(0)),
            mode(a(1)),
            a(2).as_bool().expect("grouped")
        )),
        "dirKey" => json!(changes::dir_key(mode(a(0)), s(a(1)))),
        "parseUnifiedDiff" => parse_unified_diff(s(a(0))).iter().map(line).collect(),
        "summarizeGitError" => json!(summarize_git_error(s(a(0)))),
        other => panic!("no replay for {other}"),
    }
}

#[test]
fn the_rules_replay_the_ts_golden() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture json");
    let sections = fixture["sections"].as_object().expect("sections");
    let mut failures = Vec::new();
    let mut total = 0;
    for (name, cases) in sections {
        for case in cases.as_array().expect("cases") {
            total += 1;
            let args = case["args"].as_array().expect("args");
            let got = call(name, args);
            if got != case["out"] {
                failures.push(format!(
                    "{name}({}):\n  ts:   {}\n  rust: {got}",
                    serde_json::to_string(args).unwrap_or_default(),
                    case["out"]
                ));
            }
        }
    }
    assert!(total >= 2000, "only {total} cases");
    assert!(
        failures.is_empty(),
        "{} of {total} cases differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn the_fixture_covers_every_section_the_replay_knows() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture json");
    let sections = fixture["sections"].as_object().expect("sections");
    for name in [
        "compilePattern",
        "patternExec",
        "renderCommitPrefix",
        "prBadgeLabel",
        "nextGitPollDelayMs",
        "pollSchedule",
        "groupFiles",
        "buildDirTree",
        "isPartialStage",
        "defaultDiffMode",
        "splitPath",
        "statusCharForGroup",
        "rowTitle",
        "worktreeChangeLabel",
        "displayPath",
        "dirKey",
        "parseUnifiedDiff",
        "summarizeGitError",
    ] {
        assert!(
            sections
                .get(name)
                .and_then(Value::as_array)
                .is_some_and(|c| !c.is_empty()),
            "{name} has cases"
        );
    }
}

#[test]
fn the_fixture_is_ascii() {
    assert!(FIXTURE.is_ascii());
}

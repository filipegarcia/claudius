//! Replays `tests/fixtures/composer_pickers_golden.json`, recorded from the
//! real TS by `rust/scripts/composer-pickers-golden.mjs`, through the
//! pickers' ports in `claudius_composer::{slash, mention, emoji}`.
//!
//! The TS's offsets are UTF-16 code units; the ports' are UTF-8 bytes, so
//! the replay converts carets on the way in and out.

use claudius_composer::emoji;
use claudius_composer::mention::{self, Agent, PickerItem};
use claudius_composer::slash::{self, Category, Handler, SlashSuggestion};
use serde_json::{Map, Value, json};

fn fixture() -> Value {
    let text = include_str!("fixtures/composer_pickers_golden.json");
    serde_json::from_str(text).expect("fixture parses")
}

fn cases<'a>(f: &'a Value, section: &str) -> &'a [Value] {
    let v = f[section]
        .as_array()
        .unwrap_or_else(|| panic!("section {section}"));
    assert!(!v.is_empty(), "{section} has cases");
    v
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}

fn strs(v: &Value) -> Vec<String> {
    match v {
        Value::Null => Vec::new(),
        _ => v
            .as_array()
            .unwrap()
            .iter()
            .map(|x| s(x).to_owned())
            .collect(),
    }
}

fn opt(v: Option<&str>) -> Value {
    v.map_or(Value::Null, |x| json!(x))
}

/// A UTF-16 offset of `text` as a byte offset.
fn to_byte(text: &str, units: u64) -> usize {
    let mut n = 0u64;
    for (i, c) in text.char_indices() {
        if n >= units {
            return i;
        }
        n += c.len_utf16() as u64;
    }
    text.len()
}

/// A byte offset of `text` as a UTF-16 offset.
fn to_units(text: &str, byte: usize) -> u64 {
    text[..byte].encode_utf16().count() as u64
}

fn category(id: &str) -> Category {
    let all = [
        Category::Session,
        Category::Permissions,
        Category::Tools,
        Category::Memory,
        Category::Model,
        Category::Ui,
        Category::Cost,
        Category::Skill,
        Category::Info,
        Category::Auth,
        Category::Integrations,
        Category::Platform,
        Category::Experimental,
    ];
    *all.iter()
        .find(|c| c.id() == id)
        .unwrap_or_else(|| panic!("category {id}"))
}

fn rich(v: &Value) -> Option<Vec<slash::SdkCommand>> {
    match v {
        Value::Null => None,
        _ => slash::sdk_commands_of(Some(&json!({ "commands": v }))),
    }
}

/// A merged row as the recorder writes it: registry rows by id, the SDK's
/// with the keys the TS spreads in only when set.
fn row(r: &SlashSuggestion) -> Value {
    if r.source == slash::Source::Registry {
        return json!(r.id);
    }
    let mut o = Map::new();
    o.insert("id".into(), json!(r.id));
    o.insert("name".into(), json!(r.name));
    o.insert("description".into(), json!(r.description));
    o.insert("category".into(), json!(r.category.id()));
    o.insert("handler".into(), json!(r.handler.id()));
    o.insert("source".into(), json!(r.source.id()));
    if let Some(h) = &r.args_hint {
        o.insert("argsHint".into(), json!(h));
    }
    if !r.aliases.is_empty() {
        o.insert("aliases".into(), json!(r.aliases));
    }
    if r.builtin {
        o.insert("builtin".into(), json!(true));
    }
    Value::Object(o)
}

#[test]
fn the_registry_is_the_ts_registry() {
    let f = fixture();
    let rows = cases(&f, "registry");
    assert_eq!(rows.len(), slash::SLASH_COMMANDS.len());
    for (c, want) in slash::SLASH_COMMANDS.iter().zip(rows) {
        let got = json!({
            "id": c.id,
            "name": c.name,
            "aliases": c.aliases,
            "description": c.description,
            "category": c.category.id(),
            "handler": c.handler.id(),
            "argsHint": opt(c.args_hint),
            "forwardsArgsToSdk": c.forwards_args_to_sdk,
        });
        assert_eq!(&got, want, "{}", c.id);
    }
}

#[test]
fn the_registry_matches_the_core_lookup_table() {
    // claudius-core's prompt audit keeps the (id, name, aliases) half.
    let core = claudius_core::slash_commands::SLASH_COMMANDS;
    assert_eq!(core.len(), slash::SLASH_COMMANDS.len());
    for (c, (id, name, aliases)) in slash::SLASH_COMMANDS.iter().zip(core) {
        assert_eq!((c.id, c.name, c.aliases), (*id, *name, *aliases));
    }
}

#[test]
fn categories_are_the_ts_order_and_labels() {
    let f = fixture();
    let order: Vec<&str> = cases(&f, "categoryOrder").iter().map(s).collect();
    let ids: Vec<Category> = order.iter().map(|id| category(id)).collect();
    for (i, c) in ids.iter().enumerate() {
        assert_eq!(*c as usize, i, "{}", c.id());
    }
    let labels = f["categoryLabels"].as_object().unwrap();
    assert_eq!(labels.len(), order.len());
    for (id, label) in labels {
        assert_eq!(category(id).label(), s(label), "{id}");
    }
}

#[test]
fn merge_suggestions_replays_the_ts() {
    let f = fixture();
    for c in cases(&f, "mergeSuggestions") {
        let a = &c["args"];
        let r = rich(&a[2]);
        let got: Vec<Value> = slash::merge_suggestions(&strs(&a[0]), &strs(&a[1]), r.as_deref())
            .iter()
            .map(row)
            .collect();
        assert_eq!(Value::Array(got), c["out"], "{a}");
    }
}

#[test]
fn the_tokens_replay_the_ts() {
    let f = fixture();
    for c in cases(&f, "slashTokenBeforeCaret") {
        let b = s(&c["args"][0]);
        assert_eq!(opt(slash::slash_token_before_caret(b)), c["out"], "{b:?}");
    }
    for c in cases(&f, "atToken") {
        let b = s(&c["args"][0]);
        assert_eq!(opt(mention::at_token_before_caret(b)), c["out"], "{b:?}");
    }
    for c in cases(&f, "parseEmojiTrigger") {
        let b = s(&c["args"][0]);
        assert_eq!(opt(emoji::parse_emoji_trigger(b)), c["out"], "{b:?}");
    }
    for c in cases(&f, "slashAtStart") {
        let v = s(&c["args"][0]);
        assert_eq!(json!(slash::slash_at_start(v)), c["out"], "{v:?}");
    }
}

fn spliced(got: Option<(String, usize)>) -> Value {
    match got {
        None => Value::Null,
        Some((next, at)) => json!({"next": next, "caret": to_units(&next, at)}),
    }
}

#[test]
fn the_picks_splice_as_the_ts() {
    let f = fixture();
    for (section, pick) in [
        (
            "insertSlashCommand",
            (|v: &str, c: usize, n: &str| Some(slash::insert_slash_command(v, c, n)))
                as fn(&str, usize, &str) -> Option<(String, usize)>,
        ),
        ("insertAtMention", |v, c, n| {
            Some(mention::insert_at_mention(v, c, n))
        }),
        ("insertEmojiShortcode", emoji::insert_emoji_shortcode),
    ] {
        for c in cases(&f, section) {
            let a = &c["args"];
            let value = s(&a[0]);
            let caret = to_byte(value, a[1].as_u64().unwrap());
            let got = pick(value, caret, s(&a[2]));
            assert_eq!(spliced(got), c["out"], "{section} {a}");
        }
    }
}

#[test]
fn the_closing_colon_completes_as_the_ts() {
    let f = fixture();
    for c in cases(&f, "emojiCompleteOnClose") {
        let a = &c["args"];
        let (prev, next) = (s(&a[0]), s(&a[1]));
        let caret = to_byte(next, a[2].as_u64().unwrap());
        let got = emoji::complete_on_close(prev, next, caret);
        assert_eq!(spliced(got), c["out"], "{a}");
    }
}

#[test]
fn the_scores_replay_the_ts() {
    let f = fixture();
    for c in cases(&f, "fuzzyScore") {
        let a = &c["args"];
        let got = slash::fuzzy_score(s(&a[0]), s(&a[1]));
        assert_eq!(json!(got), c["out"], "{a}");
    }
    for c in cases(&f, "descriptionWordPrefixScore") {
        let a = &c["args"];
        let got = slash::description_word_prefix_score(s(&a[0]), s(&a[1]));
        assert_eq!(json!(got), c["out"], "{a}");
    }
    for c in cases(&f, "fuzzySlashMatchIndices") {
        let a = &c["args"];
        let got = slash::fuzzy_slash_match_indices(s(&a[0]), s(&a[1]));
        assert_eq!(json!(got), c["out"], "{a}");
    }
    for c in cases(&f, "toRuns") {
        let ix: Vec<usize> = c["args"][0]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as usize)
            .collect();
        let got: Vec<[usize; 2]> = slash::to_runs(&ix).iter().map(|r| [r.0, r.1]).collect();
        assert_eq!(json!(got), c["out"], "{ix:?}");
    }
    for c in cases(&f, "highlight") {
        let a = &c["args"];
        let got: Vec<Value> = slash::highlight_segments(s(&a[0]), s(&a[1]))
            .into_iter()
            .map(|(t, b)| json!([t, b]))
            .collect();
        assert_eq!(Value::Array(got), c["out"], "{a}");
    }
    for c in cases(&f, "isConfidentSlashMatch") {
        let a = &c["args"];
        let got = slash::is_confident_slash_match(s(&a[1]), &strs(&a[2]), s(&a[0]));
        assert_eq!(json!(got), c["out"], "{a}");
    }
}

#[test]
fn the_ranking_replays_the_ts() {
    let f = fixture();
    for c in cases(&f, "ranked") {
        let a = &c["args"];
        let r = rich(&a[3]);
        let all = slash::merge_suggestions(&strs(&a[1]), &strs(&a[2]), r.as_deref());
        let filter = slash::picker_filter(s(&a[0]));
        let names: Vec<&str> = slash::filter_suggestions(&all, &filter)
            .iter()
            .map(|r| r.name.as_str())
            .collect();
        assert_eq!(
            json!({"filter": filter, "names": names}),
            c["out"],
            "{}",
            a[0]
        );
    }
}

fn agents(v: &Value) -> Vec<Agent> {
    mention::agents_of(Some(&json!({ "agents": v })))
}

fn item_json(item: &PickerItem) -> Value {
    match item {
        PickerItem::File { rel_path, dir } => {
            json!({"kind": "file", "relPath": rel_path, "type": if *dir { "dir" } else { "file" }})
        }
        PickerItem::Agent(a) => json!({
            "kind": "agent", "name": a.name, "description": opt(a.description.as_deref()),
            "model": opt(a.model.as_deref()),
        }),
    }
}

#[test]
fn the_mentions_replay_the_ts() {
    let f = fixture();
    for c in cases(&f, "parseAtMentionQuery") {
        let q = s(&c["args"][0]);
        let (agent_mode, filter) = mention::parse_at_mention_query(q);
        assert_eq!(
            json!({"agentMode": agent_mode, "filter": filter}),
            c["out"],
            "{q:?}"
        );
    }
    for c in cases(&f, "normalizeFileMentionQuery") {
        let q = s(&c["args"][0]);
        assert_eq!(
            json!(mention::normalize_file_mention_query(q)),
            c["out"],
            "{q:?}"
        );
    }
    for c in cases(&f, "itemToken") {
        let a = &c["args"][0];
        let item = if a["kind"] == "agent" {
            PickerItem::Agent(Agent {
                name: s(&a["name"]).into(),
                description: None,
                model: None,
            })
        } else {
            PickerItem::File {
                rel_path: s(&a["relPath"]).into(),
                dir: a["type"] == "dir",
            }
        };
        assert_eq!(json!(mention::item_token(&item)), c["out"], "{a}");
    }
    for c in cases(&f, "filterAgents") {
        let a = &c["args"];
        let got: Vec<Value> = mention::filter_agents(&agents(&a[0]), s(&a[1]))
            .iter()
            .map(item_json)
            .collect();
        assert_eq!(Value::Array(got), c["out"], "{}", a[1]);
    }
    for c in cases(&f, "fsListErrorText") {
        let a = &c["args"];
        let status = a[0].as_u64().unwrap() as u16;
        // A non-string `error` is what React renders: its text.
        let want = match &c["out"] {
            Value::Number(n) => json!(n.to_string()),
            v => v.clone(),
        };
        assert_eq!(
            opt(mention::fs_list_error_text(status, &a[1]).as_deref()),
            want,
            "{a}"
        );
    }
    for c in cases(&f, "fsListUrl") {
        let a = &c["args"];
        let got = mention::fs_list_url(s(&a[0]), a[1].as_str());
        assert_eq!(json!(got), c["out"], "{a}");
    }
    for c in cases(&f, "agentsUrl") {
        assert_eq!(json!(mention::agents_url(s(&c["args"][0]))), c["out"]);
    }
    for c in cases(&f, "atCountLabel") {
        let a = &c["args"];
        let got = mention::count_label(
            a[0].as_bool().unwrap(),
            a[1].as_bool().unwrap(),
            a[2].as_u64().unwrap() as usize,
        );
        assert_eq!(json!(got), c["out"], "{a}");
    }
    for c in cases(&f, "agentsOf") {
        let d = &c["args"][0];
        let names: Vec<String> = mention::agents_of(Some(d))
            .into_iter()
            .map(|a| a.name)
            .collect();
        assert_eq!(json!(names), c["out"], "{d}");
    }
}

#[test]
fn the_command_list_reads_as_the_ts() {
    let f = fixture();
    for c in cases(&f, "commandsUrl") {
        let id = s(&c["args"][0]);
        let url = format!(
            "/api/sessions/{}/commands",
            claudius_composer::rules::encode_uri_component(id)
        );
        assert_eq!(json!(url), c["out"]);
    }
    for c in cases(&f, "sdkCommandsOf") {
        let d = &c["args"][0];
        let names = slash::sdk_commands_of(Some(d))
            .map(|l| l.into_iter().map(|c| c.name).collect::<Vec<_>>());
        assert_eq!(json!(names), c["out"], "{d}");
    }
}

#[test]
fn the_emoji_table_is_the_ts_table() {
    let f = fixture();
    let rows = cases(&f, "emojiShortcodes");
    assert_eq!(rows.len(), emoji::EMOJI_SHORTCODES.len());
    for ((k, e), want) in emoji::EMOJI_SHORTCODES.iter().zip(rows) {
        assert_eq!(&json!([k, e]), want);
    }
    let rows = cases(&f, "emojiAliases");
    assert_eq!(rows.len(), emoji::EMOJI_ALIASES.len());
    for ((k, e), want) in emoji::EMOJI_ALIASES.iter().zip(rows) {
        assert_eq!(&json!([k, e]), want);
    }
}

#[test]
fn the_emoji_rules_replay_the_ts() {
    let f = fixture();
    for c in cases(&f, "filterEmojiShortcodes") {
        let q = s(&c["args"][0]);
        let got: Vec<Value> = emoji::filter_emoji_shortcodes(q)
            .into_iter()
            .map(|(name, emoji)| json!({"name": name, "emoji": emoji}))
            .collect();
        assert_eq!(Value::Array(got), c["out"], "{q:?}");
    }
    for c in cases(&f, "lookupEmojiShortcode") {
        let n = s(&c["args"][0]);
        assert_eq!(opt(emoji::lookup_emoji_shortcode(n)), c["out"], "{n:?}");
    }
    for c in cases(&f, "emojiCountLabel") {
        let n = c["args"][0].as_u64().unwrap() as usize;
        assert_eq!(json!(emoji::count_label(n)), c["out"]);
    }
    for c in cases(&f, "emojiEnabledOf") {
        let d = &c["args"][0];
        assert_eq!(json!(emoji::emoji_enabled_of(d)), c["out"], "{d}");
    }
    for c in cases(&f, "settingsUrl") {
        assert_eq!(json!(emoji::settings_url(s(&c["args"][0]))), c["out"]);
    }
}

#[test]
fn the_prototype_lookups_are_a_ts_quirk_not_mirrored() {
    let f = fixture();
    for c in cases(&f, "emojiPrototypeQuirk") {
        let name = s(&c["name"]);
        // The TS hands back Object.prototype's members; none is an emoji.
        assert_ne!(c["type"], "undefined", "{name}");
        assert_ne!(c["type"], "string", "{name}");
        assert_eq!(emoji::lookup_emoji_shortcode(name), None, "{name}");
    }
}

#[test]
fn the_copy_is_the_ts_copy() {
    let f = fixture();
    let copy = &f["copy"];
    assert_eq!(slash::HEADER, s(&copy["slashHeader"]));
    assert_eq!(slash::BUILTIN_BADGE, s(&copy["builtinBadge"]));
    assert!(s(&copy["badgeApp"]).contains(Handler::Native.badge_label()));
    assert!(s(&copy["badgeSdk"]).contains(Handler::Sdk.badge_label()));
    assert!(s(&copy["badgeExternal"]).contains(Handler::External.badge_label()));
    assert!(s(&copy["pointer"]).contains('\u{276f}'));
    assert_eq!(mention::HEADER, s(&copy["atHeader"]));
    assert!(s(&copy["atLoading"]).contains(mention::LOADING));
    assert_eq!(emoji::HEADER, s(&copy["emojiHeader"]));
    let fallbacks = slash::merge_suggestions(&["a".into(), "b".into()], &["b".into()], None);
    let desc = |n: &str| {
        fallbacks
            .iter()
            .find(|r| r.name == n)
            .map(|r| format!("{:?}", r.description))
            .unwrap()
    };
    assert_eq!(desc("a"), s(&copy["sdkFallback"]));
    assert_eq!(desc("b"), s(&copy["skillFallback"]));
}

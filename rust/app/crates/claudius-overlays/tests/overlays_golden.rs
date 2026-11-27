//! Replays `tests/fixtures/overlays_golden.json`, recorded from the TS by
//! `rust/scripts/overlays-golden.mjs`: the palette's tables, `fuzzyMatch`,
//! `workspaceIdFromPathname`, the rows (over the TS shortcut registry), the
//! filter, a palette driven step by step, the slash registry,
//! `mergeSuggestions`, the help overlay's groups and usage card, and
//! `findHelpTopic` / `usageLine`. The rows over the app's own shortcut
//! registry are claudius-app's `tests/palette_golden.rs`.

use claudius_overlays::ShortcutRow;
use claudius_overlays::help::{HelpModel, SHORTCUT_CATEGORIES, TopicCard};
use claudius_overlays::palette::{
    Activation, GLOBAL_NAV, Item, Palette, PaletteKey, WORKSPACE_NAV, build_items, filter_items,
    fuzzy_match, workspace_id_from_pathname,
};
use claudius_overlays::slash::{
    Category, SLASH_COMMANDS, SdkCommandInfo, find_help_topic, merge_suggestions, usage_line,
};
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/overlays_golden.json"))
        .expect("the fixture is JSON")
}

fn cases<'a>(f: &'a Value, section: &str) -> &'a [Value] {
    f[section]
        .as_array()
        .unwrap_or_else(|| panic!("{section} is recorded"))
}

fn opt_str(v: &Value) -> Option<String> {
    v.as_str().map(str::to_owned)
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().filter_map(opt_str).collect())
        .unwrap_or_default()
}

/// The TS registry's rows, as the palette and the cheatsheet get them.
fn ts_rows(f: &Value, mac: bool) -> Vec<ShortcutRow> {
    let fmt = cases(f, "formatBinding");
    cases(f, "shortcutActions")
        .iter()
        .zip(fmt)
        .map(|(a, b)| {
            assert_eq!(a["id"], b["id"]);
            ShortcutRow {
                id: a["id"].as_str().unwrap().into(),
                label: a["label"].as_str().unwrap().into(),
                description: opt_str(&a["description"]),
                category: a["category"].as_str().unwrap().into(),
                chord: (!a["default"].is_null()).then(|| {
                    b[if mac { "mac" } else { "other" }]
                        .as_str()
                        .unwrap()
                        .into()
                }),
            }
        })
        .collect()
}

fn platform_is_mac(v: &Value) -> bool {
    match v.as_str() {
        Some("mac") => true,
        Some("other") => false,
        other => panic!("platform {other:?}"),
    }
}

fn item_json(i: &Item) -> Value {
    let mut o = serde_json::Map::new();
    o.insert("id".into(), json!(i.id));
    o.insert("kind".into(), json!(i.kind.id()));
    o.insert("label".into(), json!(i.label));
    if let Some(d) = &i.detail {
        o.insert("detail".into(), json!(d));
    }
    if let Some(h) = &i.href {
        o.insert("href".into(), json!(h));
    }
    Value::Object(o)
}

/// The TS drops `detail: undefined` from JSON: so does [`item_json`].
fn ts_item(v: &Value) -> Value {
    let mut o = v.as_object().unwrap().clone();
    o.retain(|_, x| !x.is_null());
    Value::Object(o)
}

fn items_for(f: &Value, ws: &Value, platform: &Value) -> Vec<Item> {
    build_items(
        ws.as_str(),
        SLASH_COMMANDS,
        &ts_rows(f, platform_is_mac(platform)),
    )
}

#[test]
fn the_nav_catalogs_are_the_ts() {
    let f = fixture();
    let ws: Vec<Value> = WORKSPACE_NAV
        .iter()
        .map(|n| json!({ "label": n.label, "path": n.path }))
        .collect();
    assert_eq!(Value::Array(ws), f["workspaceNav"]);
    let global: Vec<Value> = GLOBAL_NAV
        .iter()
        .map(|n| json!({ "label": n.label, "path": n.path }))
        .collect();
    assert_eq!(Value::Array(global), f["globalNav"]);
}

#[test]
fn fuzzy_match_replays_the_ts() {
    let f = fixture();
    for c in cases(&f, "fuzzyMatch") {
        let (t, q) = (
            c["args"][0].as_str().unwrap(),
            c["args"][1].as_str().unwrap(),
        );
        assert_eq!(fuzzy_match(t, q), c["out"].as_f64(), "{t:?} {q:?}");
    }
}

#[test]
fn workspace_id_from_pathname_replays_the_ts() {
    let f = fixture();
    for c in cases(&f, "workspaceIdFromPathname") {
        let p = c["args"][0].as_str().unwrap();
        assert_eq!(workspace_id_from_pathname(p), c["out"].as_str(), "{p:?}");
    }
}

#[test]
fn the_items_memo_replays_the_ts() {
    let f = fixture();
    for c in cases(&f, "items") {
        let items = items_for(&f, &c["args"][0], &c["args"][1]);
        let want: Vec<Value> = c["out"].as_array().unwrap().iter().map(ts_item).collect();
        let got: Vec<Value> = items.iter().map(item_json).collect();
        assert_eq!(got.len(), want.len(), "{}", c["args"]);
        for (g, w) in got.iter().zip(&want) {
            assert_eq!(g, w, "{}", c["args"]);
        }
    }
}

#[test]
fn the_filtered_memo_replays_the_ts() {
    let f = fixture();
    for c in cases(&f, "filter") {
        let items = items_for(&f, &c["args"][0], &c["args"][1]);
        let q = c["args"][2].as_str().unwrap();
        let got: Vec<String> = filter_items(&items, q).into_iter().map(|i| i.id).collect();
        assert_eq!(got, strings(&c["out"]), "{q:?}");
    }
}

#[test]
fn a_palette_driven_step_by_step_replays_the_ts() {
    let f = fixture();
    for c in cases(&f, "simulate") {
        let items = items_for(&f, &c["args"][0], &c["args"][1]);
        let mut p = Palette::new(items);
        let mut open = true;
        let mut pushed: Vec<String> = Vec::new();
        let run = |a: Option<Activation>, open: &mut bool, pushed: &mut Vec<String>| {
            if let Some(a) = a {
                *open = false;
                if let Activation::Navigate(h) = a {
                    pushed.push(h);
                }
            }
        };
        let steps = c["args"][2].as_array().unwrap();
        let trace = c["out"].as_array().unwrap();
        assert_eq!(steps.len(), trace.len());
        for (i, (step, want)) in steps.iter().zip(trace).enumerate() {
            if let Some(k) = step["key"].as_str() {
                let key = match k {
                    "ArrowDown" => Some(PaletteKey::Down),
                    "ArrowUp" => Some(PaletteKey::Up),
                    "Enter" => Some(PaletteKey::Enter),
                    _ => None,
                };
                if let Some(key) = key {
                    let a = p.key(key);
                    run(a, &mut open, &mut pushed);
                }
            } else if let Some(q) = step["query"].as_str() {
                p.set_query(q);
            } else if let Some(n) = step["hover"].as_u64() {
                p.hover(n as usize);
            } else if let Some(n) = step["click"].as_u64() {
                let a = p.click(n as usize);
                run(a, &mut open, &mut pushed);
            } else {
                panic!("step {step}");
            }
            let at = format!("{} step {i}", c["args"][2]);
            assert_eq!(p.active(), want["active"].as_i64().unwrap(), "{at}");
            assert_eq!(
                p.active_item().map(|i| i.id.clone()),
                opt_str(&want["activeId"]),
                "{at}"
            );
            assert_eq!(
                p.rows().len() as u64,
                want["count"].as_u64().unwrap(),
                "{at}"
            );
            assert_eq!(open, want["open"].as_bool().unwrap(), "{at}");
            assert_eq!(pushed, strings(&want["pushed"]), "{at}");
        }
    }
}

#[test]
fn the_slash_registry_is_the_ts_entry_by_entry() {
    let f = fixture();
    let ts = cases(&f, "slashCommands");
    assert_eq!(ts.len(), SLASH_COMMANDS.len());
    for (c, t) in SLASH_COMMANDS.iter().zip(ts) {
        assert_eq!(c.id, t["id"], "{}", c.id);
        assert_eq!(c.name, t["name"], "{}", c.id);
        let aliases: Vec<&str> = c.aliases.to_vec();
        assert_eq!(aliases, strings(&t["aliases"]), "{}", c.id);
        assert_eq!(c.description, t["description"], "{}", c.id);
        assert_eq!(c.category.id(), t["category"], "{}", c.id);
        assert_eq!(c.handler.id(), t["handler"], "{}", c.id);
        assert_eq!(c.args_hint, t["argsHint"].as_str(), "{}", c.id);
        assert_eq!(
            c.forwards_args_to_sdk,
            t["forwardsArgsToSdk"].as_bool().unwrap_or(false),
            "{}",
            c.id
        );
    }
}

#[test]
fn the_categories_are_the_ts() {
    let f = fixture();
    let order: Vec<&str> = Category::ORDER.iter().map(|c| c.id()).collect();
    assert_eq!(order, strings(&f["slashCategoryOrder"]));
    for c in Category::ORDER {
        assert_eq!(c.label(), f["slashCategoryLabels"][c.id()], "{}", c.id());
    }
    assert_eq!(
        f["slashCategoryLabels"].as_object().unwrap().len(),
        Category::ORDER.len()
    );
    let order: Vec<&str> = SHORTCUT_CATEGORIES.iter().map(|(c, _)| *c).collect();
    assert_eq!(order, strings(&f["shortcutCategoryOrder"]));
    for (c, label) in SHORTCUT_CATEGORIES {
        assert_eq!(label, f["shortcutCategoryLabels"][c], "{c}");
    }
}

fn rich_of(v: &Value) -> Option<Vec<SdkCommandInfo>> {
    let list = v.as_array()?;
    Some(
        list.iter()
            .map(|r| SdkCommandInfo {
                name: r["name"].as_str().unwrap().into(),
                description: opt_str(&r["description"]),
                argument_hint: opt_str(&r["argumentHint"]),
                aliases: r["aliases"].as_array().map(|_| strings(&r["aliases"])),
                builtin: r["builtin"].as_bool().unwrap_or(false),
            })
            .collect(),
    )
}

#[test]
fn merge_suggestions_replays_the_ts() {
    let f = fixture();
    for c in cases(&f, "mergeSuggestions") {
        let (sdk, skills) = (strings(&c["args"][0]), strings(&c["args"][1]));
        let rich = rich_of(&c["args"][2]);
        let all = merge_suggestions(&sdk, &skills, rich.as_deref());
        let want = c["out"].as_array().unwrap();
        assert_eq!(all.len(), want.len(), "{}", c["args"]);
        for (g, w) in all.iter().zip(want) {
            let at = format!("{} {}", c["args"], g.id);
            assert_eq!(g.id, w["id"], "{at}");
            assert_eq!(g.name, w["name"], "{at}");
            assert_eq!(g.category.id(), w["category"], "{at}");
            assert_eq!(g.handler.id(), w["handler"], "{at}");
            assert_eq!(g.source.id(), w["source"], "{at}");
            assert_eq!(g.description, w["description"], "{at}");
            assert_eq!(g.args_hint.as_deref(), w["argsHint"].as_str(), "{at}");
            assert_eq!(g.aliases, strings(&w["aliases"]), "{at}");
            assert_eq!(g.builtin, w["builtin"].as_bool().unwrap_or(false), "{at}");
        }
    }
}

#[test]
fn the_help_overlay_replays_the_ts() {
    let f = fixture();
    for c in cases(&f, "help") {
        let a = &c["args"];
        let mut m = HelpModel::new(strings(&a[0]), strings(&a[1]), opt_str(&a[3]));
        m.set_rich(rich_of(&a[2]));
        if let Some(filter) = a[4].as_str() {
            m.set_filter(filter);
        }
        let out = &c["out"];
        assert_eq!(m.subtitle(), out["subtitle"], "{a}");
        assert_eq!(m.filter(), out["filter"], "{a}");
        let card = match m.card() {
            None => Value::Null,
            Some(TopicCard::Missing { topic }) => json!({ "missing": topic }),
            Some(TopicCard::Usage {
                usage,
                description,
                aliases,
            }) => json!({ "usage": usage, "description": description, "aliases": aliases }),
        };
        assert_eq!(card, out["card"], "{a}");
        let groups: Vec<Value> = m
            .groups()
            .iter()
            .map(|g| {
                json!({
                    "category": g.category.id(),
                    "heading": g.heading,
                    "ids": g.commands.iter().map(|c| c.id.clone()).collect::<Vec<_>>(),
                })
            })
            .collect();
        assert_eq!(Value::Array(groups), out["groups"], "{a}");
    }
}

#[test]
fn find_help_topic_and_usage_line_replay_the_ts() {
    let f = fixture();
    let all = merge_suggestions(&[], &[], None);
    for c in cases(&f, "findHelpTopic") {
        let t = c["args"][0].as_str().unwrap();
        let got = find_help_topic(&all, t).map(|c| json!({ "id": c.id, "usage": usage_line(c) }));
        assert_eq!(got.unwrap_or(Value::Null), c["out"], "{t:?}");
    }
}

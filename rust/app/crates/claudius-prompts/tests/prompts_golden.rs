//! Replays `rust/scripts/prompts-golden.mjs`: the helpers the cards port
//! (lib/shared/invisible-unicode.ts, lib/shared/elicitation.ts,
//! `formatAskAsPrompt`, `looksLikeHtml`) and what each React card renders
//! (`PermissionPrompt`, `McpElicitationPrompt`, `AskUserQuestionPrompt`,
//! some mid-interaction), against claudius-prompts' models.

use claudius_core::js_string::stringify;
use claudius_prompts::ask::{
    AskAnswer, AskForm, AskMode, AskQuestion, PreviewContent, RightPane, Working,
    format_ask_as_prompt, looks_like_html, session_chip,
};
use claudius_prompts::elicitation::{
    ElicitationCard, ElicitationForm, Field, FieldKind, FieldValue, FormValues,
    build_elicitation_content, initial_form_values, parse_elicitation_schema, safe_elicitation_url,
};
use claudius_prompts::permission::{PermissionCard, PermissionForm, hidden_chars_text};
use claudius_prompts::unicode::{
    strip_invisible_unicode, visualize_hidden_name_unicode, visualize_invisible_unicode,
};
use serde_json::{Map, Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/prompts_golden.json")).expect("the golden is JSON")
}

fn section(name: &str) -> Vec<Value> {
    fixture()[name].as_array().expect(name).clone()
}

fn opt_str(v: Option<String>) -> Value {
    v.map_or(Value::Null, Value::String)
}

/// Compares as `JSON.stringify` writes them (key order included).
#[track_caller]
fn same(got: &Value, want: &Value, what: &str) {
    assert_eq!(stringify(got), stringify(want), "{what}");
}

#[test]
fn visualize_and_strip_match_the_ts() {
    for c in section("visualize") {
        let t = c["text"].as_str().unwrap();
        let (v, n) = visualize_invisible_unicode(t);
        same(&json!({ "visualized": v, "count": n }), &c["invisible"], t);
        let (v, n) = visualize_hidden_name_unicode(t);
        same(&json!({ "visualized": v, "count": n }), &c["hiddenName"], t);
        let s = strip_invisible_unicode(t);
        same(
            &json!({ "cleaned": s.cleaned, "removedCount": s.removed_count, "bidiCount": s.bidi_count }),
            &c["strip"],
            t,
        );
    }
}

fn values_of(v: &Value) -> FormValues {
    v.as_object()
        .unwrap()
        .iter()
        .filter_map(|(k, v)| Some((k.clone(), FieldValue::from_json(v)?)))
        .collect()
}

fn values_json(v: &FormValues) -> Value {
    let mut m = Map::new();
    for (k, x) in v {
        m.insert(k.clone(), x.to_json());
    }
    Value::Object(m)
}

#[test]
fn the_schema_mapping_and_validation_match_the_ts() {
    let mut builds = 0;
    for c in section("schema") {
        let name = c["name"].as_str().unwrap();
        let fields = parse_elicitation_schema(Some(&c["schema"]));
        same(
            &Value::Array(fields.iter().map(Field::to_json).collect()),
            &c["fields"],
            name,
        );
        let initial = initial_form_values(&fields);
        same(&values_json(&initial), &c["initial"], name);
        for b in c["builds"].as_array().unwrap() {
            let values = if b["values"].is_null() {
                initial.clone()
            } else {
                values_of(&b["values"])
            };
            let got = match build_elicitation_content(&fields, &values) {
                Ok(content) => json!({ "ok": content }),
                Err(errors) => json!({ "errors": errors }),
            };
            same(&got, &b["out"], &format!("{name} {}", b["values"]));
            builds += 1;
        }
    }
    assert!(builds >= 20, "{builds}");
}

#[test]
fn safe_elicitation_url_matches_the_ts() {
    for c in section("url") {
        let raw = c["raw"].as_str();
        let got = safe_elicitation_url(raw).map_or(
            Value::Null,
            |u| json!({ "href": u.href, "host": u.host, "origin": u.origin }),
        );
        same(&got, &c["out"], &format!("{raw:?}"));
    }
}

fn questions(v: &Value) -> Vec<AskQuestion> {
    v.as_array()
        .unwrap()
        .iter()
        .map(AskQuestion::from_json)
        .collect()
}

#[test]
fn format_ask_as_prompt_matches_the_ts() {
    for c in section("formatAsk") {
        let answers: Vec<AskAnswer> = c["answers"]
            .as_array()
            .unwrap()
            .iter()
            .map(AskAnswer::from_json)
            .collect();
        assert_eq!(
            format_ask_as_prompt(&questions(&c["questions"]), &answers),
            c["out"].as_str().unwrap(),
            "{c}"
        );
    }
}

#[test]
fn looks_like_html_matches_the_ts() {
    for c in section("looksLikeHtml") {
        let s = c["s"].as_str().unwrap();
        assert_eq!(looks_like_html(s), c["out"].as_bool().unwrap(), "{s:?}");
    }
}

#[test]
fn the_permission_card_renders_what_the_ts_renders() {
    for c in section("permissionCard") {
        let name = c["name"].as_str().unwrap();
        let queue = c["queueTotal"].as_u64().map(|n| n as usize);
        let card = PermissionCard::new(
            &c["request"],
            queue,
            c["autoModeAvailable"].as_bool().unwrap(),
        );
        let mut form = PermissionForm::new(&card);
        if let Some(st) = c["state"].as_array() {
            form.show_deny = st[0].as_bool().unwrap();
            form.feedback = st[1].as_str().unwrap().to_owned();
            form.show_input = st[2].as_bool().unwrap();
        }
        let mut buttons = vec![card.input_toggle_label()];
        if card.auto_mode_tip {
            buttons.push("Yes, and switch to auto mode".into());
        }
        buttons.extend(card.buttons(&form).into_iter().map(str::to_owned));
        if form.show_deny {
            buttons.extend([
                "Deny without feedback".to_owned(),
                "Deny with feedback".to_owned(),
            ]);
        }
        let got = json!({
            "summary": card.summary,
            "description": opt_str(card.description.clone()),
            "queue": opt_str(card.queue_label.clone()),
            "queueTitle": opt_str(card.queue_title.clone()),
            "agent": opt_str(card.agent_badge.clone()),
            "mcp": opt_str(card.mcp_badge.as_ref().map(|b| b.text.clone())),
            "mcpSdk": card.mcp_badge.as_ref().map_or(Value::Null, |b| json!(b.sdk)),
            "hook": opt_str(card.hook_text()),
            "symlink": opt_str(card.symlink.as_ref().map(|s| s.text())),
            "hidden": opt_str((card.hidden_char_count > 0).then(|| hidden_chars_text(card.hidden_char_count))),
            "rule": opt_str(card.always_rule.as_ref().map(|r| r.text())),
            "autoTip": card.auto_mode_tip,
            "defaultToNo": card.default_to_no,
            "buttons": buttons,
            "denyPanel": form.show_deny,
            "input": opt_str(form.show_input.then(|| card.input_text.clone())),
        });
        same(&got, &c["out"], name);
    }
}

fn field_facts(card: &ElicitationCard, form: &ElicitationForm) -> Value {
    let facts: Vec<Value> = card
        .fields
        .iter()
        .map(|f| {
            let star = if f.required { "*" } else { "" };
            let text = |k: &str| match form.value(k) {
                Some(FieldValue::Text(s)) => s.clone(),
                _ => String::new(),
            };
            let (label, control, ty, value, checked, options) = match &f.kind {
                FieldKind::Boolean { .. } => (
                    f.label.clone(),
                    "checkbox",
                    Value::Null,
                    Value::Null,
                    vec![form.value(&f.key) == Some(&FieldValue::Bool(true))],
                    vec![],
                ),
                FieldKind::MultiEnum { options, .. } => {
                    let picked = match form.value(&f.key) {
                        Some(FieldValue::Multi(p)) => p.clone(),
                        _ => vec![],
                    };
                    (
                        format!("{}{star}", f.label),
                        "multi",
                        Value::Null,
                        Value::Null,
                        options.iter().map(|o| picked.contains(&o.value)).collect(),
                        options.iter().map(|o| o.label.clone()).collect(),
                    )
                }
                FieldKind::Enum { options, .. } => {
                    let v = text(&f.key);
                    let shown = if options.iter().any(|o| o.value == v) { v } else { String::new() };
                    let mut labels = vec!["Choose\u{2026}".to_owned()];
                    labels.extend(options.iter().map(|o| o.label.clone()));
                    (format!("{}{star}", f.label), "select", Value::Null, json!(shown), vec![], labels)
                }
                _ => (
                    format!("{}{star}", f.label),
                    "input",
                    json!(f.input_type()),
                    json!(text(&f.key)),
                    vec![],
                    vec![],
                ),
            };
            json!({
                "label": label,
                "control": control,
                "type": ty,
                "testid": if control == "input" { json!(format!("mcp-elicitation-field-{}", f.key)) } else { Value::Null },
                "value": value,
                "checked": checked,
                "options": options,
                "help": opt_str(f.description.clone()),
                "error": opt_str(form.error(&f.key).map(str::to_owned)),
            })
        })
        .collect();
    Value::Array(facts)
}

#[test]
fn the_elicitation_card_renders_what_the_ts_renders() {
    for c in section("elicitationCard") {
        let name = c["name"].as_str().unwrap();
        let queue = c["queueTotal"].as_u64().map(|n| n as usize);
        let card = ElicitationCard::new(&c["request"], queue, None);
        let mut form = ElicitationForm::new(&card);
        if let Some(st) = c["state"].as_object() {
            if let Some(errors) = st.get("1").and_then(Value::as_object) {
                form.errors = errors
                    .iter()
                    .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
                    .collect();
            }
            if let Some(opened) = st.get("2").and_then(Value::as_bool) {
                form.link_opened = opened;
            }
        }
        let done = form.shows_done(&card);
        let got = json!({
            "heading": card.heading,
            "server": card.server_name,
            "queue": opt_str(card.queue_label.clone()),
            "description": opt_str(card.description.clone()),
            "message": opt_str(card.message.clone()),
            "host": opt_str(card.url.as_ref().map(|u| u.host.clone())),
            "href": opt_str(card.url.as_ref().map(|u| u.href.clone())),
            "unsafe": card.is_url && card.url.is_none(),
            "submit": if card.is_url { Value::Null } else { json!(card.submit_label()) },
            "open": if card.is_url && !done { json!({ "disabled": card.url.is_none() }) } else { Value::Null },
            "done": done,
            "fields": field_facts(&card, &form),
        });
        same(&got, &c["out"], name);
    }
}

fn working_of(v: &Value) -> Working {
    Working {
        selected_labels: v["selectedLabels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l.as_str().unwrap().to_owned())
            .collect(),
        custom: v["custom"].as_str().unwrap().to_owned(),
        show_other: v["showOther"].as_bool().unwrap(),
    }
}

#[test]
fn the_ask_card_renders_what_the_ts_renders() {
    for c in section("askCard") {
        let name = c["name"].as_str().unwrap();
        let inline = c["inline"].as_bool().unwrap();
        let minimize = c["minimize"].as_bool().unwrap();
        let mut form = AskForm::new("q1", questions(&c["questions"]));
        if let Some(st) = c["state"].as_object() {
            form.active = st["0"].as_u64().unwrap() as usize;
            form.working = st["1"].as_array().unwrap().iter().map(working_of).collect();
            form.focused_option = st["2"].as_u64().unwrap() as usize;
        }
        let q = form.question().unwrap().clone();
        let w = form.working();
        let pane = form.right_pane();
        let (preview, label) = form.preview();
        let in_preview = pane == RightPane::Preview;
        let mode = if inline {
            AskMode::Inline
        } else {
            AskMode::Modal
        };
        let got = json!({
            "waiting": inline,
            "session": opt_str(session_chip(c["sessionLabel"].as_str()).map(str::to_owned)),
            "position": form.position(),
            "multiBadge": q.multi_select,
            "chips": form.chips().into_iter().enumerate().map(|(i, t)| json!({ "text": t, "ready": form.is_ready(i) })).collect::<Vec<_>>(),
            "header": opt_str((!q.header.is_empty()).then(|| q.header.clone())),
            "question": q.question,
            "multiHint": opt_str(form.multi_hint().map(|(a, b)| format!("{a}{}", b.unwrap_or_default()))),
            "options": q.options.iter().enumerate().map(|(i, o)| json!({
                "text": format!("{}{}{}", o.label, o.description, i + 1),
                "selected": w.selected_labels.contains(&o.label),
            })).collect::<Vec<_>>(),
            "otherInline": w.show_other,
            "otherPane": pane == RightPane::Other,
            "previewLabel": opt_str((in_preview && !label.is_empty()).then(|| format!("Preview \u{00B7} {label}"))),
            "previewNone": in_preview && preview == PreviewContent::None,
            "previewText": opt_str(match &preview { PreviewContent::Text(t) if in_preview => Some(t.clone()), _ => None }),
            "previewHtml": in_preview && matches!(preview, PreviewContent::Html(_)),
            "hint": form.hint(mode, minimize),
            "prev": if form.active > 0 { json!({ "disabled": false }) } else { Value::Null },
            "next": if form.is_last() { Value::Null } else { json!({ "disabled": !form.is_ready(form.active) }) },
            "submit": if form.is_last() { json!({ "disabled": !form.all_ready() }) } else { Value::Null },
            "minimize": minimize,
        });
        same(&got, &c["out"], name);
    }
}

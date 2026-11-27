//! Replays `tests/fixtures/composer_rules_golden.json`, recorded from the
//! real TS by `rust/scripts/composer-rules-golden.mjs`, through the ports in
//! `claudius_composer::rules`.

use claudius_client::AttachedImage;
use claudius_composer::rules::{self, *};
use serde_json::{Value, json};

fn fixture() -> Value {
    let text = include_str!("fixtures/composer_rules_golden.json");
    serde_json::from_str(text).expect("fixture parses")
}

fn cases<'a>(f: &'a Value, section: &str) -> &'a [Value] {
    let v = f[section]
        .as_array()
        .unwrap_or_else(|| panic!("section {section}"));
    assert!(!v.is_empty(), "{section} has cases");
    v
}

/// The recorder's argument encoding: `$num`, `$repeat`.
fn dec(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(dec).collect()),
        Value::Object(o) if o.len() == 1 && o.contains_key("$repeat") => {
            let r = &o["$repeat"];
            let s = r[0].as_str().unwrap();
            json!(s.repeat(r[1].as_u64().unwrap() as usize))
        }
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), dec(x))).collect()),
        _ => v.clone(),
    }
}

fn num(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap(),
        Value::Object(o) => match o["$num"].as_str().unwrap() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            other => panic!("$num {other}"),
        },
        other => panic!("not a number: {other}"),
    }
}

/// A number as the recorder writes it.
fn enc_num(x: f64) -> Value {
    if x.is_nan() {
        json!({"$num": "NaN"})
    } else if x.is_infinite() {
        json!({"$num": if x > 0.0 { "Infinity" } else { "-Infinity" }})
    } else {
        serde_json::from_str(&rules::num_text(x)).unwrap()
    }
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}

fn image(v: &Value) -> AttachedImage {
    AttachedImage {
        id: s(&v["id"]).into(),
        ordinal: num(&v["ordinal"]),
        data: s(&v["data"]).into(),
        media_type: s(&v["mediaType"]).into(),
    }
}

fn images(v: &Value) -> Vec<AttachedImage> {
    v.as_array().unwrap().iter().map(image).collect()
}

fn enc_images(ims: &[AttachedImage]) -> Value {
    Value::Array(
        ims.iter()
            .map(|im| json!({"id": im.id, "ordinal": enc_num(im.ordinal), "data": im.data, "mediaType": im.media_type}))
            .collect(),
    )
}

/// Runs `f` on every case of `section`, comparing with the recorded `out`.
fn replay(f: &Value, section: &str, run: impl Fn(&[Value]) -> Value) {
    for (i, c) in cases(f, section).iter().enumerate() {
        let args = dec(&c["args"]);
        let got = run(args.as_array().unwrap());
        assert_eq!(got, c["out"], "{section} #{i}: {}", c["args"]);
    }
}

#[test]
fn prompt_history_replays_the_ts() {
    let f = fixture();
    replay(&f, "normalizeHistoryText", |a| {
        json!(normalize_history_text(s(&a[0])))
    });
    replay(&f, "buildPromptHistory", |a| {
        let sent: Vec<SentPrompt> = a[0]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| SentPrompt {
                text: s(&e["text"]).into(),
                at: match e.get("at") {
                    None | Some(Value::Null) => None,
                    Some(v) => Some(num(v)),
                },
            })
            .collect();
        let lifted: Vec<LiftedPrompt> = a[1]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| LiftedPrompt {
                text: s(&e["text"]).into(),
                at: num(&e["at"]),
            })
            .collect();
        json!(build_prompt_history(&sent, &lifted))
    });
    replay(&f, "historyEntryIndex", |a| {
        let h: Vec<String> = serde_json::from_value(a[0].clone()).unwrap();
        json!(history_entry_index(&h, s(&a[1])))
    });
}

#[test]
fn send_bash_replays_the_ts() {
    replay(&fixture(), "commandNeedsSudo", |a| {
        json!(command_needs_sudo(s(&a[0])))
    });
}

#[test]
fn cleared_draft_replays_the_ts() {
    let f = fixture();
    replay(&f, "shouldStashClearedDraft", |a| {
        json!(should_stash_cleared_draft(
            s(&a[0]),
            a[1].as_u64().unwrap() as usize
        ))
    });
    replay(&f, "canRestoreClearedDraft", |a| {
        let g = &a[0];
        let b = |k: &str| g[k].as_bool().unwrap();
        json!(can_restore_cleared_draft(&RestoreGate {
            value: s(&g["value"]),
            image_count: g["imageCount"].as_u64().unwrap() as usize,
            picker_open: b("pickerOpen"),
            at_active: b("atActive"),
            emoji_active: b("emojiActive"),
            browsing_history: b("browsingHistory"),
            has_stash: b("hasStash"),
        }))
    });
    replay(&f, "ordinalFloorAfterRestore", |a| {
        enc_num(ordinal_floor_after_restore(num(&a[0]), &images(&a[1])))
    });
}

#[test]
fn pending_draft_replays_the_ts() {
    replay(&fixture(), "buildDraftFlushRequest", |a| {
        let p = (!a[0].is_null()).then(|| PendingDraft {
            session_id: s(&a[0]["sessionId"]).into(),
            text: s(&a[0]["text"]).into(),
            images: images(&a[0]["images"]),
        });
        match build_draft_flush_request(p.as_ref(), a[1].as_bool().unwrap()) {
            None => Value::Null,
            Some(r) => {
                let body = if utf16_len(&r.body) <= 2048 {
                    json!(r.body)
                } else {
                    let u: Vec<u16> = r.body.encode_utf16().collect();
                    json!({"$long": {
                        "head": String::from_utf16(&u[..64]).unwrap(),
                        "tail": String::from_utf16(&u[u.len() - 64..]).unwrap(),
                        "utf8": r.body.len(),
                    }})
                };
                json!({
                    "url": r.url,
                    "method": r.method,
                    "headers": {"Content-Type": "application/json"},
                    "body": body,
                    "keepalive": r.keepalive,
                })
            }
        }
    });
}

#[test]
fn send_outcome_replays_the_ts() {
    let f = fixture();
    replay(&f, "sendOutcome", |a| match send_delivery(&a[0]) {
        Ok(()) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e}),
    });
    replay(&f, "sendFailedNotice", |a| {
        let p = match s(&a[1]) {
            "restore" => NoticePlacement::Restore,
            _ => NoticePlacement::Stash,
        };
        json!(send_failed_notice(s(&a[0]), p))
    });
    replay(&f, "placeFailedSend", |a| {
        let g = &a[0];
        let placement = place_failed_send(
            g["originSessionId"].as_str(),
            g["currentSessionId"].as_str(),
            s(&g["currentText"]),
            g["currentImageCount"].as_u64().unwrap() as usize,
        );
        json!(match placement {
            FailedSendPlacement::Restore => "restore",
            FailedSendPlacement::Stash => "stash",
            FailedSendPlacement::SaveToOrigin => "save-to-origin",
        })
    });
    replay(&f, "mergeIntoDraft", |a| {
        let (text, ims) = merge_into_draft(
            s(&a[0]["text"]),
            &images(&a[0]["images"]),
            s(&a[1]["text"]),
            &images(&a[1]["images"]),
        );
        json!({"text": text, "images": enc_images(&ims)})
    });
}

#[test]
fn markdown_list_replays_the_ts() {
    let f = fixture();
    replay(
        &f,
        "computeListContinuation",
        |a| match compute_list_continuation(s(&a[0])) {
            None => Value::Null,
            Some(ListContinuation::Empty) => json!({"kind": "empty"}),
            Some(ListContinuation::Next(next)) => json!({"kind": "next", "next": next}),
        },
    );
    replay(&f, "isListLine", |a| json!(is_list_line(s(&a[0]))));
    replay(&f, "bulletsToMarkdown", |a| {
        json!(bullets_to_markdown(s(&a[0])))
    });
}

#[test]
fn invisible_unicode_replays_the_ts() {
    let f = fixture();
    replay(&f, "stripInvisibleUnicode", |a| {
        let r = strip_invisible_unicode(s(&a[0]));
        json!({"cleaned": r.cleaned, "removedCount": r.removed_count, "bidiCount": r.bidi_count})
    });
    replay(&f, "invisibleStripNeedsReview", |a| {
        json!(invisible_strip_needs_review(
            s(&a[0]),
            a[1].as_u64().unwrap() as usize,
            a[2].as_bool().unwrap()
        ))
    });
}

#[test]
fn key_match_replays_the_ts() {
    replay(&fixture(), "isLetterKey", |a| {
        let letter = s(&a[3]).chars().next().unwrap();
        json!(is_letter_key(
            s(&a[0]),
            s(&a[1]),
            a[2].as_bool().unwrap(),
            letter
        ))
    });
}

#[test]
fn keyword_hints_follow_prompt_input() {
    let f = fixture();
    let rows = f["keywordHints"].as_array().unwrap();
    assert_eq!(rows.len(), KEYWORD_HINTS.len());
    for (row, h) in rows.iter().zip(KEYWORD_HINTS.iter()) {
        assert_eq!(s(&row["id"]), h.id);
        assert_eq!(s(&row["source"]), h.source());
        assert_eq!(s(&row["flags"]), "i");
        assert_eq!(s(&row["label"]), h.label);
        assert_eq!(row["ignoredLabel"].as_str(), h.ignored_label);
    }
    for (i, c) in cases(&f, "keywordHintMatches").iter().enumerate() {
        let v = s(&c["value"]);
        let got: Vec<&str> = KEYWORD_HINTS
            .iter()
            .filter(|h| h.matches(v))
            .map(|h| h.id)
            .collect();
        let want: Vec<&str> = c["matched"].as_array().unwrap().iter().map(s).collect();
        assert_eq!(got, want, "keywordHintMatches #{i}: {v:?}");
    }
}

#[test]
fn composer_copy_is_the_ts_copy() {
    let f = fixture();
    let copy = |k: &str| s(&f["copy"][k]).to_owned();
    assert_eq!(placeholder(false, false), copy("placeholderStarting"));
    assert_eq!(placeholder(true, true), copy("placeholderPending"));
    assert_eq!(placeholder(true, false), copy("placeholderIdle"));
    assert_eq!(queue_hint(true, 0), copy("queueHintEmpty"));
    assert_eq!(
        queue_hint(true, 3),
        format!("3 {}", copy("queueHintQueued"))
    );
    assert_eq!(SEND_NOW_HINT, copy("sendNowHint"));
    assert!(hidden_chars_notice(1, false, false).contains(&copy("hiddenChars")));
    assert!(hidden_chars_notice(2, true, true).ends_with(&copy("hiddenCharsReview")));
    assert_eq!(QUEUE_HEADER, copy("queueHeader"));
    assert_eq!(SEND_ALL_NOW, copy("sendAllNow"));
    assert!(sdk_queued_turns_label(2.0).contains(&copy("sdkTurnsSent")));
}

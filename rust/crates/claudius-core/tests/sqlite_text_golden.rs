//! Replays `fixtures/sqlite_text_golden.json`, recorded by
//! `rust/scripts/sqlite-text-golden.mjs` from the real TS stores on
//! better-sqlite3 (I15): JS strings with lone surrogates (bound as their own
//! 3-byte sequences), an astral character, NUL, a real U+FFFD, plain and
//! empty text, written and looked up through sessions-db.ts (with
//! prompt-drafts-db.ts and goal-messages-db.ts), notifications-db.ts,
//! queued-messages-db.ts, asset-ingest.ts / asset-list.ts and
//! open-tabs-db.ts, the smaller stores (session-usage-db.ts,
//! session-tasks-db.ts, loop-ticks-db.ts, feedback-store.ts, the two MCP
//! notice tables, db-agents.ts, `getSessionAccountsByCwd`), the legacy
//! title copy and `backfillProject`'s cursor, plus rows of invalid UTF-8
//! written by raw SQL. And (S29a) a queued, goal, suggested or asset-use
//! `uuid` / `text` of every JSON type, bound by better-sqlite3's rules
//! (`sql_text::js_args`).
//!
//! * `binds` / `decode`: [`JsText`]'s bytes and [`sql_text::decode`]
//!   against what better-sqlite3 bound and read.
//! * Each scenario twice. First the Rust stores make the same writes: each
//!   result as `JSON.stringify` text, then every row of the scenario's
//!   tables `[typeof, hex]` cell by cell, then the reads. Then the reads
//!   again, on a database rebuilt from the recorded dump: Rust reading the
//!   bytes TS wrote. Clock stamps in columns and fields (`created_at`,
//!   `setAt`, ...) are masked in the first pass; TS pinned `Date.now`, and
//!   the second pass reads its values back exactly.
//!
//! Known differences (`KNOWN_*`): a real U+10F800–U+10FFFF character is a
//! `js_string` stand-in in Rust, so it binds as the lone surrogate it stands
//! for; and a lone-surrogate escape inside a JSON TEXT value (the `state`
//! bag, a notification's `payload`, a DB agent's definition) reads back as
//! U+FFFD (`js::json_parse`), where `JSON.parse` keeps the surrogate. The
//! open-tabs keys read with `js_string::parse` and keep it (I14a).
#![cfg(unix)]

use std::sync::{Mutex, MutexGuard, OnceLock};

use claudius_core::db::{self, Mode};
use claudius_core::feedback_store::{self, FeedbackRecord};
use claudius_core::loop_ticks_db::{self, LoopTick};
use claudius_core::notifications_db::{self as notifs, ListOpts, NewNotification, PrefsPatch};
use claudius_core::queue_db::{self, ImageInput, NewQueued, QueuedRow};
use claudius_core::session_tasks_db::{self, TaskEntry};
use claudius_core::sessions_db::UsageTotals;
use claudius_core::sql_text::{self, JsText};
use claudius_core::{
    asset_ingest, asset_list, db_agents, js_string, mcp_notices, open_tabs, paths,
    session_accounts, sessions_db,
};
use rusqlite::Connection;
use serde_json::{Map, Value, json};

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/sqlite_text_golden.json");
        // Lone-surrogate escapes kept as `js_string` stand-ins.
        js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
    })
}

/// One temp `$HOME` + config dir for the binary (the overrides are
/// process-wide); scenarios reuse their cwds, so they run one at a time.
fn world() -> MutexGuard<'static, ()> {
    static W: OnceLock<tempfile::TempDir> = OnceLock::new();
    static SERIAL: Mutex<()> = Mutex::new(());
    W.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("home")).unwrap();
        std::fs::create_dir_all(root.join("config")).unwrap();
        assert!(paths::set_home_override(root.join("home")));
        assert!(paths::set_config_dir_override(root.join("config")));
        // readLegacyTitle's file, as the recorder wrote it.
        let legacy = sessions_db::legacy_titles_path();
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(legacy, s(&fixture()["legacyTitles"])).unwrap();
        dir
    });
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

/// The cwd's project folder gone and its handles closed.
fn reset(cwd: &str) {
    db::close_db(cwd);
    let dir = paths::db_path(cwd).parent().unwrap().to_path_buf();
    if dir.exists() {
        std::fs::remove_dir_all(dir).unwrap();
    }
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}

fn opt_s(v: &Value) -> Option<String> {
    v.as_str().map(str::to_owned)
}

fn unhex(h: &str) -> Vec<u8> {
    (0..h.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap())
        .collect()
}

/// `JSON.stringify` of the value `r` holds, or `{"throws": message}`.
fn js<T>(r: anyhow::Result<T>, f: impl FnOnce(T) -> Value) -> Value {
    match r {
        Ok(v) => f(v),
        Err(e) => json!({"throws": e.to_string()}),
    }
}

const T0: f64 = 1_700_000_000_000.0;

/// `toRow(r)` of queued-messages-db.ts.
fn queued(r: QueuedRow) -> Value {
    json!({
        "uuid": r.uuid,
        "sessionId": r.session_id,
        "position": r.position,
        "text": r.text,
        "images": r.images.map(|i| serde_json::to_value(i).unwrap()),
        "slash": r.slash,
        "fromSuggestion": r.from_suggestion,
        "fromGoal": r.from_goal,
        "createdAtMs": r.created_at_ms,
    })
}

/// One recorded call, through the Rust store that ports it.
fn run(op: &str, a: &[Value]) -> Value {
    let now = || T0;
    match op {
        "exec" => js(
            db::open_db(s(&a[0]), Mode::ReadWrite)
                .and_then(|d| Ok(d.with(|c| c.execute_batch(s(&a[1])))?)),
            |_| Value::Null,
        ),
        "upsertSession" => {
            let o = &a[0];
            js(
                sessions_db::upsert_session(
                    s(&o["id"]),
                    s(&o["cwd"]),
                    o["model"].as_str(),
                    o["title"].as_str(),
                ),
                |_| Value::Null,
            )
        }
        "touchSession" => js(sessions_db::touch_session(s(&a[0]), s(&a[1])), |_| {
            Value::Null
        }),
        "setSessionTitle" => js(
            sessions_db::set_session_title(s(&a[0]), s(&a[1]), s(&a[2])),
            |_| Value::Null,
        ),
        "getSessionTitle" => js(sessions_db::get_session_title(s(&a[0]), s(&a[1])), |t| {
            json!(t)
        }),
        "setSessionGoal" => js(
            sessions_db::set_session_goal(s(&a[0]), s(&a[1]), s(&a[2])),
            |g| serde_json::to_value(g).unwrap(),
        ),
        "setGoalAchieved" => js(
            sessions_db::set_goal_achieved(s(&a[0]), s(&a[1]), s(&a[2])),
            |g| serde_json::to_value(g).unwrap(),
        ),
        "clearSessionGoal" => js(sessions_db::clear_session_goal(s(&a[0]), s(&a[1])), |g| {
            serde_json::to_value(g).unwrap()
        }),
        "getSessionGoal" => {
            serde_json::to_value(sessions_db::get_session_goal(s(&a[0]), s(&a[1]))).unwrap()
        }
        "mergeSessionState" => js(
            sessions_db::merge_session_state(s(&a[0]), s(&a[1]), a[2].as_object().unwrap().clone()),
            |_| Value::Null,
        ),
        "getSessionState" => Value::Object(sessions_db::get_session_state(s(&a[0]), s(&a[1]))),
        "listIndexedSessions" => js(sessions_db::list_indexed_sessions(s(&a[0])), |rows| {
            rows.iter()
                .map(|r| {
                    json!([
                        r.id.to_json(),
                        r.cwd.to_json(),
                        r.title.to_json(),
                        r.model.to_json()
                    ])
                })
                .collect()
        }),
        "getSessionTitlesByCwd" => {
            let pairs: Vec<(Option<&str>, &str)> = a[0]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| (p["cwd"].as_str(), s(&p["id"])))
                .collect();
            js(sessions_db::get_session_titles_by_cwd(&pairs), |m| {
                m.into_iter().map(|(k, v)| json!([k, v])).collect()
            })
        }
        "setPromptDraft" => js(
            sessions_db::set_prompt_draft(s(&a[0]), s(&a[1]), s(&a[2]), &a[3]),
            |_| Value::Null,
        ),
        "getPromptDraft" => sessions_db::get_prompt_draft(s(&a[0]), s(&a[1])).unwrap_or_default(),
        "clearPromptDraft" => {
            sessions_db::clear_prompt_draft(s(&a[0]), s(&a[1]));
            Value::Null
        }
        "recordGoalMessage" | "recordSuggestedMessage" => {
            let i = &a[1];
            js(
                sessions_db::record_tagged_message(
                    s(&a[0]),
                    op == "recordGoalMessage",
                    s(&i["sessionId"]),
                    &i["messageUuid"],
                    &i["text"],
                ),
                |_| Value::Null,
            )
        }
        "listGoalMessageUuids" | "listSuggestedMessageUuids" => {
            json!(sessions_db::list_tagged_message_uuids(
                s(&a[0]),
                op == "listGoalMessageUuids",
                s(&a[1])
            ))
        }
        "insertNotification" => {
            let i = &a[2];
            let input = NewNotification {
                id: opt_s(&i["id"]),
                session_id: opt_s(&i["sessionId"]),
                run_id: opt_s(&i["runId"]),
                job_id: opt_s(&i["jobId"]),
                kind: s(&i["kind"]).to_owned(),
                title: s(&i["title"]).to_owned(),
                body: i["body"].clone(),
                payload: i["payload"].as_object().cloned(),
                request_id: i["requestId"].clone(),
                created_at: i["createdAt"].as_f64(),
            };
            let new_id = || unreachable!("every recorded insert has an id");
            js(
                notifs::insert_notification(s(&a[0]), s(&a[1]), &input, &now, &new_id),
                |r| r.map_or(Value::Null, |r| r.to_json()),
            )
        }
        "listNotifications" => js(
            notifs::list_notifications(s(&a[0]), s(&a[1]), &ListOpts::default()),
            |rows| rows.iter().map(|r| r.to_json()).collect(),
        ),
        "getNotification" => js(
            notifs::get_notification(s(&a[0]), s(&a[1]), s(&a[2])),
            |r| r.map_or(Value::Null, |r| r.to_json()),
        ),
        "markRead" => {
            let ids: Vec<String> = a[1]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| s(v).to_owned())
                .collect();
            js(notifs::mark_read(s(&a[0]), &ids, &now), |n| json!(n))
        }
        "markReadByRequestId" => js(
            notifs::mark_read_by_request_id(s(&a[0]), s(&a[1]), &now),
            Value::Array,
        ),
        "markReadBySession" => js(
            notifs::mark_read_by_session(s(&a[0]), s(&a[1]), &now),
            |n| json!(n),
        ),
        "unreadCountsBySession" => js(notifs::unread_counts_by_session(s(&a[0])), Value::Object),
        "setSessionPrefs" => {
            let p = &a[2];
            let patch = PrefsPatch {
                blocked: p["blocked"].as_bool(),
                snooze_until: p.get("snoozeUntil").map(Value::as_f64),
            };
            js(notifs::set_session_prefs(s(&a[0]), s(&a[1]), &patch), |p| {
                p.to_json()
            })
        }
        "getSessionPrefs" => js(notifs::get_session_prefs(s(&a[0]), s(&a[1])), |p| {
            p.map_or(Value::Null, |p| p.to_json())
        }),
        "enqueueTail" => {
            let i = &a[1];
            let input = NewQueued {
                session_id: s(&i["sessionId"]),
                uuid: i["uuid"].clone(),
                text: i["text"].clone(),
                ..Default::default()
            };
            js(queue_db::enqueue_tail(s(&a[0]), input), queued)
        }
        "listQueue" => queue_db::list_queue(s(&a[0]), s(&a[1]))
            .into_iter()
            .map(queued)
            .collect(),
        "updateByUuid" => {
            // `images` absent, null, or a list.
            let images: Option<Option<Vec<ImageInput>>> = a[3].get("images").map(|i| {
                i.as_array().map(|l| {
                    l.iter()
                        .map(|x| serde_json::from_value(x.clone()).unwrap())
                        .collect()
                })
            });
            let images = images.as_ref().map(|i| i.as_deref());
            js(
                queue_db::update_by_uuid(
                    s(&a[0]),
                    s(&a[1]),
                    s(&a[2]),
                    a[3]["text"].as_str(),
                    images,
                ),
                |b| json!(b),
            )
        }
        "clearAll" => js(queue_db::clear_all(s(&a[0]), s(&a[1])), |_| Value::Null),
        "popByUuid" => js(queue_db::pop_by_uuid(s(&a[0]), s(&a[1]), &a[2]), |r| {
            r.map_or(Value::Null, queued)
        }),
        "popHead" => js(queue_db::pop_head(s(&a[0]), s(&a[1])), |r| {
            r.map_or(Value::Null, queued)
        }),
        "removeByUuid" => js(
            queue_db::remove_by_uuid(s(&a[0]), s(&a[1]), s(&a[2])),
            |b| json!(b),
        ),
        "moveByUuid" => js(
            queue_db::move_by_uuid(s(&a[0]), s(&a[1]), s(&a[2]), s(&a[3]) == "up"),
            |b| json!(b),
        ),
        "recordSendUses" => {
            let o = &a[0];
            // `recordSendUses` takes the images as posted (S29).
            let images = o["images"].as_array().unwrap();
            let out = asset_ingest::record_send_uses(
                s(&o["cwd"]),
                s(&o["sessionId"]),
                &o["messageUuid"],
                o["occurredMs"].as_f64().unwrap(),
                images,
            );
            out.iter().map(|r| r.to_json()).collect()
        }
        "listAssets" => {
            let o = &a[0];
            let q = o["q"].as_str().unwrap_or("");
            js(
                asset_list::list_assets(s(&o["scope"]), s(&o["cwd"]), "all", q, 60.0, None),
                |p| p.to_json(),
            )
        }
        "listUses" => js(asset_list::list_uses(s(&a[0]), s(&a[1])), |rows| {
            rows.iter().map(|r| r.to_json()).collect()
        }),
        "deleteAssetRow" => js(asset_list::delete_asset_row(s(&a[0]), s(&a[1])), |b| {
            json!(b)
        }),
        "writeTranscript" => {
            let dir = paths::home_dir().join(".claude/projects").join(s(&a[0]));
            std::fs::create_dir_all(&dir).unwrap();
            let file = dir.join(s(&a[1]));
            std::fs::write(&file, s(&a[2])).unwrap();
            let secs = std::time::Duration::from_secs(a[3].as_u64().unwrap());
            let f = std::fs::File::options().write(true).open(&file).unwrap();
            f.set_modified(std::time::UNIX_EPOCH + secs).unwrap();
            Value::Null
        }
        "backfillProject" => js(
            asset_ingest::backfill_project(s(&a[0])),
            |p| json!({"total": p.total, "scanned": p.scanned, "ingested": p.ingested}),
        ),
        "query" => js(
            db::open_db(s(&a[0]), Mode::ReadWrite).and_then(|d| {
                Ok(d.with(|c| {
                    let mut st = c.prepare(s(&a[1]))?;
                    let n = st.column_count();
                    let rows = st.query_map([], |r| {
                        (0..n)
                            .map(|i| sql_text::get::<String, _>(r, i))
                            .collect::<rusqlite::Result<Vec<_>>>()
                    })?;
                    rows.collect::<rusqlite::Result<Vec<_>>>()
                })?)
            }),
            |rows| json!(rows),
        ),
        "setOpenTabs" | "setPinnedTabs" => {
            let ids: Vec<&str> = a[1].as_array().unwrap().iter().map(s).collect();
            let r = if op == "setOpenTabs" {
                open_tabs::set_open_tabs(s(&a[0]), &ids)
            } else {
                open_tabs::set_pinned_tabs(s(&a[0]), &ids)
            };
            js(r, |_| Value::Null)
        }
        "getOpenTabs" => json!(open_tabs::get_open_tabs(s(&a[0]))),
        "getPinnedTabs" => json!(open_tabs::get_pinned_tabs(s(&a[0]))),
        "setActiveTab" => js(open_tabs::set_active_tab(s(&a[0]), a[1].as_str()), |_| {
            Value::Null
        }),
        "getActiveTab" => json!(open_tabs::get_active_tab(s(&a[0]))),
        "saveSessionUsage" => {
            let u = &a[2];
            let n = |k: &str| u[k].as_f64().unwrap();
            let totals = UsageTotals {
                total_cost_usd: n("totalCostUsd"),
                num_turns: n("numTurns"),
                duration_ms: n("durationMs"),
                duration_api_ms: n("durationApiMs"),
                input_tokens: n("inputTokens"),
                output_tokens: n("outputTokens"),
                cache_read_input_tokens: n("cacheReadInputTokens"),
                cache_creation_input_tokens: n("cacheCreationInputTokens"),
                model_usage: u["modelUsage"].as_object().cloned(),
            };
            js(
                sessions_db::save_session_usage(s(&a[0]), s(&a[1]), &totals),
                |_| Value::Null,
            )
        }
        "getSessionUsage" => {
            sessions_db::get_session_usage(s(&a[0]), s(&a[1])).map_or(Value::Null, |u| u.to_json())
        }
        "saveSessionTask" => {
            let t = &a[2];
            let task = TaskEntry {
                task_id: s(&t["taskId"]).to_owned(),
                tool_use_id: opt_s(&t["toolUseId"]),
                subagent_type: opt_s(&t["subagentType"]),
                description: opt_s(&t["description"]),
                task_type: opt_s(&t["taskType"]),
                workflow_name: opt_s(&t["workflowName"]),
                status: s(&t["status"]).to_owned(),
                summary: opt_s(&t["summary"]),
                error: opt_s(&t["error"]),
                output_file: opt_s(&t["outputFile"]),
                inner_messages: t["innerMessages"].as_array().cloned().unwrap_or_default(),
                ..Default::default()
            };
            js(
                session_tasks_db::save_session_task(s(&a[0]), s(&a[1]), &task),
                |_| Value::Null,
            )
        }
        "listSessionTasks" => session_tasks_db::list_session_tasks(s(&a[0]), s(&a[1]))
            .iter()
            .map(TaskEntry::to_json)
            .collect(),
        "recordLoopTick" => {
            let t = &a[1];
            let tick = LoopTick {
                session_id: s(&t["sessionId"]).to_owned(),
                session_title: opt_s(&t["sessionTitle"]),
                tool_use_id: s(&t["toolUseId"]).to_owned(),
                prompt: s(&t["prompt"]).to_owned(),
                fired_at: t["firedAt"].as_f64().unwrap(),
                noop: t["noop"] == true,
            };
            loop_ticks_db::record_loop_tick(s(&a[0]), &tick);
            Value::Null
        }
        "attachLoopTickTokens" => {
            loop_ticks_db::attach_loop_tick_tokens(s(&a[0]), s(&a[1]), a[2].as_f64().unwrap());
            Value::Null
        }
        "listLoopBreakdown" => loop_ticks_db::list_loop_breakdown(s(&a[0]))
            .iter()
            .map(|r| r.to_json())
            .collect(),
        "insertFeedback" => {
            let r = &a[1];
            let rec = FeedbackRecord {
                id: s(&r["id"]).to_owned(),
                session_id: opt_s(&r["sessionId"]),
                rating: opt_s(&r["rating"]),
                comment: s(&r["comment"]).to_owned(),
                surface: opt_s(&r["surface"]),
                forwarded: r["forwarded"] == true,
                attach_transcript: r["attachTranscript"] == true,
                created_at: r["createdAt"].as_f64().unwrap(),
            };
            js(feedback_store::insert_feedback(s(&a[0]), &rec), |_| {
                Value::Null
            })
        }
        "listFeedback" => js(
            feedback_store::list_feedback(s(&a[0]), a[1].as_f64().unwrap()),
            Value::Array,
        ),
        "syncNeedsAuthNotifications" | "syncDisconnectedNotifications" => {
            let names: Vec<String> = a[1]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| s(n).to_owned())
                .collect();
            let sync = if op == "syncNeedsAuthNotifications" {
                mcp_notices::sync_needs_auth_notifications
            } else {
                mcp_notices::sync_disconnected_notifications
            };
            js(
                sync(s(&a[0]), &names, T0 as i64).map_err(anyhow::Error::from),
                |n| json!(n),
            )
        }
        "upsertDbAgent" => match db_agents::upsert_db_agent(s(&a[0]), &a[1], Some(&a[2])) {
            Ok(row) => row,
            Err(e) => json!({"throws": e}),
        },
        "listDbAgents" => Value::Array(db_agents::list_db_agents(s(&a[0]))),
        "getSessionAccountsByCwd" => {
            let pairs: Vec<(Option<&str>, &str)> = a[0]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| (p["cwd"].as_str(), s(&p["id"])))
                .collect();
            js(session_accounts::get_session_accounts_by_cwd(&pairs), |m| {
                m.into_iter().map(|(k, v)| json!([k, v])).collect()
            })
        }
        other => panic!("no Rust port wired for {other}"),
    }
}

/// Calls whose result comes out of a JSON TEXT value, which Rust parses
/// with `js::json_parse` (a lone-surrogate escape reads as U+FFFD).
const KNOWN_JSON_COLUMN_READS: &[&str] = &[
    "getSessionState",
    "listNotifications",
    "getNotification",
    "listDbAgents",
];

/// The fields stamped with the clock, masked when Rust made the writes.
const CLOCK_FIELDS: &[&str] = &["setAt", "achievedAt", "createdAtMs", "updatedAt"];

/// Calls that list rows newest first: with Rust's clock running, rows TS
/// stamped with the same pinned time come out in write order instead, so
/// the first pass compares them as sets.
const CLOCK_ORDERED: &[&str] = &["listIndexedSessions"];

/// `(table, column)` stamped with the clock.
const CLOCK_COLUMNS: &[(&str, &str)] = &[
    ("sessions", "created_at"),
    ("sessions", "updated_at"),
    ("sessions", "last_seen_at"),
    ("sessions", "goal_set_at"),
    ("sessions", "goal_achieved_at"),
    ("queued_messages", "created_at_ms"),
    ("prompt_drafts", "updated_at"),
    ("goal_messages", "created_at"),
    ("suggested_messages", "created_at"),
    ("session_usage", "updated_at"),
    ("session_tasks", "updated_at"),
    ("loop_ticks", "created_at"),
    ("db_agents", "updated_at"),
];

fn mask_clock(v: &mut Value) {
    match v {
        Value::Object(m) => {
            for (k, x) in m.iter_mut() {
                if CLOCK_FIELDS.contains(&k.as_str()) && x.is_number() {
                    *x = json!("<clock>");
                } else {
                    mask_clock(x);
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(mask_clock),
        _ => {}
    }
}

/// The recorded result and Rust's, as comparable `JSON.stringify` text.
fn texts(op: &str, recorded: &str, got: Value, clock: bool) -> (String, String) {
    let mut want = js_string::parse(recorded).unwrap();
    if KNOWN_JSON_COLUMN_READS.contains(&op) {
        want = js_string::lossy_value(&want);
    }
    let mut got = got;
    if clock {
        mask_clock(&mut want);
        mask_clock(&mut got);
        if CLOCK_ORDERED.contains(&op) {
            for v in [&mut want, &mut got] {
                if let Value::Array(a) = v {
                    a.sort_by_cached_key(js_string::stringify);
                }
            }
        }
    }
    (js_string::stringify(&want), js_string::stringify(&got))
}

fn replay(name: &str, phase: &str, calls: &Value, clock: bool) {
    for (i, c) in calls.as_array().unwrap().iter().enumerate() {
        let op = s(&c["op"]);
        let got = run(op, c["args"].as_array().unwrap());
        let (want, got) = texts(op, s(&c["result"]), got, clock);
        assert_eq!(
            got,
            want,
            "{name} ({phase}) call {i} {op}({})",
            js_string::stringify(&c["args"])
        );
    }
}

/// Every row of `tables` as the recorder dumps them.
fn dump(cwd: &str, tables: &Value) -> Value {
    let d = db::open_db(cwd, Mode::ReadWrite).unwrap();
    let mut out = Map::new();
    for t in tables.as_array().unwrap() {
        let t = s(t);
        let (cols, rows) = d
            .with(|c| {
                let cols: Vec<String> = c
                    .prepare("SELECT name FROM pragma_table_info(?)")?
                    .query_map([t], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?;
                let sel: Vec<String> = cols
                    .iter()
                    .map(|c| format!("typeof(\"{c}\"), hex(\"{c}\")"))
                    .collect();
                let sql = format!("SELECT {} FROM \"{t}\" ORDER BY rowid", sel.join(", "));
                let mut st = c.prepare(&sql)?;
                let rows: Vec<Value> = st
                    .query_map([], |r| {
                        (0..cols.len())
                            .map(|i| {
                                Ok(json!([
                                    r.get::<_, String>(2 * i)?,
                                    r.get::<_, String>(2 * i + 1)?
                                ]))
                            })
                            .collect::<rusqlite::Result<Value>>()
                    })?
                    .collect::<rusqlite::Result<_>>()?;
                Ok((cols, rows))
            })
            .unwrap();
        out.insert(t.into(), json!({"cols": cols, "rows": rows}));
    }
    Value::Object(out)
}

fn mask_dump(d: &Value) -> Value {
    let mut d = d.clone();
    for (t, table) in d.as_object_mut().unwrap() {
        let cols: Vec<String> = table["cols"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| s(c).to_owned())
            .collect();
        for row in table["rows"].as_array_mut().unwrap() {
            for (i, cell) in row.as_array_mut().unwrap().iter_mut().enumerate() {
                let numeric = matches!(cell[0].as_str(), Some("integer" | "real"));
                // A clock stamp (TS pinned it at T0); a smaller value was
                // written as given, by SQL.
                let stamp = numeric && {
                    let text = String::from_utf8(unhex(s(&cell[1]))).unwrap();
                    text.parse::<f64>().unwrap() >= T0
                };
                if stamp && CLOCK_COLUMNS.contains(&(t.as_str(), cols[i].as_str())) {
                    cell[1] = json!("<clock>");
                }
            }
        }
    }
    d
}

/// The recorded rows written back as they were: each cell its storage class
/// and bytes.
fn rebuild(cwd: &str, dump: &Value, tables: &Value) {
    let d = db::open_db(cwd, Mode::ReadWrite).unwrap();
    for t in tables.as_array().unwrap() {
        let t = s(t);
        let table = &dump[t];
        let cols: Vec<String> = table["cols"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| format!("\"{}\"", s(c)))
            .collect();
        for row in table["rows"].as_array().unwrap() {
            let vals: Vec<String> = row
                .as_array()
                .unwrap()
                .iter()
                .map(|cell| {
                    let h = s(&cell[1]);
                    match s(&cell[0]) {
                        "null" => "NULL".into(),
                        "text" => format!("CAST(X'{h}' AS TEXT)"),
                        "blob" => format!("X'{h}'"),
                        _ => String::from_utf8(unhex(h)).unwrap(),
                    }
                })
                .collect();
            let sql = format!(
                "INSERT INTO \"{t}\"({}) VALUES ({})",
                cols.join(", "),
                vals.join(", ")
            );
            d.with(|c| c.execute(&sql, [])).unwrap();
        }
    }
}

fn scenarios() -> &'static [Value] {
    fixture()["scenarios"].as_array().unwrap()
}

#[test]
fn binds_are_better_sqlite3_s_bytes() {
    let conn = Connection::open_in_memory().unwrap();
    let mut checked = 0;
    for b in fixture()["binds"].as_array().unwrap() {
        let (name, text) = (s(&b["name"]), s(&b["s"]));
        let got: (String, String) = conn
            .query_row("SELECT typeof(?1), hex(?1)", [JsText::new(text)], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        let want = (s(&b["type"]).to_owned(), s(&b["hex"]).to_owned());
        // KNOWN: a real character in U+10F800..U+10FFFF reads as the
        // `js_string` stand-in of a lone surrogate, and binds as one.
        let want = match name {
            "U+10F800 (a stand-in)" => {
                assert_eq!(want.1, "F48FA080");
                ("text".into(), "EDA080".into())
            }
            "U+10FFFF (a stand-in)" => {
                assert_eq!(want.1, "F48FBFBF");
                ("text".into(), "EDBFBF".into())
            }
            _ => want,
        };
        assert_eq!(got, want, "bind {name}");
        checked += 1;
    }
    assert_eq!(checked, 18);
}

#[test]
fn text_reads_back_as_better_sqlite3_reads_it() {
    let conn = Connection::open_in_memory().unwrap();
    let decodes = fixture()["decode"].as_array().unwrap();
    for d in decodes {
        let bytes = unhex(s(&d["hex"]));
        let want: Vec<u16> = d["units"]
            .as_array()
            .unwrap()
            .iter()
            .map(|u| u.as_u64().unwrap() as u16)
            .collect();
        let direct: Vec<u16> = sql_text::decode(&bytes).encode_utf16().collect();
        assert_eq!(direct, want, "decode {}", s(&d["hex"]));
        let read: String = conn
            .query_row("SELECT CAST(? AS TEXT)", [&bytes], |r| sql_text::get(r, 0))
            .unwrap();
        assert_eq!(
            read.encode_utf16().collect::<Vec<_>>(),
            want,
            "get {}",
            s(&d["hex"])
        );
    }
    assert_eq!(decodes.len(), 39);
}

#[test]
fn rust_stores_write_the_bytes_ts_writes() {
    let _w = world();
    for sc in scenarios() {
        let (name, cwd) = (s(&sc["name"]), s(&sc["cwd"]));
        reset(cwd);
        replay(name, "writes", &sc["writes"], true);
        assert_eq!(
            mask_dump(&dump(cwd, &sc["tables"])),
            mask_dump(&sc["dump"]),
            "{name}: the rows"
        );
        replay(name, "reads", &sc["reads"], true);
        reset(cwd);
    }
    assert_eq!(scenarios().len(), 17);
}

#[test]
fn rust_stores_read_what_ts_wrote() {
    let _w = world();
    for sc in scenarios() {
        let (name, cwd) = (s(&sc["name"]), s(&sc["cwd"]));
        reset(cwd);
        rebuild(cwd, &sc["dump"], &sc["tables"]);
        assert_eq!(dump(cwd, &sc["tables"]), sc["dump"], "{name}: rebuilt rows");
        replay(name, "reads of the TS rows", &sc["reads"], false);
        reset(cwd);
    }
}

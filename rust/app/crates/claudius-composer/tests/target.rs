//! `SessionCall` on a `ChatState` and `Resolutions`, the helper a live
//! target pairs each call with its `Effect::ActionResolved`.

use claudius_client::effect::{Action, Effect, FetchOutcome};
use claudius_client::queue::SendOpts;
use claudius_client::state::ChatState;
use claudius_client::{AttachedImage, FixedEnv};
use claudius_composer::{Resolutions, SessionCall};
use serde_json::{Value, json};

fn ready(id: &str) -> ChatState {
    let mut s = ChatState::new("tab-1");
    s.session_id = Some(id.into());
    s.ready = true;
    s
}

fn posts(effects: &[Effect]) -> Vec<(String, Option<Value>)> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::Fetch(r) if r.method == "POST" => Some((
                r.url.clone(),
                r.body.as_deref().and_then(|b| serde_json::from_str(b).ok()),
            )),
            _ => None,
        })
        .collect()
}

#[test]
fn a_send_posts_the_prompt_with_its_images() {
    let mut s = ready("s1");
    let mut env = FixedEnv::new(1_000.0);
    let call = SessionCall::Send {
        text: "hello".into(),
        images: vec![AttachedImage {
            id: "img".into(),
            ordinal: 1.0,
            data: "AAAA".into(),
            media_type: "image/png".into(),
        }],
        opts: SendOpts {
            reports_failure_inline: true,
            ..SendOpts::default()
        },
    };
    let effects = call.apply(&mut s, &mut env);
    let p = posts(&effects);
    assert_eq!(p.len(), 1, "{effects:?}");
    let body = p[0].1.clone().expect("a JSON body");
    assert_eq!(body["text"], "hello");
    assert_eq!(body["images"][0]["mediaType"], "image/png");
    assert_eq!(call.resolves_as(), Some(Action::Send));
}

#[test]
fn a_send_with_no_images_sends_none() {
    let mut s = ready("s1");
    let mut env = FixedEnv::new(1_000.0);
    let call = SessionCall::Send {
        text: "plain".into(),
        images: vec![],
        opts: SendOpts::default(),
    };
    let body = posts(&call.apply(&mut s, &mut env))[0].1.clone().unwrap();
    assert!(
        body.get("images")
            .is_none_or(|v| v.as_array().is_none_or(Vec::is_empty))
    );
}

#[test]
fn the_queue_calls_reach_the_state() {
    let mut env = FixedEnv::new(1_000.0);
    for call in [
        SessionCall::ReorderQueued {
            qid: "q".into(),
            dir: 1.0,
        },
        SessionCall::SendQueuedNow { qid: "q".into() },
        SessionCall::SendAllQueuedNow,
        SessionCall::CancelQueued { qid: "q".into() },
        SessionCall::Interrupt,
    ] {
        let mut s = ready("s1");
        s.pending = true;
        s.queue = vec![json!({"id": "q", "text": "later", "flags": {}})];
        let effects = call.apply(&mut s, &mut env);
        assert!(!effects.is_empty(), "{call:?}");
        assert_eq!(call.resolves_as(), None, "{call:?}");
    }
    let edit = SessionCall::EditQueued { qid: "q".into() };
    assert_eq!(
        edit.resolves_as(),
        Some(Action::EditQueued { qid: "q".into() })
    );
}

#[test]
fn resolutions_pair_each_action_with_its_oldest_caller() {
    let r = Resolutions::new();
    let mut none = r.expect(None);
    assert!(none.try_recv().is_err());
    assert!(r.is_empty());
    let mut first = r.expect(Some(Action::Send));
    let mut second = r.expect(Some(Action::Send));
    let mut edit = r.expect(Some(Action::EditQueued { qid: "q".into() }));
    assert_eq!(r.len(), 3);
    assert!(
        !r.resolve(&Effect::Fetch(claudius_client::effect::FetchRequest {
            id: claudius_client::effect::FetchId(1),
            method: "GET",
            url: "/x".into(),
            headers: vec![],
            body: None,
        }))
    );
    assert!(!r.resolve(&Effect::ActionResolved {
        action: Action::EditQueued {
            qid: "other".into()
        },
        outcome: json!(null),
    }));
    assert!(r.resolve(&Effect::ActionResolved {
        action: Action::Send,
        outcome: json!({"ok": true}),
    }));
    assert_eq!(first.try_recv().unwrap(), Some(json!({"ok": true})));
    assert_eq!(second.try_recv().unwrap(), None);
    assert!(r.resolve(&Effect::ActionResolved {
        action: Action::EditQueued { qid: "q".into() },
        outcome: json!({"text": "t"}),
    }));
    assert_eq!(edit.try_recv().unwrap(), Some(json!({"text": "t"})));
    assert_eq!(r.len(), 1);
    drop(second);
    // Its caller gone, the next resolution is still taken (and dropped).
    assert!(r.resolve(&Effect::ActionResolved {
        action: Action::Send,
        outcome: json!({"ok": false, "error": "network"}),
    }));
    assert!(r.is_empty());
    let _ = FetchOutcome::Failed(String::new());
}

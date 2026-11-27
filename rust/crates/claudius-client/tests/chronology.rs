//! U05e: the single-pass chronological lookups give what the old
//! clone-and-sort did, over generated lists with missing, non-finite and
//! tied `createdAt`s (`-0` beside `0`), duplicate tool ids and folded uuids.

use claudius_client::effect::Effect;
use claudius_client::messages::{first_chronological, sort_messages_by_chronology};
use claudius_client::state::ChatState;
use claudius_client::task_status::{find_tool_use_block, find_tool_use_block_sorted};
use claudius_client::{DisplayBlock, DisplayMessage, FixedEnv, Role};
use indexmap::IndexSet;
use serde_json::json;

/// A fixed-seed generator (deterministic test data, not a security context).
struct Lcg(u64);

impl Lcg {
    fn next(&mut self, n: u64) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) % n
    }
}

fn tool(id: &str, k: usize) -> DisplayBlock {
    DisplayBlock::ToolUse {
        id: id.to_owned(),
        name: format!("Tool{k}"),
        input: json!({ "k": k }),
        result: None,
        started_at: None,
    }
}

fn list(g: &mut Lcg) -> Vec<DisplayMessage> {
    let n = g.next(12) as usize;
    (0..n)
        .map(|i| {
            let mut blocks = Vec::new();
            for k in 0..g.next(3) as usize {
                blocks.push(match g.next(3) {
                    0 => DisplayBlock::text(format!("t{i}.{k}")),
                    _ => tool(&format!("tu{}", g.next(4)), i * 10 + k),
                });
            }
            let mut m = DisplayMessage::new(format!("m{}", g.next(8)), Role::Assistant, blocks);
            // A unique tag, so a comparison names which message was found
            // (a NaN `createdAt` makes equal messages compare unequal).
            m.parent_tool_use_id = Some(format!("#{i}"));
            m.created_at = match g.next(9) {
                0 | 1 => None,
                2 => Some(f64::NAN),
                3 => Some(f64::INFINITY),
                4 => Some(-0.0),
                5 => Some(0.0),
                _ => Some(g.next(4) as f64),
            };
            if g.next(4) == 0 {
                let folded: IndexSet<String> = (0..2).map(|_| format!("m{}", g.next(8))).collect();
                m.folded_sdk_uuids = Some(folded);
            }
            m
        })
        .collect()
}

/// Which message a lookup found.
fn tag(m: Option<&DisplayMessage>) -> Option<&str> {
    m.and_then(|m| m.parent_tool_use_id.as_deref())
}

fn sorted(messages: &[DisplayMessage]) -> Vec<DisplayMessage> {
    let mut s = messages.to_vec();
    sort_messages_by_chronology(&mut s);
    s
}

#[test]
fn first_chronological_matches_the_sorted_copy() {
    let mut g = Lcg(0x5eed_005e);
    let mut ties = 0;
    for _ in 0..4000 {
        let messages = list(&mut g);
        let s = sorted(&messages);
        for want in ["m0", "m1", "m3", "m7"] {
            let pred = |m: &DisplayMessage| m.uuid == want;
            let a = first_chronological(&messages, pred);
            let b = s.iter().find(|m| pred(m));
            assert_eq!(tag(a), tag(b), "uuid {want} in {messages:#?}");
            if messages.iter().filter(|m| pred(m)).count() > 1 {
                ties += 1;
            }
            // The resolve_uuid shape: a uuid or a folded one.
            let folded = |m: &DisplayMessage| {
                m.uuid == want
                    || m.folded_sdk_uuids
                        .as_ref()
                        .is_some_and(|f| f.contains(want))
            };
            assert_eq!(
                tag(first_chronological(&messages, folded)),
                tag(s.iter().find(|m| folded(m))),
            );
        }
        // loadOlder's head: the first message of the sorted list.
        assert_eq!(
            tag(first_chronological(&messages, |_| true)),
            tag(s.first())
        );
    }
    assert!(ties > 1000, "the data must exercise ties ({ties})");
}

#[test]
fn find_tool_use_block_sorted_matches_the_sorted_copy() {
    let mut g = Lcg(0xb10c_005e);
    let mut picked_a_later_message = 0;
    for _ in 0..4000 {
        let messages = list(&mut g);
        let s = sorted(&messages);
        for id in ["tu0", "tu1", "tu2", "tu3", "absent"] {
            let a = find_tool_use_block_sorted(id, &messages);
            let b = find_tool_use_block(id, &[&s]);
            assert_eq!(a, b, "{id} in {messages:#?}");
            if a.is_some() && a != find_tool_use_block(id, &[&messages]) {
                picked_a_later_message += 1;
            }
        }
    }
    // The order matters in the data: the unsorted list's first match
    // differs from the sorted one's often.
    assert!(picked_a_later_message > 100, "{picked_a_later_message}");
}

fn stamped(uuid: &str, at: f64, blocks: Vec<DisplayBlock>) -> DisplayMessage {
    let mut m = DisplayMessage::new(uuid, Role::Assistant, blocks);
    m.created_at = Some(at);
    m
}

/// `loadOlder` pages before the first bubble as rendered (sorted), not
/// the first one stored.
#[test]
fn load_older_pages_before_the_earliest_bubble() {
    let mut s = ChatState::new("tab");
    s.session_id = Some("s1".into());
    s.has_more_above = Some(json!(true));
    s.messages = vec![
        stamped("late", 2000.0, Vec::new()),
        stamped("early", 1000.0, Vec::new()),
    ];
    let out = s.load_older(&mut FixedEnv::new(0.0));
    let urls: Vec<&str> = out
        .iter()
        .filter_map(|e| match e {
            Effect::Fetch(f) => Some(f.url.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(urls, ["/api/sessions/s1/transcript?before=early&limit=50"]);
}

/// A tool result reads the tool_use block of the earliest bubble holding
/// it (`findToolUseBlock(id, messagesRef.current)`): here a Workflow's
/// result opens a provisional task only when the Workflow block is the
/// earlier one.
#[test]
fn a_tool_result_reads_the_earliest_bubbles_block() {
    for workflow_first in [false, true] {
        let workflow = DisplayBlock::ToolUse {
            id: "tu".into(),
            name: "Workflow".into(),
            input: json!({ "script": "export const meta = { name: 'nightly' }" }),
            result: None,
            started_at: None,
        };
        let bash = DisplayBlock::ToolUse {
            id: "tu".into(),
            name: "Bash".into(),
            input: json!({ "command": "true" }),
            result: None,
            started_at: None,
        };
        let (early, late) = if workflow_first {
            (workflow, bash)
        } else {
            (bash, workflow)
        };
        let mut s = ChatState::new("tab");
        // Stored late first: the list isn't in chronological order.
        s.messages = vec![
            stamped("late", 2000.0, vec![late]),
            stamped("early", 1000.0, vec![early]),
        ];
        let ev = json!({"type": "sdk", "message": {"type": "user", "message": {"role": "user",
            "content": [{"type": "tool_result", "tool_use_id": "tu", "content": "ok"}]},
            "parent_tool_use_id": null, "uuid": "r1"}});
        s.on_message(&ev.to_string(), &mut FixedEnv::new(0.0));
        let opened = s
            .tasks
            .values()
            .any(|t| t.task_type.as_deref() == Some("local_workflow"));
        assert_eq!(opened, workflow_first, "workflow first: {workflow_first}");
    }
}

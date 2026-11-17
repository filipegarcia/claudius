//! Synthetic Claude Code transcript (JSONL), so the 10k-event benchmark is
//! reproducible without committing anyone's real session. One line = one
//! event: user prompts, assistant markdown (headings, lists, tables, links,
//! inline code, fenced code, math), tool calls (Bash, Read, Edit with a
//! diff-able old/new pair) and their results.

use serde_json::{Value, json};

pub const SESSION_ID: &str = "0a0a0a0a-0000-4000-8000-000000000a0a";

fn uuid(i: usize) -> String {
    format!("5e5e5e5e-0000-4000-8000-{i:012x}")
}

fn ts(i: usize) -> String {
    let s = i % 60;
    let m = (i / 60) % 60;
    let h = (i / 3600) % 24;
    format!("2026-11-16T{h:02}:{m:02}:{s:02}.000Z")
}

const RUST: &str = "use std::collections::HashMap;\n\n/// Counts words, case-insensitively.\npub fn word_counts(text: &str) -> HashMap<String, usize> {\n    let mut out = HashMap::new();\n    for w in text.split_whitespace() {\n        *out.entry(w.to_lowercase()).or_insert(0) += 1;\n    }\n    out\n}\n";
const TS: &str = "export async function fetchSessions(base: string): Promise<Session[]> {\n  const res = await fetch(`${base}/api/sessions`);\n  if (!res.ok) throw new Error(`HTTP ${res.status}`);\n  return (await res.json()) as Session[];\n}\n";
const PY: &str = "def fib(n: int) -> int:\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n";

fn assistant_markdown(i: usize) -> String {
    let mut s = String::new();
    match i % 6 {
        0 => {
            s.push_str(&format!("## Step {i}: what changed\n\nI looked at `lib/server/session.ts` and the [stream route](https://example.com/docs/{i}). Three things matter:\n\n1. The replay buffer is capped at **1000** events.\n2. Subscribers get a `replay_done` marker.\n3. Late joiners rebuild to-dos from the snapshot.\n\n"));
            s.push_str(&format!("```rust\n{RUST}```\n"));
        }
        1 => {
            s.push_str("| Metric | Before | After |\n|---|---:|---:|\n| p50 frame | 9.1 ms | 4.2 ms |\n| p95 frame | 22.7 ms | 7.9 ms |\n| RSS | 412 MB | 188 MB |\n\n");
            s.push_str(
                "The table above is from the last run; the *after* column uses the new list.\n",
            );
        }
        2 => {
            s.push_str(&format!("Here's the TypeScript side (turn {i}):\n\n```ts\n{TS}```\n\n- [x] parse the body\n- [ ] add a test\n- [ ] update the docs\n"));
        }
        3 => {
            s.push_str("The update is a contraction when $\\lVert \\nabla f(x) - \\nabla f(y) \\rVert \\le L \\lVert x - y \\rVert$, so with step $\\eta < 2/L$:\n\n$$\nf(x_{k+1}) \\le f(x_k) - \\eta\\left(1 - \\frac{L\\eta}{2}\\right)\\lVert \\nabla f(x_k) \\rVert^2\n$$\n");
        }
        4 => {
            s.push_str(&format!("> Note: this is a long paragraph to exercise wrapping. The session manager keeps one `Session` per id, reaps idle ones after a grace period, and re-attaches a resumed transcript when the user reopens a tab. Event {i} of the synthetic run.\n\n```python\n{PY}```\n"));
        }
        _ => {
            s.push_str(&format!("### Done\n\nAll **{i}** checks pass. Run `cargo test -p claudius-core` to confirm, then see <https://example.com/ci/{i}>.\n"));
        }
    }
    s
}

fn tool_call(i: usize) -> (Value, Value) {
    let id = format!("toolu_{i:08}");
    match i % 3 {
        0 => (
            json!({"type": "tool_use", "id": id, "name": "Bash",
                   "input": {"command": format!("cargo test -p claudius-core --lib session::tests::case_{i}"), "description": "Run one test"}}),
            json!({"type": "tool_result", "tool_use_id": id,
                   "content": format!("running 1 test\ntest session::tests::case_{i} ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; finished in 0.{:02}s", i % 100)}),
        ),
        1 => (
            json!({"type": "tool_use", "id": id, "name": "Edit",
                   "input": {"file_path": format!("/repo/src/module_{}.rs", i % 40),
                             "old_string": "    let mut out = HashMap::new();\n    for w in text.split_whitespace() {",
                             "new_string": format!("    let mut out = HashMap::with_capacity({});\n    for w in text.split(char::is_whitespace).filter(|w| !w.is_empty()) {{", i % 64)}}),
            json!({"type": "tool_result", "tool_use_id": id, "content": "The file has been updated."}),
        ),
        _ => (
            json!({"type": "tool_use", "id": id, "name": "Read",
                   "input": {"file_path": format!("/repo/src/module_{}.rs", i % 40)}}),
            json!({"type": "tool_result", "tool_use_id": id,
                   "content": RUST.lines().enumerate().map(|(n, l)| format!("{:>5}\t{l}", n + 1)).collect::<Vec<_>>().join("\n")}),
        ),
    }
}

/// `n` JSONL lines forming one parent→child chain.
pub fn generate(n: usize) -> String {
    let mut out = String::with_capacity(n * 900);
    let mut parent: Option<String> = None;
    let mut i = 0;
    let mut turn = 0;
    let push =
        |i: usize, ty: &str, message: Value, out: &mut String, parent: &mut Option<String>| {
            let u = uuid(i);
            let mut e = json!({
                "type": ty, "uuid": u, "parentUuid": parent.clone(), "sessionId": SESSION_ID,
                "timestamp": ts(i), "cwd": "/repo", "isSidechain": false, "userType": "external",
                "version": "2.1.300", "message": message,
            });
            if ty == "assistant" {
                e["requestId"] = json!(format!("req_{i:08}"));
            }
            out.push_str(&e.to_string());
            out.push('\n');
            *parent = Some(u);
        };
    while i < n {
        // A turn: prompt, then a few (text, tool call, result) rounds, then a summary.
        push(
            i,
            "user",
            json!({"role": "user", "content": format!("Turn {turn}: please look at module {} and fix the failing test, then summarize.", turn % 40)}),
            &mut out,
            &mut parent,
        );
        i += 1;
        for r in 0..3 {
            if i + 3 > n {
                break;
            }
            let msg_id = format!("msg_{i:08}");
            push(
                i,
                "assistant",
                json!({"id": msg_id, "type": "message", "role": "assistant", "model": "claude-sonnet-4-5",
                "content": [{"type": "text", "text": assistant_markdown(i + r)}], "stop_reason": null,
                "usage": {"input_tokens": 10, "output_tokens": 200}}),
                &mut out,
                &mut parent,
            );
            i += 1;
            let (call, result) = tool_call(i);
            push(
                i,
                "assistant",
                json!({"id": msg_id, "type": "message", "role": "assistant", "model": "claude-sonnet-4-5",
                "content": [call], "stop_reason": "tool_use", "usage": {"input_tokens": 10, "output_tokens": 40}}),
                &mut out,
                &mut parent,
            );
            i += 1;
            push(
                i,
                "user",
                json!({"role": "user", "content": [result]}),
                &mut out,
                &mut parent,
            );
            i += 1;
        }
        if i < n {
            push(
                i,
                "assistant",
                json!({"id": format!("msg_{i:08}"), "type": "message", "role": "assistant", "model": "claude-sonnet-4-5",
                "content": [{"type": "text", "text": assistant_markdown(5)}], "stop_reason": "end_turn",
                "usage": {"input_tokens": 10, "output_tokens": 80}}),
                &mut out,
                &mut parent,
            );
            i += 1;
        }
        turn += 1;
    }
    out
}

/// The fake CLI's script for the live turn: a long markdown answer streamed
/// as `stream_event` text deltas, `delay_ms` apart, then the final message.
pub fn stream_script(deltas: usize, delay_ms: u64) -> Value {
    let body = format!(
        "## Streaming answer\n\nThis reply arrives as {deltas} deltas, one every {delay_ms} ms. \
It mixes **bold**, `inline code`, a list, a table and a code block so every frame re-lays out real markdown.\n\n"
    );
    let filler = [
        "- The session manager keeps one `Session` per id. ",
        "It reaps idle sessions after a grace period. ",
        "\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n",
        "```rust\nfn main() { println!(\"hi\"); }\n```\n\n",
        "A resumed transcript replays through `transcript::session_messages`. ",
        "Math stays inline: $e^{i\\pi} + 1 = 0$. ",
    ];
    let mut chunks: Vec<String> = Vec::with_capacity(deltas);
    chunks.push(body);
    let mut k = 0;
    while chunks.len() < deltas {
        // Split each filler sentence into word-sized deltas, like a model does.
        for w in filler[k % filler.len()].split_inclusive(' ') {
            if chunks.len() >= deltas {
                break;
            }
            chunks.push(w.to_string());
        }
        k += 1;
    }
    let full: String = chunks.concat();
    let mut steps = vec![
        json!({"type": "stream_event", "event": {"type": "message_start", "message": {"id": "msg_live", "type": "message", "role": "assistant", "content": [], "model": "$MODEL"}}, "parent_tool_use_id": null}),
        json!({"type": "stream_event", "event": {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}, "parent_tool_use_id": null}),
    ];
    for c in &chunks {
        steps.push(json!({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": c}}, "parent_tool_use_id": null}));
        steps.push(json!({"$delay_ms": delay_ms}));
    }
    steps.push(json!({"type": "stream_event", "event": {"type": "content_block_stop", "index": 0}, "parent_tool_use_id": null}));
    steps.push(json!({"type": "assistant", "message": {"id": "msg_live", "type": "message", "role": "assistant", "model": "$MODEL", "content": [{"type": "text", "text": full}], "stop_reason": "end_turn"}, "parent_tool_use_id": null}));
    json!({"turns": [{"match": "stream", "repeat": true, "steps": steps, "result": "streamed"}]})
}

//! Event logs in the server's shapes, written as code: [`Script`] emits
//! the `ServerEvent`s a real session sends (`ready`, `replay_done`,
//! `turn_status`, and `sdk` messages: user prompts, assistant splits,
//! `stream_event` deltas, tool results, hook `system` events, `result`),
//! in the shapes `client_session_golden.json` recorded. [`demo`] is the
//! bundled "port the app shell" session; [`synthetic`] is the U00a spike's
//! long transcript (`spikes/gpui-transcript/src/synth.rs`), for scrolling.

use serde_json::{Value, json};

use crate::fixture::EventLine;

/// Builds an event log. Every event is one second after the last.
pub struct Script {
    session: String,
    at: f64,
    n: usize,
    lines: Vec<EventLine>,
}

impl Script {
    pub fn new(session: &str, start_ms: f64) -> Self {
        Script {
            session: session.to_owned(),
            at: start_ms,
            n: 0,
            lines: Vec::new(),
        }
    }

    pub fn lines(self) -> Vec<EventLine> {
        self.lines
    }

    /// Takes the lines written so far, keeping the clock.
    pub fn take(&mut self) -> Vec<EventLine> {
        std::mem::take(&mut self.lines)
    }

    /// Moves the clock on.
    pub fn wait(&mut self, ms: f64) -> &mut Self {
        self.at += ms;
        self
    }

    fn uuid(&mut self, prefix: &str) -> String {
        self.n += 1;
        format!("{prefix}-{:04}", self.n)
    }

    pub fn event(&mut self, ev: Value) -> &mut Self {
        self.at += 1000.0;
        self.lines.push(EventLine {
            at: self.at,
            data: ev.to_string(),
        });
        self
    }

    fn sdk(&mut self, mut msg: Value, stamped: bool) -> &mut Self {
        msg["session_id"] = json!(self.session);
        let at = self.at + 1000.0;
        let mut ev = json!({"type": "sdk", "message": msg});
        if stamped {
            ev["at"] = json!(at);
        }
        self.event(ev)
    }

    pub fn ready(&mut self) -> &mut Self {
        let id = self.session.clone();
        self.event(json!({"type": "ready", "sessionId": id}))
    }

    pub fn replay_done(&mut self) -> &mut Self {
        self.event(json!({"type": "replay_done", "hasMoreAbove": false}))
    }

    pub fn running(&mut self, on: bool) -> &mut Self {
        self.event(json!({"type": "turn_status", "status": if on { "running" } else { "idle" }}))
    }

    pub fn user(&mut self, text: &str) -> &mut Self {
        let uuid = self.uuid("u");
        self.sdk(
            json!({"type": "user", "message": {"role": "user", "content": text}, "parent_tool_use_id": null, "uuid": uuid}),
            true,
        )
    }

    /// A peer session's message (`origin.kind: "peer"`).
    pub fn peer(&mut self, name: &str, text: &str) -> &mut Self {
        let uuid = self.uuid("p");
        self.sdk(
            json!({"type": "user", "message": {"role": "user", "content": text}, "parent_tool_use_id": null, "uuid": uuid,
                   "origin": {"kind": "peer", "from": "local_7f3a", "name": name, "body": text, "msg_id": "m-1"}}),
            true,
        )
    }

    fn assistant(&mut self, msg_id: &str, block: Value) -> &mut Self {
        let uuid = self.uuid("a");
        self.sdk(
            json!({"type": "assistant", "message": {"id": msg_id, "type": "message", "role": "assistant",
                   "model": "claude-opus-4-5", "content": [block], "stop_reason": null,
                   "usage": {"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}},
                   "parent_tool_use_id": null, "uuid": uuid}),
            true,
        )
    }

    pub fn text(&mut self, msg_id: &str, text: &str) -> &mut Self {
        self.assistant(msg_id, json!({"type": "text", "text": text}))
    }

    pub fn thinking(&mut self, msg_id: &str, text: &str) -> &mut Self {
        self.assistant(
            msg_id,
            json!({"type": "thinking", "thinking": text, "signature": "sig"}),
        )
    }

    pub fn tool(&mut self, msg_id: &str, id: &str, name: &str, input: Value) -> &mut Self {
        self.assistant(
            msg_id,
            json!({"type": "tool_use", "id": id, "name": name, "input": input}),
        )
    }

    pub fn tool_result(&mut self, id: &str, content: &str, is_error: bool) -> &mut Self {
        let uuid = self.uuid("r");
        self.sdk(
            json!({"type": "user", "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": id, "content": content, "is_error": is_error}]},
                "parent_tool_use_id": null, "uuid": uuid}),
            false,
        )
    }

    /// A hook's `hook_started` and `hook_response` (`outcome: "error"`
    /// with exit code 2 is a failure).
    pub fn hook(&mut self, name: &str, event: &str, failed: Option<&str>) -> &mut Self {
        let id = self.uuid("hk");
        let started = self.uuid("h");
        self.sdk(
            json!({"type": "system", "subtype": "hook_started", "uuid": started, "hook_id": id,
                   "hook_name": name, "hook_event": event}),
            false,
        );
        let done = self.uuid("h");
        let (outcome, code, stderr) = match failed {
            Some(err) => ("error", 2, err),
            None => ("success", 0, ""),
        };
        self.sdk(
            json!({"type": "system", "subtype": "hook_response", "uuid": done, "hook_id": id, "hook_name": name,
                   "hook_event": event, "output": "", "stdout": "", "stderr": stderr, "exit_code": code, "outcome": outcome}),
            false,
        )
    }

    /// A `stream_event` text block: `content_block_start`, one
    /// `text_delta` per chunk, `content_block_stop`, then the final
    /// assistant split and `message_stop`.
    pub fn stream(&mut self, msg_id: &str, chunks: &[String], delta_ms: f64) -> &mut Self {
        let se = |s: &mut Script, ev: Value| {
            let uuid = s.uuid("se");
            s.sdk(
                json!({"type": "stream_event", "event": ev, "parent_tool_use_id": null, "uuid": uuid}),
                false,
            );
        };
        let start = self.uuid("se");
        let at = self.at + 1000.0;
        self.event(json!({"type": "sdk", "message": {"session_id": self.session, "type": "stream_event",
            "event": {"type": "message_start", "message": {"id": msg_id, "type": "message", "role": "assistant",
            "model": "claude-opus-4-5", "content": [], "stop_reason": null,
            "usage": {"input_tokens": 12, "output_tokens": 1, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}}},
            "parent_tool_use_id": null, "uuid": start}, "at": at}));
        se(
            self,
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        );
        for c in chunks {
            self.at += delta_ms - 1000.0;
            se(
                self,
                json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": c}}),
            );
        }
        se(self, json!({"type": "content_block_stop", "index": 0}));
        let full: String = chunks.concat();
        self.text(msg_id, &full);
        se(
            self,
            json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 200}}),
        );
        se(self, json!({"type": "message_stop"}));
        self
    }

    pub fn result(&mut self) -> &mut Self {
        let uuid = self.uuid("res");
        self.sdk(
            json!({"type": "result", "subtype": "success", "is_error": false, "duration_ms": 4200, "duration_api_ms": 4000,
                   "num_turns": 1, "result": "Done", "stop_reason": "end_turn", "total_cost_usd": 0.0421,
                   "usage": {"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
                   "modelUsage": {}, "permission_denials": [], "uuid": uuid}),
            false,
        )
    }
}

/// Splits text into word-sized deltas, as a model streams.
pub fn word_chunks(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for c in text.chars() {
        cur.push(c);
        if c == ' ' || c == '\n' {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

const REPLY: &str = r#"## The shell is on GPUI

The window, the two rails and the session strip now render natively. Three things changed:

1. **Routing** moved into `ShellState`, a pure state machine, so every redirect has a unit test.
2. The tab strip measures its tabs on one frame and fits them on the next.
3. Shortcuts go through `shortcuts::bind`, one table for the menu and the keymap.

| Piece | React source | Native |
|---|---|:---:|
| Workspace rail | `WorkspaceSwitcher.tsx` | yes |
| Nav rail | `SideNav.tsx` | yes |
| Session tabs | `SessionTabs.tsx` | yes |

```rust
/// Recomputes the hidden tabs; whether they changed.
pub(crate) fn refit(&mut self) -> bool {
    let hidden = crate::tabs::hidden_tabs(&tabs, |id| self.tab_widths.get(id).copied(), self.strip_width, active);
    if hidden != self.hidden {
        self.hidden = hidden;
        return true;
    }
    false
}
```

Next up is the transcript: a virtualized list over `ChatState`, with long rows folded."#;

const STREAMED: &str = r#"Here is how the transcript keeps up with a streaming reply:

- Each delta is **appended** to the open bubble's parsed state with `push_str`, so the markdown is never parsed again from the start.
- Only rows near the viewport keep their parsed state; the rest are dropped and parse again if they scroll back in.
- While you sit at the bottom the list follows the tail. Scroll up and it stays put.

```ts
export function nextPinGate(input: ScrollGateInput): boolean | null {
  const distFromBottom = input.scrollHeight - input.scrollTop - input.clientHeight;
  if (distFromBottom <= NEAR_BOTTOM_PX) return true;
  if (input.scrollTop >= input.prevScrollTop - SCROLL_UP_EPS_PX) return null;
  return false;
}
```

That's the React list's rule (`lib/client/scroll-gate.ts`); natively, GPUI's tail-follow mode does the same job."#;

/// The bundled demo session: a finished turn with markdown, a code block,
/// thinking, tool calls and hook pills (`history`), and a second prompt
/// whose reply streams (`stream`, word by word, `delta_ms` apart).
pub fn demo(session: &str, start_ms: f64, delta_ms: f64) -> (Vec<EventLine>, Vec<EventLine>) {
    let mut s = Script::new(session, start_ms);
    s.ready().replay_done();
    s.hook("SessionStart:startup", "SessionStart", None);
    s.user("Port the app shell to GPUI: window, workspace rail, nav rail and the session tabs. Keep the routing testable without a window.");
    s.running(true);
    s.hook("UserPromptSubmit", "UserPromptSubmit", None);
    s.thinking("msg_D1", "The React shell lives in `components/nav/` and `components/chat/`. Routing is spread over the layouts and a few hooks; pulling it into one state machine makes the redirects testable.");
    s.text(
        "msg_D1",
        "I'll start from the React layout and keep the state machine separate from the view.",
    );
    s.tool(
        "msg_D1",
        "toolu_D1",
        "Read",
        json!({"file_path": "/Users/demo/src/claudius/components/nav/SideNav.tsx"}),
    );
    s.tool_result(
        "toolu_D1",
        "1\t\"use client\";\n2\timport { useRouter } from \"next/navigation\";",
        false,
    );
    s.tool(
        "msg_D1",
        "toolu_D2",
        "Bash",
        json!({"command": "cargo test -p claudius-app", "description": "Run the shell tests"}),
    );
    s.hook("PreToolUse:Bash", "PreToolUse", None);
    s.tool_result("toolu_D2", "test result: ok. 100 passed; 0 failed", false);
    s.tool("msg_D1", "toolu_D3", "Edit", json!({"file_path": "/Users/demo/src/claudius/rust/app/crates/claudius-app/src/tabs.rs", "old_string": "a", "new_string": "b"}));
    s.hook(
        "PostToolUse:Edit",
        "PostToolUse",
        Some("prettier: no parser for .rs files\nexit status 2"),
    );
    s.tool_result("toolu_D3", "The file has been updated successfully.", false);
    s.text("msg_D2", REPLY);
    s.result().running(false);
    s.wait(60_000.0);
    s.user("How does it keep up with streaming?");
    s.running(true);
    let history = s.take();
    s.stream("msg_D3", &word_chunks(STREAMED), delta_ms);
    s.result().running(false);
    (history, s.lines())
}

const RUST: &str = "use std::collections::HashMap;\n\n/// Counts words, case-insensitively.\npub fn word_counts(text: &str) -> HashMap<String, usize> {\n    let mut out = HashMap::new();\n    for w in text.split_whitespace() {\n        *out.entry(w.to_lowercase()).or_insert(0) += 1;\n    }\n    out\n}\n";
const TS: &str = "export async function fetchSessions(base: string): Promise<Session[]> {\n  const res = await fetch(`${base}/api/sessions`);\n  if (!res.ok) throw new Error(`HTTP ${res.status}`);\n  return (await res.json()) as Session[];\n}\n";
const PY: &str = "def fib(n: int) -> int:\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n";

fn synth_markdown(i: usize) -> String {
    match i % 6 {
        0 => format!(
            "## Step {i}: what changed\n\nI looked at `lib/server/session.ts` and the [stream route](https://example.com/docs/{i}). Three things matter:\n\n1. The replay buffer is capped at **1000** events.\n2. Subscribers get a `replay_done` marker.\n3. Late joiners rebuild to-dos from the snapshot.\n\n```rust\n{RUST}```\n"
        ),
        1 => "| Metric | Before | After |\n|---|---:|---:|\n| p50 frame | 9.1 ms | 4.2 ms |\n| p95 frame | 22.7 ms | 7.9 ms |\n| RSS | 412 MB | 188 MB |\n\nThe table above is from the last run; the *after* column uses the new list.\n".into(),
        2 => format!(
            "Here's the TypeScript side (turn {i}):\n\n```ts\n{TS}```\n\n- [x] parse the body\n- [ ] add a test\n- [ ] update the docs\n"
        ),
        3 => "The update is a contraction when $\\lVert \\nabla f(x) - \\nabla f(y) \\rVert \\le L \\lVert x - y \\rVert$, so with step $\\eta < 2/L$:\n\n$$\nf(x_{k+1}) \\le f(x_k) - \\eta\\left(1 - \\frac{L\\eta}{2}\\right)\\lVert \\nabla f(x_k) \\rVert^2\n$$\n".into(),
        4 => format!(
            "> Note: this is a long paragraph to exercise wrapping. The session manager keeps one `Session` per id, reaps idle ones after a grace period, and re-attaches a resumed transcript when the user reopens a tab. Event {i} of the synthetic run.\n\n```python\n{PY}```\n"
        ),
        _ => format!(
            "### Done\n\nAll **{i}** checks pass. Run `cargo test -p claudius-core` to confirm, then see <https://example.com/ci/{i}>.\n"
        ),
    }
}

fn synth_tool(s: &mut Script, msg_id: &str, i: usize) {
    let id = format!("toolu_{i:08}");
    match i % 3 {
        0 => {
            s.tool(msg_id, &id, "Bash", json!({"command": format!("cargo test -p claudius-core --lib session::tests::case_{i}"), "description": "Run one test"}));
            s.tool_result(&id, &format!("running 1 test\ntest session::tests::case_{i} ... ok\n\ntest result: ok. 1 passed; 0 failed"), false);
        }
        1 => {
            s.tool(msg_id, &id, "Edit", json!({"file_path": format!("/repo/src/module_{}.rs", i % 40), "old_string": "a", "new_string": "b"}));
            s.tool_result(&id, "The file has been updated.", false);
        }
        _ => {
            s.tool(
                msg_id,
                &id,
                "Read",
                json!({"file_path": format!("/repo/src/module_{}.rs", i % 40)}),
            );
            s.tool_result(&id, RUST, false);
        }
    }
}

/// About `n` events of the spike's synthetic transcript: turns of a
/// prompt, three (markdown reply, tool call, result) rounds and a summary.
pub fn synthetic(session: &str, n: usize, start_ms: f64) -> Vec<EventLine> {
    let mut s = Script::new(session, start_ms);
    s.ready();
    let mut i = 0;
    let mut turn = 0;
    while i < n {
        s.user(&format!(
            "Turn {turn}: please look at module {} and fix the failing test, then summarize.",
            turn % 40
        ));
        i += 1;
        for r in 0..3 {
            if i + 3 > n {
                break;
            }
            let msg_id = format!("msg_{i:08}");
            s.text(&msg_id, &synth_markdown(i + r));
            synth_tool(&mut s, &msg_id, i + 1);
            i += 3;
        }
        if i < n {
            s.text(&format!("msg_{i:08}"), &synth_markdown(5));
            i += 1;
        }
        turn += 1;
    }
    s.replay_done();
    s.lines()
}

const MARKDOWN: &str = r#"# Release notes, 0.4

The transcript now renders **natively**. A few highlights, with *emphasis*, ~~strikethrough~~, `inline code` and a [link](https://example.com/docs).

## What changed

1. Rows are a pure model: `rows(&ChatState, &ViewOptions)`.
   - one decision per test, named after it
   - no GPUI in the model
2. The list is virtualized, so only the rows near the viewport lay out.
3. Long rows fold behind **Show more**.

> Streaming appends each delta to the parsed state instead of parsing the
> whole message again.

- [x] bubbles and markdown
- [x] highlighted code
- [ ] tool cards (U06)

| Row kind | Source | Folds |
|---|---|:---:|
| user | `UserMessage.tsx` | yes |
| assistant | `AssistantMessage.tsx` | yes |
| pill | `SystemPill.tsx` | no |

Math stays raw until U05b: $e^{i\pi} + 1 = 0$, and as a block:

$$
\int_0^1 x^2 \, dx = \tfrac{1}{3}
$$

---

That's all for this release."#;

const CODE: &str = r#"Here's the parser and its test:

```rust
/// The fold point: the last line break at or before `cap`.
pub fn fold_cut(text: &str, cap: usize) -> Option<usize> {
    if text.len() <= cap {
        return None;
    }
    let mut cut = cap;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    Some(text[..cut].rfind('\n').map_or(cut, |i| i + 1))
}
```

And the client side, in TypeScript:

```ts
export function nextPinGate(input: ScrollGateInput): boolean | null {
  const dist = input.scrollHeight - input.scrollTop - input.clientHeight;
  if (dist <= NEAR_BOTTOM_PX) return true; // re-arm near the bottom
  return input.scrollTop >= input.prevScrollTop - SCROLL_UP_EPS_PX ? null : false;
}
```

```bash
cargo test -p claudius-chat --lib rows::tests
```"#;

/// A prompt and one reply of `reply` (as a finished turn).
pub fn turn(session: &str, start_ms: f64, prompt: &str, reply: &str) -> Vec<EventLine> {
    let mut s = Script::new(session, start_ms);
    s.ready().replay_done();
    s.user(prompt).running(true);
    s.text("msg_T1", reply);
    s.result().running(false);
    s.lines()
}

/// A markdown-heavy reply: headings, lists, a task list, a table, a quote,
/// raw math.
pub fn markdown_turn(session: &str, start_ms: f64) -> Vec<EventLine> {
    turn(
        session,
        start_ms,
        "Write the release notes for the native transcript.",
        MARKDOWN,
    )
}

/// A reply with highlighted code blocks (Rust, TypeScript, shell).
pub fn code_turn(session: &str, start_ms: f64) -> Vec<EventLine> {
    turn(
        session,
        start_ms,
        "Show me `fold_cut` and the pin gate.",
        CODE,
    )
}

/// A reply of about `kb` KB of markdown (it folds).
pub fn long_turn(session: &str, start_ms: f64, kb: usize) -> Vec<EventLine> {
    let mut reply = String::from("## The full log\n\n");
    let mut i = 0;
    while reply.len() < kb * 1024 {
        reply.push_str(&format!(
            "{i}. Checked `module_{i}.rs`: the replay buffer keeps its cap, the subscribers get `replay_done`, and late joiners rebuild from the snapshot.\n"
        ));
        i += 1;
    }
    turn(session, start_ms, "Paste the whole audit log.", &reply)
}

/// Hook rows: a session start, a prompt hook, a passing and a failing tool
/// hook (with stderr), around a tool call.
pub fn hooks_turn(session: &str, start_ms: f64) -> Vec<EventLine> {
    let mut s = Script::new(session, start_ms);
    s.ready().replay_done();
    s.hook("SessionStart:startup", "SessionStart", None);
    s.user("Format the changed files.").running(true);
    s.hook("UserPromptSubmit", "UserPromptSubmit", None);
    s.tool(
        "msg_H1",
        "toolu_H1",
        "Bash",
        json!({"command": "cargo fmt --all", "description": "Format"}),
    );
    s.hook("PreToolUse:Bash", "PreToolUse", None);
    s.tool_result("toolu_H1", "", false);
    s.hook(
        "PostToolUse:Bash",
        "PostToolUse",
        Some("prettier: no parser could be inferred for file \"src/rows.rs\"\nhint: add an override for *.rs\nexit status 2"),
    );
    s.text("msg_H2", "Formatted. The `PostToolUse` hook failed on the Rust files (prettier has no parser for them); the formatting itself went through.");
    s.result().running(false);
    s.lines()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_chunks_keep_every_character() {
        let text = "a b\nc  d";
        let chunks = word_chunks(text);
        assert_eq!(chunks.concat(), text);
        assert_eq!(chunks, ["a ", "b\n", "c ", " ", "d"]);
    }

    #[test]
    fn the_demo_streams_its_second_reply() {
        let (history, stream) = demo("s", 0.0, 50.0);
        assert!(history.len() > 10);
        let deltas = stream
            .iter()
            .filter(|l| l.data.contains("text_delta"))
            .count();
        assert_eq!(deltas, word_chunks(STREAMED).len());
    }
}

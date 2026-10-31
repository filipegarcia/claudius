//! Live smoke test against the real `claude` binary.
//!
//!   cargo run -p claudius-agent --example smoke -- "<prompt>"
//!
//! Denies every tool permission request and prints the message flow.

use std::sync::Arc;

use async_trait::async_trait;
use claudius_agent::{CanUseTool, Options, PermissionResult, Query, ToolPermissionContext};
use serde_json::{Value, json};

struct DenyAll;

#[async_trait]
impl CanUseTool for DenyAll {
    async fn can_use_tool(
        &self,
        tool: &str,
        input: Value,
        ctx: ToolPermissionContext,
    ) -> Option<PermissionResult> {
        println!(
            "<< can_use_tool {tool} {input} (tool_use_id={:?}, suggestions={})",
            ctx.tool_use_id,
            ctx.suggestions
                .as_ref()
                .map(|s| s.to_string())
                .unwrap_or_default()
        );
        Some(PermissionResult::deny(
            "Denied by claudius-agent smoke test",
        ))
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let prompt = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "Reply with exactly: pong".into());
    let session_id = uuid::Uuid::new_v4().to_string();
    let mut q = Query::spawn(Options {
        model: Some(std::env::var("SMOKE_MODEL").unwrap_or_else(|_| "haiku".into())),
        permission_mode: Some("default".into()),
        max_turns: Some(3.0),
        max_budget_usd: Some(0.25),
        include_partial_messages: true,
        session_id: Some(session_id.clone()),
        persist_session: Some(false),
        can_use_tool: Some(Arc::new(DenyAll)),
        stderr: Some(Arc::new(|chunk: &str| eprint!("{chunk}"))),
        ..Default::default()
    })
    .await?;
    let h = q.handle();
    h.send_user_message(
        &json!({"type": "user", "message": {"role": "user", "content": prompt},
                                "parent_tool_use_id": null, "session_id": session_id}),
    )
    .await?;
    let mut partials = 0;
    while let Some(msg) = q.next().await {
        let msg = msg?;
        let ty = msg["type"].as_str().unwrap_or("?");
        match ty {
            "stream_event" => partials += 1,
            "system" => println!(
                ">> system/{} model={}",
                msg["subtype"].as_str().unwrap_or("?"),
                msg["model"]
            ),
            "assistant" => {
                for block in msg["message"]["content"].as_array().into_iter().flatten() {
                    match block["type"].as_str() {
                        Some("text") => println!(">> assistant text: {}", block["text"]),
                        Some("tool_use") => println!(
                            ">> assistant tool_use: {} {}",
                            block["name"], block["input"]
                        ),
                        other => println!(">> assistant {other:?}"),
                    }
                }
            }
            "user" => println!(
                ">> user (tool_result) {}",
                msg["message"]["content"][0]["content"]
                    .to_string()
                    .chars()
                    .take(120)
                    .collect::<String>()
            ),
            "result" => {
                println!(
                    ">> result {} cost=${} turns={} result={}",
                    msg["subtype"], msg["total_cost_usd"], msg["num_turns"], msg["result"]
                );
                break;
            }
            other => println!(">> {other}"),
        }
    }
    let init = h.initialization_result().await?;
    println!(
        "init: {} commands, {} models, account keys={:?}",
        init["commands"].as_array().map_or(0, Vec::len),
        init["models"].as_array().map_or(0, Vec::len),
        init["account"]
            .as_object()
            .map(|o| o.keys().collect::<Vec<_>>())
    );
    println!("stream_event partials: {partials}");
    h.close().await;
    Ok(())
}

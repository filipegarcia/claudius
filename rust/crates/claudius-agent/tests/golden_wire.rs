//! Wire parity with the real TypeScript Agent SDK.
//!
//! `rust/scripts/golden-wire.mjs` runs `query()` from the installed
//! `@anthropic-ai/claude-agent-sdk` against `claudius-fake-claude` and records
//! argv, env, the `initialize` body and every stdin line into
//! `tests/fixtures/golden/<case>.json`. This test builds the same `Options`
//! from each fixture's `spec`, drives the Rust `Query` against the same fake
//! with the same input env, normalizes identically and diffs.
//!
//! A difference fails the test unless [`ALLOWED`] lists it with the TODO id
//! that will close it. Allowlist entries that no longer differ fail too, so
//! the list can only shrink.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use claudius_agent::options::{LocalPlugin, SkillsOption};
use claudius_agent::permission::ElicitationRequest;
use claudius_agent::{
    CanUseTool, HookMatcher, McpServerConfig, OnElicitation, Options, PermissionResult, Query,
    SystemPrompt, ThinkingConfig, ToolDef, ToolOutput, ToolPermissionContext, ToolServer, Tools,
    hook_fn,
};
use serde_json::{Value, json};

/// Known, tracked differences: (case, JSON path prefix, TODO id). Empty
/// since A03 (2026-10-26): every case matches SDK 0.3.312 exactly. Add an
/// entry only with the TODO id that will remove it.
const ALLOWED: &[(&str, &str, &str)] = &[];

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/golden")
}

struct AllowAll;

#[async_trait]
impl CanUseTool for AllowAll {
    async fn can_use_tool(
        &self,
        _tool: &str,
        input: Value,
        _ctx: ToolPermissionContext,
    ) -> Option<PermissionResult> {
        Some(PermissionResult::allow(input))
    }
}

struct Decline;

#[async_trait]
impl OnElicitation for Decline {
    async fn on_elicitation(&self, _req: ElicitationRequest) -> Option<Value> {
        Some(json!({"action": "decline"}))
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .expect("array")
        .iter()
        .map(|s| s.as_str().expect("string").to_owned())
        .collect()
}

fn thinking(v: &Value) -> ThinkingConfig {
    let display = v["display"].as_str().map(str::to_owned);
    match v["type"].as_str() {
        Some("adaptive") => ThinkingConfig::Adaptive { display },
        Some("enabled") => ThinkingConfig::Enabled {
            budget_tokens: v["budgetTokens"].as_u64(),
            display,
        },
        Some("disabled") => ThinkingConfig::Disabled,
        other => panic!("thinking type {other:?}"),
    }
}

fn system_prompt(v: &Value) -> SystemPrompt {
    match v {
        Value::String(s) => SystemPrompt::Custom {
            prompt: s.clone(),
            snapshot: None,
        },
        Value::Array(_) => SystemPrompt::Parts(strings(v)),
        Value::Object(o) if o["type"] == "preset" => SystemPrompt::Preset {
            append: o.get("append").and_then(Value::as_str).map(str::to_owned),
            exclude_dynamic_sections: o.get("excludeDynamicSections").and_then(Value::as_bool),
            snapshot: o.get("snapshot").and_then(Value::as_bool),
        },
        Value::Object(o) if o["type"] == "custom" => SystemPrompt::Custom {
            prompt: o["prompt"].as_str().unwrap().to_owned(),
            snapshot: o.get("snapshot").and_then(Value::as_bool),
        },
        other => panic!("systemPrompt {other}"),
    }
}

/// TS `Options` spec → Rust `Options`. Panics on an unmapped key so a new
/// fixture case can't silently test less than it claims.
fn options_from_spec(spec: &Value) -> Options {
    let mut o = Options::default();
    let s = |v: &Value| v.as_str().expect("string").to_owned();
    for (k, v) in spec.as_object().expect("spec object") {
        match k.as_str() {
            "model" => o.model = Some(s(v)),
            "fallbackModel" => o.fallback_model = Some(s(v)),
            "agent" => o.agent = Some(s(v)),
            "agents" => o.agents = Some(v.clone()),
            "permissionMode" => o.permission_mode = Some(s(v)),
            "allowDangerouslySkipPermissions" => {
                o.allow_dangerously_skip_permissions = v.as_bool().unwrap()
            }
            "permissionPromptToolName" => o.permission_prompt_tool_name = Some(s(v)),
            "permissionPrompts" => o.permission_prompts = Some(s(v)),
            "effort" => o.effort = Some(s(v)),
            "thinking" => o.thinking = Some(thinking(v)),
            "maxTurns" => o.max_turns = v.as_f64(),
            "maxBudgetUsd" => o.max_budget_usd = v.as_f64(),
            "taskBudget" => o.task_budget_total = v["total"].as_f64(),
            "betas" => o.betas = strings(v),
            "outputFormat" => o.json_schema = Some(v["schema"].clone()),
            "continue" => o.continue_conversation = v.as_bool().unwrap(),
            "resume" => o.resume = Some(s(v)),
            "sessionId" => o.session_id = Some(s(v)),
            "resumeSessionAt" => o.resume_session_at = Some(s(v)),
            "resumeDropsTurn" => o.resume_drops_turn = Some(s(v)),
            "forkSession" => o.fork_session = v.as_bool().unwrap(),
            "persistSession" => o.persist_session = v.as_bool(),
            "allowedTools" => o.allowed_tools = strings(v),
            "disallowedTools" => o.disallowed_tools = strings(v),
            "tools" => {
                o.tools = Some(if v.is_array() {
                    Tools::List(strings(v))
                } else {
                    Tools::Default
                })
            }
            "skills" => {
                o.skills = Some(if v == "all" {
                    SkillsOption::All
                } else {
                    SkillsOption::Named(strings(v))
                })
            }
            "mcpServers" => {
                for (name, cfg) in v.as_object().unwrap() {
                    o.mcp_servers
                        .insert(name.clone(), McpServerConfig::External(cfg.clone()));
                }
            }
            "strictMcpConfig" => o.strict_mcp_config = v.as_bool().unwrap(),
            "settingSources" => o.setting_sources = Some(strings(v)),
            "additionalDirectories" => {
                o.additional_directories = strings(v).into_iter().map(PathBuf::from).collect()
            }
            "plugins" => {
                o.plugins = v
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| LocalPlugin {
                        path: PathBuf::from(p["path"].as_str().unwrap()),
                        skip_mcp_discovery: p["skipMcpDiscovery"] == true,
                    })
                    .collect()
            }
            "includePartialMessages" => o.include_partial_messages = v.as_bool().unwrap(),
            "includeHookEvents" => o.include_hook_events = v.as_bool().unwrap(),
            // `query()` JSON-stringifies object settings (`se(i)`).
            "settings" => {
                o.settings = Some(match v {
                    Value::String(path) => path.clone(),
                    obj => serde_json::to_string(obj).unwrap(),
                })
            }
            "managedSettings" => o.managed_settings = Some(serde_json::to_string(v).unwrap()),
            "sandbox" => o.sandbox = Some(v.clone()),
            "extraArgs" => {
                o.extra_args = v
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(k, v)| (k.clone(), v.as_str().map(str::to_owned)))
                    .collect()
            }
            "enableFileCheckpointing" => o.enable_file_checkpointing = v.as_bool().unwrap(),
            "toolConfig" => o.tool_config = Some(v.clone()),
            "systemPrompt" => o.system_prompt = Some(system_prompt(v)),
            "planModeInstructions" => o.plan_mode_instructions = Some(s(v)),
            "appendSubagentSystemPrompt" => o.append_subagent_system_prompt = Some(s(v)),
            "title" => o.title = Some(s(v)),
            "promptSuggestions" => o.prompt_suggestions = v.as_bool(),
            "agentProgressSummaries" => o.agent_progress_summaries = v.as_bool(),
            "forwardSubagentText" => o.forward_subagent_text = v.as_bool(),
            "perTaskStopAffordance" => o.per_task_stop_affordance = v.as_bool(),
            "$canUseTool" => o.can_use_tool = Some(Arc::new(AllowAll)),
            "$onElicitation" => o.on_elicitation = Some(Arc::new(Decline)),
            "$hooks" => {
                for (event, matchers) in v.as_object().unwrap() {
                    let list = matchers
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|m| HookMatcher {
                            matcher: m["matcher"].as_str().map(str::to_owned),
                            hooks: (0..m["count"].as_u64().unwrap_or(1))
                                .map(|_| hook_fn(|_, _| async { json!({"continue": true}) }))
                                .collect(),
                            timeout: m["timeout"].as_u64(),
                        })
                        .collect();
                    o.hooks.insert(event.clone(), list);
                }
            }
            "$sdkMcpServers" => {
                for (name, def) in v.as_object().unwrap() {
                    let tools = def["tools"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|t| {
                            let params = t["params"].as_object().cloned().unwrap_or_default();
                            // What zod emits for `{arg: z.string().describe(…)}`.
                            let schema = json!({
                                "$schema": "http://json-schema.org/draft-07/schema#",
                                "type": "object",
                                "properties": params.iter().map(|(k, p)| (k.clone(), json!({
                                    "type": "string", "description": p["description"],
                                }))).collect::<serde_json::Map<_, _>>(),
                                "required": params.keys().collect::<Vec<_>>(),
                            });
                            ToolDef::new(
                                t["name"].as_str().unwrap(),
                                t["description"].as_str().unwrap(),
                                schema,
                                |_| async { ToolOutput::text("ok") },
                            )
                        })
                        .collect();
                    let mut server = ToolServer::new(name.clone(), s(&def["version"]), tools);
                    if let Some(t) = def["timeout"].as_u64() {
                        server = server.with_timeout(t);
                    }
                    o.mcp_servers
                        .insert(name.clone(), McpServerConfig::Sdk(Arc::new(server)));
                }
            }
            other => panic!("golden spec key `{other}` has no Rust mapping; add one here"),
        }
    }
    o
}

/// The same normalization golden-wire.mjs applies.
fn norm(v: Value, tmp: &str) -> Value {
    match v {
        Value::String(s) => Value::String(s.replace(tmp, "$TMP")),
        Value::Array(a) => Value::Array(a.into_iter().map(|x| norm(x, tmp)).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, x)| (k, norm(x, tmp))).collect()),
        other => other,
    }
}

fn normalize_stdin(log: &str) -> Vec<Value> {
    let mut ids: HashMap<String, String> = HashMap::new();
    log.lines()
        .filter(|l| !l.is_empty())
        .map(|l| {
            let mut m: Value = serde_json::from_str(l).unwrap();
            if let Some(id) = m["request_id"].as_str().map(str::to_owned) {
                let n = ids.len();
                let alias = ids.entry(id).or_insert_with(|| format!("$ID{n}")).clone();
                m["request_id"] = json!(alias);
            } else if m["type"] == "control_response" && m["response"]["request_id"].is_string() {
                m["response"]["request_id"] = json!("$CLI_ID");
            }
            m
        })
        .collect()
}

/// What the Rust host sends for `spec`, in the fixture's shape.
async fn capture(spec: &Value, base_env: &Value, fake: &Path) -> Value {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let cwd = tmp_path.join("proj");
    std::fs::create_dir(&cwd).unwrap();
    let (argv_f, env_f, log_f) = (
        tmp_path.join("argv.json"),
        tmp_path.join("env.json"),
        tmp_path.join("stdin.log"),
    );
    let mut env: HashMap<String, String> = base_env
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
        .collect();
    for (k, p) in [
        ("FAKE_CLAUDE_ARGV", &argv_f),
        ("FAKE_CLAUDE_ENV", &env_f),
        ("FAKE_CLAUDE_LOG", &log_f),
    ] {
        env.insert(k.into(), p.display().to_string());
    }
    let mut opts = options_from_spec(spec);
    opts.path_to_claude_code_executable = Some(fake.to_owned());
    opts.cwd = Some(cwd);
    opts.env = Some(env);

    let mut q = Query::spawn(opts).await.expect("spawn");
    q.handle()
        .send_user_message(&json!({
            "type": "user", "message": {"role": "user", "content": "hello"},
            "parent_tool_use_id": null, "session_id": "",
        }))
        .await
        .unwrap();
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(10), q.next())
            .await
            .expect("timed out waiting for the result")
            .expect("stream ended early")
            .expect("stream error");
        if msg["type"] == "result" {
            break;
        }
    }
    q.handle().close().await;

    let argv: Value = serde_json::from_str(&std::fs::read_to_string(&argv_f).unwrap()).unwrap();
    let mut env: BTreeMap<String, Value> =
        serde_json::from_str(&std::fs::read_to_string(&env_f).unwrap()).unwrap();
    env.retain(|k, _| !k.starts_with("FAKE_CLAUDE_") && !k.starts_with("__CF"));
    let stdin = normalize_stdin(&std::fs::read_to_string(&log_f).unwrap());
    let initialize = stdin
        .iter()
        .find(|m| m["type"] == "control_request" && m["request"]["subtype"] == "initialize")
        .map(|m| m["request"].clone())
        .unwrap_or(Value::Null);
    norm(
        json!({"argv": argv, "env": env, "initialize": initialize, "stdin": stdin}),
        &tmp_path.display().to_string(),
    )
}

/// Every leaf-level difference as `path: expected …, got …`.
fn diff(path: &str, want: &Value, got: &Value, out: &mut Vec<(String, String)>) {
    match (want, got) {
        (Value::Object(a), Value::Object(b)) => {
            let keys: std::collections::BTreeSet<&String> = a.keys().chain(b.keys()).collect();
            for k in keys {
                let p = format!("{path}.{k}");
                match (a.get(k), b.get(k)) {
                    (Some(x), Some(y)) => diff(&p, x, y, out),
                    (Some(x), None) => out.push((p, format!("missing in Rust (TS: {x})"))),
                    (None, Some(y)) => out.push((p, format!("extra in Rust: {y}"))),
                    (None, None) => {}
                }
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                diff(&format!("{path}[{i}]"), x, y, out);
            }
        }
        _ if want == got => {}
        _ => out.push((path.to_owned(), format!("TS {want}\n      Rust {got}"))),
    }
}

#[tokio::test]
async fn rust_wire_matches_ts_sdk_golden_fixtures() {
    let fake = PathBuf::from(env!("CARGO_BIN_EXE_claudius-fake-claude"));
    let mut files: Vec<PathBuf> = std::fs::read_dir(fixtures_dir())
        .expect("fixtures dir (run `bun rust/scripts/golden-wire.mjs`)")
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    assert!(
        files.len() >= 4,
        "expected golden fixtures, found {files:?}"
    );

    let mut failures = vec![];
    let mut used = vec![false; ALLOWED.len()];
    for file in &files {
        let fixture: Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
        let case = fixture["case"].as_str().unwrap();
        assert_eq!(
            fixture["sdkVersion"],
            claudius_agent::options::MIRRORED_SDK_VERSION,
            "{case}: fixture recorded from a different SDK version; re-run golden-wire.mjs and port the changes"
        );
        let got = capture(&fixture["spec"], &fixture["baseEnv"], &fake).await;
        for field in ["argv", "env", "initialize", "stdin"] {
            let mut diffs = vec![];
            diff(field, &fixture[field], &got[field], &mut diffs);
            for (path, what) in diffs {
                match ALLOWED
                    .iter()
                    .position(|(c, prefix, _)| *c == case && path.starts_with(prefix))
                {
                    Some(i) => used[i] = true,
                    None => failures.push(format!("[{case}] {path}: {what}")),
                }
            }
        }
    }
    for (i, (case, prefix, todo)) in ALLOWED.iter().enumerate() {
        if !used[i] {
            failures.push(format!(
                "allowlist entry ({case}, {prefix}, {todo}) no longer differs; remove it"
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "Rust wire differs from the TS SDK golden fixtures:\n  {}",
        failures.join("\n  ")
    );
}

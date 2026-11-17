//! `Options` → CLI argv / env / initialize payload.
//!
//! This mirrors `ProcessTransport.initialize()` in
//! `@anthropic-ai/claude-agent-sdk/sdk.mjs` (v0.3.312) flag-for-flag and in
//! the same order, so a Rust-spawned `claude` sees exactly the argv the TS
//! SDK would have produced for the same options. When bumping the SDK, diff
//! the arg builder there against [`Options::to_args`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use crate::error::AgentError;
use crate::hooks::HookMatcher;
use crate::mcp::SdkMcpServer;
use crate::permission::{CanUseTool, OnElicitation};

/// SDK version whose wire behaviour this crate mirrors ([`crate::SDK_VERSION`]).
/// Exported to the CLI as `CLAUDE_AGENT_SDK_VERSION`, same as the TS SDK does
/// on import.
pub const MIRRORED_SDK_VERSION: &str = crate::SDK_VERSION;

#[derive(Clone, Debug)]
pub enum ThinkingConfig {
    Adaptive {
        display: Option<String>,
    },
    Enabled {
        budget_tokens: Option<u64>,
        display: Option<String>,
    },
    Disabled,
}

#[derive(Clone, Debug)]
pub enum SystemPrompt {
    /// Fully custom prompt (replaces Claude Code's).
    Custom {
        prompt: String,
        snapshot: Option<bool>,
    },
    /// Pre-split custom prompt parts.
    Parts(Vec<String>),
    /// Claude Code's own prompt, optionally with an append.
    Preset {
        append: Option<String>,
        exclude_dynamic_sections: Option<bool>,
        snapshot: Option<bool>,
    },
}

#[derive(Clone, Debug)]
pub enum Tools {
    List(Vec<String>),
    /// `--tools=default`
    Default,
}

#[derive(Clone, Debug)]
pub struct LocalPlugin {
    pub path: PathBuf,
    pub skip_mcp_discovery: bool,
}

/// MCP server entry. `External` servers go to `--mcp-config`; `Sdk` servers
/// are hosted in this process and reached via `mcp_message` control requests.
#[derive(Clone)]
pub enum McpServerConfig {
    External(Value),
    Sdk(Arc<dyn SdkMcpServer>),
}

impl std::fmt::Debug for McpServerConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            McpServerConfig::External(v) => f.debug_tuple("External").field(v).finish(),
            McpServerConfig::Sdk(_) => f.write_str("Sdk(..)"),
        }
    }
}

/// Options accepted by [`crate::Query::spawn`]. Field names follow the TS
/// `Options` type (camelCase there, snake_case here).
/// `stderr` callback: each chunk of the CLI's stderr as it arrives, decoded
/// as UTF-8 (a code point split across reads is held back for the next
/// chunk), like the SDK's `options.stderr`. Chunks aren't lines.
pub type StderrFn = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone, Default)]
pub struct Options {
    pub cwd: Option<PathBuf>,
    /// Path to the `claude` executable. Defaults to [`crate::binary::locate`].
    pub path_to_claude_code_executable: Option<PathBuf>,
    /// The interpreter for a JS/TS entry point (`executable`): a
    /// `path_to_claude_code_executable` ending in `.js`, `.mjs`, `.ts`,
    /// `.tsx` or `.jsx` runs as `<executable> <executable_args…> <path>`.
    /// Defaults to `node`.
    pub executable: Option<String>,
    /// `executableArgs`: put before the CLI arguments, for a native binary
    /// too, exactly like the SDK.
    pub executable_args: Vec<String>,
    /// Full environment for the child. `None` inherits this process's env
    /// (the TS default is `{ ...process.env }`; a provided env REPLACES it).
    pub env: Option<HashMap<String, String>>,

    pub model: Option<String>,
    pub fallback_model: Option<String>,
    pub agent: Option<String>,
    pub permission_mode: Option<String>,
    pub allow_dangerously_skip_permissions: bool,
    pub permission_prompt_tool_name: Option<String>,
    pub permission_prompts: Option<String>,
    pub effort: Option<String>,
    pub thinking: Option<ThinkingConfig>,
    /// JS numbers, printed the way the SDK's template literal prints them
    /// (`2.5`, `1e+21`). `--max-turns` only for a truthy value (not 0 / NaN).
    pub max_turns: Option<f64>,
    pub max_budget_usd: Option<f64>,
    /// `taskBudget.total`: printed whenever a `taskBudget` is set.
    pub task_budget_total: Option<f64>,
    pub betas: Vec<String>,
    pub json_schema: Option<Value>,
    pub debug: bool,
    pub debug_file: Option<PathBuf>,

    pub continue_conversation: bool,
    pub resume: Option<String>,
    pub session_id: Option<String>,
    pub resume_session_at: Option<String>,
    /// SDK 0.3.312 types this as a string (passed through verbatim).
    pub resume_drops_turn: Option<String>,
    pub fork_session: bool,
    /// `Some(false)` → `--no-session-persistence`.
    pub persist_session: Option<bool>,

    pub channels: Vec<String>,
    pub allowed_tools: Vec<String>,
    pub disallowed_tools: Vec<String>,
    pub tools: Option<Tools>,
    /// `None` = "all" (Skill unrestricted), `Some(list)` = `Skill(name)` rules.
    pub skills: Option<SkillsOption>,
    /// Insertion-ordered like the TS object: `--mcp-config` and
    /// `sdkMcpServers` list servers in the order they were added.
    pub mcp_servers: IndexMap<String, McpServerConfig>,
    pub strict_mcp_config: bool,
    pub setting_sources: Option<Vec<String>>,
    pub additional_directories: Vec<PathBuf>,
    pub project_config_root: Option<PathBuf>,
    pub plugins: Vec<LocalPlugin>,
    pub include_partial_messages: bool,
    pub include_hook_events: bool,
    pub session_mirror: bool,
    /// `verbatimPrompts`: every user message goes out with
    /// `client_composed: true`, so the CLI takes the text as written (no
    /// `@path` expansion, no slash-command dispatch, no turn-start
    /// attachments). Host-side only: it changes no argv, env or
    /// `initialize` field.
    pub verbatim_prompts: bool,
    /// JSON string (or path) handed to `--settings`.
    pub settings: Option<String>,
    pub managed_settings: Option<String>,
    /// Sandbox settings, folded into `--settings` by [`crate::sandbox::merge_into_args`] (the SDK's `CZ()`).
    pub sandbox: Option<Value>,
    /// Raw `--flag value` pairs; `None` value → bare `--flag`.
    /// Insertion-ordered (emitted in order, `settings` last unless already present).
    pub extra_args: IndexMap<String, Option<String>>,
    /// `enableFileCheckpointing` → `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true`.
    pub enable_file_checkpointing: bool,
    /// `toolConfig` (e.g. `{askUserQuestion:{previewFormat:"html"}}`) — the
    /// SDK translates it to `CLAUDE_CODE_QUESTION_*` env vars.
    pub tool_config: Option<Value>,

    // ---- initialize-request config (sent over the control channel) ----
    pub system_prompt: Option<SystemPrompt>,
    pub plan_mode_instructions: Option<String>,
    pub append_subagent_system_prompt: Option<String>,
    pub agents: Option<Value>,
    pub title: Option<String>,
    pub prompt_suggestions: Option<bool>,
    pub agent_progress_summaries: Option<bool>,
    pub forward_subagent_text: Option<bool>,
    pub per_task_stop_affordance: Option<bool>,
    /// Any other initialize fields, merged verbatim after the modelled ones
    /// (forward-compat escape hatch). SDK 0.3.312 initialize fields Claudius
    /// never sets, so they aren't typed here: `toolAliases`,
    /// `codeRunningMcpTools`, `webSearchIsolationExemptMcpServers`,
    /// `supportedDialogKinds` (needs an `onUserDialog` callback),
    /// `rapidFollowupPreempt`, `forwardNestedSubagentToolCalls`,
    /// `workspaceTrust`, and `plugins` under `pluginDelivery: "initialize"`
    /// (the default delivery is argv).
    pub initialize_extra: Map<String, Value>,

    // ---- callbacks ----
    pub can_use_tool: Option<Arc<dyn CanUseTool>>,
    pub on_elicitation: Option<Arc<dyn OnElicitation>>,
    /// Insertion-ordered: callback ids (`hook_<n>`) are assigned in this
    /// order, exactly like the TS SDK walking the `hooks` object.
    pub hooks: IndexMap<String, Vec<HookMatcher>>,
    pub stderr: Option<StderrFn>,
}

#[derive(Clone, Debug)]
pub enum SkillsOption {
    All,
    Named(Vec<String>),
}

impl std::fmt::Debug for Options {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Options")
            .field("cwd", &self.cwd)
            .field("model", &self.model)
            .field("permission_mode", &self.permission_mode)
            .field("resume", &self.resume)
            .field("session_id", &self.session_id)
            .finish_non_exhaustive()
    }
}

fn eq(flag: &str, value: impl std::fmt::Display) -> String {
    format!("{flag}={value}")
}

/// A JS number in a template literal (`${n}`).
fn js_number(n: f64) -> String {
    if n.is_nan() {
        "NaN".into()
    } else if n.is_infinite() {
        if n > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else {
        crate::js::number_to_string(n)
    }
}

/// The SDK tests its string options for truthiness (`if (model)`), so an
/// empty string is the same as none.
fn truthy(s: &Option<String>) -> Option<&String> {
    s.as_ref().filter(|s| !s.is_empty())
}

/// `T_()` — `[flag, value]`, except values that look like flags are glued
/// with `=` so the CLI's parser can't mistake them for a new option.
fn flag_value(flag: &str, value: &str) -> Vec<String> {
    if value.len() > 1 && value.starts_with('-') {
        vec![eq(flag, value)]
    } else {
        vec![flag.to_string(), value.to_string()]
    }
}

/// `TVe()` — skill names go verbatim into `Skill(<name>)`; the TS SDK only
/// validates them (non-empty), it does not escape.
fn validate_skill(name: &str) -> Result<&str, AgentError> {
    if name.trim().is_empty() {
        return Err(AgentError::InvalidOptions(
            "Skill names must be non-empty strings.".into(),
        ));
    }
    Ok(name)
}

impl Options {
    /// SDK-hosted MCP servers (split out of `mcp_servers`).
    pub fn sdk_mcp_servers(&self) -> IndexMap<String, Arc<dyn SdkMcpServer>> {
        self.mcp_servers
            .iter()
            .filter_map(|(k, v)| match v {
                McpServerConfig::Sdk(s) => Some((k.clone(), s.clone())),
                McpServerConfig::External(_) => None,
            })
            .collect()
    }

    fn external_mcp_servers(&self) -> Map<String, Value> {
        self.mcp_servers
            .iter()
            .filter_map(|(k, v)| match v {
                McpServerConfig::External(cfg) => Some((k.clone(), cfg.clone())),
                McpServerConfig::Sdk(_) => None,
            })
            .collect()
    }

    /// Build the CLI argv (without the executable).
    pub fn to_args(&self) -> Result<Vec<String>, AgentError> {
        let mut allowed = self.allowed_tools.clone();
        if let Some(skills) = &self.skills {
            let extra: Vec<String> = match skills {
                SkillsOption::All => vec!["Skill".into()],
                SkillsOption::Named(names) => names
                    .iter()
                    .map(|n| validate_skill(n).map(|n| format!("Skill({n})")))
                    .collect::<Result<_, _>>()?,
            };
            for e in extra {
                if !allowed.contains(&e) {
                    allowed.push(e);
                }
            }
        }

        let mut g: Vec<String> = [
            "--output-format",
            "stream-json",
            "--verbose",
            "--input-format",
            "stream-json",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();

        if let Some(t) = &self.thinking {
            match t {
                ThinkingConfig::Enabled {
                    budget_tokens: None,
                    ..
                } => g.push("--thinking=adaptive".into()),
                ThinkingConfig::Enabled {
                    budget_tokens: Some(n),
                    ..
                } => g.push(eq("--max-thinking-tokens", n)),
                ThinkingConfig::Disabled => g.push("--thinking=disabled".into()),
                ThinkingConfig::Adaptive { .. } => g.push("--thinking=adaptive".into()),
            }
            let display = match t {
                ThinkingConfig::Enabled { display, .. } | ThinkingConfig::Adaptive { display } => {
                    display.as_ref()
                }
                ThinkingConfig::Disabled => None,
            };
            if let Some(d) = display.filter(|d| !d.is_empty()) {
                g.push(eq("--thinking-display", d));
            }
        }
        if let Some(e) = truthy(&self.effort) {
            g.push(eq("--effort", e));
        }
        if let Some(n) = self.max_turns.filter(|n| *n != 0.0 && !n.is_nan()) {
            g.push(eq("--max-turns", js_number(n)));
        }
        if let Some(b) = self.max_budget_usd {
            g.push(eq("--max-budget-usd", js_number(b)));
        }
        if let Some(t) = self.task_budget_total {
            g.push(eq("--task-budget", js_number(t)));
        }
        let model = truthy(&self.model);
        if let Some(m) = model {
            g.push(eq("--model", m));
        }
        if let Some(a) = truthy(&self.agent) {
            g.push(eq("--agent", a));
        }
        if !self.betas.is_empty() {
            g.push(eq("--betas", self.betas.join(",")));
        }
        if let Some(s) = &self.json_schema {
            g.push(eq("--json-schema", crate::js::stringify(s)));
        }
        if let Some(f) = self
            .debug_file
            .as_ref()
            .filter(|f| !f.as_os_str().is_empty())
        {
            g.push(eq("--debug-file", f.display()));
        } else if self.debug {
            g.push("--debug".into());
        }
        let prompt_tool = truthy(&self.permission_prompt_tool_name);
        if self.can_use_tool.is_some() {
            if prompt_tool.is_some() {
                return Err(AgentError::InvalidOptions(
                    "canUseTool callback cannot be used with permissionPromptToolName. Please use one or the other."
                        .into(),
                ));
            }
            g.push("--permission-prompt-tool=stdio".into());
        } else if let Some(name) = prompt_tool {
            g.push(eq("--permission-prompt-tool", name));
        }
        if let Some(p) = truthy(&self.permission_prompts) {
            g.push(eq("--permission-prompts", p));
        }
        if self.continue_conversation {
            g.push("--continue".into());
        }
        if let Some(r) = truthy(&self.resume) {
            g.push(eq("--resume", r));
        }
        for c in &self.channels {
            g.push(eq("--channels", c));
        }
        if !allowed.is_empty() {
            g.push(eq("--allowedTools", allowed.join(",")));
        }
        if !self.disallowed_tools.is_empty() {
            g.push(eq("--disallowedTools", self.disallowed_tools.join(",")));
        }
        match &self.tools {
            Some(Tools::List(list)) => g.push(eq("--tools", list.join(","))),
            Some(Tools::Default) => g.push("--tools=default".into()),
            None => {}
        }
        let external = self.external_mcp_servers();
        if !external.is_empty() {
            let cfg = crate::js::stringify(&json!({ "mcpServers": external }));
            g.extend(flag_value("--mcp-config", &cfg));
        }
        if let Some(src) = &self.setting_sources {
            g.push(eq("--setting-sources", src.join(",")));
        }
        if self.strict_mcp_config {
            g.push("--strict-mcp-config".into());
        }
        if let Some(m) = truthy(&self.permission_mode) {
            g.push(eq("--permission-mode", m));
        }
        if self.allow_dangerously_skip_permissions {
            g.push("--allow-dangerously-skip-permissions".into());
        }
        if let Some(fb) = truthy(&self.fallback_model) {
            if model == Some(fb) {
                return Err(AgentError::InvalidOptions(
                    "Fallback model cannot be the same as the main model. Please specify a different model for fallbackModel option."
                        .into(),
                ));
            }
            g.push(eq("--fallback-model", fb));
        }
        if self.include_hook_events {
            g.push("--include-hook-events".into());
        }
        if self.include_partial_messages {
            g.push("--include-partial-messages".into());
        }
        if self.session_mirror {
            g.push("--session-mirror".into());
        }
        if let Some(root) = &self.project_config_root {
            g.push(eq("--project-config-root", root.display()));
        }
        for d in &self.additional_directories {
            g.push(eq("--add-dir", d.display()));
        }
        for p in &self.plugins {
            if p.skip_mcp_discovery {
                g.push(eq("--plugin-dir-no-mcp", p.path.display()));
            } else {
                g.push(eq("--plugin-dir", p.path.display()));
            }
        }
        if self.fork_session {
            g.push("--fork-session".into());
        }
        if let Some(at) = truthy(&self.resume_session_at) {
            g.push(eq("--resume-session-at", at));
        }
        if let Some(d) = &self.resume_drops_turn {
            g.push(eq("--resume-drops-turn", d));
        }
        if let Some(id) = truthy(&self.session_id) {
            g.push(eq("--session-id", id));
        }
        if self.persist_session == Some(false) {
            g.push("--no-session-persistence".into());
        }
        if let Some(ms) = truthy(&self.managed_settings) {
            g.extend(flag_value("--managed-settings", ms));
        }

        // `vt = {...extraArgs}; if (settings) vt.settings = settings;
        // CZ(vt, sandbox)`: an extraArgs `settings` keeps its position.
        let mut extra = self.extra_args.clone();
        if let Some(settings) = self.settings.as_ref().filter(|s| !s.is_empty()) {
            extra.insert("settings".into(), Some(settings.clone()));
        }
        if let Some(sandbox) = &self.sandbox {
            crate::sandbox::merge_into_args(&mut extra, sandbox)?;
        }
        for (k, v) in extra {
            match v {
                None => g.push(format!("--{k}")),
                Some(v) => g.extend(flag_value(&format!("--{k}"), &v)),
            }
        }
        Ok(g)
    }

    /// Child environment. Mirrors the TS transport: inherit (or use the
    /// provided env verbatim), tag the entrypoint, drop `NODE_OPTIONS`, and
    /// only pass `DEBUG` through when `DEBUG_CLAUDE_AGENT_SDK` is set.
    pub fn to_env(&self) -> HashMap<String, String> {
        self.env_over(|| std::env::vars().collect())
    }

    /// [`Self::to_env`] with `inherited` standing in for the process env.
    fn env_over(
        &self,
        inherited: impl FnOnce() -> HashMap<String, String>,
    ) -> HashMap<String, String> {
        // --- query() (sdk.mjs) ---
        let custom_env = self.env.is_some();
        let mut env: HashMap<String, String> = self.env.clone().unwrap_or_else(inherited);
        let missing =
            |env: &HashMap<String, String>, k: &str| env.get(k).is_none_or(|v| v.is_empty());
        if missing(&env, "CLAUDE_CODE_ENTRYPOINT") {
            env.insert("CLAUDE_CODE_ENTRYPOINT".into(), "sdk-ts".into());
        }
        // `query()` writes its version into the host's own `process.env`
        // before copying it, so an inherited env always carries this SDK's
        // version; a custom `env` keeps a non-empty one.
        if !custom_env || missing(&env, "CLAUDE_AGENT_SDK_VERSION") {
            env.insert(
                "CLAUDE_AGENT_SDK_VERSION".into(),
                MIRRORED_SDK_VERSION.into(),
            );
        }
        if self.enable_file_checkpointing {
            env.insert(
                "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING".into(),
                "true".into(),
            );
        }
        if !env
            .keys()
            .any(|k| k.eq_ignore_ascii_case("CLAUDE_CODE_SDK_READS_SESSION_STATE"))
        {
            env.insert("CLAUDE_CODE_SDK_READS_SESSION_STATE".into(), "1".into());
        }
        let ask = self
            .tool_config
            .as_ref()
            .and_then(|t| t.get("askUserQuestion"));
        if let Some(fmt) = ask
            .and_then(|a| a.get("previewFormat"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            env.insert("CLAUDE_CODE_QUESTION_PREVIEW_FORMAT".into(), fmt.into());
        }
        let truthy = |v: Option<&Value>| match v {
            None | Some(Value::Null) | Some(Value::Bool(false)) => false,
            Some(Value::String(s)) => !s.is_empty(),
            Some(Value::Number(n)) => n.as_f64() != Some(0.0),
            _ => true,
        };
        for (on, key) in [
            (
                truthy(ask.and_then(|a| a.get("extendedQuestions"))),
                "CLAUDE_CODE_QUESTION_EXTENDED",
            ),
            (
                truthy(ask.and_then(|a| a.get("optionalDescriptions"))),
                "CLAUDE_CODE_QUESTION_OPTIONAL_DESCRIPTIONS",
            ),
            (false, "CLAUDE_CODE_AGENT_PROGRESS_SUMMARIES"),
        ] {
            if on {
                env.insert(key.into(), "1".into());
            } else if !custom_env {
                env.retain(|k, _| !k.eq_ignore_ascii_case(key));
            }
        }
        // --- ProcessTransport ---
        env.remove("NODE_OPTIONS");
        let debug_sdk = env
            .get("DEBUG_CLAUDE_AGENT_SDK")
            .map(|v| !v.is_empty() && v != "0" && v.to_lowercase() != "false")
            .unwrap_or(false);
        if debug_sdk {
            env.insert("DEBUG".into(), "1".into());
        } else {
            env.remove("DEBUG");
        }
        env
    }

    /// The `initialize` control request body (`buildInitializeRequest`).
    /// `hooks` carries the callback ids the query assigned; `manifests` is
    /// the result of [`crate::mcp::capture_manifests`].
    pub(crate) fn initialize_request(
        &self,
        hooks: Option<Value>,
        manifests: Option<Map<String, Value>>,
    ) -> Value {
        let mut req = Map::new();
        req.insert("subtype".into(), "initialize".into());
        if let Some(h) = hooks {
            req.insert("hooks".into(), h);
        }
        let sdk = self.sdk_mcp_servers();
        if !sdk.is_empty() {
            let names: Vec<&String> = sdk.keys().collect();
            req.insert("sdkMcpServers".into(), json!(names));
        }
        // `{name: settings}` for servers with non-empty settings only.
        let configs: Map<String, Value> = sdk
            .iter()
            .filter_map(|(name, server)| {
                let s = server.settings().to_json();
                (!s.is_empty()).then(|| (name.clone(), Value::Object(s)))
            })
            .collect();
        if !configs.is_empty() {
            req.insert("sdkMcpServerConfigs".into(), Value::Object(configs));
        }
        if let Some(m) = manifests {
            req.insert("sdkMcpServerManifests".into(), Value::Object(m));
        }
        if let Some(s) = &self.json_schema {
            req.insert("jsonSchema".into(), s.clone());
        }
        // `query()` maps an unset systemPrompt to "" (an EMPTY custom prompt),
        // not to the Claude Code preset. Keep that exact behaviour.
        let (system_prompt, append, exclude, snapshot): (
            Option<Value>,
            Option<&String>,
            Option<bool>,
            Option<bool>,
        ) = match &self.system_prompt {
            None => (Some(json!([""])), None, None, None),
            Some(SystemPrompt::Custom { prompt, snapshot }) => {
                (Some(json!([prompt])), None, None, *snapshot)
            }
            Some(SystemPrompt::Parts(parts)) => (Some(json!(parts)), None, None, None),
            Some(SystemPrompt::Preset {
                append,
                exclude_dynamic_sections,
                snapshot,
            }) => (None, append.as_ref(), *exclude_dynamic_sections, *snapshot),
        };
        if let Some(sp) = system_prompt {
            req.insert("systemPrompt".into(), sp);
        }
        if let Some(a) = append {
            req.insert("appendSystemPrompt".into(), json!(a));
        }
        if let Some(p) = &self.plan_mode_instructions {
            req.insert("planModeInstructions".into(), json!(p));
        }
        if let Some(s) = snapshot {
            req.insert("systemPromptSnapshot".into(), json!(s));
        }
        if let Some(a) = &self.append_subagent_system_prompt {
            req.insert("appendSubagentSystemPrompt".into(), json!(a));
        }
        if let Some(e) = exclude {
            req.insert("excludeDynamicSections".into(), json!(e));
        }
        if let Some(a) = &self.agents {
            req.insert("agents".into(), a.clone());
        }
        if let Some(t) = &self.title {
            req.insert("title".into(), json!(t));
        }
        if let Some(SkillsOption::Named(names)) = &self.skills {
            req.insert("skills".into(), json!(names));
        }
        for (key, val) in [
            ("promptSuggestions", self.prompt_suggestions),
            ("agentProgressSummaries", self.agent_progress_summaries),
            ("forwardSubagentText", self.forward_subagent_text),
            ("perTaskStopAffordance", self.per_task_stop_affordance),
        ] {
            if let Some(v) = val {
                req.insert(key.into(), json!(v));
            }
        }
        for (k, v) in &self.initialize_extra {
            req.insert(k.clone(), v.clone());
        }
        Value::Object(req)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `query()` sets `process.env.CLAUDE_AGENT_SDK_VERSION` before copying
    /// the process env, so a parent's value never reaches the CLI; a custom
    /// `env` keeps its own non-empty value.
    #[test]
    fn sdk_version_env_overrides_inherited_value() {
        let parent =
            || HashMap::from([("CLAUDE_AGENT_SDK_VERSION".to_owned(), "9.9.9".to_owned())]);
        let version = |o: &Options| o.env_over(parent)["CLAUDE_AGENT_SDK_VERSION"].clone();
        assert_eq!(version(&Options::default()), crate::SDK_VERSION);
        let custom = |v: &str| Options {
            env: Some(HashMap::from([(
                "CLAUDE_AGENT_SDK_VERSION".to_owned(),
                v.to_owned(),
            )])),
            ..Options::default()
        };
        assert_eq!(version(&custom("1.2.3")), "1.2.3");
        assert_eq!(version(&custom("")), crate::SDK_VERSION);
        assert_eq!(
            version(&Options {
                env: Some(HashMap::new()),
                ..Options::default()
            }),
            crate::SDK_VERSION
        );
    }

    #[test]
    fn base_args_match_ts_sdk_prefix() {
        let o = Options::default();
        assert_eq!(
            o.to_args().unwrap(),
            vec![
                "--output-format",
                "stream-json",
                "--verbose",
                "--input-format",
                "stream-json"
            ]
        );
    }

    #[test]
    fn ordering_and_eq_style_flags() {
        let o = Options {
            model: Some("claude-opus-4-5".into()),
            permission_mode: Some("auto".into()),
            max_turns: Some(5.0),
            include_partial_messages: true,
            include_hook_events: true,
            session_id: Some("abc".into()),
            additional_directories: vec![PathBuf::from("/x")],
            ..Default::default()
        };
        let a = o.to_args().unwrap();
        let tail: Vec<&str> = a[5..].iter().map(String::as_str).collect();
        assert_eq!(
            tail,
            vec![
                "--max-turns=5",
                "--model=claude-opus-4-5",
                "--permission-mode=auto",
                "--include-hook-events",
                "--include-partial-messages",
                "--add-dir=/x",
                "--session-id=abc",
            ]
        );
    }

    #[test]
    fn mcp_config_excludes_sdk_servers() {
        struct Nop;
        #[async_trait::async_trait]
        impl SdkMcpServer for Nop {
            async fn handle(&self, _m: Value) -> Option<Value> {
                None
            }
        }
        let mut o = Options::default();
        o.mcp_servers.insert(
            "ext".into(),
            McpServerConfig::External(json!({"command": "x"})),
        );
        o.mcp_servers
            .insert("inproc".into(), McpServerConfig::Sdk(Arc::new(Nop)));
        let a = o.to_args().unwrap();
        let i = a.iter().position(|s| s == "--mcp-config").unwrap();
        assert_eq!(a[i + 1], r#"{"mcpServers":{"ext":{"command":"x"}}}"#);
        let init = o.initialize_request(None, None);
        assert_eq!(init["sdkMcpServers"], json!(["inproc"]));
    }

    #[test]
    fn unset_system_prompt_is_empty_custom_prompt() {
        let init = Options::default().initialize_request(None, None);
        assert_eq!(init["systemPrompt"], json!([""]));
        let preset = Options {
            system_prompt: Some(SystemPrompt::Preset {
                append: Some("extra".into()),
                exclude_dynamic_sections: None,
                snapshot: Some(false),
            }),
            ..Default::default()
        }
        .initialize_request(None, None);
        assert!(preset.get("systemPrompt").is_none());
        assert_eq!(preset["appendSystemPrompt"], json!("extra"));
        assert_eq!(preset["systemPromptSnapshot"], json!(false));
    }

    #[test]
    fn fallback_equal_to_model_is_rejected() {
        let o = Options {
            model: Some("m".into()),
            fallback_model: Some("m".into()),
            ..Default::default()
        };
        assert!(o.to_args().is_err());
    }

    /// The SDK's `if (model)`-style tests: an empty string option is no
    /// flag, and an empty model can't clash with an empty fallback.
    #[test]
    fn empty_string_options_are_skipped_like_the_sdk() {
        let s = |v: &str| Some(v.to_owned());
        let o = Options {
            model: s(""),
            fallback_model: s(""),
            agent: s(""),
            effort: s(""),
            permission_mode: s(""),
            permission_prompts: s(""),
            permission_prompt_tool_name: s(""),
            resume: s(""),
            resume_session_at: s(""),
            session_id: s(""),
            managed_settings: s(""),
            debug_file: Some(PathBuf::new()),
            thinking: Some(ThinkingConfig::Adaptive { display: s("") }),
            ..Default::default()
        };
        assert_eq!(o.to_args().unwrap()[5..], ["--thinking=adaptive"]);
        // `canUseTool` with an empty `permissionPromptToolName` is no clash.
        struct Allow;
        #[async_trait::async_trait]
        impl CanUseTool for Allow {
            async fn can_use_tool(
                &self,
                _: &str,
                _: Value,
                _: crate::permission::ToolPermissionContext,
            ) -> Option<crate::permission::PermissionResult> {
                None
            }
        }
        let o = Options {
            can_use_tool: Some(Arc::new(Allow)),
            permission_prompt_tool_name: s(""),
            ..Default::default()
        };
        assert_eq!(
            o.to_args().unwrap()[5..],
            ["--permission-prompt-tool=stdio"]
        );
        // An empty model doesn't make an equal fallback a clash either.
        let o = Options {
            model: s(""),
            fallback_model: s("m"),
            ..Default::default()
        };
        assert_eq!(o.to_args().unwrap()[5..], ["--fallback-model=m"]);
    }

    /// `${n}`: JS number text, and `--max-turns` only for a truthy count.
    #[test]
    fn numbers_print_like_js_template_literals() {
        let tail = |max_turns, budget, task| {
            Options {
                max_turns,
                max_budget_usd: budget,
                task_budget_total: task,
                ..Default::default()
            }
            .to_args()
            .unwrap()[5..]
                .to_vec()
        };
        assert_eq!(
            tail(Some(2.5), Some(1e21), Some(1.5)),
            [
                "--max-turns=2.5",
                "--max-budget-usd=1e+21",
                "--task-budget=1.5"
            ]
        );
        assert_eq!(
            tail(Some(1e10), Some(0.000001), Some(3.0)),
            [
                "--max-turns=10000000000",
                "--max-budget-usd=0.000001",
                "--task-budget=3"
            ]
        );
        assert_eq!(
            tail(Some(-1.0), Some(1e-7), Some(0.0)),
            ["--max-turns=-1", "--max-budget-usd=1e-7", "--task-budget=0"]
        );
        assert_eq!(
            tail(Some(0.0), Some(f64::INFINITY), Some(f64::NAN)),
            ["--max-budget-usd=Infinity", "--task-budget=NaN"]
        );
        assert_eq!(
            tail(Some(f64::NAN), Some(-0.0), None),
            ["--max-budget-usd=0"]
        );
    }

    /// `to_args` feeds `{...extraArgs, settings?}` through the SDK's `CZ()`
    /// (the merge rules themselves are covered by `tests/sandbox_merge.rs`).
    #[test]
    fn sandbox_merges_into_settings() {
        let tail = |o: Options| o.to_args().map(|a| a[5..].to_vec());
        // No sandbox: settings go out verbatim, not re-serialized.
        assert_eq!(
            tail(Options {
                settings: Some(r#"{"a": 1.0}"#.into()),
                ..Default::default()
            })
            .unwrap(),
            ["--settings", r#"{"a": 1.0}"#]
        );
        // Sandbox: merged, normalized like JSON.stringify, and an enabled
        // sandbox defaults to failIfUnavailable.
        assert_eq!(
            tail(Options {
                settings: Some(r#"{"includeCoAuthoredBy":false,"n":1.0}"#.into()),
                sandbox: Some(json!({"enabled": true})),
                ..Default::default()
            })
            .unwrap(),
            [
                "--settings",
                r#"{"includeCoAuthoredBy":false,"n":1,"sandbox":{"enabled":true,"failIfUnavailable":true}}"#
            ]
        );
        // `settings` overrides an extraArgs `settings` in place; an empty
        // string is falsy, so the extraArgs one is the merge base.
        let mut extra = IndexMap::new();
        extra.insert("foo".to_string(), Some("1".to_string()));
        extra.insert("settings".to_string(), Some(r#"{"x":1}"#.to_string()));
        extra.insert("bare".to_string(), None);
        for (settings, base) in [(Some(r#"{"y":2}"#), r#""y":2"#), (Some(""), r#""x":1"#)] {
            assert_eq!(
                tail(Options {
                    settings: settings.map(Into::into),
                    extra_args: extra.clone(),
                    sandbox: Some(json!({})),
                    ..Default::default()
                })
                .unwrap(),
                [
                    "--foo".to_string(),
                    "1".into(),
                    "--settings".into(),
                    format!(r#"{{{base},"sandbox":{{}}}}"#),
                    "--bare".into()
                ]
            );
        }
        // A settings file path can't take a sandbox.
        let err = tail(Options {
            settings: Some("/etc/claude/settings.json".into()),
            sandbox: Some(json!({"enabled": true})),
            ..Default::default()
        })
        .unwrap_err();
        assert!(
            err.to_string()
                .contains(crate::sandbox::SETTINGS_PATH_CONFLICT),
            "{err}"
        );
        // A falsy sandbox is ignored, like `if (!t) return`.
        assert_eq!(
            tail(Options {
                sandbox: Some(json!(false)),
                ..Default::default()
            })
            .unwrap(),
            Vec::<String>::new()
        );
    }
}

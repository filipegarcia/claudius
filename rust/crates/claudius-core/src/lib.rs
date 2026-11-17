//! Claudius domain core — the Rust port of `lib/server/` (Node-only code in
//! the TS app). No HTTP here: the server crate and, later, the native UI
//! both link this directly.

pub mod account_drift;
pub mod account_oauth;
pub mod account_pinning;
pub mod account_profile;
pub mod accounts;
pub mod active_cwd;
pub mod agents;
pub mod asset_ingest;
pub mod asset_list;
pub mod asset_store;
pub mod auto_memory;
pub mod auto_mode_disabled;
pub mod bash_mode;
pub mod claude_global_config;
pub mod claudemd;
pub mod collate;
pub mod commit_drafts;
pub mod commit_message;
pub mod community;
pub mod cost_aggregate;
pub mod cost_overview;
pub mod cost_pricing;
pub mod cron;
pub mod customization_auto_fix;
pub mod customization_bootstrap;
pub mod customization_build;
pub mod customization_description;
pub mod customization_manifest;
pub mod customization_publish;
pub mod customization_revert;
pub mod customization_sync;
pub mod customizations;
pub mod customizations_startup;
pub mod customize_runtime;
pub mod customize_settings;
pub mod dangerous_rm_deny;
pub mod db;
pub mod db_agents;
pub mod detectors;
pub mod docker;
pub mod doctor;
pub mod effort;
pub mod events;
pub mod exec_file;
pub mod extra_ca_certs;
pub mod extra_ca_env;
pub mod fast_mode;
pub mod feedback_refusal;
pub mod feedback_store;
pub mod feedback_survey;
pub mod fetch;
pub mod file_types;
pub mod files_preview;
pub mod fork;
pub mod fork_worktrees;
pub mod fs_list;
pub mod git;
pub mod git_stub;
pub mod hook_ask;
pub mod hooks;
pub mod image_size;
pub mod js_date;
pub mod js_string;
pub mod jsonl_lines;
pub mod jsonl_watch;
pub mod keybindings;
pub mod limits_store;
pub mod litellm_pricing;
pub mod log;
pub mod loop_keepalive;
pub mod loop_ticks_db;
pub mod managed_settings;
pub mod mcp_config;
pub mod mcp_delta;
pub mod mcp_notices;
pub mod model_pricing_override;
pub mod models;
pub mod node_err;
pub mod node_fs;
pub mod node_path;
pub mod notification_bus;
pub mod notifications_db;
pub mod open_tabs;
pub mod paths;
pub mod peer_source;
pub mod permission_symlink;
pub mod plugins;
pub mod pr_status;
pub mod preview_server;
pub mod process_group;
pub mod prompt_audit;
pub mod prompt_events;
pub mod queue_db;
pub mod read_paths;
pub mod reminders;
pub mod resumed_transcript;
pub mod reveal;
pub mod rules;
pub mod runtime_dir;
pub mod safe_path;
pub mod schedule_form;
pub mod schedule_skip;
pub mod scheduler;
pub mod scheduler_store;
pub mod sdk_cost_state;
pub mod session;
pub mod session_accounts;
pub mod session_consume;
pub mod session_file;
pub mod session_fork;
pub mod session_history;
pub mod session_loops;
pub mod session_manager;
pub mod session_notify;
pub mod session_recap;
pub mod session_search;
pub mod session_tasks_db;
pub mod session_titles;
pub mod sessions_all;
pub mod sessions_db;
pub mod sessions_list;
pub mod sessions_store;
pub mod settings;
pub mod settings_export;
pub mod settings_import;
pub mod settings_load_error;
pub mod shell;
pub mod skill_names;
pub mod skills;
pub mod slash_commands;
pub mod spinner_tips;
pub mod splash_examples;
pub mod splash_fallback_name;
pub mod sql_text;
pub mod tcc_protected;
pub mod telemetry_env;
pub mod text_encoding;
pub mod thinking_replay;
pub mod tls_cert_hint;
pub mod todos;
pub mod transcript;
pub mod trusted_cwd;
pub mod ultrathink_keyword;
pub mod updater;
pub mod usage_behaviors;
pub mod usage_seed;
pub mod user_prompt;
pub mod voice_stream;
pub mod voice_tls;
pub mod voice_ws;
pub mod workspace_files;
pub mod workspace_relocate;
pub mod workspace_roots;
pub mod workspaces;
pub mod worktrees;
pub mod yaml;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A JS `number` as JSON: integral values serialize as integers (`3`, not
/// `3.0`), matching `JSON.stringify`.
pub fn js_num(v: f64) -> serde_json::Value {
    if v.is_finite() && v.fract() == 0.0 && v.abs() < 9_007_199_254_740_992.0 {
        serde_json::Value::from(v as i64)
    } else if v.is_finite() {
        serde_json::Value::from(v)
    } else {
        serde_json::Value::Null
    }
}

/// `/^[\w-]+$/` — the session-id shape every route checks.
pub fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Canonical UUID shape check (any version), as the TS `UUID_RE`.
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

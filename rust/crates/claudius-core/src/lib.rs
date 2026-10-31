//! Claudius domain core — the Rust port of `lib/server/` (Node-only code in
//! the TS app). No HTTP here: the server crate and, later, the native UI
//! both link this directly.

pub mod account_drift;
pub mod account_oauth;
pub mod account_profile;
pub mod accounts;
pub mod active_cwd;
pub mod agents;
pub mod asset_ingest;
pub mod asset_list;
pub mod asset_store;
pub mod auto_memory;
pub mod bash_mode;
pub mod claude_global_config;
pub mod collate;
pub mod cost_pricing;
pub mod cron;
pub mod db;
pub mod db_agents;
pub mod detectors;
pub mod docker;
pub mod effort;
pub mod events;
pub mod exec_file;
pub mod feedback_survey;
pub mod fetch;
pub mod fork;
pub mod fs_list;
pub mod git;
pub mod image_size;
pub mod js_date;
pub mod js_string;
pub mod jsonl_lines;
pub mod jsonl_watch;
pub mod log;
pub mod loop_keepalive;
pub mod loop_ticks_db;
pub mod managed_settings;
pub mod mcp_config;
pub mod mcp_delta;
pub mod mcp_notices;
pub mod models;
pub mod node_err;
pub mod node_fs;
pub mod node_path;
pub mod notification_bus;
pub mod notifications_db;
pub mod open_tabs;
pub mod paths;
pub mod peer_source;
pub mod plugins;
pub mod queue_db;
pub mod read_paths;
pub mod reminders;
pub mod rules;
pub mod scheduler;
pub mod scheduler_store;
pub mod sdk_cost_state;
pub mod session;
pub mod session_consume;
pub mod session_loops;
pub mod session_manager;
pub mod session_recap;
pub mod session_search;
pub mod session_tasks_db;
pub mod session_titles;
pub mod sessions_db;
pub mod sessions_list;
pub mod sessions_store;
pub mod settings;
pub mod settings_load_error;
pub mod spinner_tips;
pub mod splash_examples;
pub mod splash_fallback_name;
pub mod tcc_protected;
pub mod thinking_replay;
pub mod todos;
pub mod transcript;
pub mod trusted_cwd;
pub mod usage_behaviors;
pub mod usage_seed;
pub mod user_prompt;
pub mod workspace_relocate;
pub mod workspaces;
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

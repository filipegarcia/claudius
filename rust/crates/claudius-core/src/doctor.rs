//! `GET /api/doctor` and `POST /api/doctor/fix` (D22): ports of
//! `app/api/doctor/route.ts` and `app/api/doctor/fix/route.ts`. The routes
//! are `claudius-server`'s `doctor.rs`.
//!
//! The report's checks come in the TS order, each built in the TS key order:
//! `node`, `agent-sdk` (`<process cwd>/node_modules/@anthropic-ai/
//! claude-agent-sdk/package.json`), `auth` (`ANTHROPIC_API_KEY`, `homedir()/
//! .claude/.credentials.json`, the `CLAUDE_CODE_USE_*` providers),
//! `claude-dir` and `projects-dir` (`access` F_OK then W_OK, fixable only
//! when missing), `git` (`git --version`, 1.5 s), `prompt-caching`
//! (`DISABLE_PROMPT_CACHING`), then per project workspace the CLAUDE.md
//! size checks, the prompt audits ([`crate::prompt_audit`]) and the ignored
//! telemetry / attachments env checks. Workspace entries are raw
//! workspaces.json values, read with JS property and `String()` semantics:
//! a `null` entry, a non-string `rootPath` or a CLAUDE.md that can't be read
//! makes the size check throw, which fails the whole report (Next's empty
//! 500), as in TS.
//!
//! Differences, all deliberate:
//! * Node.js: TS reports its own runtime (`process.versions.node`). The
//!   Rust server runs `node --version` (1.5 s, through `exec_file`) and
//!   reads the version off its output; without a `node` that answers, the
//!   check fails with `node not on PATH` and `runtime.node` is `""`.
//!   `runtime.platform` / `arch` are this binary's, in Node's names.
//! * `doctor/fix` with an `id` naming one of `Object.prototype`'s
//!   `toString` / `toLocaleString`: TS calls it as a fix and `mkdir`s
//!   `[object Object]` in its own cwd. Here it is refused like any other id
//!   that isn't a fix (400). The other prototype names answer what TS
//!   answers (Node's `ERR_INVALID_ARG_TYPE` 500, or the empty 500), and
//!   write nothing either way.

use std::collections::HashMap;

use indexmap::IndexSet;
use serde_json::{Map, Value, json};

use crate::claudemd;
use crate::exec_file::{self, ExecFileOptions};
use crate::prompt_audit::{self, Report, SourceKind};
use crate::rules::{self, RuleScope};
use crate::settings::{self, Scope};
use crate::telemetry_env;
use crate::{js_string, node_fs, node_path, paths, workspaces};
use claudius_agent::js;

/// What the TS reads off `process` and `os`.
#[derive(Clone, Debug, Default)]
pub struct Host {
    /// `os.homedir()`.
    pub home: String,
    /// `process.cwd()`.
    pub cwd: String,
    /// The `process.env` entries the report reads.
    pub env: HashMap<String, String>,
    /// `process.platform`.
    pub platform: String,
    /// `process.arch`.
    pub arch: String,
}

/// The env vars the report reads.
pub const ENV_KEYS: [&str; 5] = [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "DISABLE_PROMPT_CACHING",
];

impl Host {
    /// This process: `paths::home_dir()` (which `CLAUDIUS_STATE_HOME`
    /// moves), the cwd, the env, and the platform and arch in Node's names.
    pub fn current() -> Host {
        Host {
            home: paths::home_dir().to_string_lossy().into_owned(),
            cwd: std::env::current_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| "/".into()),
            env: ENV_KEYS
                .iter()
                .filter_map(|k| Some((k.to_string(), std::env::var(k).ok()?)))
                .collect(),
            platform: crate::tcc_protected::platform().into(),
            arch: node_arch(std::env::consts::ARCH).into(),
        }
    }

    fn env(&self, key: &str) -> Option<&str> {
        self.env.get(key).map(String::as_str)
    }

    /// `!!process.env[key]`.
    fn env_set(&self, key: &str) -> bool {
        self.env(key).is_some_and(|v| !v.is_empty())
    }
}

/// `process.arch` for a Rust target arch.
pub fn node_arch(arch: &str) -> &str {
    match arch {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        "x86" => "ia32",
        "powerpc64" => "ppc64",
        "loongarch64" => "loong64",
        "riscv64" => "riscv64",
        "s390x" => "s390x",
        "arm" => "arm",
        other => other,
    }
}

/// A throw out of the handler (Next's empty 500), by message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Thrown(pub String);

impl std::fmt::Display for Thrown {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

const NO_PRIMITIVE: &str = "TypeError: Cannot convert object to primitive value";

/// `` `${v}` `` for a property read (`None` is `undefined`).
fn template(v: Option<&Value>) -> Result<String, Thrown> {
    match v {
        None => Ok("undefined".into()),
        Some(v) => js_string::to_js_string(v).map_err(|_| Thrown(NO_PRIMITIVE.into())),
    }
}

/// `v.key` on a JSON value that isn't `null` (an object's own property;
/// a string, number, array or boolean has none of the keys read here).
fn prop<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_object()?.get(key)
}

/// `(ws.kind ?? "project") !== "project"`, which throws on a `null` entry.
fn is_project(ws: &Value) -> Result<bool, Thrown> {
    if ws.is_null() {
        return Err(Thrown(
            "TypeError: Cannot read properties of null (reading 'kind')".into(),
        ));
    }
    Ok(match prop(ws, "kind") {
        None | Some(Value::Null) => true,
        Some(k) => k.as_str() == Some("project"),
    })
}

fn check(id: String, label: &str, status: &str, detail: Value) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("id".into(), json!(id));
    m.insert("label".into(), json!(label));
    m.insert("status".into(), json!(status));
    m.insert("detail".into(), detail);
    m
}

fn link(href: String, label: &str) -> Value {
    json!({"href": href, "label": label})
}

// ─────────────────────────────── the probes ───────────────────────────────

const PROBE_TIMEOUT_MS: u64 = 1500;

/// `node --version`'s version (one trailing newline and a leading `v`
/// dropped), or `None` when it can't be run or fails.
async fn node_version() -> Option<String> {
    let opts = ExecFileOptions {
        timeout_ms: PROBE_TIMEOUT_MS,
        ..ExecFileOptions::default()
    };
    let out = exec_file::exec_file("node", &["--version"], opts)
        .await
        .ok()?;
    let s = out.stdout.strip_suffix('\n').unwrap_or(&out.stdout);
    Some(s.strip_prefix('v').unwrap_or(s).to_owned())
}

/// `gitVersion()`: `git --version`'s trimmed stdout, or `null`.
async fn git_version() -> Option<String> {
    let opts = ExecFileOptions {
        timeout_ms: PROBE_TIMEOUT_MS,
        ..ExecFileOptions::default()
    };
    let out = exec_file::exec_file("git", &["--version"], opts)
        .await
        .ok()?;
    Some(js::trim(&out.stdout).to_owned())
}

fn exists(path: &str) -> bool {
    node_fs::access(path, node_fs::F_OK).is_ok()
}

fn writable(path: &str) -> bool {
    node_fs::access(path, node_fs::W_OK).is_ok()
}

/// The `node` check and `runtime.node`.
fn node_check(version: Option<&str>) -> (Map<String, Value>, String) {
    let Some(v) = version else {
        return (
            check("node".into(), "Node.js", "fail", json!("node not on PATH")),
            String::new(),
        );
    };
    let major = js::to_number(v.split('.').next().unwrap_or("0"));
    let status = if major >= 20.0 {
        "ok"
    } else if major >= 18.0 {
        "warn"
    } else {
        "fail"
    };
    (
        check("node".into(), "Node.js", status, json!(format!("v{v}"))),
        v.to_owned(),
    )
}

/// The `agent-sdk` check and `sdk.version`.
fn sdk_check(cwd: &str) -> (Map<String, Value>, Value) {
    let path = node_path::join(&[
        cwd,
        "node_modules",
        "@anthropic-ai",
        "claude-agent-sdk",
        "package.json",
    ]);
    let parsed = node_fs::read_to_string(&path)
        .ok()
        .and_then(|text| js_string::parse(&text).ok())
        // `(null).version` throws into the catch.
        .filter(|v| !v.is_null());
    let label = "@anthropic-ai/claude-agent-sdk";
    let Some(pkg) = parsed else {
        return (
            check(
                "agent-sdk".into(),
                label,
                "fail",
                json!("package not found — npm install"),
            ),
            Value::Null,
        );
    };
    let version = prop(&pkg, "version").cloned().unwrap_or(Value::Null);
    let detail = match prop(&pkg, "claudeCodeVersion").filter(|c| js::truthy(c)) {
        Some(ccv) => {
            // `${x}` of a JSON value never throws here unless an object
            // carries its own `toString`, which JSON can spell: V8 throws
            // inside the `try` and reports the package missing.
            let (Ok(v), Ok(c)) = (
                js_string::to_js_string(&version),
                js_string::to_js_string(ccv),
            ) else {
                return (
                    check(
                        "agent-sdk".into(),
                        label,
                        "fail",
                        json!("package not found — npm install"),
                    ),
                    version,
                );
            };
            json!(format!("{v} (Claude Code {c})"))
        }
        None if version.is_null() => json!("(unknown)"),
        None => version.clone(),
    };
    (check("agent-sdk".into(), label, "ok", detail), version)
}

// ──────────────────────────── workspace checks ────────────────────────────

/// `listWorkspaces()`, or `[]` where it throws.
fn workspaces_or_empty() -> Vec<Value> {
    workspaces::list_raw().unwrap_or_default()
}

/// `.split("\n").length`, less one for a trailing newline.
fn line_count(content: &str) -> usize {
    let parts = content.split('\n').count();
    if content.ends_with('\n') {
        parts - 1
    } else {
        parts
    }
}

/// JS `Math.round` of a non-negative ratio.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

const CLAUDE_MD_TRIM_THRESHOLD_LINES: usize = 300;

fn claude_md_size_checks(home: &str) -> Result<Vec<Map<String, Value>>, Thrown> {
    let mut checks = Vec::new();
    for ws in workspaces_or_empty() {
        if !is_project(&ws)? {
            continue;
        }
        let root = prop(&ws, "rootPath").and_then(Value::as_str);
        let Some(root) = root else {
            // `assertWithin` refuses a base that isn't a string.
            return Err(Thrown("PathInjectionError: invalid base path".into()));
        };
        let root = js_string::lossy(root).into_owned();
        let hierarchy =
            claudemd::resolve_hierarchy(home, &root).map_err(|e| Thrown(e.to_string()))?;
        let mut contents: Vec<String> = Vec::new();
        let mut source_count = 0usize;
        for sc in hierarchy["scopes"].as_array().into_iter().flatten() {
            if sc["exists"] != Value::Bool(true) {
                continue;
            }
            source_count += 1;
            contents.extend(
                sc["segments"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|s| s["content"].as_str().map(str::to_owned)),
            );
        }
        for scope in [RuleScope::Project, RuleScope::User] {
            let Ok(files) = rules::list_rules(home, scope, Some(&root)) else {
                continue;
            };
            for rf in files {
                let c = rules::read_rule(home, scope, &rf.name, Some(&root))
                    .map_err(|e| Thrown(e.to_string()))?;
                if let Some(c) = c {
                    contents.push(c);
                    source_count += 1;
                }
            }
        }
        if contents.is_empty() {
            continue;
        }
        let total_lines: usize = contents.iter().map(|c| line_count(c)).sum();
        if total_lines <= CLAUDE_MD_TRIM_THRESHOLD_LINES {
            continue;
        }
        let total_bytes: usize = contents.iter().map(|c| js_string::lossy(c).len()).sum();
        let id = template(prop(&ws, "id"))?;
        let name = template(prop(&ws, "name"))?;
        let detail = format!(
            "{total_lines} lines (~{} KB) across {source_count} instruction file{} (CLAUDE.md scopes incl. @-imports and .claude/rules) — Claude can usually re-derive routine info (file layout, tech stack, build commands) from the codebase itself; consider trimming content it doesn't need spelled out, or moving procedures into a skill.",
            js::number_to_string(js_round(total_bytes as f64 / 1024.0)),
            if source_count > 1 { "s" } else { "" },
        );
        let mut c = check(
            format!("claude-md-size:{id}"),
            &format!("CLAUDE.md size — {name}"),
            "warn",
            json!(detail),
        );
        c.insert(
            "link".into(),
            link(format!("/{id}/memory"), "Review in Memory"),
        );
        checks.push(c);
    }
    Ok(checks)
}

/// `pickPromptAuditLink(...)`.
fn pick_prompt_audit_link(id: &str, r: &Report) -> Option<Value> {
    let kinds: Vec<SourceKind> = r
        .findings
        .iter()
        .map(|f| f.source.kind)
        .chain(r.stale_paths.iter().map(|(s, _)| s.kind))
        .chain(r.stale_commands.iter().map(|(s, _)| s.kind))
        .chain(
            r.contradictions
                .iter()
                .flat_map(|(_, s)| s.iter().map(|s| s.kind)),
        )
        .collect();
    let has = |k| kinds.contains(&k);
    if has(SourceKind::ClaudeMd) {
        Some(link(format!("/{id}/memory"), "Review in Memory"))
    } else if has(SourceKind::Skill) {
        Some(link(format!("/{id}/skills"), "Review in Skills"))
    } else if has(SourceKind::Agent) {
        Some(link(format!("/{id}/agents"), "Review in Agents"))
    } else {
        None
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn prompt_audit_checks(home: &str) -> Result<Vec<Map<String, Value>>, Thrown> {
    let mut checks = Vec::new();
    for ws in workspaces_or_empty() {
        if !is_project(&ws)? {
            continue;
        }
        let Some(root) = prop(&ws, "rootPath").and_then(Value::as_str) else {
            continue; // the audit throws on a non-string cwd
        };
        let Ok(report) = prompt_audit::audit_workspace_prompts(home, &js_string::lossy(root))
        else {
            continue;
        };
        if !report.had_sources {
            continue;
        }
        let id = template(prop(&ws, "id"))?;
        let name = template(prop(&ws, "name"))?;
        let label = format!("Prompt audit — {name}");
        let r = &report;
        if r.findings.is_empty()
            && r.stale_paths.is_empty()
            && r.stale_commands.is_empty()
            && r.contradictions.is_empty()
        {
            let mut c = check(
                format!("prompt-audit:{id}"),
                &label,
                "ok",
                json!(
                    "No broken references, contradicting instructions, or stale prompting patterns found."
                ),
            );
            c.insert("category".into(), json!("prompt-audit"));
            checks.push(c);
            continue;
        }
        let mut parts = Vec::new();
        if !r.stale_paths.is_empty() {
            parts.push(format!(
                "{} to a missing file",
                plural(r.stale_paths.len(), "path reference", "path references")
            ));
        }
        if !r.stale_commands.is_empty() {
            parts.push(format!(
                "{} to an unknown /command",
                plural(r.stale_commands.len(), "reference", "references")
            ));
        }
        if !r.contradictions.is_empty() {
            parts.push(plural(
                r.contradictions.len(),
                "contradicting instruction",
                "contradicting instructions",
            ));
        }
        if !r.findings.is_empty() {
            parts.push(plural(
                r.findings.len(),
                "stale prompting pattern",
                "stale prompting patterns",
            ));
        }
        let mut examples: Vec<String> = Vec::new();
        for (s, p) in r.stale_paths.iter().take(2) {
            examples.push(format!("{} — references missing `{p}`", s.id()));
        }
        for (s, c) in r.stale_commands.iter().take(2) {
            examples.push(format!("{} — unknown command `/{c}`", s.id()));
        }
        for (token, sources) in r.contradictions.iter().take(2) {
            let across: Vec<String> = sources.iter().map(|s| s.id()).collect();
            examples.push(format!(
                "`{token}` — contradicting directives across {}",
                across.join(" vs ")
            ));
        }
        for f in r.findings.iter().take(2) {
            examples.push(format!(
                "{} — {} (\"{}\")",
                f.source.id(),
                f.found.pattern.note(),
                f.found.snippet
            ));
        }
        let mut c = check(
            format!("prompt-audit:{id}"),
            &label,
            "warn",
            json!(format!("{}. {}", parts.join(" · "), examples.join("; "))),
        );
        if let Some(l) = pick_prompt_audit_link(&id, r) {
            c.insert("link".into(), l);
        }
        c.insert("category".into(), json!("prompt-audit"));
        checks.push(c);
    }
    Ok(checks)
}

/// JS `[...set].sort()`.
fn sorted(set: IndexSet<String>) -> Vec<String> {
    let mut v: Vec<String> = set.into_iter().collect();
    v.sort_by_cached_key(|a| js_string::units(a));
    v
}

fn ignored_project_env_checks() -> Result<Vec<Map<String, Value>>, Thrown> {
    let mut checks = Vec::new();
    for ws in workspaces_or_empty() {
        if !is_project(&ws)? {
            continue;
        }
        let mut ignored: IndexSet<String> = IndexSet::new();
        let mut attachments: IndexSet<String> = IndexSet::new();
        if let Some(root) = prop(&ws, "rootPath").and_then(Value::as_str) {
            let root = js_string::lossy(root);
            for scope in [Scope::Project, Scope::Local] {
                // A read that throws (or a `null` file, whose `.env` throws)
                // is skipped.
                if let Ok(Some(s)) = settings::read_settings_js(scope, &root) {
                    let env = s.get("env");
                    ignored.extend(telemetry_env::ignored_telemetry_env_keys(env));
                    attachments.extend(telemetry_env::ignored_attachments_env_keys(env));
                }
            }
        }
        if !ignored.is_empty() {
            let id = template(prop(&ws, "id"))?;
            let name = template(prop(&ws, "name"))?;
            let keys = sorted(ignored);
            let mut c = check(
                format!("telemetry-env:{id}"),
                &format!("Ignored telemetry env — {name}"),
                "warn",
                json!(format!(
                    "{} ({}) set in this workspace's project/local settings are IGNORED — Claude Code only honors telemetry export/content vars from user or managed settings. Move them to your user-scope env for them to take effect.",
                    plural(keys.len(), "telemetry env var", "telemetry env vars"),
                    keys.join(", ")
                )),
            );
            c.insert(
                "link".into(),
                link("/settings".into(), "Open Settings → Environment"),
            );
            checks.push(c);
        }
        if !attachments.is_empty() {
            let id = template(prop(&ws, "id"))?;
            let name = template(prop(&ws, "name"))?;
            let mut c = check(
                format!("attachments-env:{id}"),
                &format!("Ignored attachments env — {name}"),
                "warn",
                json!(format!(
                    "{} is set in this workspace's project/local settings, which Claude Code ignores since 2.1.290 — a repository's settings can no longer turn attachments off. Set it in your user-scope env (or your shell) for it to take effect.",
                    sorted(attachments).join(", ")
                )),
            );
            c.insert(
                "link".into(),
                link("/settings".into(), "Open Settings → Environment"),
            );
            checks.push(c);
        }
    }
    Ok(checks)
}

// ─────────────────────────────── GET ───────────────────────────────

/// `GET /api/doctor`'s body, or what the handler throws.
pub async fn report(host: &Host) -> Result<Value, Thrown> {
    let (node, git) = tokio::join!(node_version(), git_version());
    let host = host.clone();
    tokio::task::spawn_blocking(move || report_with(&host, node.as_deref(), git))
        .await
        .map_err(|e| Thrown(format!("Error: {e}")))?
}

fn report_with(host: &Host, node: Option<&str>, git: Option<String>) -> Result<Value, Thrown> {
    let mut checks: Vec<Map<String, Value>> = Vec::new();
    let (node_check, node) = node_check(node);
    checks.push(node_check);

    let (sdk, sdk_version) = sdk_check(&host.cwd);
    checks.push(sdk);

    let has_env = host.env_set("ANTHROPIC_API_KEY");
    let creds = node_path::join(&[&host.home, ".claude", ".credentials.json"]);
    let has_creds = exists(&creds);
    let provider = if host.env("CLAUDE_CODE_USE_BEDROCK") == Some("1") {
        "Bedrock"
    } else if host.env("CLAUDE_CODE_USE_VERTEX") == Some("1") {
        "Vertex"
    } else if host.env("CLAUDE_CODE_USE_FOUNDRY") == Some("1") {
        "Foundry"
    } else {
        "Anthropic"
    };
    let anthropic = provider == "Anthropic";
    checks.push(check(
        "auth".into(),
        "Auth",
        if has_env || has_creds || !anthropic {
            "ok"
        } else {
            "warn"
        },
        json!(if !anthropic {
            format!("Provider: {provider} (uses external credentials)")
        } else if has_env {
            "ANTHROPIC_API_KEY set".into()
        } else if has_creds {
            "OAuth credentials file present".into()
        } else {
            "No API key or OAuth credentials found".into()
        }),
    ));

    let claude_dir = node_path::join(&[&host.home, ".claude"]);
    let claude_ok = exists(&claude_dir) && writable(&claude_dir);
    let mut c = check(
        "claude-dir".into(),
        "~/.claude",
        if claude_ok { "ok" } else { "warn" },
        json!(claude_dir),
    );
    c.insert("fixable".into(), json!(!claude_ok && !exists(&claude_dir)));
    checks.push(c);

    let projects_dir = node_path::join(&[&host.home, ".claude", "projects"]);
    let projects_ok = exists(&projects_dir) && writable(&projects_dir);
    let mut c = check(
        "projects-dir".into(),
        "~/.claude/projects",
        if projects_ok { "ok" } else { "warn" },
        json!(if projects_ok {
            "writable"
        } else {
            "missing or read-only — sessions can't persist"
        }),
    );
    c.insert(
        "fixable".into(),
        json!(!projects_ok && !exists(&projects_dir)),
    );
    checks.push(c);

    // `git ? "ok" : "warn"`, but `git ?? "…"`: an empty answer warns with
    // an empty detail.
    checks.push(check(
        "git".into(),
        "git",
        if git.as_deref().is_some_and(|g| !g.is_empty()) {
            "ok"
        } else {
            "warn"
        },
        json!(git.unwrap_or_else(|| "git not on PATH — worktrees won't work".into())),
    ));

    if host.env_set("DISABLE_PROMPT_CACHING") {
        checks.push(check(
            "prompt-caching".into(),
            "Prompt caching",
            "warn",
            json!("DISABLE_PROMPT_CACHING is set — caching off increases token cost and latency"),
        ));
    }

    checks.extend(claude_md_size_checks(&host.home)?);
    checks.extend(prompt_audit_checks(&host.home)?);
    checks.extend(ignored_project_env_checks()?);

    Ok(json!({
        "runtime": {"node": node, "platform": host.platform, "arch": host.arch},
        "sdk": {"version": sdk_version},
        "checks": checks.into_iter().map(Value::Object).collect::<Vec<_>>(),
    }))
}

// ─────────────────────────────── POST fix ───────────────────────────────

/// What `POST /api/doctor/fix` answers: a status and JSON body, or Next's
/// empty 500 for a throw outside its `try`.
#[derive(Clone, Debug, PartialEq)]
pub enum FixAnswer {
    Json(u16, Value),
    Thrown(String),
}

/// `ERR_INVALID_ARG_TYPE` for a `path` argument, as `fs.mkdir` throws it.
fn invalid_path_arg(received: &str) -> String {
    format!(
        "The \"path\" argument must be of type string or an instance of Buffer or URL. Received {received}"
    )
}

/// `POST /api/doctor/fix` on a parsed body (`Err`: `req.json()` threw).
pub fn fix(home: &str, body: Result<Value, String>) -> FixAnswer {
    let Ok(body) = body else {
        return FixAnswer::Json(400, json!({"ok": false, "error": "Invalid JSON body"}));
    };
    let unknown = || {
        FixAnswer::Json(
            400,
            json!({"ok": false, "error": "Unknown or non-fixable check id"}),
        )
    };
    let Some(id) = prop(&body, "id").and_then(Value::as_str) else {
        return unknown();
    };
    let target = match id {
        "claude-dir" => node_path::join(&[home, ".claude"]),
        "projects-dir" => node_path::join(&[home, ".claude", "projects"]),
        // `id in FIXABLE_CHECKS` also finds Object.prototype's names, and
        // `FIXABLE_CHECKS[id]()` calls them: what each gives `fs.mkdir`.
        "constructor" | "valueOf" => {
            return mkdir_type_error(id, "an instance of Object");
        }
        "hasOwnProperty" | "isPrototypeOf" | "propertyIsEnumerable" => {
            return mkdir_type_error(id, "type boolean (false)");
        }
        "__lookupGetter__" | "__lookupSetter__" => return mkdir_type_error(id, "undefined"),
        "__defineGetter__" | "__defineSetter__" => {
            return FixAnswer::Thrown(format!(
                "TypeError: Object.prototype.{id}: Expecting function"
            ));
        }
        "__proto__" => {
            return FixAnswer::Thrown("TypeError: FIXABLE_CHECKS[id] is not a function".into());
        }
        // `toString` / `toLocaleString` give "[object Object]", a path in
        // the server's cwd: refused (see the module docs).
        _ => return unknown(),
    };
    match node_fs::mkdir_recursive(&target, 0o777) {
        Ok(()) => FixAnswer::Json(200, json!({"ok": true, "id": id, "path": target})),
        Err(e) => FixAnswer::Json(500, json!({"ok": false, "id": id, "error": e.message})),
    }
}

fn mkdir_type_error(id: &str, received: &str) -> FixAnswer {
    FixAnswer::Json(
        500,
        json!({"ok": false, "id": id, "error": invalid_path_arg(received)}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_versions() {
        let status = |v: &str| node_check(Some(v)).0["status"].as_str().unwrap().to_owned();
        assert_eq!(status("22.23.3"), "ok");
        assert_eq!(status("19.9.0"), "warn");
        assert_eq!(status("17.0.0"), "fail");
        assert_eq!(status("abc"), "fail");
        assert_eq!(status(" 20.1"), "ok");
        assert_eq!(status("0x14.0"), "ok");
        assert_eq!(node_check(None).0["detail"], "node not on PATH");
    }

    #[test]
    fn lines() {
        assert_eq!(line_count(""), 1);
        assert_eq!(line_count("a\n"), 1);
        assert_eq!(line_count("a\nb"), 2);
        assert_eq!(js_round(1.5), 2.0);
        assert_eq!(js_round(0.49), 0.0);
    }
}

//! Skills: `lib/server/skills.ts`. A skill is a folder holding a `SKILL.md`
//! (YAML front matter between `---` lines, parsed like an agent file by
//! [`agents::parse_frontmatter`], then a markdown body). User skills live in
//! `homedir()/.claude/skills/<name>/`, project skills in
//! `<cwd>/.claude/skills/<name>/`; the folder is the skill's identity.
//!
//! Every function takes `home` (`homedir()`; the server passes
//! [`crate::paths::home_dir`], which `CLAUDIUS_STATE_HOME` moves).
//!
//! As in TS: a folder name must pass [`skill_names::is_valid_skill_dir_name`]
//! to be listed, read, written or deleted, and a new folder must also pass
//! the engine's offerable-name rule ([`skill_names::is_engine_offerable_name`]),
//! while an existing one that fails it stays listed (`notOffered`), readable,
//! writable and deletable. The listing takes directory entries only (a
//! symlinked folder is skipped), reads `SKILL.md` through symlinks, skips a
//! folder whose `SKILL.md` can't be read, and sorts by `localeCompare`.
//! Reads and writes follow symlinks inside the scope's folder; a delete
//! removes a symlinked folder's link only. Each fs call checks inline that
//! its path stays under the scope's folder (which, after the name rule,
//! never fires).

use std::path::Path;

use serde_json::{Map, Value, json};

use crate::js_string::{self, NoPrimitive};
use crate::node_err::{self, NodeError};
use crate::{agents, collate, db_agents, fs_list, node_path, safe_path, skill_names, yaml};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkillScope {
    User,
    Project,
}

impl SkillScope {
    /// `SCOPES.includes(s)`.
    pub fn parse(s: &str) -> Option<SkillScope> {
        match s {
            "user" => Some(SkillScope::User),
            "project" => Some(SkillScope::Project),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            SkillScope::User => "user",
            SkillScope::Project => "project",
        }
    }
}

/// A thrown error: its `name` and `message` (also what `hooks`,
/// `keybindings` and `claudemd` throw).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Thrown {
    pub name: &'static str,
    pub message: String,
}

impl Thrown {
    pub(crate) fn error(message: impl Into<String>) -> Thrown {
        Thrown {
            name: "Error",
            message: message.into(),
        }
    }

    pub(crate) fn type_error(message: impl Into<String>) -> Thrown {
        Thrown {
            name: "TypeError",
            message: message.into(),
        }
    }

    pub(crate) fn path_injection(message: &str) -> Thrown {
        Thrown {
            name: "PathInjectionError",
            message: message.into(),
        }
    }
}

impl From<NodeError> for Thrown {
    fn from(e: NodeError) -> Thrown {
        Thrown::error(e.message)
    }
}

impl From<crate::settings::SettingsError> for Thrown {
    fn from(e: crate::settings::SettingsError) -> Thrown {
        Thrown {
            name: e.name(),
            message: e.to_string(),
        }
    }
}

impl std::fmt::Display for Thrown {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.name, self.message)
    }
}

/// A `SkillFile`.
#[derive(Clone, Debug)]
pub struct SkillFile {
    pub scope: SkillScope,
    /// The folder name.
    pub name: String,
    /// The `SKILL.md` path.
    pub path: String,
    pub frontmatter: yaml::Frontmatter,
    pub body: String,
    pub raw: String,
    /// The folder name fails the engine's offerable-name rule.
    pub not_offered: bool,
}

impl SkillFile {
    /// The object `NextResponse.json` serializes; `None` when
    /// `JSON.stringify` throws on it (a cyclic front matter).
    pub fn to_json(&self) -> Option<Value> {
        let mut m = Map::new();
        m.insert("scope".into(), json!(self.scope.as_str()));
        m.insert("name".into(), json!(self.name));
        m.insert("path".into(), json!(self.path));
        m.insert("frontmatter".into(), self.frontmatter.json.clone()?);
        m.insert("body".into(), json!(self.body));
        m.insert("raw".into(), json!(self.raw));
        m.insert("notOffered".into(), json!(self.not_offered));
        Some(Value::Object(m))
    }

    fn read(scope: SkillScope, name: &str, path: String, raw: String) -> SkillFile {
        let parsed = agents::parse_frontmatter(&raw);
        SkillFile {
            scope,
            name: name.to_owned(),
            path,
            frontmatter: parsed.frontmatter,
            body: parsed.body,
            raw,
            not_offered: !skill_names::is_engine_offerable_name(name),
        }
    }
}

/// `skillsDir(scope, projectCwd)`.
pub fn skills_dir(home: &str, scope: SkillScope, project_cwd: &str) -> String {
    match scope {
        SkillScope::User => node_path::join(&[home, ".claude", "skills"]),
        SkillScope::Project => node_path::join(&[project_cwd, ".claude", "skills"]),
    }
}

/// `skillPath(scope, projectCwd, name)`: the `SKILL.md` of a valid folder
/// name, through `assertWithin`.
pub fn skill_path(
    home: &str,
    scope: SkillScope,
    project_cwd: &str,
    name: &str,
) -> Result<String, Thrown> {
    if !skill_names::is_valid_skill_dir_name(name) {
        return Err(Thrown::error("invalid skill name"));
    }
    safe_path::assert_within(
        &skills_dir(home, scope, project_cwd),
        &node_path::join(&[name, "SKILL.md"]),
    )
    .map_err(Thrown::path_injection)
}

/// `path.resolve(skillsDir(scope, projectCwd))`: the base every fs call is
/// checked against.
fn resolved_base(home: &str, scope: SkillScope, project_cwd: &str) -> String {
    node_path::resolve(&[&skills_dir(home, scope, project_cwd)])
}

/// The containment check at an fs call: `target` is inside `base`.
fn inside(base: &str, target: &str) -> bool {
    target.starts_with(&format!("{base}/"))
}

/// Node's `ERR_INVALID_ARG_VALUE` for a path holding a NUL (`getValidatedPath`).
fn nul_path_error(path: &str) -> Thrown {
    Thrown::type_error(format!(
        "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received {}",
        crate::git::node_inspect_string(path)
    ))
}

/// `listSkills(scope, projectCwd)`: the scope's skill folders (none when
/// the folder is missing), sorted by `localeCompare` of their names. `Err`
/// is what `readdir` threw otherwise.
pub fn list_skills(
    home: &str,
    scope: SkillScope,
    project_cwd: &str,
) -> Result<Vec<SkillFile>, Thrown> {
    let dir = skills_dir(home, scope, project_cwd);
    if dir.contains('\0') {
        return Err(nul_path_error(&dir));
    }
    let base = node_path::resolve(&[&dir]);
    let entries = match fs_list::read_dir(&base) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(node_err::uv_exception(&e, "scandir", Some(Path::new(&dir)), None).into());
        }
    };
    let mut out = Vec::new();
    for entry in entries {
        if entry.kind != fs_list::DirentKind::Dir {
            continue;
        }
        let filename = entry.name;
        if !skill_names::is_valid_skill_dir_name(&filename) {
            continue; // dotfiles, odd names
        }
        let skill_file = node_path::join(&[&dir, &filename, "SKILL.md"]);
        let target = node_path::resolve(&[&base, &filename, "SKILL.md"]);
        if !inside(&base, &target) {
            continue;
        }
        let Ok(bytes) = node_err::fs::read_file(Path::new(&target)) else {
            continue; // no readable SKILL.md: not a skill
        };
        let raw = String::from_utf8_lossy(&bytes).into_owned();
        out.push(SkillFile::read(scope, &filename, skill_file, raw));
    }
    out.sort_by(|a, b| collate::locale_compare(&a.name, &b.name));
    Ok(out)
}

/// `readSkill(scope, projectCwd, name)`: `None` when `SKILL.md` is missing.
pub fn read_skill(
    home: &str,
    scope: SkillScope,
    project_cwd: &str,
    name: &str,
) -> Result<Option<SkillFile>, Thrown> {
    let p = skill_path(home, scope, project_cwd, name)?;
    let base = resolved_base(home, scope, project_cwd);
    if !inside(&base, &p) {
        return Err(Thrown::path_injection("path escapes base directory"));
    }
    match node_err::fs::read_file(Path::new(&p)) {
        Ok(bytes) => {
            let raw = String::from_utf8_lossy(&bytes).into_owned();
            Ok(Some(SkillFile::read(scope, name, p, raw)))
        }
        Err(e) if e.code == "ENOENT" => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// `String(v)` of a body value read by [`db_agents::json_parse`], whose
/// infinities are sentinel strings.
fn string_of(v: &Value) -> Result<String, NoPrimitive> {
    fn texts(v: &Value) -> Value {
        if let Some(f) = db_agents::infinity(v) {
            return json!(if f > 0.0 { "Infinity" } else { "-Infinity" });
        }
        match v {
            Value::Array(items) => Value::Array(items.iter().map(texts).collect()),
            v => v.clone(),
        }
    }
    js_string::to_js_string(&texts(v))
}

/// `path.join`'s `validateString(name, "path")` refusal of a non-string.
fn not_a_path_string(v: &Value) -> Thrown {
    let received = match (db_agents::infinity(v), v) {
        (Some(f), _) => format!(
            "type number ({})",
            if f > 0.0 { "Infinity" } else { "-Infinity" }
        ),
        (None, Value::Number(n)) => format!(
            "type number ({})",
            claudius_agent::js::number_to_string(n.as_f64().unwrap_or(f64::NAN))
        ),
        (None, Value::Bool(b)) => format!("type boolean ({b})"),
        (None, Value::Array(_)) => "an instance of Array".into(),
        (None, Value::Object(_)) => "an instance of Object".into(),
        (None, _) => "null".into(),
    };
    Thrown::type_error(format!(
        "The \"path\" argument must be of type string. Received {received}"
    ))
}

/// `writeSkill(scope, projectCwd, name, raw)`, `name` being whatever the
/// request body held. `Err` is the thrown error, whose `message` the route
/// answers 400 with.
pub fn write_skill(
    home: &str,
    scope: SkillScope,
    project_cwd: &str,
    name: &Value,
    raw: &str,
) -> Result<(), Thrown> {
    // `skillPath`: the regex test sees `String(name)`, `path.join` the value.
    let text = string_of(name)
        .map_err(|_| Thrown::type_error("Cannot convert object to primitive value"))?;
    if !skill_names::is_valid_skill_dir_name(&text) {
        return Err(Thrown::error("invalid skill name"));
    }
    let Some(name) = db_agents::as_str(name) else {
        return Err(not_a_path_string(name));
    };
    let p = skill_path(home, scope, project_cwd, name)?;
    let base = resolved_base(home, scope, project_cwd);
    if !skill_names::is_engine_offerable_name(name) {
        // Only a folder that already exists may keep a name the engine
        // won't offer.
        let skill_dir = node_path::resolve(&[&base, name]);
        if !inside(&base, &skill_dir) {
            return Err(Thrown::error("invalid skill name"));
        }
        match std::fs::metadata(&skill_dir) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let (shown, _) = skill_names::visualize_hidden_name_unicode(name);
                return Err(Thrown::error(format!(
                    "{shown} is not offered: {}",
                    skill_names::ENGINE_NAME_RULE_MESSAGE
                )));
            }
            Err(e) => {
                return Err(
                    node_err::uv_exception(&e, "stat", Some(Path::new(&skill_dir)), None).into(),
                );
            }
        }
    }
    let folder = node_path::dirname(&p);
    if !inside(&base, &folder) {
        return Err(Thrown::path_injection("path escapes base directory"));
    }
    node_err::fs::mkdir_recursive(Path::new(&folder))?;
    if !inside(&base, &p) {
        return Err(Thrown::path_injection("path escapes base directory"));
    }
    node_err::fs::write_file(Path::new(&p), raw.as_bytes())?;
    Ok(())
}

/// `deleteSkill(scope, projectCwd, name)`: the whole folder, and whether it
/// was there.
pub fn delete_skill(
    home: &str,
    scope: SkillScope,
    project_cwd: &str,
    name: &str,
) -> Result<bool, Thrown> {
    if !skill_names::is_valid_skill_dir_name(name) {
        return Err(Thrown::error("invalid skill name"));
    }
    let dir_base = skills_dir(home, scope, project_cwd);
    let dir = safe_path::assert_within(&dir_base, name).map_err(Thrown::path_injection)?;
    let base = node_path::resolve(&[&dir_base]);
    if dir == base {
        return Err(Thrown::error("invalid skill name"));
    }
    if !inside(&base, &dir) {
        return Err(Thrown::path_injection("path escapes base directory"));
    }
    match crate::node_fs::rm_recursive(&dir, false) {
        Ok(()) => Ok(true),
        Err(e) if e.is_not_found() => Ok(false),
        Err(e) => Err(Thrown::error(e.message)),
    }
}

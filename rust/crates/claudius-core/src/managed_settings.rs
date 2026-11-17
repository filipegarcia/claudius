//! The managed (policy) settings source, as far as Claudius reads it: SDK
//! 0.3.312 `resolveSettings()`'s `managed` source (`M9` → `iv` → `Bc`),
//! consumed by `lib/server/managed-model-policy.ts` (`deniedModels`,
//! `availableModelsMatch`) and `lib/server/model-pricing-override.ts`
//! (`modelPricing`).
//!
//! **Tiers ported:**
//! - The managed-settings **file tier** (A05a, `Bp`):
//!   `<managed dir>/managed-settings.json`, then `managed-settings.d/*.json`
//!   (files or symlinks, not dot-files, sorted), merged in order (lodash
//!   `mergeWith` + `Hr`).
//! - The macOS **MDM tier** (A05b, `lv` + `uv`): the per-user, then the
//!   device managed-preferences plist, converted by `/usr/bin/plutil`. Only
//!   plists up to the first readable one count, so an empty or garbage
//!   per-user plist hides the device plist. The plists are read once per
//!   process, like the SDK; the files are re-read on every call.
//! - The Windows **registry** (A05d, `uv`'s win32 branch): `reg query` of
//!   `HKLM\SOFTWARE\Policies\ClaudeCode` and `HKCU\…` value `Settings`
//!   (`REG_SZ` or `REG_EXPAND_SZ`). HKLM is the MDM tier (`policyOrigin`
//!   `"hklm"`) when its document has policy content. If it overflows or
//!   doesn't parse, the registry stops there. HKCU, being user-writable, is
//!   the last resort: it loses the admin-only keys (`Oy` + `V4e`) and the
//!   composition keys, isn't loaded at all when the file tier binds
//!   (`r9e`), and is used only when no tier has policy content (`ki`).
//! - **WSL** (A05e, `$p()`: Linux with `WSL_DISTRO_NAME`, unless
//!   `CLAUDE_CODE_ENTRYPOINT` is a cowork cloud one, or a Microsoft/WSL
//!   `/proc/version`): the same registry through `/mnt/c/.../reg.exe`, plus
//!   the Windows managed folder `/mnt/c/Program Files/ClaudeCode`. None of it
//!   counts until an admin source arms `wslInheritsWindowsSettings` (HKLM's
//!   value, else any document in that folder; an unreadable value arms it
//!   fail-closed with nothing in it). Armed, the Windows folder replaces
//!   `/etc/claude-code` as the file tier whenever it or the MDM tier binds,
//!   and HKCU must arm the flag itself. Unarmed, a Windows source that
//!   failed to load still shuts `/etc/claude-code` out (`$4`).
//!
//! Files (managed-settings and HKCU-suppression reads alike) go through the
//! SDK's reader (`kje`): regular files only, up to 2 MiB, UTF-16LE after an
//! `FF FE` BOM, else lossy UTF-8, CRLF folded to LF.
//!
//! **Tier selection** (`Bc` + `by` + `Q4`): each tier is ranked: authored
//! content 2, only fail-closed substitutes 1, only void values (`{}`) 0. The
//! MDM tier wins on a tie. With `managedSourcesBehavior: "first-wins"` (the
//! default) the winner is the managed source alone, except that a losing MDM
//! tier's fail-closed values still bind beside it (most restrictive wins:
//! `availableModelsMatch: "exact"`). With `"merge"` (declared by the first
//! tier that is primary or declares it) the lower tiers deep-merge under the
//! winner: arrays union with the higher tier's entries first.
//!
//! **What's modelled.** Per document, the three consumer keys are validated
//! the way the CLI's policy-tolerant schema leaves them, and
//! `managedSourcesBehavior` must be `"first-wins"` or `"merge"`. Every other
//! key is kept raw (a non-null value counts as authored content), because
//! only its presence feeds the tier ranks. Full key validation is the CLI's
//! job, and this port has no Rust-side schema. So a document whose other
//! keys the CLI would drop or substitute can rank higher here (PORT_PLAN
//! gap). Behaviour is pinned against the real SDK by
//! `tests/managed_settings_golden.rs`.
//!
//! **Never read, as in the SDK host:**
//! - The server-managed **remote** tier (A05c). `nv` → `o4` → `r4` reads
//!   `<config dir>/remote-settings.json` only when `Ro().eligible === true`.
//!   Only the CLI records eligibility; the SDK library never does
//!   (`recordEligibility` and `replaceSessionCache` have no callers). The
//!   other way in, the `serverManagedSettings` option, isn't passed by
//!   Claudius.
//! - The `parentManaged` (`managedSettings` option) and `flag` tiers, because
//!   Claudius calls `resolveSettings({ cwd })` with neither.
//!
//! **Not modelled: a cowork cloud host.** With `CLAUDE_CODE_ENTRYPOINT`
//! `remote_cowork` / `remote_cowork_trigger` in the host's own env, the SDK
//! asks the organization (`h_()`). A managed document the process can write
//! (`ev()`: by owner, mode, `access(W_OK)` and a walk of its folders) is then
//! "held" (`Xx`): it may only restrict (`XZ`), so `modelPricing` goes and
//! `availableModelsMatch: "prefix"` is dropped, and tier selection weighs it
//! as held content. The registry read can also be withheld (`uv`'s
//! `whereAsked` and `heldDocuments`), though not on a real WSL host, where
//! the registry tool under `/mnt/c` is never held. Only the WSL check's part
//! (`WSL_DISTRO_NAME` doesn't count) is ported; Claudius doesn't run as a
//! cowork cloud session. The recorder's control pair pins the gate.
//!
//! On plain Linux the OS policy is empty and only `/etc/claude-code` is read.

use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

/// The keys this module validates and returns.
pub const MANAGED_KEYS: [&str; 3] = ["availableModelsMatch", "deniedModels", "modelPricing"];

/// `Ai`: keys that steer how tiers compose but aren't policy content.
const COMPOSITION_KEYS: [&str; 2] = ["managedSourcesBehavior", "wslInheritsWindowsSettings"];

/// `tBe()`: the platform's managed-settings directory. The SDK's override
/// hook (`nBe`) is compiled out in this build, so there's no env override.
pub fn managed_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/Library/Application Support/ClaudeCode")
    } else if cfg!(windows) {
        PathBuf::from(r"C:\Program Files\ClaudeCode")
    } else {
        PathBuf::from("/etc/claude-code")
    }
}

/// The root of `O4()`'s plist paths.
pub const MANAGED_PREFERENCES_DIR: &str = "/Library/Managed Preferences";

/// `O4()`: `<root>/<user>/com.anthropic.claudecode.plist` (when the user name
/// is known), then `<root>/com.anthropic.claudecode.plist`.
pub fn mdm_plist_paths(root: &Path, user: Option<&str>) -> Vec<PathBuf> {
    const PLIST: &str = "com.anthropic.claudecode.plist";
    let mut paths = Vec::new();
    if let Some(user) = user.filter(|u| !u.is_empty()) {
        paths.push(root.join(user).join(PLIST));
    }
    paths.push(root.join(PLIST));
    paths
}

/// `os.userInfo().username`: the passwd entry of the effective uid.
pub fn current_username() -> Option<String> {
    #[cfg(unix)]
    {
        let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
        let mut buf = vec![0 as libc::c_char; 16 * 1024];
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        // SAFETY: getpwuid_r writes into `pwd` and `buf`, which outlive the
        // call. `result` is either null or points at `pwd`.
        let rc = unsafe {
            libc::getpwuid_r(
                libc::geteuid(),
                &mut pwd,
                buf.as_mut_ptr(),
                buf.len(),
                &mut result,
            )
        };
        if rc != 0 || result.is_null() || pwd.pw_name.is_null() {
            return None;
        }
        // SAFETY: on success pw_name is a NUL-terminated string inside `buf`.
        let name = unsafe { std::ffi::CStr::from_ptr(pwd.pw_name) };
        Some(name.to_string_lossy().into_owned())
    }
    #[cfg(not(unix))]
    {
        std::env::var("USERNAME").ok()
    }
}

/// `q().min(lo).max(hi)` / `.gt(0).lte(10)` on a JSON value.
fn number_in(v: &Value, ok: impl Fn(f64) -> bool) -> Option<Value> {
    v.as_f64().filter(|n| ok(*n)).map(|_| v.clone())
}

/// `sx`: an override row needs all four rates, each in 0..=10000. Extra keys
/// are stripped and the schema's key order is used.
fn pricing_row(v: &Value) -> Option<Value> {
    let row = v.as_object()?;
    let mut out = Map::new();
    for k in ["input", "output", "cacheRead", "cacheWrite"] {
        let n = number_in(row.get(k)?, |n| (0.0..=10_000.0).contains(&n))?;
        out.insert(k.into(), n);
    }
    Some(Value::Object(out))
}

/// One document's value for a consumer key, as the CLI's lenient validator
/// leaves it (`None` = the key is dropped):
/// - `deniedModels` (`string[]`): an array keeps its strings; anything else
///   is dropped.
/// - `availableModelsMatch` (`"prefix" | "exact"`): `null` is dropped, and
///   any other invalid value fails closed to `"exact"` (a substitute).
/// - `modelPricing` (`{multiplier?, overrides?}`): a non-object is dropped.
///   Otherwise each field is kept only if valid (`0 < multiplier <= 10`;
///   `overrides` an object of valid rows, with invalid rows dropped).
fn validate(key: &str, v: &Value) -> Option<Value> {
    match key {
        "deniedModels" => v
            .as_array()
            .map(|a| Value::Array(a.iter().filter(|m| m.is_string()).cloned().collect())),
        "availableModelsMatch" => match v {
            Value::Null => None,
            Value::String(s) if s == "prefix" || s == "exact" => Some(v.clone()),
            _ => Some(json!("exact")),
        },
        "modelPricing" => {
            let p = v.as_object()?;
            let mut out = Map::new();
            if let Some(m) = p
                .get("multiplier")
                .and_then(|m| number_in(m, |n| n > 0.0 && n <= 10.0))
            {
                out.insert("multiplier".into(), m);
            }
            if let Some(Value::Object(rows)) = p.get("overrides") {
                let kept: Map<String, Value> = rows
                    .iter()
                    .filter_map(|(model, row)| pricing_row(row).map(|r| (model.clone(), r)))
                    .collect();
                out.insert("overrides".into(), Value::Object(kept));
            }
            Some(Value::Object(out))
        }
        _ => None,
    }
}

/// `Mp`: a plain object whose values are all void (`{}`, `{"a": {}}`).
fn is_void(v: &Value) -> bool {
    v.as_object().is_some_and(|o| o.values().all(is_void))
}

/// `Kc`: any key besides the composition keys.
fn has_content(settings: &Map<String, Value>) -> bool {
    settings
        .keys()
        .any(|k| !COMPOSITION_KEYS.contains(&k.as_str()))
}

/// `Gc`: any non-composition key with a non-void value.
fn has_non_void_content(settings: &Map<String, Value>) -> bool {
    settings
        .iter()
        .any(|(k, v)| !COMPOSITION_KEYS.contains(&k.as_str()) && !is_void(v))
}

/// One parsed managed document (`IZe` / `Ay`), as tier selection needs it.
#[derive(Debug, Clone)]
struct Doc {
    /// Validated consumer keys, `managedSourcesBehavior` if valid, and every
    /// other key's non-null raw value, in document order.
    settings: Map<String, Value>,
    /// Its only non-void content is fail-closed substitutes (`onlySubstitutes`).
    only_substitutes: bool,
    /// `b9`: any non-null raw value outside the composition keys, or content.
    has_policy_content: bool,
}

fn validate_document(raw: &Map<String, Value>) -> Doc {
    let mut settings = Map::new();
    let mut substituted = false;
    for (k, v) in raw {
        match k.as_str() {
            "deniedModels" | "availableModelsMatch" | "modelPricing" => {
                if let Some(valid) = validate(k, v) {
                    substituted |= k == "availableModelsMatch" && valid != *v;
                    settings.insert(k.clone(), valid);
                }
            }
            "managedSourcesBehavior" => {
                if v == "first-wins" || v == "merge" {
                    settings.insert(k.clone(), v.clone());
                }
            }
            "wslInheritsWindowsSettings" => {}
            _ => {
                if !v.is_null() {
                    settings.insert(k.clone(), v.clone());
                }
            }
        }
    }
    let only_substitutes = substituted
        && settings
            .iter()
            .filter(|(k, v)| !COMPOSITION_KEYS.contains(&k.as_str()) && !is_void(v))
            .all(|(k, _)| k == "availableModelsMatch");
    let has_policy_content = raw
        .iter()
        .any(|(k, v)| !v.is_null() && !COMPOSITION_KEYS.contains(&k.as_str()))
        || has_content(&settings);
    Doc {
        settings,
        only_substitutes,
        has_policy_content,
    }
}

/// lodash `mergeWith(dest, src, customizer)` for one value. Both arrays →
/// union (`zt`): `Hr` puts the destination's entries first, `Zx`/`T9` (tier
/// merge) the source's. Both objects → recursive merge. Otherwise `src`
/// replaces (the returned value).
fn merge_value(dest: Option<&mut Value>, src: Value, src_first: bool) -> Option<Value> {
    match (dest, src) {
        (Some(Value::Array(a)), Value::Array(b)) => {
            let joined = if src_first {
                b.into_iter().chain(a.iter().cloned()).collect()
            } else {
                a.iter().cloned().chain(b).collect()
            };
            *a = claudius_agent::js::dedupe(joined);
            None
        }
        (Some(Value::Object(a)), Value::Object(b)) => {
            merge_map(a, b, src_first);
            None
        }
        (_, src) => Some(src),
    }
}

fn merge_map(dest: &mut Map<String, Value>, src: Map<String, Value>, src_first: bool) {
    for (k, v) in src {
        if let Some(replacement) = merge_value(dest.get_mut(&k), v, src_first) {
            dest.insert(k, replacement);
        }
    }
}

/// A managed tier as `Bc` sees it.
#[derive(Debug, Clone, Default)]
pub struct Tier {
    /// The tier's settings, `None` when absent.
    settings: Option<Map<String, Value>>,
    /// Present, but its only non-void content is fail-closed substitutes.
    only_substitutes: bool,
    /// `zc`: some document in it has policy content, even if none of it
    /// survived validation. With no admin tier this shuts HKCU out (`ki`).
    policy_content: bool,
    /// `loadState: "didNotLoad"`: a document in it couldn't be read or
    /// parsed.
    did_not_load: bool,
}

impl Tier {
    /// A source that failed to load: it binds with nothing in it.
    fn failed() -> Self {
        Self {
            did_not_load: true,
            ..Self::default()
        }
    }

    /// `Ta`: the tier binds (has policy content or failed to load), which
    /// shuts out the user-writable sources beneath it.
    pub fn binds(&self) -> bool {
        self.policy_content || self.did_not_load
    }

    /// `E_`: the tier has authored (non-substitute, non-void) content.
    fn authored(&self) -> bool {
        self.settings.as_ref().is_some_and(has_non_void_content) && !self.only_substitutes
    }

    /// `Cy(settings)`: the settings, if they hold any content.
    fn content(&self) -> Option<&Map<String, Value>> {
        self.settings.as_ref().filter(|s| has_content(s))
    }

    fn behavior(&self) -> Option<&str> {
        self.settings
            .as_ref()?
            .get("managedSourcesBehavior")?
            .as_str()
    }
}

/// `qx`: -1 absent, 2 authored, 1 only substitutes, 0 only void values.
fn rank(tier: &Tier) -> i8 {
    match tier.content() {
        None => -1,
        Some(_) if tier.authored() => 2,
        Some(s) if has_non_void_content(s) => 1,
        Some(_) => 0,
    }
}

/// `Bp`: the managed-settings file tier under `dir` (normally
/// [`managed_dir`]).
pub fn read_file_tier(dir: &Path) -> Tier {
    let mut docs = vec![dir.join("managed-settings.json")];
    let drop_in = dir.join("managed-settings.d");
    let mut did_not_load = false;
    match std::fs::read_dir(&drop_in) {
        // A missing or non-directory drop-in folder is fine (`dv`).
        Err(e) => did_not_load = !is_missing(&e),
        Ok(rd) => {
            let mut names: Vec<String> = rd
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_ok_and(|t| t.is_file() || t.is_symlink()))
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.ends_with(".json") && !n.starts_with('.'))
                .collect();
            // JS `Array.prototype.sort`: UTF-16 code unit order.
            names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            docs.extend(names.into_iter().map(|n| drop_in.join(n)));
        }
    }
    let mut merged = Map::new();
    let (mut found, mut authored, mut policy_content) = (false, false, false);
    for path in docs {
        let text = match read_managed_file(&path) {
            Ok(text) => text,
            // `jZe`: only ENOENT reads as absent (ENOTDIR doesn't).
            Err(e) => {
                did_not_load |= e.raw_os_error() != Some(libc_enoent());
                continue;
            }
        };
        // `Ay`: blank text loads as `{}`.
        if claudius_agent::js::trim(&text).is_empty() {
            continue;
        }
        let Some(raw) = parse_document(&text) else {
            did_not_load = true;
            continue;
        };
        // `Wx`: an empty document doesn't count.
        let doc = validate_document(&raw);
        policy_content |= doc.has_policy_content;
        if doc.settings.is_empty() {
            continue;
        }
        authored |= has_non_void_content(&doc.settings) && !doc.only_substitutes;
        merge_map(&mut merged, doc.settings, false);
        found = true;
    }
    let settings = (found && has_content(&merged)).then_some(merged);
    let only_substitutes = settings
        .as_ref()
        .is_some_and(|s| !authored && has_non_void_content(s));
    Tier {
        settings,
        only_substitutes,
        policy_content,
        did_not_load,
    }
}

/// The SDK's cap on a managed file (`Wp`, `gi(path, Wp)`).
pub const MANAGED_FILE_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// `gi(path, Wp)` / `kje`: read a managed file the way the SDK does. It must
/// be a regular file (after symlinks) of at most 2 MiB. An `FF FE` BOM means
/// UTF-16LE (an odd trailing byte is dropped), anything else is lossy UTF-8.
/// CRLF becomes LF. A lone surrogate in UTF-16 text decodes to U+FFFD here,
/// where JS keeps it.
fn read_managed_file(path: &Path) -> std::io::Result<String> {
    let too_big = || std::io::Error::other("File exceeds maxBytes limit");
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() {
        return Err(std::io::Error::other("not a regular file"));
    }
    if meta.len() > MANAGED_FILE_MAX_BYTES {
        return Err(too_big());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(MANAGED_FILE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MANAGED_FILE_MAX_BYTES {
        return Err(too_big());
    }
    let text = if bytes.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
    Ok(text.replace("\r\n", "\n"))
}

/// `pv(dir)`, which `r9e` asks before reading HKCU: does the file tier under
/// `dir` bind (`Ta(Bp(dir))`)? A document with policy content, one that
/// doesn't parse, or one that can't be read for any reason but ENOENT
/// (`at`) binds. A missing or non-directory drop-in folder doesn't (`dv`).
pub fn file_tier_blocks_hkcu(dir: &Path) -> bool {
    read_file_tier(dir).binds()
}

/// How an `execFile` run ended (`av` + `F9`).
enum Run {
    Ok(String),
    /// Exited with a non-zero code.
    Exited,
    /// Output over the buffer limit (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`).
    Overflow,
    /// Spawn failure, timeout or signal.
    NotFinished,
}

/// `execFile(program, args, {timeout: 5000, maxBuffer})`.
fn run(program: &str, args: &[&OsStr], max_buffer: usize) -> Run {
    let Ok(mut child) = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    else {
        return Run::NotFinished;
    };
    // Read up to the limit, then drain the rest so the child can exit.
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = (&mut pipe)
                    .take(max_buffer as u64 + 1)
                    .read_to_end(&mut buf);
                let _ = std::io::copy(&mut pipe, &mut std::io::sink());
            }
            buf
        })
    };
    let out = drain(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let err = drain(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let deadline = Instant::now() + Duration::from_millis(5000);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    match status {
        Some(_) if stdout.len() > max_buffer || stderr.len() > max_buffer => Run::Overflow,
        Some(s) if s.success() => Run::Ok(String::from_utf8_lossy(&stdout).into_owned()),
        Some(s) if s.code().is_some() => Run::Exited,
        _ => Run::NotFinished,
    }
}

const PLUTIL: &str = "/usr/bin/plutil";
const PLUTIL_MAX_BUFFER: usize = 2 * 1024 * 1024;
/// Node's default `maxBuffer`, used by the lint run.
const NODE_MAX_BUFFER: usize = 1024 * 1024;

fn is_missing(e: &std::io::Error) -> bool {
    matches!(e.raw_os_error(), Some(code) if code == libc_enoent() || code == libc_enotdir())
}

fn libc_enoent() -> i32 {
    #[cfg(unix)]
    {
        libc::ENOENT
    }
    #[cfg(not(unix))]
    {
        2
    }
}

fn libc_enotdir() -> i32 {
    #[cfg(unix)]
    {
        libc::ENOTDIR
    }
    #[cfg(not(unix))]
    {
        20
    }
}

/// `accessSync(path, R_OK)`.
fn access_readable(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(path.as_os_str().as_bytes())
            .map_err(|_| std::io::Error::from_raw_os_error(libc::ENOENT))?;
        // SAFETY: `c` is a valid NUL-terminated path for the duration of the call.
        if unsafe { libc::access(c.as_ptr(), libc::R_OK) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
    #[cfg(not(unix))]
    {
        std::fs::File::open(path).map(|_| ())
    }
}

/// `B4e`: open the file and read one byte.
fn probe_read(path: &Path) -> std::io::Result<()> {
    let mut f = std::fs::File::open(path)?;
    let mut byte = [0u8; 1];
    f.read(&mut byte).map(|_| ())
}

/// `lv()` for one plist: `None` = missing (skipped), `Some(None)` =
/// unreadable, `Some(Some(json))` = readable (`""` when `plutil` can neither
/// convert nor lint it).
fn read_plist(path: &Path) -> Option<Option<String>> {
    if let Err(e) = access_readable(path) {
        return if is_missing(&e) { None } else { Some(None) };
    }
    let p = path.as_os_str();
    match run(
        PLUTIL,
        &[
            "-convert".as_ref(),
            "json".as_ref(),
            "-o".as_ref(),
            "-".as_ref(),
            "--".as_ref(),
            p,
        ],
        PLUTIL_MAX_BUFFER,
    ) {
        Run::Ok(json) => return Some(Some(json)),
        Run::NotFinished | Run::Overflow => return Some(None),
        Run::Exited => {}
    }
    match run(
        PLUTIL,
        &["-lint".as_ref(), "-s".as_ref(), "--".as_ref(), p],
        NODE_MAX_BUFFER,
    ) {
        // A valid plist plutil can't convert (a date or data value), or an
        // unfinished lint: unreadable.
        Run::Ok(_) | Run::NotFinished | Run::Overflow => Some(None),
        Run::Exited => match probe_read(path) {
            Err(e) if is_missing(&e) => None,
            Err(_) => Some(None),
            Ok(()) => Some(Some(String::new())),
        },
    }
}

/// The macOS MDM tier read from `root` (normally
/// [`MANAGED_PREFERENCES_DIR`]): `lv()` keeps the plists up to the first
/// readable one, and `uv` takes that one if it has policy content (the
/// unreadable ones before it carry none). Other platforms have no plist
/// tier.
pub fn read_mdm_tier(root: &Path, user: Option<&str>) -> Tier {
    if !cfg!(target_os = "macos") {
        return Tier::default();
    }
    let readable = mdm_plist_paths(root, user)
        .iter()
        .filter_map(|p| read_plist(p))
        .find_map(|stdout| stdout);
    let Some(doc) = readable
        .as_deref()
        .and_then(parse_document)
        .map(|raw| validate_document(&raw))
        .filter(|d| d.has_policy_content)
    else {
        return Tier::default();
    };
    // `tv`: empty settings are no settings.
    Tier {
        settings: (!doc.settings.is_empty()).then_some(doc.settings),
        only_substitutes: doc.only_substitutes,
        policy_content: true,
        did_not_load: false,
    }
}

/// One `reg query` result (`av` in `$9`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegRead {
    /// Exit 0, with its stdout.
    Ok(String),
    /// Output over the 2 MiB buffer.
    Overflow,
    /// A non-zero exit (e.g. no such key or value), timeout, or spawn failure.
    Failed,
}

/// The policy keys `$9` queries (`hy` / `_y`) and the value name (`Fp`).
pub const HKLM_POLICY_KEY: &str = r"HKLM\SOFTWARE\Policies\ClaudeCode";
pub const HKCU_POLICY_KEY: &str = r"HKCU\SOFTWARE\Policies\ClaudeCode";
pub const REG_VALUE_NAME: &str = "Settings";
/// `yy`: the `maxBuffer` for both queries.
pub const REG_MAX_BUFFER: usize = 2 * 1024 * 1024;

/// The argv `$9` passes to `reg.exe` for one key.
pub fn reg_query_args(key: &str) -> [&str; 4] {
    ["query", key, "/v", REG_VALUE_NAME]
}

/// `xy(stdout)`: the `Settings` value's data from `reg query` output. It
/// matches `/^[ \t]+Settings[ \t]+REG_(?:EXPAND_)?SZ[ \t]+([\s\S]*)/im`.
/// The first line (JS line terminators: LF, CR, U+2028, U+2029) that starts
/// with spaces/tabs, the value name and type (ASCII case-insensitive), then
/// spaces/tabs, captures **the rest of the output**, end-trimmed. An empty
/// capture is `None`.
pub fn reg_value(stdout: &str) -> Option<String> {
    fn blanks(s: &str) -> Option<&str> {
        let rest = s.trim_start_matches([' ', '\t']);
        (rest.len() < s.len()).then_some(rest)
    }
    fn word<'a>(s: &'a str, w: &str) -> Option<&'a str> {
        s.get(..w.len())
            .filter(|head| head.eq_ignore_ascii_case(w))
            .map(|_| &s[w.len()..])
    }
    let starts = std::iter::once(0).chain(
        stdout
            .char_indices()
            .filter(|(_, c)| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
            .map(|(i, c)| i + c.len_utf8()),
    );
    for start in starts {
        let line = &stdout[start..];
        let Some(rest) = blanks(line)
            .and_then(|r| word(r, REG_VALUE_NAME))
            .and_then(blanks)
            .and_then(|r| word(r, "REG_"))
        else {
            continue;
        };
        let rest = word(rest, "EXPAND_").unwrap_or(rest);
        let Some(data) = word(rest, "SZ").and_then(blanks) else {
            continue;
        };
        let data = data
            .trim_end_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}');
        return (!data.is_empty()).then(|| data.to_owned());
    }
    None
}

/// `Yp(value, …, {userWritable: true})` for HKCU: keys only honored from
/// admin-controlled sources are dropped (`Oy`: `managedMcpServers`,
/// `isolation`, `attributionProjectPolicy` (new in 0.3.312); `V4e`:
/// `prependPlugins`, `appendPlugins`), and `enabledPlugins` keeps only
/// entries that disable a non-built-in plugin.
fn strip_user_writable(raw: &mut Map<String, Value>) {
    for key in [
        "managedMcpServers",
        "isolation",
        "attributionProjectPolicy",
        "prependPlugins",
        "appendPlugins",
    ] {
        raw.shift_remove(key);
    }
    // Touched only when an entry goes: an empty `{}` stays as authored.
    if let Some(Value::Object(plugins)) = raw.get_mut("enabledPlugins") {
        let before = plugins.len();
        plugins.retain(|name, v| !name.ends_with("@builtin") && *v == Value::Bool(false));
        if plugins.len() < before && plugins.is_empty() {
            raw.shift_remove("enabledPlugins");
        }
    }
}

/// The OS policy sources (`uv`), read once per process.
#[derive(Debug, Clone, Default)]
pub struct OsPolicy {
    /// The MDM tier: the macOS plist, or the Windows HKLM value.
    pub mdm: Tier,
    /// What `policyOrigin` calls the MDM tier (`Ra()`): `"plist"` or `"hklm"`.
    pub mdm_origin: &'static str,
    /// HKCU's settings (Windows), the last-resort source. `None` when it
    /// wasn't read or was shut out at load time.
    pub hkcu: Option<Map<String, Value>>,
    /// WSL inherits the Windows policy (`wslInherits`): an admin source armed
    /// `wslInheritsWindowsSettings`, or holds a value for it that can't be
    /// read (fail closed).
    pub wsl_inherits: bool,
}

impl OsPolicy {
    /// The macOS MDM tier.
    pub fn plist(mdm: Tier) -> Self {
        Self {
            mdm,
            mdm_origin: "plist",
            hkcu: None,
            wsl_inherits: false,
        }
    }
}

/// `px`: what a document says about `wslInheritsWindowsSettings`. `true`
/// and `"true"` arm, `false`, `"false"`, `null` and no value don't, and
/// anything else can't be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WslFlag {
    Disarmed,
    Armed,
    Unreadable,
}

fn wsl_flag(raw: &Map<String, Value>) -> WslFlag {
    match raw.get("wslInheritsWindowsSettings") {
        None | Some(Value::Null) => WslFlag::Disarmed,
        Some(Value::Bool(true)) => WslFlag::Armed,
        Some(Value::Bool(false)) => WslFlag::Disarmed,
        Some(Value::String(s)) if s == "true" => WslFlag::Armed,
        Some(Value::String(s)) if s == "false" => WslFlag::Disarmed,
        Some(_) => WslFlag::Unreadable,
    }
}

/// `o9e`: the flag in the Windows managed-settings folder (seen from WSL),
/// and whether a document there failed to load. Any armed document arms it;
/// otherwise any unreadable flag makes it unreadable. Missing files and a
/// missing or non-directory drop-in folder are skipped silently (`dv`).
fn windows_flag(dir: &Path) -> (WslFlag, bool) {
    let mut failed = false;
    let mut read = |path: &Path| match read_managed_file(path) {
        Err(e) => {
            failed |= !is_missing(&e);
            WslFlag::Disarmed
        }
        Ok(text) if claudius_agent::js::trim(&text).is_empty() => WslFlag::Disarmed,
        Ok(text) => parse_document(&text).map_or_else(
            || {
                failed = true;
                WslFlag::Disarmed
            },
            |raw| wsl_flag(&raw),
        ),
    };
    let mut flag = read(&dir.join("managed-settings.json"));
    if flag == WslFlag::Armed {
        return (flag, failed);
    }
    let drop_in = dir.join("managed-settings.d");
    let entries = match std::fs::read_dir(&drop_in) {
        Ok(rd) => rd,
        Err(e) => {
            failed |= !is_missing(&e);
            return (flag, failed);
        }
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !entry
            .file_type()
            .is_ok_and(|t| t.is_file() || t.is_symlink())
            || !name.ends_with(".json")
            || name.starts_with('.')
        {
            continue;
        }
        match read(&drop_in.join(&name)) {
            WslFlag::Armed => return (WslFlag::Armed, failed),
            WslFlag::Unreadable => flag = WslFlag::Unreadable,
            WslFlag::Disarmed => {}
        }
    }
    (flag, failed)
}

/// `uv` from the two `reg query` results: the Windows branch, or the WSL
/// one when `windows_dir` (the Windows managed folder under `/mnt/c`) is
/// given.
/// - Under WSL nothing Windows-side counts unless an admin source arms
///   `wslInheritsWindowsSettings` (HKLM's value first, then the documents in
///   `windows_dir`). Unarmed, a Windows source that failed to load still
///   binds (with nothing in it), which shuts out `/etc/claude-code`.
/// - HKLM that has policy content, or failed to load (unparseable value,
///   output over 2 MiB), is the MDM tier, and HKCU isn't read.
/// - An unreadable flag binds with nothing in it.
/// - Otherwise HKCU is read, unless the file tier in `file_dir` (or, when
///   inheriting, in `windows_dir`) already binds (`r9e`), minus the
///   admin-only and composition keys. Under WSL HKCU must also arm the flag
///   itself.
pub fn registry_policy(
    hklm: &RegRead,
    hkcu: &RegRead,
    file_dir: &Path,
    windows_dir: Option<&Path>,
) -> OsPolicy {
    let mut out = OsPolicy {
        mdm_origin: "hklm",
        ..OsPolicy::default()
    };
    // `a` (HKLM's document) and `l` (its flag).
    let mut flag = WslFlag::Disarmed;
    let hklm_tier = match hklm {
        RegRead::Ok(stdout) => Some(
            match parse_document(&reg_value(stdout).unwrap_or_default()) {
                Some(raw) => {
                    flag = wsl_flag(&raw);
                    let doc = validate_document(&raw);
                    Tier {
                        settings: (!doc.settings.is_empty()).then_some(doc.settings),
                        only_substitutes: doc.only_substitutes,
                        policy_content: doc.has_policy_content,
                        did_not_load: false,
                    }
                }
                None => Tier::failed(),
            },
        ),
        RegRead::Overflow => Some(Tier::failed()),
        RegRead::Failed => None,
    };
    let mut unreadable = false;
    if let Some(windows) = windows_dir {
        let mut failed = hklm_tier.as_ref().is_some_and(|t| t.did_not_load);
        let mut armed = flag;
        if armed != WslFlag::Armed {
            let (walked, walk_failed) = windows_flag(windows);
            if walked == WslFlag::Armed || armed == WslFlag::Disarmed {
                armed = walked;
            }
            if armed == WslFlag::Disarmed {
                failed |= walk_failed;
            }
        }
        if armed == WslFlag::Disarmed {
            out.mdm.did_not_load = failed;
            return out;
        }
        out.wsl_inherits = true;
        unreadable = armed == WslFlag::Unreadable;
    }
    if let Some(tier) = hklm_tier.filter(Tier::binds) {
        out.mdm = tier;
        return out;
    }
    if unreadable {
        out.mdm.policy_content = true;
        return out;
    }
    let RegRead::Ok(stdout) = hkcu else {
        return out;
    };
    let windows_binds = out.wsl_inherits && windows_dir.is_some_and(file_tier_blocks_hkcu);
    if windows_binds || file_tier_blocks_hkcu(file_dir) {
        return out;
    }
    let Some(mut raw) = parse_document(&reg_value(stdout).unwrap_or_default()) else {
        return out;
    };
    if windows_dir.is_some() && wsl_flag(&raw) != WslFlag::Armed {
        return out;
    }
    strip_user_writable(&mut raw);
    let mut settings = validate_document(&raw).settings;
    for key in COMPOSITION_KEYS {
        settings.shift_remove(key);
    }
    out.hkcu = Some(settings);
    out
}

/// `$4`: the managed-settings file tier. Outside WSL (`windows_dir` is
/// `None`) it's [`read_file_tier`] of `managed`. Under WSL:
/// - inheriting, the Windows folder's tier stands in when it or the MDM tier
///   binds, and `managed` (`/etc/claude-code`) is read only when neither
///   does;
/// - not inheriting, a binding MDM tier (a Windows source that failed to
///   load) leaves no file tier at all.
pub fn file_tier(os: &OsPolicy, managed: &Path, windows_dir: Option<&Path>) -> Tier {
    if let Some(windows) = windows_dir {
        if os.wsl_inherits {
            let tier = read_file_tier(windows);
            if tier.binds() || os.mdm.binds() {
                return tier;
            }
        } else if os.mdm.binds() {
            return Tier::default();
        }
    }
    read_file_tier(managed)
}

/// `$9(reg)`: query both keys.
fn read_registry(reg: &str) -> (RegRead, RegRead) {
    let query = |key: &str| {
        let argv = reg_query_args(key);
        let args: Vec<&OsStr> = argv.iter().map(OsStr::new).collect();
        match run(reg, &args, REG_MAX_BUFFER) {
            Run::Ok(stdout) => RegRead::Ok(stdout),
            Run::Overflow => RegRead::Overflow,
            Run::Exited | Run::NotFinished => RegRead::Failed,
        }
    };
    (query(HKLM_POLICY_KEY), query(HKCU_POLICY_KEY))
}

/// `reg.exe` as WSL sees it (`Ti`).
pub const WSL_REG_EXE: &str = "/mnt/c/Windows/System32/reg.exe";

/// The Windows managed-settings folder as WSL sees it (`xn`).
pub const WSL_WINDOWS_MANAGED_DIR: &str = "/mnt/c/Program Files/ClaudeCode";

/// `d_`: the `CLAUDE_CODE_ENTRYPOINT` values of a cowork cloud session.
pub const COWORK_CLOUD_ENTRYPOINTS: [&str; 2] = ["remote_cowork", "remote_cowork_trigger"];

/// `$p()`: Linux with a non-empty `WSL_DISTRO_NAME`, unless `entrypoint`
/// (the host's `CLAUDE_CODE_ENTRYPOINT`) is exactly a cowork cloud one
/// (`Kx()`), or a `/proc/version` that mentions Microsoft or WSL (in any
/// case). `WSL_INTEROP` doesn't count here.
pub fn detect_wsl(
    linux: bool,
    distro: Option<&OsStr>,
    entrypoint: Option<&OsStr>,
    proc_version: impl FnOnce() -> Option<String>,
) -> bool {
    if !linux {
        return false;
    }
    let cowork_cloud = entrypoint
        .and_then(OsStr::to_str)
        .is_some_and(|e| COWORK_CLOUD_ENTRYPOINTS.contains(&e));
    if distro.is_some_and(|d| !d.is_empty()) && !cowork_cloud {
        return true;
    }
    proc_version().is_some_and(|v| {
        let v = v.to_lowercase();
        v.contains("microsoft") || v.contains("wsl")
    })
}

/// The Windows managed folder when running under WSL, else `None`.
fn wsl_windows_dir() -> Option<&'static Path> {
    static WSL: OnceLock<bool> = OnceLock::new();
    let wsl = *WSL.get_or_init(|| {
        detect_wsl(
            cfg!(target_os = "linux"),
            std::env::var_os("WSL_DISTRO_NAME").as_deref(),
            std::env::var_os("CLAUDE_CODE_ENTRYPOINT").as_deref(),
            || {
                std::fs::read("/proc/version")
                    .ok()
                    .map(|b| String::from_utf8_lossy(&b).into_owned())
            },
        )
    });
    wsl.then(|| Path::new(WSL_WINDOWS_MANAGED_DIR))
}

/// The real OS policy, read once per process like the SDK's `W9()`: the
/// plists on macOS, the registry on Windows, and the Windows registry
/// through `/mnt/c` under WSL.
fn os_policy() -> &'static OsPolicy {
    static OS: OnceLock<OsPolicy> = OnceLock::new();
    OS.get_or_init(|| {
        if cfg!(target_os = "macos") {
            OsPolicy::plist(read_mdm_tier(
                Path::new(MANAGED_PREFERENCES_DIR),
                current_username().as_deref(),
            ))
        } else if cfg!(windows) {
            let root = std::env::var("SYSTEMROOT")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| r"C:\Windows".into());
            let (hklm, hkcu) = read_registry(&format!(r"{root}\System32\reg.exe"));
            registry_policy(&hklm, &hkcu, &managed_dir(), None)
        } else if let Some(windows) = wsl_windows_dir() {
            let (hklm, hkcu) = read_registry(WSL_REG_EXE);
            registry_policy(&hklm, &hkcu, &managed_dir(), Some(windows))
        } else {
            OsPolicy::default()
        }
    })
}

/// The resolved managed source, projected to [`MANAGED_KEYS`].
#[derive(Debug, Clone, PartialEq)]
pub struct ManagedSource {
    /// The consumer keys present in the managed source, in [`MANAGED_KEYS`]
    /// order.
    pub settings: Map<String, Value>,
    /// `policyOrigin`: `"plist"` / `"hklm"` when the MDM tier is the managed
    /// tier, `"file"`, or `"hkcu"` when HKCU stands in for a missing admin
    /// tier.
    pub origin: &'static str,
}

/// The consumer keys of one tier.
fn project(settings: &Map<String, Value>) -> Map<String, Value> {
    MANAGED_KEYS
        .iter()
        .filter_map(|k| settings.get(*k).map(|v| ((*k).to_owned(), v.clone())))
        .collect()
}

/// `Q4` for the one restrictive consumer key: `"exact"` from any tier binds.
/// Otherwise a value only lower tiers supplied is removed.
fn bind_restrictive(admin: &mut Map<String, Value>, tiers: &[Map<String, Value>]) {
    const KEY: &str = "availableModelsMatch";
    if tiers.iter().any(|t| t.get(KEY) == Some(&json!("exact"))) {
        admin.insert(KEY.into(), json!("exact"));
    } else if !tiers[0].contains_key(KEY) {
        admin.shift_remove(KEY);
    }
}

/// `iv`: the admin tier from `Bc` + `by` over the MDM and file tiers. With
/// no admin tier, HKCU stands in, unless some tier had policy content that
/// didn't survive (`ki`: the admin is then `{}`, an empty source).
pub fn resolve(os: &OsPolicy, file: &Tier) -> Option<ManagedSource> {
    if let Some(admin) = resolve_tiers(&os.mdm, os.mdm_origin, file) {
        return Some(admin);
    }
    if os.mdm.policy_content || file.policy_content {
        return None;
    }
    let hkcu = os.hkcu.as_ref().filter(|h| !h.is_empty())?;
    Some(ManagedSource {
        settings: project(hkcu),
        origin: "hkcu",
    })
}

/// `Bc` + `by` over the MDM and file tiers: `None` when neither has content.
fn resolve_tiers(mdm: &Tier, mdm_origin: &'static str, file: &Tier) -> Option<ManagedSource> {
    let mdm_content = mdm.content();
    let file_content = file.content();
    let mdm_primary = mdm_content.is_some() && rank(mdm) >= rank(file);
    // `me`: the first tier that is primary or declares a behavior.
    let behavior = [(mdm, mdm_primary), (file, file_content.is_some())]
        .into_iter()
        .find(|(t, primary)| t.settings.is_some() && (t.behavior().is_some() || *primary))
        .and_then(|(t, _)| t.behavior());
    // A losing MDM tier binds beside the winner (`Q`).
    let loser = mdm_content.filter(|_| !mdm_primary);
    let tiers: Vec<Map<String, Value>> = [mdm_content.filter(|_| mdm_primary), file_content, loser]
        .into_iter()
        .flatten()
        .map(project)
        .collect();
    let primary = tiers.first()?;
    let merge = behavior == Some("merge") && tiers.len() >= 2;
    let losers = usize::from(loser.is_some());
    let mut admin = primary.clone();
    if merge {
        let mut merged = Map::new();
        for lower in tiers[1..].iter().rev() {
            merge_map(&mut merged, lower.clone(), true);
        }
        merge_map(&mut merged, primary.clone(), true);
        admin = merged;
        bind_restrictive(&mut admin, &tiers);
    } else if losers > 0 {
        let bound: Vec<Map<String, Value>> = std::iter::once(primary.clone())
            .chain(tiers[tiers.len() - losers..].iter().cloned())
            .collect();
        bind_restrictive(&mut admin, &bound);
    }
    Some(ManagedSource {
        settings: project(&admin),
        origin: if mdm_primary { mdm_origin } else { "file" },
    })
}

/// `UZe`/`Ay` text → document. A leading BOM is stripped. Text that isn't a
/// JSON object (including blank text, comments, or trailing commas) gives
/// `None`. `JSON.parse` reads out-of-range literals (`1e400`) as ±Infinity,
/// while serde_json rejects the whole text. On that error they're rewritten
/// to ±`f64::MAX`, which every check here treats like ±Infinity: it isn't a
/// string, and it's outside every range. These values are validated, never
/// re-serialized.
fn parse_document(text: &str) -> Option<Map<String, Value>> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let parsed = serde_json::from_str::<Value>(text).or_else(|e| {
        if e.to_string().starts_with("number out of range") {
            serde_json::from_str(&clamp_overflowing_numbers(text))
        } else {
            Err(e)
        }
    });
    match parsed {
        Ok(Value::Object(doc)) => Some(doc),
        _ => None,
    }
}

/// Rewrite number literals outside strings that overflow `f64` to
/// ±`f64::MAX`. Other text is left as is.
fn clamp_overflowing_numbers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.char_indices().peekable();
    let (mut in_string, mut escaped) = (false, false);
    while let Some((i, c)) = chars.next() {
        if in_string {
            out.push(c);
            match (escaped, c) {
                (true, _) => escaped = false,
                (false, '\\') => escaped = true,
                (false, '"') => in_string = false,
                _ => {}
            }
            continue;
        }
        if c == '-' || c.is_ascii_digit() {
            let mut end = i + c.len_utf8();
            while let Some(&(j, d)) = chars.peek() {
                if !(d.is_ascii_digit() || matches!(d, '.' | 'e' | 'E' | '+' | '-')) {
                    break;
                }
                end = j + d.len_utf8();
                chars.next();
            }
            let literal = &text[i..end];
            match literal.parse::<f64>() {
                Ok(n) if n.is_infinite() => out.push_str(&format!("{:e}", f64::MAX.copysign(n))),
                _ => out.push_str(literal),
            }
            continue;
        }
        in_string = c == '"';
        out.push(c);
    }
    out
}

/// The managed source Claudius sees: the real OS policy (cached) over the
/// file tier in [`managed_dir`].
fn resolve_managed() -> Option<ManagedSource> {
    let os = os_policy();
    resolve(os, &file_tier(os, &managed_dir(), wsl_windows_dir()))
}

/// `ManagedModelPolicy` (managed-model-policy.ts).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedModelPolicy {
    pub denied_models: Option<Vec<String>>,
    /// `"prefix"` (default) or `"exact"`.
    pub available_models_match: &'static str,
}

/// `resolveManagedModelPolicy` over a resolved managed source.
pub fn model_policy_from(managed: Option<&Map<String, Value>>) -> ManagedModelPolicy {
    let denied_models = managed
        .and_then(|m| m.get("deniedModels"))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|m| m.as_str().map(str::to_owned))
                .collect()
        });
    let exact = managed.and_then(|m| m.get("availableModelsMatch")) == Some(&json!("exact"));
    ManagedModelPolicy {
        denied_models,
        available_models_match: if exact { "exact" } else { "prefix" },
    }
}

/// `resolveManagedModelPolicy(cwd)`. The managed tiers don't depend on
/// `cwd`; it's kept for signature parity.
pub fn resolve_managed_model_policy(_cwd: &str) -> ManagedModelPolicy {
    model_policy_from(resolve_managed().as_ref().map(|m| &m.settings))
}

/// `resolveManagedModelPricing` over a resolved managed source. A present
/// `modelPricing` is returned even when it's `{}`, like the TS truthiness
/// check.
pub fn model_pricing_from(managed: Option<&Map<String, Value>>) -> Option<Value> {
    managed?.get("modelPricing").cloned()
}

/// `resolveManagedModelPricing(cwd)`.
pub fn resolve_managed_model_pricing(_cwd: &str) -> Option<Value> {
    model_pricing_from(resolve_managed().as_ref().map(|m| &m.settings))
}

/// `isModelDeniedByManaged` (lib/shared/denied-models.ts).
pub fn is_model_denied_by_managed(
    value: &str,
    denied: Option<&[String]>,
    match_mode: &str,
) -> bool {
    let Some(denied) = denied.filter(|d| !d.is_empty()) else {
        return false;
    };
    let v = value.to_lowercase();
    denied.iter().any(|raw| {
        let d = claudius_agent::js::trim(raw).to_lowercase();
        if d.is_empty() {
            return false;
        }
        if v == d {
            return true;
        }
        // A bare family alias ("opus") denies that family's ids and alias.
        if d.bytes().all(|b| b.is_ascii_lowercase())
            && (v.contains(&format!("-{d}-"))
                || v.ends_with(&format!("-{d}"))
                || v.starts_with(&format!("{d}-")))
        {
            return true;
        }
        // Prefix mode: a model-id entry also denies ids that extend it.
        match_mode == "prefix" && v.starts_with(&format!("{d}-"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn denied(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    /// Cases from tests/unit for `isModelDeniedByManaged`.
    #[test]
    fn denied_model_matching() {
        let d = denied(&["opus", " claude-sonnet-5 ", ""]);
        assert!(is_model_denied_by_managed("opus", Some(&d), "prefix"));
        assert!(is_model_denied_by_managed(
            "claude-opus-5-5",
            Some(&d),
            "prefix"
        ));
        assert!(is_model_denied_by_managed(
            "Claude-Sonnet-5",
            Some(&d),
            "exact"
        ));
        assert!(is_model_denied_by_managed(
            "claude-sonnet-5-1",
            Some(&d),
            "prefix"
        ));
        assert!(!is_model_denied_by_managed(
            "claude-sonnet-5-1",
            Some(&d),
            "exact"
        ));
        assert!(!is_model_denied_by_managed("fable", Some(&d), "prefix"));
        assert!(!is_model_denied_by_managed("fable", None, "prefix"));
        assert!(!is_model_denied_by_managed("fable", Some(&[]), "prefix"));
        let fam = denied(&["fable"]);
        assert!(is_model_denied_by_managed("fable", Some(&fam), "exact"));
        assert!(is_model_denied_by_managed(
            "claude-fable-5",
            Some(&fam),
            "exact"
        ));
        assert!(!is_model_denied_by_managed(
            "claude-fables-5",
            Some(&fam),
            "exact"
        ));
    }

    #[test]
    fn policy_and_pricing_from_source() {
        assert_eq!(
            model_policy_from(None),
            ManagedModelPolicy {
                denied_models: None,
                available_models_match: "prefix"
            }
        );
        let m: Map<String, Value> = serde_json::from_value(
            json!({"deniedModels": ["a"], "availableModelsMatch": "exact", "modelPricing": {}}),
        )
        .unwrap();
        assert_eq!(
            model_policy_from(Some(&m)),
            ManagedModelPolicy {
                denied_models: Some(vec!["a".into()]),
                available_models_match: "exact"
            }
        );
        assert_eq!(model_pricing_from(Some(&m)), Some(json!({})));
        assert_eq!(model_pricing_from(None), None);
    }

    #[test]
    fn overflowing_literals_read_as_out_of_range_numbers() {
        assert_eq!(
            clamp_overflowing_numbers(
                r#"{"a":1e400,"b":-1E999,"c":"1e400","d":[1.5e3,"\"9e999"]}"#
            ),
            r#"{"a":1.7976931348623157e308,"b":-1.7976931348623157e308,"c":"1e400","d":[1.5e3,"\"9e999"]}"#
        );
        let doc = parse_document("\u{feff}{\"x\":1e400}").unwrap();
        assert!(doc["x"].as_f64().unwrap() > 1e300);
        assert!(parse_document("{\"x\":1e400,}").is_none());
        assert!(parse_document("").is_none());
        assert!(parse_document("[1]").is_none());
    }

    fn tier(v: Value, only_substitutes: bool) -> Tier {
        Tier {
            settings: Some(serde_json::from_value(v).unwrap()),
            only_substitutes,
            policy_content: true,
            did_not_load: false,
        }
    }

    /// The ranks and the MDM-wins-ties rule, without plists.
    #[test]
    fn tier_ranks_and_ties() {
        assert_eq!(rank(&Tier::default()), -1);
        assert_eq!(
            rank(&tier(json!({"managedSourcesBehavior": "merge"}), false)),
            -1
        );
        assert_eq!(
            rank(&tier(json!({"modelPricing": {"overrides": {}}}), false)),
            0
        );
        assert_eq!(
            rank(&tier(json!({"availableModelsMatch": "exact"}), true)),
            1
        );
        assert_eq!(rank(&tier(json!({"deniedModels": []}), false)), 2);
        let void = tier(json!({"modelPricing": {}}), false);
        let r = resolve(&OsPolicy::plist(void.clone()), &void.clone()).unwrap();
        assert_eq!(
            (r.origin, r.settings),
            ("plist", project(void.settings.as_ref().unwrap()))
        );
        assert_eq!(resolve(&OsPolicy::default(), &Tier::default()), None);
    }

    /// `xy` on captured `reg query` output shapes.
    #[test]
    fn reg_value_parsing() {
        let out = |line: &str| {
            format!("\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\ClaudeCode\r\n{line}\r\n\r\n")
        };
        assert_eq!(
            reg_value(&out(r#"    Settings    REG_SZ    {"deniedModels":["x"]}"#)).as_deref(),
            Some(r#"{"deniedModels":["x"]}"#)
        );
        assert_eq!(
            reg_value(&out("\tsettings\treg_expand_sz\t{} ")).as_deref(),
            Some("{}")
        );
        // The capture runs to the end of the output.
        assert_eq!(
            reg_value("  Settings  REG_SZ  {\n  \"a\": 1\n}\n\n").as_deref(),
            Some("{\n  \"a\": 1\n}")
        );
        for miss in [
            "Settings    REG_SZ    {}",           // no leading blank
            "    Settings    REG_DWORD    0x1",   // wrong type
            "    Settings    REG_MULTI_SZ    {}", // wrong type
            "    SettingsX    REG_SZ    {}",      // longer name
            "    Settings    REG_SZ    ",         // empty data
            "    ſettings    REG_SZ    {}",       // no Unicode case folding
        ] {
            assert_eq!(reg_value(&out(miss)), None, "{miss:?}");
        }
        assert_eq!(
            reg_query_args(HKLM_POLICY_KEY),
            [
                "query",
                r"HKLM\SOFTWARE\Policies\ClaudeCode",
                "/v",
                "Settings"
            ]
        );
    }

    /// `$p()`: Linux only; a non-empty `WSL_DISTRO_NAME` is enough unless
    /// the entrypoint is a cowork cloud one, else `/proc/version` must
    /// mention Microsoft or WSL in any case.
    #[test]
    fn wsl_detection() {
        let distro = |s: &str| Some(OsStr::new(s).to_owned());
        let never = || -> Option<String> { panic!("/proc/version read") };
        assert!(!detect_wsl(false, distro("Ubuntu").as_deref(), None, never));
        assert!(detect_wsl(true, distro("Ubuntu").as_deref(), None, never));
        for other in ["sdk-ts", "Remote_Cowork", "remote_cowork ", ""] {
            let e = OsStr::new(other);
            assert!(
                detect_wsl(true, distro("Ubuntu").as_deref(), Some(e), never),
                "{other:?}"
            );
        }
        let plain = || Some("Linux version 6.1.0-18-amd64 (debian)".to_owned());
        let wsl2 = || Some("Linux version 5.15.153.1-microsoft-standard-WSL2".to_owned());
        for cowork in COWORK_CLOUD_ENTRYPOINTS {
            let e = Some(OsStr::new(cowork));
            assert!(
                !detect_wsl(true, distro("Ubuntu").as_deref(), e, plain),
                "{cowork}"
            );
            assert!(
                !detect_wsl(true, distro("Ubuntu").as_deref(), e, || None),
                "{cowork}"
            );
            assert!(
                detect_wsl(true, distro("Ubuntu").as_deref(), e, wsl2),
                "{cowork}"
            );
            assert!(detect_wsl(true, None, e, wsl2), "{cowork}");
        }
        let proc = |v: &'static str| move || Some(v.to_owned());
        for (version, want) in [
            (
                "Linux version 5.15.153.1-microsoft-standard-WSL2 (root@x)",
                true,
            ),
            (
                "Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com)",
                true,
            ),
            ("Linux version 6.6.0-WSL (gcc)", true),
            (
                "Linux version 6.1.0-18-amd64 (debian-kernel@lists.debian.org)",
                false,
            ),
        ] {
            assert_eq!(
                detect_wsl(true, distro("").as_deref(), None, proc(version)),
                want,
                "{version}"
            );
            assert_eq!(
                detect_wsl(true, None, None, proc(version)),
                want,
                "{version}"
            );
        }
        assert!(!detect_wsl(true, None, None, || None));
    }

    #[test]
    fn hkcu_drops_user_writable_keys() {
        let strip = |v: Value| {
            let mut m = v.as_object().unwrap().clone();
            strip_user_writable(&mut m);
            Value::Object(m)
        };
        assert_eq!(
            strip(json!({
                "managedMcpServers": {}, "isolation": 1, "prependPlugins": [], "appendPlugins": [],
                "attributionProjectPolicy": {"commit": "x"},
                "enabledPlugins": {"a@m": false, "b@m": true, "c@builtin": false}, "deniedModels": ["x"]
            })),
            json!({"enabledPlugins": {"a@m": false}, "deniedModels": ["x"]})
        );
        assert_eq!(strip(json!({"enabledPlugins": {"b@m": true}})), json!({}));
        // `Yp` rewrites the map only when an entry goes.
        assert_eq!(
            strip(json!({"enabledPlugins": {}})),
            json!({"enabledPlugins": {}})
        );
        assert_eq!(
            strip(json!({"enabledPlugins": []})),
            json!({"enabledPlugins": []})
        );
    }

    /// An MDM tier with policy content shuts HKCU out even when none of its
    /// settings survive validation (`ki` in `iv`, and `uv`'s early return).
    #[test]
    fn policy_content_without_settings_shuts_out_hkcu() {
        let hkcu: Map<String, Value> = json!({"deniedModels": ["x"]}).as_object().unwrap().clone();
        let bare = Tier {
            settings: None,
            only_substitutes: false,
            policy_content: true,
            did_not_load: false,
        };
        let os = |mdm: Tier| OsPolicy {
            mdm,
            mdm_origin: "hklm",
            hkcu: Some(hkcu.clone()),
            wsl_inherits: false,
        };
        assert!(resolve(&os(bare.clone()), &Tier::default()).is_none());
        assert!(resolve(&os(Tier::default()), &bare).is_none());
        let open = resolve(&os(Tier::default()), &Tier::default()).unwrap();
        assert_eq!(
            (open.origin, Value::Object(open.settings)),
            ("hkcu", json!({"deniedModels": ["x"]}))
        );
        // HKLM with policy content but no valid key: HKCU isn't even kept.
        let dir = tempfile::tempdir().unwrap();
        let hklm = RegRead::Ok(format!(
            "\r\n    Settings    REG_SZ    {}\r\n",
            r#"{"deniedModels":7}"#
        ));
        let hkcu_out = RegRead::Ok(format!(
            "\r\n    Settings    REG_SZ    {}\r\n",
            r#"{"deniedModels":["x"]}"#
        ));
        let policy = registry_policy(&hklm, &hkcu_out, dir.path(), None);
        assert!(
            policy.mdm.policy_content && policy.hkcu.is_none(),
            "{policy:?}"
        );
        assert!(resolve(&policy, &Tier::default()).is_none());
        // With no HKLM, HKCU loads stripped of what only an admin may set and
        // of the composition keys (the projection can't see either).
        let doc = json!({
            "isolation": {}, "managedMcpServers": {}, "appendPlugins": ["p"],
            "managedSourcesBehavior": "merge", "enabledPlugins": {"a@m": true, "b@m": false},
            "deniedModels": ["x"]
        });
        let hkcu_out = RegRead::Ok(format!("\r\n    Settings    REG_SZ    {doc}\r\n"));
        let policy = registry_policy(&RegRead::Failed, &hkcu_out, dir.path(), None);
        assert_eq!(
            policy.hkcu.map(Value::Object),
            Some(json!({"enabledPlugins": {"b@m": false}, "deniedModels": ["x"]}))
        );
    }
}

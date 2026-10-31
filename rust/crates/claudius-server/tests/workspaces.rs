//! The workspace routes (`/api/workspaces`, `reorder`, `[id]`, `select`,
//! `icon`, `roots`) against the real binary, replaying the `steps` of
//! `claudius-core/tests/fixtures/workspaces_golden.json` (recorded by
//! `rust/scripts/workspaces-golden.mjs` from the real TS store and route
//! handlers run inside Next's route module): the same file-system setup
//! (store files, icons, settings, backups, symlinks, modes) at the same
//! points, and every request must answer the same status, content type,
//! `Set-Cookie`s, `Cache-Control`, `Content-Length` and body ("threw" is
//! Next's empty 500), leave the same `workspaces.json` bytes, backups (count,
//! new ones, and every backup's text at the dump points), icon files and
//! `.claudius` entries.
//!
//! Three things differ by nature and are mapped, not ignored:
//! * Generated ids are random: the n-th `201` here stands for the n-th
//!   recorded one (and its letter icon's colour, which hashes the id, for
//!   the recorded colour). Each id must be `wks_` + 12 lowercase hex.
//! * The recorder pinned `Date.now()` per request; this server runs on the
//!   real clock. A recorded request time found in a body or the store must
//!   come back as one value within the request, which from then on stands
//!   for it. Cookie `Expires` and backup stamps must fall within the
//!   request, and the recorded ones must be the TS format of the pinned
//!   time.
//! * Requests are 2 ms apart, so two backups never share a stamp.
//!
//! Two recorded cases differ on purpose (see `expected_difference`).
#![cfg(unix)]

mod common;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use claudius_core::workspaces::default_letter_icon;
use claudius_core::{js_string, now_ms};
use claudius_server::workspaces::{
    BufferError, base64_decode, buffer_from, parse_cookie_header, utc_string,
};
use common::{Server, World};
use serde_json::{Map, Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../claudius-core/tests/fixtures/workspaces_golden.json");
    // Lone-surrogate escapes: serde_json would refuse them.
    js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

// ---- tiny encoders the replay needs ------------------------------------------

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn base64(b: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(b.len().div_ceil(3) * 4);
    for chunk in b.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// SHA-256 (FIPS 180-4), for the big icon fixtures.
fn sha256(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for block in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes(block[i * 4..i * 4 + 4].try_into().unwrap());
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            (hh, g, f, e, d, c, b, a) = (g, f, e, d.wrapping_add(t1), c, b, a, t1.wrapping_add(t2));
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *x = x.wrapping_add(y);
        }
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}

/// The recorder's form of a file or body: hex up to `small` bytes, else
/// `sha256:<hex>:<length>`.
fn digest(b: &[u8], small: usize) -> String {
    if b.len() <= small {
        hex(b)
    } else {
        format!("sha256:{}:{}", sha256(b), b.len())
    }
}

// ---- the helper sections ------------------------------------------------------

#[test]
fn base64_matches_node() {
    let fx = fixture();
    let cases = fx["base64"].as_array().unwrap();
    assert!(cases.len() >= 400);
    for c in cases {
        let s = c["s"].as_str().unwrap();
        assert_eq!(hex(&base64_decode(s)), c["hex"].as_str().unwrap(), "{s:?}");
    }
}

#[test]
fn buffer_from_matches_node() {
    let fx = fixture();
    for c in fx["bufferFrom"].as_array().unwrap() {
        let got = buffer_from(&c["value"], usize::MAX);
        match (got, c.get("hex"), c.get("threw")) {
            (Ok(buf), Some(want), None) => {
                assert_eq!(digest(&buf, 64), want.as_str().unwrap(), "{}", c["value"]);
            }
            (Err(BufferError::Throws(msg)), None, Some(want)) => {
                assert!(want.as_str().unwrap().starts_with(msg), "{msg} / {want}");
            }
            (got, _, _) => panic!("{}: {got:?} vs {c}", c["value"]),
        }
    }
    // An array-like past the limit is refused before it is allocated.
    assert_eq!(
        buffer_from(&json!({"length": 1e15}), 2 << 20),
        Err(BufferError::TooLarge)
    );
    // ... but its elements convert (and throw) first, as in TS.
    assert!(matches!(
        buffer_from(&json!({"length": 1e15, "7": {"toString": 1}}), 2 << 20),
        Err(BufferError::Throws(_))
    ));
}

#[test]
fn cookie_header_parses_like_next() {
    let fx = fixture();
    for c in fx["cookies"].as_array().unwrap() {
        let header = c["header"].as_str().unwrap();
        let got = parse_cookie_header(header)
            .into_iter()
            .find(|(n, _)| n == "claudius.workspace")
            .map(|(_, v)| v);
        assert_eq!(got.as_deref(), c["value"].as_str(), "{header:?}");
    }
}

// ---- the replay ---------------------------------------------------------------

struct Got {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Got {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
    fn all(&self, name: &str) -> Vec<String> {
        self.headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.clone())
            .collect()
    }
}

/// One HTTP/1.1 request; `cookie` and `body` are sent as raw bytes.
fn request(port: u16, method: &str, path: &str, cookie: Option<&[u8]>, body: Option<&[u8]>) -> Got {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n")
        .into_bytes();
    if let Some(c) = cookie {
        req.extend_from_slice(b"Cookie: ");
        req.extend_from_slice(c);
        req.extend_from_slice(b"\r\n");
    }
    let body = body.unwrap_or(b"");
    req.extend_from_slice(
        format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .as_bytes(),
    );
    req.extend_from_slice(body);
    s.write_all(&req).unwrap();
    let mut out = Vec::new();
    s.read_to_end(&mut out).unwrap();
    let split = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head: String = out[..split].iter().map(|&b| char::from(b)).collect();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    let mut body = out[split + 4..].to_vec();
    if headers
        .iter()
        .any(|(k, v)| k == "transfer-encoding" && v.contains("chunked"))
    {
        let mut plain = Vec::new();
        let mut rest = &body[..];
        loop {
            let eol = rest.windows(2).position(|w| w == b"\r\n").unwrap();
            let size = usize::from_str_radix(std::str::from_utf8(&rest[..eol]).unwrap().trim(), 16)
                .unwrap();
            if size == 0 {
                break;
            }
            plain.extend_from_slice(&rest[eol + 2..eol + 2 + size]);
            rest = &rest[eol + 2 + size + 2..];
        }
        body = plain;
    }
    Got {
        status,
        headers,
        body,
    }
}

const STAMP_PREFIX: &str = "workspaces.json.bak.";

/// `<file>.bak.<ISO stamp with [:.] → ->`, the names the store writes.
fn is_stamped(name: &str) -> bool {
    let Some(s) = name.strip_prefix(STAMP_PREFIX) else {
        return false;
    };
    let b = s.as_bytes();
    let pattern = b"dddd-dd-ddTdd-dd-dd-dddZ";
    b.len() == pattern.len()
        && b.iter().zip(pattern).all(|(c, p)| match p {
            b'd' => c.is_ascii_digit(),
            p => c == p,
        })
}

fn stamp(ms: i64) -> String {
    let t = chrono::DateTime::from_timestamp_millis(ms).unwrap();
    format!("{STAMP_PREFIX}{}", t.format("%Y-%m-%dT%H-%M-%S-%3fZ"))
}

/// What the recorder saw on disk.
struct Disk {
    store: Option<Vec<u8>>,
    icons: Value,
    claudius: Value,
    baks: Vec<String>,
}

fn names(dir: &Path) -> Option<Vec<String>> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    v.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Some(v)
}

fn snapshot(claudius: &Path) -> Disk {
    let icons_dir = claudius.join("workspace-icons");
    let icons = match names(&icons_dir) {
        None => Value::Null,
        Some(ns) => {
            let mut m = Map::new();
            for n in ns {
                let p = icons_dir.join(&n);
                let st = std::fs::symlink_metadata(&p).unwrap();
                let v = if st.is_dir() {
                    "dir".to_owned()
                } else if st.file_type().is_symlink() {
                    "link".to_owned()
                } else {
                    digest(&std::fs::read(&p).unwrap(), 32)
                };
                m.insert(n, json!(v));
            }
            Value::Object(m)
        }
    };
    let all = names(claudius);
    let claudius_names = match &all {
        None => Value::Null,
        Some(ns) => json!(
            ns.iter()
                .filter(|n| !n.starts_with(STAMP_PREFIX) && *n != "workspace-icons")
                .collect::<Vec<_>>()
        ),
    };
    Disk {
        store: std::fs::read(claudius.join("workspaces.json")).ok(),
        icons,
        claudius: claudius_names,
        baks: all
            .unwrap_or_default()
            .into_iter()
            .filter(|n| n.starts_with(STAMP_PREFIX))
            .collect(),
    }
}

/// The replay's translation of recorded text: the temp root, generated ids
/// and request times.
#[derive(Default)]
struct Mapping {
    root: String,
    ids: Vec<(String, String)>,
    clocks: Vec<(String, String)>,
    /// Real U+10F800..U+10FFFF characters met in recorded output.
    stand_ins: std::cell::Cell<usize>,
}

impl Mapping {
    fn text(&self, s: &str) -> String {
        let mut s = s.replace("$ROOT", &self.root);
        for (ts, rs) in &self.ids {
            s = s
                .replace(ts, rs)
                .replace(&ts.replacen('_', "%5F", 1), &rs.replacen('_', "%5F", 1));
        }
        for (c, r) in &self.clocks {
            s = s.replace(c, r);
        }
        s
    }

    /// [`Mapping::text`] for JSON, plus the letter-icon colour of each
    /// generated id. The text is re-serialized the way it was written (it
    /// must round-trip exactly, or it is left as mapped).
    fn json(&self, recorded: &str) -> String {
        // The one known difference of `js_string`: a real character in
        // U+10F800..U+10FFFF reads as the lone surrogate it stands for, so
        // text this port writes (it re-serializes as itself) has that escape
        // instead. A verbatim copy (a backup of a hand-written file) keeps it.
        let escaped: String = recorded
            .chars()
            .map(|c| match js_string::lone_unit(c) {
                Some(u) => format!("\\u{u:04x}"),
                None => c.to_string(),
            })
            .collect();
        let rewritten = js_string::parse(&escaped).is_ok_and(|v| {
            let pretty = js_string::stringify_pretty(&v);
            [format!("{pretty}\n"), pretty, js_string::stringify(&v)].contains(&escaped)
        });
        let recorded = if escaped != recorded && rewritten {
            self.stand_ins.set(self.stand_ins.get() + 1);
            escaped.as_str()
        } else {
            recorded
        };
        let mapped = self.text(recorded);
        if !self
            .ids
            .iter()
            .any(|(ts, _)| recorded.contains(ts.as_str()))
        {
            return mapped;
        }
        let Ok(mut v) = js_string::parse(&mapped) else {
            return mapped;
        };
        let pretty = js_string::stringify_pretty(&v);
        let format: fn(&Value) -> String = if format!("{pretty}\n") == mapped {
            |v| format!("{}\n", js_string::stringify_pretty(v))
        } else if pretty == mapped {
            js_string::stringify_pretty
        } else if js_string::stringify(&v) == mapped {
            js_string::stringify
        } else {
            return mapped;
        };
        self.recolor(&mut v);
        format(&v)
    }

    fn recolor(&self, v: &mut Value) {
        match v {
            Value::Array(items) => items.iter_mut().for_each(|i| self.recolor(i)),
            Value::Object(m) => {
                if let Some(Value::String(id)) = m.get("id")
                    && let Some((ts, rs)) = self.ids.iter().find(|(_, rs)| rs == id)
                    && let Some(Value::Object(icon)) = m.get_mut("icon")
                    && icon.get("kind") == Some(&json!("letter"))
                    && icon.get("color") == Some(&default_letter_icon("", ts)["color"])
                {
                    icon.insert("color".into(), default_letter_icon("", rs)["color"].clone());
                }
                m.values_mut().for_each(|x| self.recolor(x));
            }
            _ => {}
        }
    }
}

/// Every number in `got` where `want` has `clock`.
fn clock_values(want: &Value, got: &Value, clock: f64, out: &mut Vec<f64>) {
    match (want, got) {
        (Value::Number(w), Value::Number(g)) if w.as_f64() == Some(clock) => {
            out.extend(g.as_f64());
        }
        (Value::Array(w), Value::Array(g)) => {
            for (w, g) in w.iter().zip(g) {
                clock_values(w, g, clock, out);
            }
        }
        (Value::Object(w), Value::Object(g)) => {
            for (k, w) in w {
                if let Some(g) = g.get(k) {
                    clock_values(w, g, clock, out);
                }
            }
        }
        _ => {}
    }
}

/// Recorded cases this port answers differently, on purpose.
fn expected_difference(step: &Value) -> Option<&'static str> {
    let path = step["path"].as_str().unwrap_or("");
    let body = step["body"].as_str().unwrap_or("");
    if path.contains("/..%2F") {
        // `writeIcon` joins `<id>.<ext>` onto the icon dir, so this id
        // writes `.claudius/escape.png` in TS. The port refuses any icon
        // path outside the dir: a 500, nothing written.
        Some("escape")
    } else if body.contains("\"rootPath\":1e400") {
        // `1e400` is Infinity in JS, and `(Infinity).trim()` throws; a
        // `Value` holds it as null, which is "rootPath required".
        Some("infinity")
    } else {
        None
    }
}

#[test]
fn replays_the_ts_golden() {
    let fx = fixture();
    let world = World::new();
    let root = world
        .project
        .parent()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let claudius = world.home.join(".claude/.claudius");
    let server = Server::spawn(&world, &[]);
    let mut map = Mapping {
        root: root.clone(),
        ..Mapping::default()
    };
    let real_bytes = |b: Vec<u8>| -> Vec<u8> {
        let (needle, with) = (b"$ROOT".as_slice(), root.as_bytes());
        let mut out = Vec::with_capacity(b.len());
        let mut i = 0;
        while i < b.len() {
            if b[i..].starts_with(needle) {
                out.extend_from_slice(with);
                i += needle.len();
            } else {
                out.push(b[i]);
                i += 1;
            }
        }
        out
    };
    let year_ms = 31_536_000_000i64;
    let mut last = snapshot(&claudius);
    let mut failures: Vec<String> = vec![];
    let mut fail = |i: usize, what: String| failures.push(format!("step {i}: {what}"));
    let (mut requests, mut differences) = (0, 0);

    for (i, s) in fx["steps"].as_array().unwrap().iter().enumerate() {
        match s["op"].as_str().unwrap() {
            "fs" => {
                let p = PathBuf::from(map.text(s["path"].as_str().unwrap()));
                match s["act"].as_str().unwrap() {
                    "write" => {
                        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                        let bytes = match s.get("hex") {
                            Some(h) => real_bytes(unhex(h.as_str().unwrap())),
                            None => map.text(s["text"].as_str().unwrap()).into_bytes(),
                        };
                        std::fs::write(&p, bytes).unwrap();
                    }
                    "mkdir" => std::fs::create_dir_all(&p).unwrap(),
                    "rm" => match std::fs::symlink_metadata(&p) {
                        Ok(m) if m.is_dir() => std::fs::remove_dir_all(&p).unwrap(),
                        Ok(_) => std::fs::remove_file(&p).unwrap(),
                        Err(_) => {}
                    },
                    "symlink" => {
                        std::os::unix::fs::symlink(map.text(s["target"].as_str().unwrap()), &p)
                            .unwrap()
                    }
                    "chmod" => {
                        let mode = s["mode"].as_u64().unwrap() as u32;
                        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode))
                            .unwrap();
                    }
                    other => panic!("fs {other}"),
                }
                last = snapshot(&claudius);
                continue;
            }
            "baks" => {
                let mut got = vec![];
                for n in &last.baks {
                    let p = claudius.join(n);
                    let mut e = Map::new();
                    if !is_stamped(n) {
                        e.insert("name".into(), json!(n));
                    }
                    if std::fs::symlink_metadata(&p).unwrap().is_dir() {
                        e.insert("dir".into(), json!(true));
                    } else {
                        let text =
                            String::from_utf8_lossy(&std::fs::read(&p).unwrap()).into_owned();
                        e.insert("text".into(), json!(text));
                    }
                    got.push(Value::Object(e));
                }
                let want: Vec<Value> = s["got"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|e| {
                        let mut e = e.as_object().unwrap().clone();
                        if let Some(Value::String(t)) = e.get("text") {
                            let t = map.json(t);
                            e.insert("text".into(), json!(t));
                        }
                        Value::Object(e)
                    })
                    .collect();
                if got != want {
                    fail(
                        i,
                        format!("backups\n got {}\nwant {}", json!(got), json!(want)),
                    );
                }
                continue;
            }
            "req" => {}
            other => panic!("op {other}"),
        }
        requests += 1;
        let method = s["method"].as_str().unwrap();
        let path = map.text(s["path"].as_str().unwrap());
        let cookie: Option<Vec<u8>> = match (s.get("cookie"), s.get("cookies")) {
            (Some(c), _) => Some(map.text(c.as_str().unwrap())),
            (None, Some(cs)) => Some(
                cs.as_array()
                    .unwrap()
                    .iter()
                    .map(|c| map.text(c.as_str().unwrap()))
                    .collect::<Vec<_>>()
                    .join("; "),
            ),
            _ => None,
        }
        .map(|c| {
            // A JS header string goes on the wire as latin1.
            c.chars()
                .map(|ch| u8::try_from(u32::from(ch)).expect("latin1 cookie"))
                .collect()
        });
        let body: Option<Vec<u8>> = if let Some(b) = s.get("body") {
            Some(map.text(b.as_str().unwrap()).into_bytes())
        } else if let Some(h) = s.get("bodyHex") {
            Some(real_bytes(unhex(h.as_str().unwrap())))
        } else if let Some(g) = s.get("gen") {
            let size = g["size"].as_u64().unwrap() as usize;
            Some(if g["kind"] == "array" {
                format!("{{\"data\":[{}]}}", vec!["0"; size].join(",")).into_bytes()
            } else {
                let mut buf = vec![0u8; size];
                let magic: &[u8] = match g["magic"].as_str().unwrap() {
                    "png" => &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
                    "jpg" => &[0xff, 0xd8, 0xff],
                    other => panic!("magic {other}"),
                };
                buf[..magic.len()].copy_from_slice(magic);
                format!("{{\"data\":\"{}\"}}", base64(&buf)).into_bytes()
            })
        } else {
            None
        };

        std::thread::sleep(Duration::from_millis(2));
        let t0 = now_ms();
        let got = request(
            server.port,
            method,
            &path,
            cookie.as_deref(),
            body.as_deref(),
        );
        let t1 = now_ms();
        let now = snapshot(&claudius);
        let want = &s["got"];
        let clock = s["clock"].as_i64().unwrap();
        let clock_text = clock.to_string();
        let difference = expected_difference(s);
        if difference.is_some() {
            differences += 1;
        }

        // Generated ids, in creation order.
        if method == "POST" && s["path"] == "/api/workspaces" && want["status"] == 201 {
            let ts_id = js_string::parse(want["body"].as_str().unwrap()).unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let rs_id = js_string::parse(&String::from_utf8_lossy(&got.body))
                .ok()
                .and_then(|v| v["id"].as_str().map(str::to_owned));
            match rs_id {
                Some(id)
                    if id.len() == 16
                        && id.starts_with("wks_")
                        && id[4..]
                            .bytes()
                            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) =>
                {
                    map.ids.push((ts_id, id));
                }
                other => fail(i, format!("no generated id: {other:?}")),
            }
        }

        // The request's time: learnt from the body, else the store.
        let candidates: Vec<(String, Vec<u8>)> = [
            want.get("body")
                .and_then(Value::as_str)
                .map(|w| (w.to_owned(), got.body.clone())),
            s.get("store")
                .and_then(Value::as_str)
                .map(|w| (w.to_owned(), now.store.clone().unwrap_or_default())),
        ]
        .into_iter()
        .flatten()
        .collect();
        for (w, g) in candidates {
            if !w.contains(&clock_text) || map.clocks.iter().any(|(c, _)| *c == clock_text) {
                continue;
            }
            let (Ok(wv), Ok(gv)) = (
                js_string::parse(&map.json(&w)),
                js_string::parse(&String::from_utf8_lossy(&g)),
            ) else {
                continue;
            };
            let mut seen = vec![];
            clock_values(&wv, &gv, clock as f64, &mut seen);
            seen.dedup();
            match seen.as_slice() {
                [r] if (t0 as f64..=t1 as f64).contains(r) => {
                    map.clocks
                        .push((clock_text.clone(), (*r as i64).to_string()));
                }
                other => fail(
                    i,
                    format!("request time {other:?} not one value in [{t0}, {t1}]"),
                ),
            }
        }

        // The response.
        let label = format!("{method} {path}");
        if difference == Some("escape") {
            if (got.status, got.body.is_empty()) != (500, true) {
                fail(i, format!("{label}: {} (want the refusal 500)", got.status));
            }
        } else if difference == Some("infinity") {
            if (got.status, got.body.as_slice())
                != (400, br#"{"error":"rootPath required"}"#.as_slice())
            {
                fail(
                    i,
                    format!(
                        "{label}: {} {}",
                        got.status,
                        String::from_utf8_lossy(&got.body)
                    ),
                );
            }
        } else if want.get("threw").is_some() {
            if (got.status, got.body.is_empty(), got.header("content-type")) != (500, true, None) {
                fail(
                    i,
                    format!(
                        "{label}: {} {} (want the bare 500: {})",
                        got.status,
                        String::from_utf8_lossy(&got.body),
                        want["threw"]
                    ),
                );
            }
        } else {
            let status = want["status"].as_u64().unwrap() as u16;
            if got.status != status {
                fail(
                    i,
                    format!(
                        "{label}: status {} != {status} ({})",
                        got.status,
                        String::from_utf8_lossy(&got.body)
                    ),
                );
            }
            if got.header("content-type") != want["type"].as_str() {
                fail(
                    i,
                    format!(
                        "{label}: content-type {:?} != {}",
                        got.header("content-type"),
                        want["type"]
                    ),
                );
            }
            for (key, name) in [("cache", "cache-control"), ("length", "content-length")] {
                if let Some(w) = want.get(key)
                    && got.header(name) != w.as_str()
                {
                    fail(i, format!("{label}: {name} {:?} != {w}", got.header(name)));
                }
            }
            if want.get("cache").is_none() && got.header("cache-control").is_some() {
                fail(i, format!("{label}: unexpected cache-control"));
            }
            // Set-Cookie, with Expires checked against the request time.
            let want_cookies: Vec<String> = want
                .get("cookies")
                .and_then(Value::as_array)
                .map(|cs| cs.iter().map(|c| map.text(c.as_str().unwrap())).collect())
                .unwrap_or_default();
            let mut got_cookies = got.all("set-cookie");
            if got_cookies.len() == want_cookies.len() {
                for (g, w) in got_cookies.iter_mut().zip(&want_cookies) {
                    let date = |c: &str| {
                        c.split("Expires=")
                            .nth(1)
                            .map(|r| r.split(';').next().unwrap().to_owned())
                    };
                    if let (Some(gd), Some(wd)) = (date(g), date(w))
                        && !wd.contains("1970")
                    {
                        if wd != utc_string(clock + year_ms) {
                            fail(
                                i,
                                format!("recorded Expires {wd} isn't toUTCString of the clock"),
                            );
                        }
                        let ok = ((t0 + year_ms) / 1000..=(t1 + year_ms) / 1000)
                            .any(|sec| utc_string(sec * 1000) == gd);
                        if !ok {
                            fail(
                                i,
                                format!("{label}: Expires {gd} not a year after the request"),
                            );
                        }
                        *g = g.replace(&gd, &wd);
                    }
                }
            }
            if got_cookies != want_cookies {
                fail(
                    i,
                    format!("{label}: set-cookie\n got {got_cookies:?}\nwant {want_cookies:?}"),
                );
            }
            let others: Vec<&String> = got
                .headers
                .iter()
                .map(|(k, _)| k)
                .filter(|k| {
                    ![
                        "content-type",
                        "content-length",
                        "set-cookie",
                        "cache-control",
                        "date",
                        "connection",
                    ]
                    .contains(&k.as_str())
                })
                .collect();
            if !others.is_empty() {
                fail(i, format!("{label}: extra headers {others:?}"));
            }
            if let Some(w) = want.get("body") {
                let w = map.json(w.as_str().unwrap());
                let g = String::from_utf8_lossy(&got.body);
                if g != w {
                    fail(i, format!("{label}: body\n got {g}\nwant {w}"));
                }
            } else if let Some(w) = want.get("hex") {
                if hex(&got.body) != w.as_str().unwrap() {
                    fail(i, format!("{label}: bytes {} != {w}", hex(&got.body)));
                }
            } else if let Some(w) = want.get("sha256") {
                if digest(&got.body, 0) != format!("sha256:{}", w.as_str().unwrap()) {
                    fail(i, format!("{label}: bytes {}", digest(&got.body, 0)));
                }
            }
        }

        // The disk.
        match s.get("store") {
            None => {
                if now.store != last.store {
                    fail(
                        i,
                        format!(
                            "{label}: store changed\n{}",
                            String::from_utf8_lossy(now.store.as_deref().unwrap_or(b"(gone)"))
                        ),
                    );
                }
            }
            Some(Value::Null) => {
                if now.store.is_some() {
                    fail(i, format!("{label}: store should be gone"));
                }
            }
            Some(w) => {
                let w = map.json(w.as_str().unwrap());
                let g = now.store.as_deref().map(String::from_utf8_lossy);
                if g.as_deref() != Some(w.as_str()) {
                    fail(i, format!("{label}: store\n got {g:?}\nwant {w}"));
                }
            }
        }
        if now.baks.len() as u64 != s["baks"].as_u64().unwrap() {
            fail(
                i,
                format!("{label}: {} backups != {}", now.baks.len(), s["baks"]),
            );
        }
        let fresh: Vec<&String> = now.baks.iter().filter(|n| !last.baks.contains(n)).collect();
        let want_fresh = s
            .get("bak")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if fresh.len() != want_fresh.len() {
            fail(
                i,
                format!("{label}: new backups {fresh:?} vs {want_fresh:?}"),
            );
        }
        for w in &want_fresh {
            if w.as_str() != Some(stamp(clock).as_str()) {
                fail(i, format!("recorded backup {w} isn't the clock's stamp"));
            }
        }
        for n in &fresh {
            if !(t0..=t1).any(|t| **n == stamp(t)) {
                fail(
                    i,
                    format!("{label}: backup {n} not stamped within the request"),
                );
            }
        }
        let want_icons = match s.get("icons") {
            None => last.icons.clone(),
            Some(w) => js_string::parse(&map.text(&js_string::stringify(w))).unwrap(),
        };
        if now.icons != want_icons {
            fail(
                i,
                format!("{label}: icons\n got {}\nwant {}", now.icons, want_icons),
            );
        }
        let want_claudius = match s.get("claudius") {
            Some(w) if difference != Some("escape") => w.clone(),
            _ => last.claudius.clone(),
        };
        if now.claudius != want_claudius {
            fail(
                i,
                format!("{label}: .claudius {} != {}", now.claudius, want_claudius),
            );
        }
        last = now;
    }
    assert!(requests >= 400, "{requests} requests");
    assert!(
        failures.is_empty(),
        "{} failures:\n{}",
        failures.len(),
        failures
            .iter()
            .take(40)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n\n")
    );
    assert_eq!(differences, 2);
    assert!(map.stand_ins.get() > 0, "the U+10FFFF case wasn't met");
}

#[test]
fn other_methods_answer_405() {
    let world = World::new();
    let server = Server::spawn(&world, &[]);
    for (method, path) in [
        ("PUT", "/api/workspaces"),
        ("DELETE", "/api/workspaces"),
        ("GET", "/api/workspaces/reorder"),
        ("PUT", "/api/workspaces/x"),
        ("POST", "/api/workspaces/x"),
        ("GET", "/api/workspaces/x/select"),
        ("DELETE", "/api/workspaces/x/icon"),
        ("POST", "/api/workspaces/x/roots"),
    ] {
        let got = request(server.port, method, path, None, None);
        assert_eq!(got.status, 405, "{method} {path}");
    }
}

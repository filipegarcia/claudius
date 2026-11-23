//! `GET /api/assets`, `GET`/`DELETE /api/assets/:hash`,
//! `GET /api/assets/:hash/uses` and `GET /api/local-image` against the real
//! binary, replaying the `assets` and `localImage` parts of
//! `claudius-core/tests/fixtures/assets_golden.json` (recorded by
//! `rust/scripts/assets-golden.mjs` from the real TS route handlers): the
//! same setup in a fresh temp root (`{PH}`, its canonical path) and a fresh
//! dir under `/tmp` (`{TP}`), the same requests in order, and every answer
//! must have the same status, `Content-Type`, `Cache-Control`, the
//! `Content-Length` the handler set (if it did) and the same body bytes.
//! A recorded throw is Next's empty 500.
//!
//! Each `localImage` world is its own server, started with that world's
//! `TMPDIR`/`TMP`/`TEMP` (the roots are taken once). Steps marked `darwin`
//! need macOS's `/tmp -> /private/tmp` link and only run there; the
//! unreadable-file step is skipped where the file stays readable (root).
#![cfg(unix)]

mod common;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use claudius_core::asset_store::sha256_hex;
use claudius_core::db::{Mode, open_path};
use claudius_core::paths::encode_project_dir;
use common::{Server, World, fake_bin, free_port, http, wait_until};
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../claudius-core/tests/fixtures/assets_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn base64(b: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = (u32::from(c[0]) << 16)
            | (u32::from(*c.get(1).unwrap_or(&0)) << 8)
            | u32::from(*c.get(2).unwrap_or(&0));
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            out.push(if i <= c.len() {
                char::from(A[(n >> shift) as usize & 63])
            } else {
                '='
            });
        }
    }
    out
}

/// `encodeURIComponent`.
fn uri_component(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// The recorder's placeholders, for this run's paths.
struct Places {
    ph: String,
    tp: String,
}

impl Places {
    fn fill(&self, s: &str) -> String {
        let tpname = self.tp.strip_prefix("/tmp/").unwrap();
        s.replace("{PHQ}", &uri_component(&self.ph))
            .replace("{PHENC}", &encode_project_dir(&self.ph))
            .replace("{PH}", &self.ph)
            .replace("{TPQ}", &uri_component(&self.tp))
            .replace("{TPNAME}", tpname)
            .replace("{TP}", &self.tp)
    }

    fn path(&self, rel: &str) -> PathBuf {
        let p = self.fill(rel);
        if p.starts_with('/') {
            PathBuf::from(p)
        } else {
            Path::new(&self.ph).join(p)
        }
    }
}

/// A temp root named like the recorder's (no dot in it), canonical, and a
/// dir under `/tmp` as spelled.
fn roots() -> (tempfile::TempDir, tempfile::TempDir, Places) {
    let root = tempfile::Builder::new()
        .prefix("assets-golden-")
        .tempdir()
        .unwrap();
    let tp = tempfile::Builder::new()
        .prefix("assets-golden-tmp-")
        .tempdir_in("/tmp")
        .unwrap();
    let places = Places {
        ph: root.path().canonicalize().unwrap().display().to_string(),
        tp: tp.path().display().to_string(),
    };
    (root, tp, places)
}

fn world(places: &Places, root: tempfile::TempDir) -> World {
    let ph = PathBuf::from(&places.ph);
    let (home, config, project) = (ph.join("rhome"), ph.join("config"), ph.join("project"));
    for d in [&home, &config, &project] {
        std::fs::create_dir_all(d).unwrap();
    }
    World {
        root,
        home,
        config,
        project,
    }
}

/// [`Server::spawn`] with `env` set and every `None` removed.
fn spawn(world: &World, env: &[(&str, Option<String>)]) -> Server {
    let port = free_port();
    let mut cmd = Command::new(common::server_bin());
    cmd.args(["--port", &port.to_string(), "--no-next", "--claude-bin"])
        .arg(fake_bin())
        .current_dir(&world.project)
        .env_remove("RUST_LOG")
        .env_remove("CLAUDIUS_DEBUG_SESSIONS")
        .env_remove("NODE_ENV")
        .env_remove("CLAUDIUS_DEV")
        .env_remove("CLAUDIUS_SCHEDULER")
        .env("CLAUDIUS_STATE_HOME", &world.home)
        .env("CLAUDE_CONFIG_DIR", &world.config)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (k, v) in env {
        match v {
            Some(v) => cmd.env(k, v),
            None => cmd.env_remove(k),
        };
    }
    let child = cmd.spawn().unwrap();
    let server = Server { child, port };
    wait_until("health", Duration::from_secs(20), || {
        TcpStream::connect(("127.0.0.1", port)).is_ok()
            && http(port, "GET", "/api/rust/health", "").0 == 200
    });
    server
}

struct Answer {
    status: u16,
    headers: Vec<(String, Vec<u8>)>,
    body: Vec<u8>,
}

impl Answer {
    fn header(&self, name: &str) -> Option<String> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.iter().map(|&b| char::from(b)).collect())
    }
}

fn request(port: u16, method: &str, url: &str) -> Answer {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        s,
        "{method} {url} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut out = Vec::new();
    s.read_to_end(&mut out).unwrap();
    let at = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&out[..at]).into_owned();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers: Vec<(String, Vec<u8>)> = out[..at]
        .split(|&b| b == b'\n')
        .skip(1)
        .filter_map(|l| {
            let l = l.strip_suffix(b"\r").unwrap_or(l);
            let c = l.iter().position(|&b| b == b':')?;
            let v = &l[c + 1..];
            let v = v.strip_prefix(b" ").unwrap_or(v);
            Some((String::from_utf8_lossy(&l[..c]).into_owned(), v.to_vec()))
        })
        .collect();
    let mut body = out[at + 4..].to_vec();
    let chunked = headers.iter().any(|(k, v)| {
        k.eq_ignore_ascii_case("transfer-encoding") && v.eq_ignore_ascii_case(b"chunked")
    });
    if chunked {
        let mut dec = Vec::new();
        let mut rest = &body[..];
        loop {
            let nl = rest.windows(2).position(|w| w == b"\r\n").unwrap();
            let n = usize::from_str_radix(std::str::from_utf8(&rest[..nl]).unwrap().trim(), 16)
                .unwrap();
            if n == 0 {
                break;
            }
            dec.extend_from_slice(&rest[nl + 2..nl + 2 + n]);
            rest = &rest[nl + 2 + n + 2..];
        }
        body = dec;
    }
    Answer {
        status,
        headers,
        body,
    }
}

/// The differences between `got` and the recorded answer `want`.
fn compare(places: &Places, want: &Value, got: &Answer, wire_refused: bool) -> Option<String> {
    let s = |v: &Value| v.as_str().map(str::to_owned);
    if want["threw"] == true || wire_refused {
        return (got.status != 500 || !got.body.is_empty())
            .then(|| format!("want Next's empty 500, got {}", got.status));
    }
    let mut diffs = vec![];
    if json!(got.status) != want["status"] {
        diffs.push(format!("status {} != {}", got.status, want["status"]));
    }
    if got.header("content-type") != s(&want["type"]) {
        diffs.push(format!(
            "content-type {:?} != {}",
            got.header("content-type"),
            want["type"]
        ));
    }
    if got.header("cache-control") != s(&want["cache"]) {
        diffs.push(format!(
            "cache-control {:?} != {}",
            got.header("cache-control"),
            want["cache"]
        ));
    }
    if !want["length"].is_null() && got.header("content-length") != s(&want["length"]) {
        diffs.push(format!(
            "content-length {:?} != {}",
            got.header("content-length"),
            want["length"]
        ));
    }
    if let Some(text) = want["body"].as_str() {
        if String::from_utf8_lossy(&got.body) != places.fill(text) {
            diffs.push(format!(
                "body {:?} != {text:?}",
                String::from_utf8_lossy(&got.body)
            ));
        }
    } else if let Some(h) = want["hex"].as_str() {
        if hex(&got.body) != h {
            diffs.push(format!(
                "body {} != {h}",
                hex(&got.body[..got.body.len().min(64)])
            ));
        }
    } else if (json!(got.body.len()), json!(sha256_hex(&got.body)))
        != (want["len"].clone(), want["sha"].clone())
    {
        diffs.push(format!(
            "body of {} bytes != {} bytes",
            got.body.len(),
            want["len"]
        ));
    }
    (!diffs.is_empty()).then(|| diffs.join("; "))
}

/// The recorder's user transcript line holding one base64 image.
fn image_line(uuid: &str, timestamp: &str, data: &str) -> String {
    let line = json!({
        "type": "user",
        "uuid": uuid,
        "timestamp": timestamp,
        "message": {"role": "user", "content": [{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": data}}]},
    });
    format!("{line}\n")
}

#[test]
fn asset_routes_replay_the_ts_golden() {
    let fx = fixture();
    let (root, _tp, places) = roots();
    let world = world(&places, root);
    let server = spawn(
        &world,
        &[("TZ", fx["assets"]["tz"].as_str().map(str::to_owned))],
    );
    let mut failures = vec![];
    for (i, st) in fx["assets"]["steps"].as_array().unwrap().iter().enumerate() {
        let path = || places.path(st["path"].as_str().unwrap());
        match st["op"].as_str().unwrap() {
            "file" | "jsonl" => {
                std::fs::create_dir_all(path().parent().unwrap()).unwrap();
                std::fs::write(path(), places.fill(st["text"].as_str().unwrap())).unwrap();
            }
            "bigjsonl" => {
                let mut bytes = unhex(st["seed"].as_str().unwrap());
                let n = st["n"].as_u64().unwrap() as usize;
                bytes.extend((0..n).map(|i| (i.wrapping_mul(7) + 3) as u8));
                std::fs::create_dir_all(path().parent().unwrap()).unwrap();
                let line = image_line(
                    st["uuid"].as_str().unwrap(),
                    st["timestamp"].as_str().unwrap(),
                    &base64(&bytes),
                );
                std::fs::write(path(), line).unwrap();
            }
            "mkdir" => std::fs::create_dir_all(path()).unwrap(),
            "rm" => std::fs::remove_file(path()).unwrap(),
            "exists" => {
                if json!(path().exists()) != st["got"] {
                    failures.push(format!("#{i} exists {} != {}", path().display(), st["got"]));
                }
            }
            "sql" => {
                let cwd = places.fill(st["cwd"].as_str().unwrap());
                let db = world
                    .home
                    .join(".claude/projects")
                    .join(encode_project_dir(&cwd))
                    .join(".claudius.db");
                open_path(&db, Mode::ReadWrite)
                    .unwrap()
                    .execute_batch(st["sql"].as_str().unwrap())
                    .unwrap();
            }
            "req" => {
                let url = places.fill(st["url"].as_str().unwrap());
                let got = request(server.port, st["method"].as_str().unwrap(), &url);
                if let Some(d) = compare(&places, &st["got"], &got, st["wireRefused"] == true) {
                    failures.push(format!("#{i} {} {}: {d}", st["method"], st["url"]));
                }
            }
            other => panic!("unknown step {other}"),
        }
    }
    let (status, _, _) = server.stop(Duration::from_secs(10));
    assert!(status.success() || status.code().is_none());
    assert!(
        failures.is_empty(),
        "{} failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn local_image_replays_the_ts_golden() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let fx = fixture();
    let (root, _tp, places) = roots();
    let world = world(&places, root);
    let li = &fx["localImage"];
    let mut locked = None;
    for item in li["setup"].as_array().unwrap() {
        let kind = item[0].as_str().unwrap();
        let p = places.path(item[1].as_str().unwrap());
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        match kind {
            "file" => std::fs::write(&p, unhex(item[2].as_str().unwrap())).unwrap(),
            "locked" => {
                std::fs::write(&p, unhex(item[2].as_str().unwrap())).unwrap();
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o000)).unwrap();
                locked = Some(p);
            }
            "dir" => std::fs::create_dir_all(&p).unwrap(),
            "fifo" => assert!(Command::new("mkfifo").arg(&p).status().unwrap().success()),
            "big" => std::fs::File::create(&p)
                .unwrap()
                .set_len(item[2].as_u64().unwrap())
                .unwrap(),
            "link" => symlink(places.fill(item[2].as_str().unwrap()), &p).unwrap(),
            other => panic!("unknown setup {other}"),
        }
    }
    // Root reads a mode-0 file: that step can't be replayed there.
    let locked_readable = locked.as_ref().is_some_and(|p| std::fs::read(p).is_ok());
    let mut failures = vec![];
    let mut ran = 0;
    for w in li["worlds"].as_array().unwrap() {
        let env: Vec<(&str, Option<String>)> = w["env"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str().map(|v| places.fill(v))))
            .collect();
        let server = spawn(&world, &env);
        for st in w["steps"].as_array().unwrap() {
            if (st["darwin"] == true && !cfg!(target_os = "macos"))
                || (st["locked"] == true && locked_readable)
            {
                continue;
            }
            ran += 1;
            let url = places.fill(st["url"].as_str().unwrap());
            let got = request(server.port, "GET", &url);
            if let Some(d) = compare(&places, &st["got"], &got, false) {
                failures.push(format!("{} {}: {d}", w["name"], st["url"]));
            }
        }
        server.stop(Duration::from_secs(10));
    }
    if let Some(p) = &locked {
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    assert!(ran > 80, "{ran}");
    assert!(
        failures.is_empty(),
        "{} failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// `POST /api/sessions/:id/input` with images hands them to
/// `recordSendUses` (asset-ingest) before it decides to send or queue: one
/// use row per image under the message's uuid (an image's own `ordinal`,
/// else its position), the bytes in the store, the dimensions on the row.
/// A message without images records nothing.
#[test]
fn input_images_go_to_the_asset_store() {
    let world = World::new();
    let server = Server::spawn(&world, &[]);
    let id = server.create_session(&world);
    let _sse = server.open_stream(&id);
    let mut png = vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
    png.extend(13u32.to_be_bytes());
    png.extend(b"IHDR");
    png.extend(640u32.to_be_bytes());
    png.extend(480u32.to_be_bytes());
    png.extend([8, 6, 0, 0, 0]);
    png.extend(0x1234_abcd_u32.to_be_bytes());
    let gif = b"GIF89a\x07\x00\x09\x00\x00\x00\x00;".to_vec();
    let (hp, hg) = (sha256_hex(&png), sha256_hex(&gif));
    let send = |body: Value| {
        let (st, out) = http(
            server.port,
            "POST",
            &format!("/api/sessions/{id}/input"),
            &body.to_string(),
        );
        assert_eq!(st, 200, "{out}");
        serde_json::from_str::<Value>(&out).unwrap()
    };
    let now = send(json!({"text": "look", "uuid": "u-now", "images": [
        {"data": base64(&png), "mediaType": "image/png"},
        {"data": base64(&gif), "mediaType": "image/gif", "ordinal": 5},
    ]}));
    assert_eq!(now["queued"], false);
    let queued = send(json!({"text": "", "uuid": "u-queued", "forceQueue": true,
        "images": [{"data": base64(&png), "mediaType": "image/png"}]}));
    assert_eq!(queued["queued"], true);
    send(json!({"text": "plain", "uuid": "u-text", "forceQueue": true}));

    let db = world
        .home
        .join(".claude/projects")
        .join(encode_project_dir(&world.project.display().to_string()))
        .join(".claudius.db");
    let uses = || -> Vec<(String, String, String, i64)> {
        if !db.exists() {
            return vec![];
        }
        let Ok(conn) = open_path(&db, Mode::ReadWrite) else {
            return vec![];
        };
        let Ok(mut st) = conn.prepare(
            "SELECT asset_hash, session_id, message_uuid, ordinal FROM asset_uses ORDER BY message_uuid, ordinal",
        ) else {
            return vec![];
        };
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    wait_until("three asset uses", Duration::from_secs(10), || {
        uses().len() >= 3
    });
    assert_eq!(
        uses(),
        [
            (hp.clone(), id.clone(), "u-now".to_owned(), 1),
            (hg.clone(), id.clone(), "u-now".to_owned(), 5),
            (hp.clone(), id.clone(), "u-queued".to_owned(), 1),
        ]
    );
    let conn = open_path(&db, Mode::ReadWrite).unwrap();
    let row: (String, i64, i64, i64) = conn
        .query_row(
            "SELECT media_type, size_bytes, width, height FROM assets WHERE hash = ?",
            [&hp],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(row, ("image/png".to_owned(), 33, 640, 480));
    let store = db.parent().unwrap().join("assets");
    assert_eq!(
        std::fs::read(store.join(&hp[..2]).join(format!("{hp}.png"))).unwrap(),
        png
    );
    assert_eq!(
        std::fs::read(store.join(&hg[..2]).join(format!("{hg}.gif"))).unwrap(),
        gif
    );
}

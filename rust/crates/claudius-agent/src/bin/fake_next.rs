//! A scripted stand-in for `next dev` (and the worker it can leave behind),
//! for the customization preview tests: `claudius-server/tests/
//! customization_preview.rs` and the TS recorder
//! `rust/scripts/customization-preview-golden.mjs`. Never a real Next.
//!
//! It runs as `<src>/node_modules/.bin/next dev -p <port>` through a shell
//! wrapper (`FAKE_NEXT_ARGV0="$0" exec "$FAKE_NEXT_BIN" "$@"`), its cwd the
//! customization's mirror, and:
//! 1. appends `{"pid", "argv0", "argv", "cwd", "env"}` as one JSON line to
//!    `$FAKE_LOG_DIR/next.log` (`env`: only the keys the preview env shapes,
//!    see [`recorded`]);
//! 2. listens on `[::]:<port>` (dual-stack, as `next dev` does), answering
//!    each connection `200 fake next <port>`, and appends its pid to
//!    `$FAKE_LSOF_DIR/<port>`, which the fake `lsof` lists while it lives. A
//!    port it can't bind ends it: next's `EADDRINUSE` line, exit 1;
//! 3. writes the `chunks` of `./fake-next.json` (default: two lines, the
//!    second saying `ready`), one `write` each, 100 ms apart, with `{port}`
//!    replaced;
//! 4. waits for SIGTERM.
//!
//! `fake-next.json`, every key optional:
//! * `chunks`: `"text"` (stdout), `{"err": "text"}` (stderr), `{"hex": "…"}`
//!   / `{"errHex": "…"}` (raw bytes);
//! * `listen: false`: no listener and no pid file;
//! * `term`: `"die"` (the default action), `"ignore"`, `"exit:<n>"`, or
//!   `"slow:<ms>"` (exit 0 that long after the first SIGTERM);
//! * `go: {"code": n, "chunks": […]}`: once `./go` exists, write those chunks
//!   and exit with `n`;
//! * `grandchild: true`: a second process (this binary, `--grandchild
//!   <port>`, stdio on `/dev/null`) listens and registers instead, so it
//!   outlives this one's SIGTERM, as a Turbopack worker can.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::time::Duration;

use serde_json::{Value, json};

/// The env keys `next.log` keeps: what `buildPreviewEnv` sets, scrubs or
/// passes through, and the `LEAK_*` probes a test plants.
fn recorded(key: &str) -> bool {
    matches!(
        key,
        "PATH" | "HOME" | "NODE_ENV" | "PORT" | "NEXT_TELEMETRY_DISABLED" | "TURBOPACK"
    ) || ["CLAUDIUS_", "NEXT_", "__NEXT", "__next", "LEAK_"]
        .iter()
        .any(|p| key.starts_with(p))
}

fn log_invocation(args: &[String]) {
    let Ok(dir) = std::env::var("FAKE_LOG_DIR") else {
        return;
    };
    let env: BTreeMap<String, String> = std::env::vars().filter(|(k, _)| recorded(k)).collect();
    let line = json!({
        "pid": std::process::id(),
        "argv0": std::env::var("FAKE_NEXT_ARGV0").unwrap_or_default(),
        "argv": args.get(1..).unwrap_or_default(),
        "cwd": std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default(),
        "env": env,
    });
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(Path::new(&dir).join("next.log"))
        .expect("next.log");
    writeln!(f, "{line}").expect("write next.log");
}

/// `[::]:<port>` (`0.0.0.0` on a host without IPv6, as Node falls back),
/// or `None` when it is taken.
fn listen(port: u16) -> Option<TcpListener> {
    match TcpListener::bind(("::", port)) {
        Ok(l) => Some(l),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => None,
        Err(_) => TcpListener::bind(("0.0.0.0", port)).ok(),
    }
}

/// One pid line in `$FAKE_LSOF_DIR/<port>`.
fn register(port: u16) {
    let Ok(dir) = std::env::var("FAKE_LSOF_DIR") else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(Path::new(&dir).join(port.to_string()))
        .expect("lsof pid file");
    writeln!(f, "{}", std::process::id()).expect("write pid");
}

/// Answer every connection with a tiny 200.
fn serve(listener: TcpListener, port: u16) {
    for conn in listener.incoming() {
        let Ok(mut conn) = conn else { continue };
        let mut buf = [0u8; 4096];
        let _ = conn.set_read_timeout(Some(Duration::from_secs(2)));
        let _ = conn.read(&mut buf);
        let body = format!("fake next {port}");
        let _ = write!(
            conn,
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
    }
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex"))
        .collect()
}

fn write_chunks(chunks: &[Value], port: u16) {
    for (i, c) in chunks.iter().enumerate() {
        if i > 0 {
            std::thread::sleep(Duration::from_millis(100));
        }
        let text = |s: &str| s.replace("{port}", &port.to_string()).into_bytes();
        let (bytes, err) = match c {
            Value::String(s) => (text(s), false),
            _ => match (c["err"].as_str(), c["hex"].as_str(), c["errHex"].as_str()) {
                (Some(s), _, _) => (text(s), true),
                (_, Some(h), _) => (unhex(h), false),
                (_, _, Some(h)) => (unhex(h), true),
                _ => panic!("bad chunk {c}"),
            },
        };
        if err {
            let mut e = std::io::stderr();
            e.write_all(&bytes).unwrap();
            e.flush().unwrap();
        } else {
            let mut o = std::io::stdout();
            o.write_all(&bytes).unwrap();
            o.flush().unwrap();
        }
    }
}

static TERM_EXIT: AtomicI32 = AtomicI32::new(0);
static TERMED: AtomicBool = AtomicBool::new(false);

extern "C" fn note_term(_: libc::c_int) {
    TERMED.store(true, Ordering::SeqCst);
}

extern "C" fn exit_on_term(_: libc::c_int) {
    // SAFETY: `_exit` is async-signal-safe.
    unsafe { libc::_exit(TERM_EXIT.load(Ordering::SeqCst)) }
}

fn on_term(term: &str) {
    if term == "ignore" {
        // SAFETY: setting a disposition for our own process.
        unsafe { libc::signal(libc::SIGTERM, libc::SIG_IGN) };
    } else if let Some(code) = term.strip_prefix("exit:") {
        TERM_EXIT.store(code.parse().expect("exit code"), Ordering::SeqCst);
        let handler = exit_on_term as extern "C" fn(libc::c_int);
        // SAFETY: installing an async-signal-safe handler.
        unsafe { libc::signal(libc::SIGTERM, handler as libc::sighandler_t) };
    } else if let Some(ms) = term.strip_prefix("slow:") {
        let ms: u64 = ms.parse().expect("ms");
        let handler = note_term as extern "C" fn(libc::c_int);
        // SAFETY: installing an async-signal-safe handler.
        unsafe { libc::signal(libc::SIGTERM, handler as libc::sighandler_t) };
        std::thread::spawn(move || {
            while !TERMED.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
            std::thread::sleep(Duration::from_millis(ms));
            std::process::exit(0);
        });
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--grandchild") {
        let port: u16 = args[2].parse().expect("port");
        let Some(l) = listen(port) else {
            std::process::exit(1)
        };
        register(port);
        println!("up");
        let _ = std::io::stdout().flush();
        serve(l, port);
        return;
    }
    let cfg: Value = std::fs::read_to_string("fake-next.json")
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}));
    let port = args
        .windows(2)
        .find(|w| w[0] == "-p")
        .and_then(|w| w[1].parse::<u16>().ok())
        .unwrap_or(0);
    log_invocation(&args);
    on_term(cfg["term"].as_str().unwrap_or("die"));
    if cfg["grandchild"] == json!(true) {
        let exe = std::env::current_exe().expect("own path");
        let mut gc = Command::new(exe)
            .args(["--grandchild", &port.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn the grandchild");
        let mut up = String::new();
        let _ = BufReader::new(gc.stdout.take().expect("piped")).read_line(&mut up);
        // Never waited for: it is meant to outlive this process.
        std::mem::forget(gc);
    } else if cfg["listen"] != json!(false) {
        match listen(port) {
            Some(l) => {
                register(port);
                std::thread::spawn(move || serve(l, port));
            }
            None => {
                eprintln!("Error: listen EADDRINUSE: address already in use :::{port}");
                std::process::exit(1);
            }
        }
    }
    let default = vec![
        json!("fake next dev -p {port}\n"),
        json!("ready on http://localhost:{port}\n"),
    ];
    let chunks = cfg["chunks"].as_array().unwrap_or(&default);
    write_chunks(chunks, port);
    if cfg["go"].is_object() {
        let go = &cfg["go"];
        loop {
            if Path::new("go").exists() {
                write_chunks(go["chunks"].as_array().map_or(&[][..], Vec::as_slice), port);
                std::process::exit(go["code"].as_i64().unwrap_or(0) as i32);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

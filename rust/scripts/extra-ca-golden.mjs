#!/usr/bin/env node
// Golden fixture for a process-env `NODE_EXTRA_CA_CERTS` (I19): what Node 22
// does with the bundle the variable names, recorded from real node processes
// fetching from a local TLS server whose leaf a test CA signed:
//
//   node rust/scripts/extra-ca-golden.mjs          (node@22)
//   OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl \
//     node rust/scripts/extra-ca-golden.mjs --make-certs
//
// `--make-certs` regenerates the certificates under
// crates/claudius-core/tests/fixtures/tls/ (EC P-256, valid 2019 to 2119 so
// macOS judges them on trust alone; needs OpenSSL 3.4+ for `-not_before`):
// `extra_ca_cert.der` (a CA), `extra_ca_leaf_{cert,key}.der` (a leaf it
// signed, SAN localhost and 127.0.0.1) and `extra_ca_other_cert.der` (an
// unrelated CA). The self-signed `self_signed_{cert,key}.der` there is R08's.
//
// Every case is one fresh `node` (no flags, no NODE_OPTIONS, HOME in a temp
// dir) whose NODE_EXTRA_CA_CERTS is unset, a raw value, or a path the case
// sets up (a file with the case's bytes, a missing file, an unreadable one, a
// directory, a path under a regular file, a path relative to the cwd). The
// child then runs the case's steps:
//
// - `tls`: load `node:tls` and wait for its extra-CA load
//   (`tls.getCACertificates("extra")`); Node 22 reads the file when `tls`
//   first loads, once per process;
// - `fetch:leaf` / `fetch:self`: `fetch` the CA-signed server or the
//   self-signed one; `{ok, status, body}`, or the rejection's `message`, its
//   `cause.code`, and what the real `isCaTrustFailure` (lib/shared/
//   tls-cert-hint.ts) says about it (`caTrust`);
// - `write` (the case's `later` bytes) / `rm`: change the file afterwards.
//
// Recorded per case: the child's whole stderr (Node's
// "Warning: Ignoring extra certs from `<path>`, load failed: <OpenSSL
// error>" when the load failed), with the variable's value as `<value>`;
// `extra`, the certificates the load kept (`tls.getCACertificates("extra")`
// named by the fixture they are: ca, other, self), or null when the child
// never loaded `tls`; and each step's result (null for the non-fetch steps).
//
// Runs twice (two temp roots); the recordings must agree byte for byte.
// Written to rust/crates/claudius-core/tests/fixtures/extra_ca_golden.json
// and replayed by crates/claudius-core/tests/fetch_client.rs.
import { spawn, spawnSync } from "node:child_process";
import { X509Certificate, createHash, createPrivateKey } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scannerSafeJson } from "./scanner-safe-json.mjs";

// Nothing above loads `node:tls`: the child's first `tls` or `fetch` step
// must be what reads the bundle.

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const tlsDir = join(rustDir, "crates/claudius-core/tests/fixtures/tls");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/extra_ca_golden.json");

// ------------------------------------------------------------------ child

if (process.env.EXTRA_CA_GOLDEN_CHILD) {
  const steps = JSON.parse(process.env.EXTRA_CA_GOLDEN_CHILD);
  const ports = JSON.parse(process.env.EXTRA_CA_GOLDEN_PORTS);
  const path = process.env.EXTRA_CA_GOLDEN_PATH;
  const later = process.env.EXTRA_CA_GOLDEN_LATER;
  const results = [];
  let loaded = false;
  for (const step of steps) {
    if (step === "tls") {
      (await import("node:tls")).getCACertificates("extra");
      loaded = true;
      results.push(null);
    } else if (step.startsWith("fetch:")) {
      loaded = true;
      try {
        const res = await fetch(`https://127.0.0.1:${ports[step.slice(6)]}/`);
        results.push({ ok: true, status: res.status, body: await res.text() });
      } catch (e) {
        const cause = e.cause ? { code: e.cause.code ?? null, message: e.cause.message ?? null } : null;
        results.push({ ok: false, message: e.message, cause });
      }
    } else if (step === "write") {
      writeFileSync(path, Buffer.from(later, "base64"));
      results.push(null);
    } else if (step === "rm") {
      unlinkSync(path);
      results.push(null);
    } else {
      throw new Error(`unknown step ${step}`);
    }
  }
  const extra = loaded
    ? (await import("node:tls")).getCACertificates("extra").map((pem) => new X509Certificate(pem).raw.toString("base64"))
    : null;
  process.stdout.write(JSON.stringify({ results, extra }));
  process.exit(0);
}

// ------------------------------------------------------------ certificates

if (process.argv.includes("--make-certs")) {
  const openssl = process.env.OPENSSL || "openssl";
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "extra-ca-certs-")));
  try {
    const ssl = (...args) => {
      const r = spawnSync(openssl, args, { cwd: dir, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`openssl ${args.join(" ")}: ${r.stderr}`);
    };
    const validity = ["-not_before", "20190101000000Z", "-not_after", "21190101000000Z"];
    const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
    for (const [name, cn] of [
      ["ca", "Claudius Extra CA Golden"],
      ["other", "Claudius Extra CA Golden Other"],
    ]) {
      ssl("req", "-x509", ...ec, "-keyout", `${name}.key`, "-out", `${name}.pem`, ...validity, "-subj", `/CN=${cn}`,
        "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
    }
    writeFileSync(
      join(dir, "leaf.ext"),
      "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n" +
        "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n",
    );
    ssl("req", ...ec, "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=localhost");
    ssl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-set_serial", "2", "-out", "leaf.pem",
      ...validity, "-extfile", "leaf.ext");
    for (const [pem, der] of [
      ["ca.pem", "extra_ca_cert.der"],
      ["other.pem", "extra_ca_other_cert.der"],
      ["leaf.pem", "extra_ca_leaf_cert.der"],
    ]) {
      ssl("x509", "-in", pem, "-outform", "der", "-out", join(tlsDir, der));
    }
    ssl("pkcs8", "-topk8", "-nocrypt", "-in", "leaf.key", "-outform", "der", "-out", join(tlsDir, "extra_ca_leaf_key.der"));
    console.log(`wrote ${tlsDir.slice(repo.length + 1)}/extra_ca_*.der`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(0);
}

// ------------------------------------------------------------------- cases

const der = (name) => readFileSync(join(tlsDir, name));
const CERTS = {
  ca: der("extra_ca_cert.der"),
  other: der("extra_ca_other_cert.der"),
  self: der("self_signed_cert.der"),
};
const b64 = (buf) => buf.toString("base64");
const pemOf = (buf, label = "CERTIFICATE") =>
  `-----BEGIN ${label}-----\n${b64(buf).match(/.{1,64}/g).join("\n")}\n-----END ${label}-----\n`;
const CA = pemOf(CERTS.ca);
const OTHER = pemOf(CERTS.other);
const SELF = pemOf(CERTS.self);
const KEY = pemOf(der("extra_ca_leaf_key.der"), "PRIVATE KEY");
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const caLines = CA.trimEnd().split("\n");
const caBody = caLines.slice(1, -1);
const block = (body, label = "CERTIFICATE") => `-----BEGIN ${label}-----\n${body}-----END ${label}-----\n`;
const text = (s) => Buffer.from(s, "latin1");
const file = (bytes, extra = {}) => ({ kind: "file", bytes: b64(bytes), ...extra });

const CASES = [
  // Well-formed bundles.
  { name: "ca", env: file(text(CA)), steps: ["fetch:leaf", "fetch:self"] },
  { name: "other-then-ca", env: file(text(OTHER + CA)), steps: ["fetch:leaf"] },
  { name: "other-only", env: file(text(OTHER)), steps: ["fetch:leaf"] },
  { name: "self-signed-leaf", env: file(text(SELF)), steps: ["fetch:self", "fetch:leaf"] },
  { name: "crlf", env: file(text(CA.replace(/\n/g, "\r\n"))), steps: ["fetch:leaf"] },
  { name: "bom", env: file(Buffer.concat([BOM, text(CA)])), steps: ["fetch:leaf"] },
  { name: "bom-second", env: file(Buffer.concat([text(OTHER), BOM, text(CA)])), steps: ["fetch:leaf"] },
  { name: "bom-after-blank-line", env: file(Buffer.concat([text(`${OTHER}\n`), BOM, text(CA)])), steps: ["fetch:leaf"] },
  {
    name: "preamble",
    env: file(text(`Bag Attributes\n    friendlyName: proxy\nsubject=CN = Claudius Extra CA Golden\n\n${CA}trailing text\n`)),
    steps: ["fetch:leaf"],
  },
  { name: "key-first", env: file(text(KEY + CA)), steps: ["fetch:leaf"] },
  { name: "x509-label", env: file(text(pemOf(CERTS.ca, "X509 CERTIFICATE"))), steps: ["fetch:leaf"] },
  { name: "trusted-label", env: file(text(pemOf(CERTS.ca, "TRUSTED CERTIFICATE"))), steps: ["fetch:leaf"] },
  { name: "indented", env: file(text(caLines.map((l) => `  ${l}`).join("\n") + "\n")), steps: ["fetch:leaf"] },
  {
    name: "trailing-whitespace",
    env: file(text(caLines.map((l, i) => l + (i % 2 ? " \t" : "  ")).join("\r\n") + "\r\n")),
    steps: ["fetch:leaf"],
  },
  { name: "one-line", env: file(text(block(`${b64(CERTS.ca)}\n`))), steps: ["fetch:leaf"] },
  { name: "lines-254", env: file(text(block(`${b64(CERTS.ca).match(/.{1,254}/g).join("\n")}\n`))), steps: ["fetch:leaf"] },
  { name: "begin-without-dashes", env: file(text(`-----BEGIN CERTIFICATE\n${CA}`)), steps: ["fetch:leaf"] },
  { name: "trailing-der-junk", env: file(text(pemOf(Buffer.concat([CERTS.ca, Buffer.from([1, 2, 3])])))), steps: ["fetch:leaf"] },
  // Nothing to load, quietly.
  { name: "empty", env: file(Buffer.alloc(0)), steps: ["fetch:leaf"] },
  { name: "not-pem", env: file(text("not a certificate\n")), steps: ["fetch:leaf"] },
  { name: "der", env: file(CERTS.ca), steps: ["fetch:leaf"] },
  { name: "empty-block-first", env: file(text(block("") + CA)), steps: ["fetch:leaf"] },
  {
    name: "colon-header",
    env: file(text(block(`Comment: proxy\n${caBody.join("\n")}\n`) + OTHER)),
    steps: ["fetch:leaf"],
  },
  // Broken: a warning, and whatever came before the break.
  { name: "ca-then-bad-base64", env: file(text(CA + block("!!!!not*base64!!!!\n"))), steps: ["fetch:leaf"] },
  { name: "ca-then-short-group", env: file(text(CA + block("AAAAAA\n") + OTHER)), steps: ["fetch:leaf"] },
  { name: "ca-then-bad-der", env: file(text(CA + block("AAAAAAAA\n"))), steps: ["fetch:leaf"] },
  {
    name: "ca-then-not-a-certificate",
    env: file(text(CA + pemOf(Buffer.from([0x30, 0x03, 0x02, 0x01, 0x01])) + OTHER)),
    steps: ["fetch:leaf"],
  },
  { name: "bad-der-then-ca", env: file(text(block("AAAAAAAA\n") + CA)), steps: ["fetch:leaf"] },
  { name: "ca-then-unterminated", env: file(text(CA + `-----BEGIN CERTIFICATE-----\n${caBody.join("\n")}\n`)), steps: ["fetch:leaf"] },
  {
    name: "ca-then-wrong-end",
    env: file(text(CA + `-----BEGIN CERTIFICATE-----\n${caBody.join("\n")}\n-----END X509 CRL-----\n` + OTHER)),
    steps: ["fetch:leaf"],
  },
  {
    name: "ca-then-end-without-dashes",
    env: file(text(CA + `-----BEGIN CERTIFICATE-----\n${caBody.join("\n")}\n-----END CERTIFICATE\n` + OTHER)),
    steps: ["fetch:leaf"],
  },
  {
    name: "ca-then-end-label-longer",
    env: file(text(CA + `-----BEGIN CERTIFICATE-----\n${caBody.join("\n")}\n-----END CERTIFICATES-----\n` + OTHER)),
    steps: ["fetch:leaf"],
  },
  {
    name: "blank-line-in-body",
    env: file(text(block(`${caBody.slice(0, 2).join("\n")}\n\n${caBody.slice(2).join("\n")}\n`))),
    steps: ["fetch:leaf"],
  },
  {
    name: "two-blank-lines",
    env: file(text(OTHER + block(`${caBody[0]}\n\n\n${caBody.slice(1).join("\n")}\n`) + CA)),
    steps: ["fetch:leaf"],
  },
  {
    name: "colon-after-blank-line",
    env: file(text(OTHER + block(`${caBody[0]}\n\nx:y\n${caBody.slice(1).join("\n")}\n`) + CA)),
    steps: ["fetch:leaf"],
  },
  {
    name: "long-line-after-blank-line",
    env: file(text(OTHER + block(`${caBody[0]}\n\n${b64(CERTS.ca)}\n`) + CA)),
    steps: ["fetch:leaf"],
  },
  {
    name: "line-65-after-blank-line",
    env: file(text(OTHER + block(`${caBody[0]}\n\n${"A".repeat(65)}\n`) + CA)),
    steps: ["fetch:leaf"],
  },
  {
    name: "line-64-after-blank-line",
    env: file(text(OTHER + block(`${caBody[0]}\n\n${"A".repeat(64)}\n`) + CA)),
    steps: ["fetch:leaf"],
  },
  {
    name: "proc-type-header",
    env: file(
      text(OTHER + block(`Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00112233445566778899AABBCCDDEEFF\n\n${caBody.join("\n")}\n`) + CA),
    ),
    steps: ["fetch:leaf"],
  },
  { name: "padding-then-data", env: file(text(OTHER + block("AA==AAAA\n") + CA)), steps: ["fetch:leaf"] },
  // The value itself.
  { name: "unset", env: { kind: "unset" }, steps: ["fetch:leaf"] },
  { name: "empty-value", env: { kind: "raw", value: "" }, steps: ["fetch:leaf"] },
  { name: "space-value", env: { kind: "raw", value: " " }, steps: ["fetch:leaf"] },
  { name: "tilde-value", env: { kind: "raw", value: "~/ca.pem" }, steps: ["fetch:leaf"] },
  { name: "missing", env: { kind: "missing" }, steps: ["fetch:leaf"] },
  { name: "unreadable", env: file(text(CA), { kind: "unreadable" }), steps: ["fetch:leaf"] },
  { name: "directory", env: { kind: "dir" }, steps: ["fetch:leaf"] },
  { name: "under-a-file", env: { kind: "notdir" }, steps: ["fetch:leaf"] },
  { name: "relative", env: file(text(CA), { kind: "relative" }), steps: ["fetch:leaf"] },
  // When it's read: once, when `tls` first loads.
  { name: "never-loaded", env: { kind: "missing" }, steps: [] },
  { name: "written-before-first-fetch", env: { kind: "missing" }, later: b64(text(CA)), steps: ["write", "fetch:leaf"] },
  { name: "written-after-tls-loaded", env: { kind: "missing" }, later: b64(text(CA)), steps: ["tls", "write", "fetch:leaf"] },
  { name: "removed-after-first-fetch", env: file(text(CA)), steps: ["fetch:leaf", "rm", "fetch:leaf", "fetch:self"] },
  {
    name: "garbled-after-tls-loaded",
    env: file(text(CA)),
    later: b64(text("garbage\n")),
    steps: ["tls", "write", "fetch:leaf"],
  },
];

// ------------------------------------------------------------- recording

if (process.env.EXTRA_CA_GOLDEN_RECORD) {
  const { isCaTrustFailure } = await import(pathToFileURL(join(repo, "lib/shared/tls-cert-hint.ts")).href);
  const https = await import("node:https");
  const serve = (cert, key) =>
    new Promise((res) => {
      const s = https.createServer(
        {
          cert: new X509Certificate(cert).toString(),
          key: createPrivateKey({ key, format: "der", type: "pkcs8" }).export({ format: "pem", type: "pkcs8" }),
        },
        (_req, r) => {
          r.setHeader("connection", "close");
          r.end("ok");
        },
      );
      s.listen(0, "127.0.0.1", () => res(s));
    });
  const servers = {
    leaf: await serve(der("extra_ca_leaf_cert.der"), der("extra_ca_leaf_key.der")),
    self: await serve(CERTS.self, der("self_signed_key.der")),
  };
  const ports = Object.fromEntries(Object.entries(servers).map(([k, s]) => [k, s.address().port]));
  const names = new Map(Object.entries(CERTS).map(([k, v]) => [b64(v), k]));
  const root = process.env.EXTRA_CA_GOLDEN_RECORD;

  const runCase = (c, i) => {
    const dir = join(root, `c${i}`);
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    const env = c.env;
    let value;
    let path = join(dir, "ca.pem");
    if (env.kind === "raw") value = env.value;
    else if (env.kind === "file" || env.kind === "unreadable") {
      writeFileSync(path, Buffer.from(env.bytes, "base64"));
      if (env.kind === "unreadable") chmodSync(path, 0);
      value = path;
    } else if (env.kind === "relative") {
      writeFileSync(path, Buffer.from(env.bytes, "base64"));
      value = "ca.pem";
    } else if (env.kind === "missing") value = path;
    else if (env.kind === "dir") {
      mkdirSync(path);
      value = path;
    } else if (env.kind === "notdir") {
      writeFileSync(join(dir, "file"), CA);
      path = join(dir, "file", "ca.pem");
      value = path;
    } else if (env.kind !== "unset") throw new Error(`unknown env ${env.kind}`);
    const childEnv = {
      PATH: process.env.PATH,
      HOME: home,
      EXTRA_CA_GOLDEN_CHILD: JSON.stringify(c.steps),
      EXTRA_CA_GOLDEN_PORTS: JSON.stringify(ports),
      EXTRA_CA_GOLDEN_PATH: path,
      EXTRA_CA_GOLDEN_LATER: c.later ?? "",
    };
    if (value !== undefined) childEnv.NODE_EXTRA_CA_CERTS = value;
    return new Promise((res, rej) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { cwd: dir, env: childEnv });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b) => (stdout += b));
      child.stderr.on("data", (b) => (stderr += b));
      child.on("exit", (code) => {
        if (code !== 0) return rej(new Error(`case ${c.name} exited ${code}: ${stderr}`));
        const got = JSON.parse(stdout);
        if (value !== undefined) stderr = stderr.split(`\`${value}\``).join("`<value>`");
        const results = got.results.map((r) => {
          if (r === null || r.ok) return r;
          return {
            ok: false,
            message: r.message,
            code: r.cause?.code ?? null,
            caTrust: isCaTrustFailure({ message: r.message, cause: r.cause }),
          };
        });
        const extra = got.extra && got.extra.map((raw) => names.get(raw) ?? `?${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`);
        res({ stderr, extra, results });
      });
    });
  };
  const recorded = [];
  for (const [i, c] of CASES.entries()) recorded.push({ ...c, later: c.later ?? null, ...(await runCase(c, i)) });
  for (const s of Object.values(servers)) s.close();
  const fixture = { node: process.version, openssl: process.versions.openssl, cases: recorded };
  writeFileSync(join(root, "out.json"), `${JSON.stringify(fixture, null, 1)}\n`);
  process.exit(0);
}

// ----------------------------------------------------------------- parent

if (process.getuid?.() === 0) throw new Error("run as a normal user: root reads the unreadable file");
const runs = [0, 1].map(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "extra-ca-golden-")));
  try {
    const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)], {
      cwd: repo,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: root, EXTRA_CA_GOLDEN_RECORD: root },
    });
    if (r.status !== 0) {
      process.stderr.write(r.stderr);
      process.exit(r.status ?? 1);
    }
    return readFileSync(join(root, "out.json"), "utf8");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
if (runs[0] !== runs[1]) throw new Error("the two recordings differ");
writeFileSync(out, scannerSafeJson(runs[0]));
console.log(`wrote ${out.slice(repo.length + 1)}: ${JSON.parse(runs[0]).cases.length} cases (stable)`);

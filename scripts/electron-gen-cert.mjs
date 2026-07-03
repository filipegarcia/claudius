// Build-time self-signed TLS cert for the packaged app's HTTP/2 loopback proxy.
//
// Why a cert at all: Chromium only speaks HTTP/2 over TLS. The packaged app
// serves the UI through an in-process HTTP/2 reverse proxy (electron/proxy.ts)
// so that all requests + SSE streams multiplex over a SINGLE connection —
// dodging Chromium's 6-connections-per-origin HTTP/1.1 limit, which otherwise
// stalls navigations for 10-17s once the pool saturates (see the plan file).
//
// Why BUILD time (not first run): `selfsigned` (pure-JS, node-forge) does a
// 1-3s SYNCHRONOUS RSA keygen. Doing that at first launch would block the
// Electron main-process event loop and starve the splash — the exact failure
// electron/server.ts was restructured to avoid. Generating here bakes the cost
// into the build and lets the proxy live safely in the main process.
//
// Why pure-JS: a native cert lib would need to compile against Electron 42's
// V8 ABI, which is fragile (a prior `re2`/`nan` dep broke the packaged build).
// `selfsigned` is pure JS — no native compile, nothing to unpack from the asar.
//
// Security: the key authenticates ONLY 127.0.0.1/localhost over loopback. There
// is no network hop, so a shared bundled key discloses nothing exploitable.
//
// Output: build/cert/{cert.pem,key.pem}. electron-builder.yml ships these as an
// extraResource to Resources/cert; electron/main.ts loads them and computes the
// cert fingerprint at runtime to scope its `certificate-error` trust handler.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import selfsigned from "selfsigned";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(projectRoot, "build", "cert");

// SAN is what Chromium actually validates (it ignores CN). Cover both the
// loopback IP the proxy binds and the `localhost` alias. Type 7 = IP,
// type 2 = DNS in node-forge's altName encoding.
const attrs = [{ name: "commonName", value: "127.0.0.1" }];
const pems = selfsigned.generate(attrs, {
  keySize: 2048,
  days: 3650, // ~10y — the app re-issues on every build anyway.
  algorithm: "sha256",
  extensions: [
    {
      name: "subjectAltName",
      altNames: [
        { type: 7, ip: "127.0.0.1" },
        { type: 2, value: "localhost" },
      ],
    },
  ],
});

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "cert.pem"), pems.cert, "utf8");
writeFileSync(join(outDir, "key.pem"), pems.private, "utf8");

console.log(`[gen-cert] wrote cert.pem + key.pem to ${outDir}`);

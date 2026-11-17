#!/usr/bin/env node
// Golden fixture for the account store and profile lookup (G02a):
// lib/server/accounts-store.ts, lib/server/account-profile.ts and what they
// import (lib/shared/accounts.ts, lib/server/claude-global-config.ts), plus
// lib/server/token-expiry.ts's `shouldWarnTokenExpiring` (the session's
// `activeProfileExpiresAt` check).
//
//   node rust/scripts/accounts-golden.mjs        (node@22)
//
// Re-runs itself under `--experimental-transform-types` with HOME and
// CLAUDE_CONFIG_DIR in a temp root and a resolve hook for the `@/` and
// extensionless imports, twice (two temp roots); both recordings must agree
// byte for byte. Nothing outside the temp root is read or written: every
// case gets its own world `$W` (HOME is `$W/home`, the store usually
// `CLAUDIUS_ACCOUNTS_DIR=$W/acc`), and `fetch` is a scripted stand-in that
// records what it was asked (the real Anthropic endpoint is never called).
// All tokens are fake. The TS writes no keychain entry (it writes a
// per-profile `.credentials.json`), so there is no keychain boundary to stub.
//
// Determinism: `crypto.randomBytes` is replaced (through
// `syncBuiltinESMExports`) by a counter: byte i of call n is
// `(n * 37 + i * 11 + 5) & 255`, n counted from 0 per case. `Date` is pinned
// to a per-case clock starting at T0 that only `advance` steps move.
// `process.pid` in a temp name prints as `$PID`, the world as `$W`.
//
// Each store case builds its world (`files`: text, hex bytes, directories,
// symlinks, modes) and environment, then runs steps against the real
// modules; after each step it records the result as `JSON.stringify` text
// (`out`) or the thrown message (`throws`), and the whole world tree
// (`tree`: type, mode, file text or hex, symlink target; `start` is the tree
// before the first step, and a step without `tree` left it unchanged). Steps:
// read / public / active / byId / add / autoRotate / meta / rotate /
// activate / delete (the store's exports), env (`buildEnvForProfile` on a
// stored profile, with the effective env the CLI would get: `String(v)` of
// every defined value), info (`getProfileInfoForAccount`, with its fetches;
// its fire-and-forget metadata write is waited for), invalidate, global
// (`readClaudeGlobalOauthAccount`), advance (the clock) and files (change
// the world mid-case).
//
// `pure` holds the functions without a world: normalizeBedrockConfig,
// isValidAwsRegion, describeBedrockConfig, toPublic, isAccountKind,
// applyBedrockEnv, accountsDir and shouldWarnTokenExpiring.
//
// Written to rust/crates/claudius-core/tests/fixtures/accounts_golden.json
// and replayed by crates/claudius-core/tests/accounts_golden.rs.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire, register, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/accounts_golden.json");

/** Make everything under `p` deletable again (cases chmod things away). */
function unlock(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    chmodSync(p, 0o700);
    for (const n of readdirSync(p)) unlock(join(p, n));
  } else {
    chmodSync(p, 0o600);
  }
}

if (!process.env.ACCOUNTS_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "accounts-golden-")));
    try {
      mkdirSync(join(root, "home"));
      mkdirSync(join(root, "config"));
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: join(root, "home"),
            CLAUDE_CONFIG_DIR: join(root, "config"),
            ACCOUNTS_GOLDEN_CHILD: root,
          },
        },
      );
      if (r.status !== 0) {
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      return readFileSync(join(root, "out.json"), "utf8");
    } finally {
      unlock(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) throw new Error("the two recordings differ");
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const steps = fixture.store.reduce((n, c) => n + c.steps.length, 0);
  const pure = Object.entries(fixture.pure)
    .map(([k, v]) => `${v.length} ${k}`)
    .join(", ");
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.store.length} store cases (${steps} steps); ${pure} (stable)`,
  );
  process.exit(0);
}

// ---- child ------------------------------------------------------------------

const ROOT = process.env.ACCOUNTS_GOLDEN_CHILD;
process.umask(0o022);

const hook = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = ${JSON.stringify(pathToFileURL(repo + "/").href)};
export async function resolve(spec, ctx, next) {
  const s = spec.startsWith("@/") ? new URL(spec.slice(2), ROOT).href : spec;
  if ((s.startsWith(".") || s.startsWith("file:")) && ctx.parentURL) {
    const p = fileURLToPath(new URL(s, ctx.parentURL));
    if (!existsSync(p)) {
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        if (existsSync(p + ext)) return next(pathToFileURL(p + ext).href, ctx);
      }
    }
  }
  return next(s, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const require = createRequire(import.meta.url);

// randomBytes: a counter, so ids and temp names are the same every run.
const nodeCrypto = require("node:crypto");
let rngCalls = 0;
nodeCrypto.randomBytes = (n, cb) => {
  if (cb) throw new Error("the golden only stubs the synchronous randomBytes");
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (rngCalls * 37 + i * 11 + 5) & 0xff;
  rngCalls++;
  return b;
};
syncBuiltinESMExports();

// Date: a pinned clock.
const T0 = 1790000000123;
const RealDate = Date;
let NOW = T0;
globalThis.Date = class extends RealDate {
  constructor(...a) {
    if (a.length === 0) super(NOW);
    else super(...a);
  }
  static now() {
    return NOW;
  }
};

// fs.promises: count operations in flight, to wait out fire-and-forget writes.
const fsp = require("node:fs").promises;
let pending = 0;
for (const k of ["readFile", "writeFile", "rename", "chmod", "unlink", "mkdir", "readdir", "readlink", "symlink", "rm"]) {
  const orig = fsp[k];
  fsp[k] = (...a) => {
    pending++;
    return orig.apply(fsp, a).finally(() => {
      pending--;
    });
  };
}
async function drain() {
  let idle = 0;
  for (let i = 0; i < 100000 && idle < 5; i++) {
    await new Promise((r) => setImmediate(r));
    idle = pending === 0 ? idle + 1 : 0;
  }
  if (pending !== 0) throw new Error("fs operations never settled");
}

// console.warn: captured per step (the CC 2.1.309 cert-failure line).
let warnLog = [];
console.warn = (...a) => warnLog.push(a.map((v) => String(v)).join(" "));

// fetch: scripted.
let fetchQueue = [];
let fetchCalls = [];
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), method: init?.method ?? null, headers: init?.headers ?? null });
  const r = fetchQueue.shift();
  if (!r) throw new Error("unscripted fetch");
  if (r.throwCert !== undefined) {
    // undici's shape for a TLS failure: `TypeError("fetch failed")` whose
    // `cause` carries the OpenSSL code / message (CC 2.1.309).
    const cause = Object.assign(new Error(r.throwCert.message), { code: r.throwCert.code });
    throw new TypeError("fetch failed", { cause });
  }
  if (r.throws !== undefined) throw new TypeError(r.throws);
  const body = r.hex !== undefined ? Buffer.from(r.hex, "hex") : (r.body ?? null);
  return new Response(body, { status: r.status });
};

const mod = (p) => import(pathToFileURL(join(repo, p)).href);
const store = await mod("lib/server/accounts-store.ts");
const profileInfo = await mod("lib/server/account-profile.ts");
const globalCfg = await mod("lib/server/claude-global-config.ts");
const shared = await mod("lib/shared/accounts.ts");
const expiry = await mod("lib/server/token-expiry.ts");

// ---- helpers ----------------------------------------------------------------

/** `{"$num": "NaN"}` and friends: numbers JSON can't hold. */
function num(v) {
  if (v && typeof v === "object" && !Array.isArray(v) && typeof v.$num === "string") return Number(v.$num);
  return v;
}

function setEnv(env) {
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}

function buildFiles(W, files) {
  const entries = Object.entries(files ?? {});
  for (const [rel, spec] of entries) {
    const p = join(W, rel);
    if (spec.delete) {
      unlock(p);
      rmSync(p, { recursive: true, force: true });
      continue;
    }
    mkdirSync(dirname(p), { recursive: true });
    if (spec.dir) mkdirSync(p, { recursive: true });
    else if (spec.symlink !== undefined) symlinkSync(spec.symlink.replaceAll("$W", W), p);
    else if (spec.text !== undefined || spec.hex !== undefined) {
      writeFileSync(p, spec.hex !== undefined ? Buffer.from(spec.hex, "hex") : spec.text);
    }
  }
  for (const [rel, spec] of [...entries].reverse()) {
    if (spec.mode !== undefined && !spec.delete) chmodSync(join(W, rel), parseInt(spec.mode, 8));
  }
}

function tree(W, sub) {
  const res = {};
  const walk = (rel) => {
    const dir = rel ? join(W, rel) : W;
    let names;
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      const full = join(W, r);
      const st = lstatSync(full);
      const m = (st.mode & 0o777).toString(8);
      if (st.isSymbolicLink()) res[r] = { t: "l", to: sub(readlinkSync(full)) };
      else if (st.isDirectory()) {
        res[r] = { t: "d", m };
        walk(r);
      } else {
        let b = null;
        try {
          b = readFileSync(full);
        } catch {
          // unreadable: type and mode only
        }
        if (b === null) res[r] = { t: "f", m };
        else {
          const text = b.toString("utf8");
          res[r] = Buffer.from(text, "utf8").equals(b) ? { t: "f", m, x: text } : { t: "f", m, h: b.toString("hex") };
        }
      }
    }
  };
  walk("");
  return res;
}

/** The env a spawned CLI sees: `String(v)` of every defined value. */
function effectiveEnv(env) {
  const vars = {};
  const types = {};
  for (const k of Object.keys(env).sort()) {
    const v = env[k];
    if (typeof v !== "string") types[k] = typeof v;
    if (v === undefined) continue;
    vars[k] = String(v);
  }
  return { vars, types };
}

const json = (v) => JSON.stringify(v === undefined ? null : v);

async function runStoreCase(c, index) {
  const W = join(ROOT, `w${index}`);
  mkdirSync(W);
  const sub = (s) => s.replaceAll(W, "$W").replaceAll(`.${process.pid}.`, ".$PID.");
  const fill = (v) => JSON.parse(JSON.stringify(v ?? {}).replaceAll("$W", W));
  rngCalls = 0;
  NOW = T0;
  profileInfo.invalidateProfileCache();
  globalCfg.__resetClaudeGlobalConfigCache();
  const worldEnv = { HOME: `${W}/home`, ...fill(c.env) };
  setEnv(worldEnv);
  buildFiles(W, fill(c.files));
  const rec = {
    name: c.name,
    env: c.env ?? {},
    files: c.files ?? {},
    dir: sub(store.accountsDir()),
    start: tree(W, sub),
    steps: [],
  };
  let last = JSON.stringify(rec.start);
  const added = [];
  for (const step of c.steps) {
    const r = { ...step };
    const id = step.added !== undefined ? added[step.added] : step.id;
    try {
      let v;
      switch (step.op) {
        case "read":
          v = await store.readAccountsRaw();
          break;
        case "public":
          v = await store.readAccountsPublic();
          break;
        case "active":
          v = await store.getActiveProfile();
          break;
        case "byId":
          v = await store.getProfileById(id);
          break;
        case "add": {
          const input = { ...step.input };
          if ("expiresAt" in input) input.expiresAt = num(input.expiresAt);
          v = await store.addAccount(input);
          added.push(v.profile.id);
          break;
        }
        case "autoRotate":
          v = await store.setAutoRotate(step.on);
          break;
        case "meta":
          v = await store.updateAccountMetadata(id, step.meta);
          break;
        case "rotate":
          v = await store.rotateToNextProfile();
          break;
        case "activate":
          v = await store.setActiveAccount(id);
          break;
        case "delete":
          v = await store.deleteAccount(id);
          break;
        case "env": {
          const p = await store.getProfileById(id);
          setEnv({ ...worldEnv, ...fill(step.env) });
          try {
            v = effectiveEnv(await store.buildEnvForProfile(p));
          } finally {
            setEnv(worldEnv);
          }
          break;
        }
        case "info": {
          fetchQueue = [...(step.fetch ?? [])];
          fetchCalls = [];
          warnLog = [];
          try {
            v = await profileInfo.getProfileInfoForAccount(id, step.skipCache ? { skipCache: true } : undefined);
          } finally {
            await drain();
            r.fetches = fetchCalls;
            r.unused = fetchQueue.length;
            if (warnLog.length) r.warns = warnLog.map(sub);
          }
          break;
        }
        case "invalidate":
          v = profileInfo.invalidateProfileCache(id);
          break;
        case "global":
          v = await globalCfg.readClaudeGlobalOauthAccount(step.skipCache ? { skipCache: true } : undefined);
          break;
        case "advance":
          NOW += step.ms;
          break;
        case "files":
          buildFiles(W, fill(step.files));
          break;
        default:
          throw new Error(`unknown op ${step.op}`);
      }
      r.out = sub(json(v));
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("unscripted")) throw e;
      r.throws = sub(e instanceof Error ? e.message : String(e));
    }
    if (r.fetches) r.fetches = JSON.parse(sub(JSON.stringify(r.fetches)));
    const t = tree(W, sub);
    if (JSON.stringify(t) !== last) {
      r.tree = t;
      last = JSON.stringify(t);
    }
    rec.steps.push(r);
  }
  unlock(W);
  rmSync(W, { recursive: true, force: true });
  return rec;
}

// ---- data -------------------------------------------------------------------

const OAUTH = "sk-ant-oat01-FAKE-0001-alpha";
const APIKEY = "sk-ant-api03-FAKE-0002-beta";
const AWS_SECRET = "FAKEsecretAccessKey0003xyz";
const BEARER = "FAKE-bedrock-api-key-0004";
const SESSION_TOKEN = "FAKE-session-token-0005";
const C0 = "2026-01-02T03:04:05.006Z";

const P = {
  oauth: { id: "acc_oauth", label: "Personal Max", kind: "oauth-token", secret: OAUTH, createdAt: C0 },
  oauth2: { id: "acc_oauth2", label: "Work Max", kind: "oauth-token", secret: `${OAUTH}-two`, createdAt: C0 },
  api: { id: "acc_api", label: "Overflow API", kind: "api-key", secret: APIKEY, createdAt: C0 },
  bProfile: {
    id: "acc_bp",
    label: "AWS SSO",
    kind: "bedrock",
    secret: "",
    createdAt: C0,
    bedrock: { auth: "aws-profile", region: "us-east-1", awsProfile: "work-sso" },
  },
  bKeys: {
    id: "acc_bk",
    label: "AWS keys",
    kind: "bedrock",
    secret: AWS_SECRET,
    createdAt: C0,
    bedrock: {
      auth: "access-keys",
      region: "eu-central-1",
      accessKeyId: "AKIAFAKE0000WXYZ",
      sessionToken: SESSION_TOKEN,
      model: "eu.anthropic.claude-sonnet-4-6",
      regionPrefix: "eu",
      baseUrl: "https://bedrock.example.com",
    },
  },
  bBearer: { id: "acc_bb", label: "Bedrock key", kind: "bedrock", secret: BEARER, createdAt: C0, bedrock: { auth: "bearer-token" } },
  bAmbient: { id: "acc_ba", label: "Ambient", kind: "bedrock", secret: "", createdAt: C0, bedrock: { auth: "ambient" } },
};
const store2 = (profiles, activeProfileId = null, autoRotateOnRateLimit = false) =>
  JSON.stringify({ profiles, activeProfileId, autoRotateOnRateLimit }, null, 2);
const accFile = (text, extra = {}) => ({ "acc/accounts.json": { text }, ...extra });
const E = { CLAUDIUS_ACCOUNTS_DIR: "$W/acc" };
const S = (op, more = {}) => ({ op, ...more });
const scan = [S("read"), S("public"), S("active"), S("autoRotate", { on: true }), S("read")];

const store_cases = [];
const add = (c) => store_cases.push({ env: E, ...c });

// -- basics
add({
  name: "nothing configured",
  steps: [
    S("read"),
    S("public"),
    S("active"),
    S("byId", { id: "acc_x" }),
    S("rotate"),
    S("activate", { id: "acc_x" }),
    S("delete", { id: "acc_x" }),
    S("meta", { id: "acc_x", meta: { emailAddress: "a@example.com" } }),
    S("autoRotate", { on: true }),
    S("read"),
    S("autoRotate", { on: false }),
  ],
});
add({
  name: "add three kinds, rotate, activate, delete",
  steps: [
    S("add", { input: { label: "  Personal Max  ", kind: "oauth-token", secret: `  ${OAUTH}\n` } }),
    S("add", { input: { label: "Overflow API", kind: "api-key", secret: APIKEY } }),
    S("add", {
      input: { label: "AWS SSO", kind: "bedrock", bedrock: { auth: "aws-profile", awsProfile: " work-sso ", region: " us-west-2 " } },
    }),
    S("public"),
    S("rotate"),
    S("rotate"),
    S("rotate"),
    S("active"),
    S("activate", { added: 1 }),
    S("byId", { added: 2 }),
    S("delete", { added: 1 }),
    S("public"),
    S("delete", { added: 2 }),
    S("delete", { added: 2 }),
    S("delete", { added: 0 }),
    S("read"),
    S("rotate"),
  ],
});
add({
  name: "add keeps metadata that is set",
  steps: [
    S("add", {
      input: {
        label: "Signed in",
        kind: "oauth-token",
        secret: OAUTH,
        accountUuid: "11111111-2222-3333-4444-555555555555",
        emailAddress: "max@example.com",
        organizationUuid: "org-0001",
        subscriptionType: "max",
        expiresAt: 1790003600000,
        refreshToken: "FAKE-refresh-ignored",
      },
    }),
    S("add", {
      input: {
        label: "Falsy metadata",
        kind: "api-key",
        secret: APIKEY,
        accountUuid: "",
        emailAddress: null,
        organizationUuid: 0,
        subscriptionType: false,
        expiresAt: "1790003600000",
      },
    }),
    S("add", { input: { label: "NaN expiry", kind: "oauth-token", secret: OAUTH, expiresAt: { $num: "NaN" } } }),
    S("add", { input: { label: "Zero expiry", kind: "oauth-token", secret: OAUTH, expiresAt: 0 } }),
    S("add", { input: { label: "Fractional expiry", kind: "oauth-token", secret: OAUTH, expiresAt: 1790000000000.5 } }),
    S("add", { input: { label: "Infinite expiry", kind: "oauth-token", secret: OAUTH, expiresAt: { $num: "Infinity" } } }),
    S("add", { input: { label: "Negative zero", kind: "oauth-token", secret: OAUTH, expiresAt: { $num: "-0" } } }),
    S("add", {
      input: {
        label: "Odd metadata types",
        kind: "oauth-token",
        secret: OAUTH,
        accountUuid: 42,
        emailAddress: ["a@example.com"],
        organizationUuid: { id: 1 },
        subscriptionType: true,
      },
    }),
    S("read"),
    S("active"),
  ],
});
add({
  name: "add input validation",
  steps: [
    S("add", { input: { kind: "oauth-token", secret: OAUTH } }),
    S("add", { input: { label: "   ", kind: "oauth-token", secret: OAUTH } }),
    S("add", { input: { label: "\u3000\u00a0\ufeff\u2028", kind: "oauth-token", secret: OAUTH } }),
    S("add", { input: { label: "\u0085", kind: "api-key", secret: APIKEY } }),
    S("add", { input: { label: null, kind: "oauth-token", secret: OAUTH } }),
    S("add", { input: { label: 5, kind: "oauth-token", secret: OAUTH } }),
    S("add", { input: { label: true, kind: "oauth-token", secret: OAUTH } }),
    S("add", { input: { label: { a: 1 }, kind: "oauth-token", secret: OAUTH } }),
    S("add", { input: { label: ["x"], kind: "oauth-token", secret: OAUTH } }),
    S("add", { input: { label: "", kind: "bogus", secret: 5 } }),
    S("add", { input: { label: "x", kind: "bogus", secret: OAUTH } }),
    S("add", { input: { label: "x", secret: OAUTH } }),
    S("add", { input: { label: "x", kind: "OAuth-Token", secret: OAUTH } }),
    S("add", { input: { label: "x", kind: 1, secret: OAUTH } }),
    S("add", { input: { label: "x", kind: "oauth-token" } }),
    S("add", { input: { label: "x", kind: "oauth-token", secret: "  \t " } }),
    S("add", { input: { label: "x", kind: "api-key", secret: null } }),
    S("add", { input: { label: "x", kind: "api-key", secret: 12345 } }),
    S("add", { input: { label: "x", kind: "bedrock", secret: 12345, bedrock: { auth: "ambient" } } }),
    S("add", { input: { label: "x", kind: "bedrock" } }),
    S("add", { input: { label: "x", kind: "bedrock", bedrock: { auth: "access-keys", accessKeyId: "AKIAFAKE" } } }),
    S("add", { input: { label: "x", kind: "bedrock", secret: "s", bedrock: { auth: "ambient", region: "mars-1" } } }),
    S("read"),
  ],
});
add({
  name: "add bedrock configs",
  steps: [
    S("add", {
      input: {
        label: "Keys",
        kind: "bedrock",
        secret: ` ${AWS_SECRET} `,
        bedrock: {
          auth: "access-keys",
          accessKeyId: " AKIAFAKE0000WXYZ ",
          sessionToken: ` ${SESSION_TOKEN} `,
          region: "ap-southeast-2",
          model: "  apac.anthropic.claude-sonnet-4-6 ",
          regionPrefix: "apac",
          baseUrl: " https://gateway.example.com/bedrock ",
          extra: "dropped",
        },
      },
    }),
    S("add", { input: { label: "Bearer", kind: "bedrock", secret: BEARER, bedrock: { auth: "bearer-token", regionPrefix: "" } } }),
    S("add", { input: { label: "Ambient", kind: "bedrock", secret: "ignored-secret", bedrock: { auth: "ambient", regionPrefix: null } } }),
    S("add", { input: { label: "Profile", kind: "bedrock", bedrock: { auth: "aws-profile", awsProfile: "dev", sessionToken: "x" } } }),
    S("public"),
    S("rotate"),
    S("read"),
  ],
});
add({
  name: "add to a store whose active pointer is empty or null",
  files: accFile(store2([{ ...P.api, id: "" }, P.oauth], "")),
  steps: [S("read"), S("active"), S("add", { input: { label: "New", kind: "api-key", secret: APIKEY } }), S("active")],
});
add({
  name: "add to profiles with no active one",
  files: accFile(store2([P.api, P.oauth], null, true)),
  steps: [S("add", { input: { label: "New", kind: "api-key", secret: APIKEY } }), S("active"), S("read")],
});

// -- rotation edges
add({ name: "rotate: two, none active", files: accFile(store2([P.oauth, P.api])), steps: [S("rotate"), S("read")] });
add({
  name: "rotate: duplicate ids",
  files: accFile(store2([P.oauth, { ...P.api, id: P.oauth.id }], P.oauth.id)),
  steps: [S("rotate"), S("read"), S("active")],
});
add({
  name: "rotate: wraps from the last",
  files: accFile(store2([P.oauth, P.api, P.bAmbient], P.bAmbient.id)),
  steps: [S("rotate"), S("rotate"), S("read")],
});
add({ name: "rotate: a single profile", files: accFile(store2([P.oauth], P.oauth.id)), steps: [S("rotate"), S("read")] });
add({
  name: "rotate: active points at a dropped profile",
  files: accFile(store2([P.oauth, P.api, { id: "acc_bad", label: 5 }], "acc_bad")),
  steps: [S("read"), S("rotate"), S("read")],
});
add({
  name: "rotate: the next one fails toPublic after the write",
  files: accFile(
    store2(
      [P.oauth, { ...P.bKeys, bedrock: { auth: "access-keys", accessKeyId: 12345678 } }],
      P.oauth.id,
    ),
  ),
  steps: [S("rotate"), S("read"), S("public")],
});
add({
  name: "rotate: duplicate active id later in the list",
  files: accFile(store2([P.api, P.oauth, P.oauth2, { ...P.bAmbient, id: P.oauth.id }], P.oauth.id)),
  steps: [S("rotate"), S("rotate"), S("rotate"), S("rotate")],
});

// -- metadata
const compact = (state) => ({ "acc/accounts.json": { text: JSON.stringify(state) } });
add({
  name: "metadata updates",
  files: compact({
    profiles: [
      { ...P.oauth, emailAddress: "old@example.com" },
      P.api,
      { ...P.oauth2, id: P.oauth.id, accountUuid: "dup" },
    ],
    activeProfileId: P.oauth.id,
    autoRotateOnRateLimit: false,
  }),
  steps: [
    S("meta", { id: "acc_nope", meta: { emailAddress: "x@example.com" } }),
    S("meta", { id: P.oauth.id, meta: {} }),
    S("meta", { id: P.oauth.id, meta: { emailAddress: "", accountUuid: null, organizationUuid: 0 } }),
    S("meta", { id: P.api.id, meta: { emailAddress: undefined } }),
    S("meta", { id: P.oauth.id, meta: { emailAddress: "old@example.com" } }),
    S("meta", { id: P.oauth.id, meta: { accountUuid: "dup" } }),
    S("meta", {
      id: P.oauth.id,
      meta: { subscriptionType: "Claude Max", organizationUuid: "org-1", emailAddress: "new@example.com", accountUuid: "u-1" },
    }),
    S("meta", { id: P.api.id, meta: { organizationUuid: { o: 1 } } }),
    // An equal object is still !== the stored one, so the file is rewritten
    // (the mode set here goes back to 0600).
    S("files", { files: { "acc/accounts.json": { mode: "644" } } }),
    S("meta", { id: P.api.id, meta: { organizationUuid: { o: 1 } } }),
    S("meta", { id: P.api.id, meta: { accountUuid: 7 } }),
    S("meta", { id: P.api.id, meta: { accountUuid: 7.0 } }),
    S("read"),
  ],
});

add({
  name: "metadata compares numbers by value",
  files: {
    "acc/accounts.json": {
      text: '{"profiles":[{"id":"acc_api","label":"n","kind":"api-key","secret":"sk-ant-api03-FAKE-0002-beta","createdAt":"c","accountUuid":1.0,"emailAddress":1e2}]}',
    },
  },
  steps: [
    S("meta", { id: P.api.id, meta: { accountUuid: 1, emailAddress: 100 } }),
    S("meta", { id: P.api.id, meta: { accountUuid: 1.5 } }),
    S("read"),
  ],
});

// -- foreign files
const FOREIGN = [
  ["not JSON", { text: "{" }],
  ["empty file", { text: "" }],
  ["only whitespace", { text: " \n\t" }],
  ["a BOM before valid JSON", { hex: `efbbbf${Buffer.from(store2([P.api], P.api.id)).toString("hex")}` }],
  ["null", { text: "null" }],
  ["an array", { text: "[]" }],
  ["a number", { text: "5" }],
  ["a string", { text: '"profiles"' }],
  ["true", { text: "true" }],
  ["profiles an object", { text: JSON.stringify({ profiles: { 0: P.api }, activeProfileId: P.api.id }) }],
  ["profiles a string", { text: JSON.stringify({ profiles: "[]", autoRotateOnRateLimit: true }) }],
  [
    "junk profile entries",
    {
      text: JSON.stringify({
        profiles: [
          null,
          5,
          "x",
          [],
          {},
          [P.api],
          { ...P.api, id: 5 },
          { ...P.api, label: null },
          { ...P.api, kind: "oauth" },
          { ...P.api, secret: 5 },
          { ...P.api, createdAt: 0 },
          { id: "acc_min", label: "", kind: "api-key", secret: "", createdAt: "" },
          { ...P.bAmbient, id: "b1", bedrock: undefined },
          { ...P.bAmbient, id: "b2", bedrock: null },
          { ...P.bAmbient, id: "b3", bedrock: [] },
          { ...P.bAmbient, id: "b4", bedrock: { auth: 5 } },
          { ...P.bAmbient, id: "b5", bedrock: { auth: "weird" } },
          { ...P.bAmbient, id: "b6", bedrock: {} },
          { ...P.bAmbient, id: "b7", bedrock: "aws" },
          { ...P.api, id: "k1", kind: "bedrock" },
          { ...P.bAmbient, id: "b8", kind: "api-key" },
        ],
        activeProfileId: "acc_min",
      }),
    },
  ],
  ["active is a number", { text: JSON.stringify({ profiles: [P.api], activeProfileId: 5 }) }],
  ["active names no profile", { text: JSON.stringify({ profiles: [P.api], activeProfileId: "acc_gone" }) }],
  ["active an empty id", { text: JSON.stringify({ profiles: [{ ...P.api, id: "" }], activeProfileId: "" }) }],
  ["autoRotate a string", { text: JSON.stringify({ profiles: [], activeProfileId: null, autoRotateOnRateLimit: "true" }) }],
  ["autoRotate one", { text: JSON.stringify({ profiles: [], autoRotateOnRateLimit: 1 }) }],
  [
    "foreign keys and odd numbers",
    {
      text:
        '{"version":2,"activeProfileId":"acc_api","profiles":[{"zeta":1.0,"id":"acc_api","10":"ten","label":"Overflow API",' +
        `"kind":"api-key","2":"two","secret":"${APIKEY}","createdAt":"${C0}","big":12345678901234567890,"e":1e2,` +
        '"tiny":1e-7,"huge":1e21,"neg":-0,"nested":{"b":1,"a":[1.50,{"z":null}]},"__proto__":{"polluted":true}}],' +
        '"autoRotateOnRateLimit":true,"extra":[1,2]}',
    },
  ],
  [
    "duplicate keys",
    {
      text:
        `{"profiles":[{"id":"first","label":"L","kind":"api-key","secret":"${APIKEY}","createdAt":"${C0}","id":"acc_api","label":"Later"}],` +
        '"activeProfileId":"first","activeProfileId":"acc_api","profiles2":0}',
    },
  ],
  [
    "unicode labels and secrets",
    {
      text: store2(
        [
          { ...P.api, id: "u1", label: "\ud83d\ude00 Max \u00e9\u0301", secret: "sk-\ud83d\ude00\ud83d\ude00" },
          { ...P.api, id: "u2", label: "tab\there", secret: "ab\ud83d\ude00cde" },
          { ...P.api, id: "u3", label: "\u2028\u2029\u0000\u001f\u007f", secret: "\ud83d\ude00\ud83d\ude00" },
          { ...P.api, id: "u4", label: "short", secret: "a" },
          { ...P.api, id: "u5", label: "four", secret: "abcd" },
          { ...P.api, id: "u6", label: "five", secret: "abcde" },
          { ...P.api, id: "u7", label: "empty secret", secret: "" },
        ],
        "u1",
      ),
    },
  ],
  [
    "invalid UTF-8 bytes",
    {
      hex: Buffer.concat([
        Buffer.from(`{"profiles":[{"id":"acc_api","label":"bad `),
        Buffer.from([0xff, 0xc3, 0x28, 0xe2, 0x82]),
        Buffer.from(`","kind":"api-key","secret":"${APIKEY}","createdAt":"${C0}"}],"activeProfileId":"acc_api"}`),
      ]).toString("hex"),
    },
  ],
  [
    "a lone surrogate escape",
    { text: `{"profiles":[{"id":"acc_api","label":"half \\ud800","kind":"api-key","secret":"${APIKEY}","createdAt":"${C0}"}]}` },
  ],
  [
    "nested 200 deep",
    {
      text: `{"profiles":[{"id":"acc_api","label":"deep","kind":"api-key","secret":"${APIKEY}","createdAt":"${C0}","deep":${"[".repeat(200)}${"]".repeat(200)}}]}`,
    },
  ],
  ["CRLF and tabs", { text: `{\r\n\t"profiles" : [ ${JSON.stringify(P.oauth)} ] ,\r\n\t"activeProfileId":"acc_oauth"\r\n}\r\n` }],
  [
    "bedrock profiles with odd config values",
    {
      text: store2(
        [
          { ...P.bKeys, id: "o1", bedrock: { auth: "access-keys", accessKeyId: [1, 2, 3, 4, 5], region: 5, model: { m: 1 } } },
          { ...P.bKeys, id: "o2", bedrock: { auth: "access-keys", accessKeyId: null, sessionToken: "s" } },
          { ...P.bKeys, id: "o3", bedrock: { auth: "access-keys", accessKeyId: "" } },
          { ...P.bKeys, id: "o4", bedrock: { auth: "access-keys", accessKeyId: "ab\ud83d\ude00" } },
          { ...P.bProfile, id: "o5", bedrock: { auth: "aws-profile" } },
          { ...P.bProfile, id: "o6", bedrock: { auth: "aws-profile", awsProfile: null, region: "" } },
          { ...P.bProfile, id: "o7", bedrock: { auth: "aws-profile", awsProfile: ["a", ["b", null]], model: 0 } },
          { ...P.bProfile, id: "o8", bedrock: { auth: "weird", region: "r", model: "m", sessionToken: "s", 1: "one" } },
          { ...P.bProfile, id: "o9", bedrock: { sessionToken: "first", auth: "bearer-token", region: true } },
        ],
        "o1",
      ),
    },
  ],
  ["a bedrock profile whose key id throws", { text: store2([{ ...P.bKeys, bedrock: { auth: "access-keys", accessKeyId: true } }]) }],
];
for (const [name, spec] of FOREIGN) add({ name: `foreign: ${name}`, files: { "acc/accounts.json": spec }, steps: scan });
add({
  name: "foreign: byId over duplicates",
  files: accFile(store2([P.api, { ...P.oauth, id: P.api.id }], P.api.id)),
  steps: [S("byId", { id: P.api.id }), S("active"), S("delete", { id: P.api.id }), S("read")],
});

// -- I/O
add({ name: "io: accounts.json is a directory", files: { "acc/accounts.json": { dir: true } }, steps: [S("read"), S("add", { input: { label: "x", kind: "api-key", secret: APIKEY } }), S("delete", { id: "x" })] });
add({ name: "io: accounts.json unreadable", files: { "acc/accounts.json": { text: store2([P.api]), mode: "000" } }, steps: [S("read"), S("autoRotate", { on: true })] });
add({
  name: "io: the store directory is read-only",
  files: { "acc/accounts.json": { text: store2([P.api], P.api.id) }, acc: { dir: true, mode: "555" } },
  steps: [S("read"), S("autoRotate", { on: true }), S("add", { input: { label: "x", kind: "api-key", secret: APIKEY } })],
});
add({
  name: "io: the store directory is a file",
  files: { acc: { text: "not a dir" } },
  steps: [S("read"), S("autoRotate", { on: true }), S("delete", { id: "x" })],
});
add({
  name: "io: accounts.json is a symlink",
  files: { "acc/real.json": { text: store2([P.api], P.api.id) }, "acc/accounts.json": { symlink: "$W/acc/real.json" } },
  steps: [S("read"), S("autoRotate", { on: true }), S("read")],
});
add({
  name: "io: accounts.json is a dangling symlink",
  files: { "acc/accounts.json": { symlink: "$W/acc/missing.json" } },
  steps: [S("read"), S("add", { input: { label: "x", kind: "api-key", secret: APIKEY } })],
});
add({ name: "io: accounts.json is a symlink loop", files: { "acc/accounts.json": { symlink: "$W/acc/accounts.json" } }, steps: [S("read")] });
add({
  name: "io: a looser mode is tightened on write",
  files: { "acc/accounts.json": { text: store2([P.api], P.api.id), mode: "644" }, "acc/accounts.json.123.abc.tmp": { text: "leftover" } },
  steps: [S("autoRotate", { on: true })],
});
add({
  name: "io: a missing nested store directory",
  env: { CLAUDIUS_ACCOUNTS_DIR: "$W/a/b/c" },
  steps: [S("read"), S("add", { input: { label: "x", kind: "api-key", secret: APIKEY } })],
});
add({
  name: "io: a store directory under a read-only parent",
  env: { CLAUDIUS_ACCOUNTS_DIR: "$W/ro/a/b" },
  files: { ro: { dir: true, mode: "555" } },
  steps: [S("read"), S("autoRotate", { on: true })],
});
add({
  name: "io: an empty override falls back to the home store",
  env: { CLAUDIUS_ACCOUNTS_DIR: "" },
  steps: [S("add", { input: { label: "x", kind: "api-key", secret: APIKEY } }), S("read")],
});
add({
  name: "io: an override with doubled and trailing slashes",
  env: { CLAUDIUS_ACCOUNTS_DIR: "$W//acc/./x/../" },
  files: { "acc/x": { dir: true } },
  steps: [S("add", { input: { label: "x", kind: "oauth-token", secret: OAUTH } }), S("env", { added: 0 }), S("read")],
});

// -- delete
add({
  name: "delete removes the profile directory",
  files: { "home/.claude/settings.json": { text: "{}" } },
  steps: [
    S("add", { input: { label: "A", kind: "oauth-token", secret: OAUTH } }),
    S("add", { input: { label: "B", kind: "api-key", secret: APIKEY } }),
    S("env", { added: 0 }),
    S("env", { added: 1 }),
    S("delete", { added: 0 }),
    S("files", { files: { [`acc/profiles/stray`]: { text: "x" } } }),
    S("delete", { added: 1 }),
    S("read"),
  ],
});
add({
  name: "delete when the profile path is a file",
  files: accFile(store2([P.api, P.oauth], P.api.id), { "acc/profiles/acc_api": { text: "a file" } }),
  steps: [S("delete", { id: P.api.id }), S("read")],
});
add({
  name: "delete an id that names the profiles directory",
  files: accFile(store2([{ ...P.api, id: "" }, P.oauth], ""), { "acc/profiles/acc_oauth/.credentials.json": { text: "{}" } }),
  steps: [S("delete", { id: "" }), S("read")],
});
add({
  name: "delete an id that climbs out",
  files: accFile(store2([{ ...P.api, id: ".." }, P.oauth], P.oauth.id), { "acc/keep.txt": { text: "keep" } }),
  steps: [S("delete", { id: ".." }), S("read")],
});

// -- env
const PARENT = {
  PATH: "/usr/bin:/bin",
  FOO: "bar",
  ANTHROPIC_API_KEY: "sk-ant-api03-FAKE-parent",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-FAKE-parent",
  ANTHROPIC_AUTH_TOKEN: "FAKE-parent-auth",
  CLAUDE_CONFIG_DIR: "/parent/config",
  CLAUDE_CODE_USE_BEDROCK: "1",
  CLAUDE_CODE_USE_VERTEX: "1",
  CLAUDE_CODE_USE_FOUNDRY: "1",
  CLAUDE_CODE_USE_MANTLE: "1",
  CLAUDE_CODE_ACCOUNT_UUID: "parent-uuid",
  CLAUDE_CODE_USER_EMAIL: "parent@example.com",
  CLAUDE_CODE_ORGANIZATION_UUID: "parent-org",
  AWS_PROFILE: "parent-profile",
  AWS_ACCESS_KEY_ID: "AKIAPARENT",
  AWS_SECRET_ACCESS_KEY: "FAKE-parent-secret",
  AWS_SESSION_TOKEN: "FAKE-parent-session",
  AWS_BEARER_TOKEN_BEDROCK: "FAKE-parent-bearer",
  AWS_REGION: "us-west-1",
  AWS_DEFAULT_REGION: "us-west-1",
  ANTHROPIC_MODEL: "parent-model",
  ANTHROPIC_BEDROCK_REGION_PREFIX: "us",
  ANTHROPIC_BEDROCK_BASE_URL: "https://parent.example.com",
  ANTHROPIC_BASE_URL: "https://kept.example.com",
};
const CLAUDE_HOME = {
  "home/.claude/settings.json": { text: '{"model":"opus"}' },
  "home/.claude/plugins": { dir: true },
  "home/.claude/projects/p/x.jsonl": { text: "{}\n" },
  "home/.claude/.credentials.json": { text: '{"claudeAiOauth":{"accessToken":"FAKE-keychain"}}' },
  "home/.claude/dangling": { symlink: "$W/nowhere" },
  "home/.claude/CLAUDE.md": { text: "# memory" },
};
const envProfiles = [
  P.oauth,
  { ...P.oauth2, accountUuid: "u-2", emailAddress: "work@example.com", organizationUuid: "org-2" },
  { ...P.oauth, id: "acc_partial", accountUuid: "u-3", emailAddress: "p@example.com" },
  { ...P.oauth, id: "acc_oddtriple", accountUuid: 5, emailAddress: ["e"], organizationUuid: { o: 1 } },
  P.api,
  P.bProfile,
  P.bKeys,
  { ...P.bKeys, id: "acc_bk2", bedrock: { auth: "access-keys", accessKeyId: "AKIAFAKE", sessionToken: "" } },
  P.bBearer,
  P.bAmbient,
  { ...P.bAmbient, id: "acc_ba2", bedrock: { auth: "ambient", region: "eu-west-3", model: "m", regionPrefix: "global", baseUrl: "http://gw" } },
  {
    ...P.bKeys,
    id: "acc_odd",
    bedrock: { auth: "access-keys", accessKeyId: null, region: 5, model: { m: 1 }, sessionToken: [], regionPrefix: [1, 2], baseUrl: true },
  },
  { ...P.bProfile, id: "acc_noprof", bedrock: { auth: "aws-profile", awsProfile: 7 } },
  { ...P.bProfile, id: "acc_noprof2", bedrock: { auth: "aws-profile" } },
  { ...P.bProfile, id: "acc_weird", bedrock: { auth: "weird", region: "r-1" } },
];
add({
  name: "env for every kind",
  files: { ...accFile(store2(envProfiles, P.oauth.id)), ...CLAUDE_HOME },
  steps: [
    ...envProfiles.map((p) => S("env", { id: p.id, env: PARENT })),
    S("env", { id: P.api.id, env: {} }),
    S("env", { id: P.bAmbient.id, env: { AWS_PROFILE: "kept", AWS_DEFAULT_REGION: "kept" } }),
  ],
});
add({
  name: "env mirror: existing entries in the profile directory",
  files: {
    ...accFile(store2([P.oauth, P.api], P.oauth.id)),
    ...CLAUDE_HOME,
    "acc/profiles/acc_oauth/settings.json": { text: "local copy" },
    "acc/profiles/acc_oauth/plugins": { symlink: "$W/elsewhere/plugins" },
    "acc/profiles/acc_oauth/CLAUDE.md": { symlink: "$W/home/.claude/CLAUDE.md/" },
    "acc/profiles/acc_oauth/projects": { dir: true },
    "acc/profiles/acc_oauth/.credentials.json": { text: "stale", mode: "644" },
    "acc/profiles/acc_api/.credentials.json": { text: '{"claudeAiOauth":{"accessToken":"FAKE-stale"}}' },
    "acc/profiles/acc_api/dangling": { symlink: "$W/nowhere" },
  },
  steps: [S("env", { id: P.oauth.id }), S("env", { id: P.oauth.id }), S("env", { id: P.api.id })],
});
add({ name: "env: no ~/.claude", files: accFile(store2([P.oauth, P.api])), steps: [S("env", { id: P.oauth.id }), S("env", { id: P.api.id })] });
add({
  name: "env: ~/.claude is a file",
  files: { ...accFile(store2([P.oauth])), "home/.claude": { text: "file" } },
  steps: [S("env", { id: P.oauth.id })],
});
add({
  name: "env: .credentials.json is a directory",
  files: {
    ...accFile(store2([P.oauth, P.api])),
    "acc/profiles/acc_oauth/.credentials.json/x": { text: "x" },
    "acc/profiles/acc_api/.credentials.json": { dir: true },
  },
  steps: [S("env", { id: P.oauth.id }), S("env", { id: P.api.id })],
});
add({
  name: "env: the profiles path is a file",
  files: { ...accFile(store2([P.oauth, { ...P.api, id: "a/b" }])), "acc/profiles": { text: "file" } },
  steps: [S("env", { id: P.oauth.id }), S("env", { id: "a/b" })],
});
add({
  name: "env: nested and normalized profile ids",
  files: accFile(store2([{ ...P.oauth, id: "team/alpha" }, { ...P.api, id: "x/../acc_api" }])),
  steps: [S("env", { id: "team/alpha" }), S("env", { id: "x/../acc_api" })],
});
add({
  name: "env: the default store under ~/.claude/.claudius",
  env: {},
  files: { "home/.claude/.claudius/accounts.json": { text: store2([P.oauth], P.oauth.id) }, "home/.claude/settings.json": { text: "{}" } },
  steps: [S("env", { id: P.oauth.id }), S("delete", { id: P.oauth.id })],
});
add({
  name: "env: HOME with a trailing slash",
  env: { ...E, HOME: "$W/home/" },
  files: { ...accFile(store2([P.oauth])), "home/.claude/settings.json": { text: "{}" } },
  steps: [S("env", { id: P.oauth.id })],
});
add({
  name: "env: an id that climbs out",
  files: { ...accFile(store2([{ ...P.api, id: ".." }])), "home/.claude/settings.json": { text: "{}" } },
  steps: [S("env", { id: ".." })],
});

// -- profile info
const ok = (data) => ({ status: 200, body: JSON.stringify(data) });
const FULL = {
  account: { uuid: "u-live", email: "live@example.com", display_name: "Live Person" },
  organization: { uuid: "org-live", organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" },
};
const GLOBAL = {
  oauthAccount: {
    accountUuid: "u-global",
    emailAddress: "global@example.com",
    displayName: "Global Person",
    organizationUuid: "org-global",
    organizationName: "Global Org",
    hasExtraUsageEnabled: false,
    billingType: "stripe_subscription",
    accountCreatedAt: "2025-01-01T00:00:00Z",
    subscriptionCreatedAt: "2025-02-01T00:00:00Z",
    unknownField: "dropped",
  },
};
const gfile = (v) => ({ "home/.claude.json": { text: typeof v === "string" ? v : JSON.stringify(v) } });
const info = (id, more = {}) => S("info", { id, ...more });
add({
  name: "info: unknown id and api-key profiles",
  files: accFile(store2([P.api, { ...P.api, id: "acc_meta", emailAddress: "m@example.com", subscriptionType: null, organizationUuid: "o" }])),
  steps: [
    info("acc_nope"),
    info(P.api.id),
    S("files", { files: gfile(GLOBAL) }),
    info(P.api.id),
    info(P.api.id, { skipCache: true }),
    info("acc_meta", { skipCache: true }),
    S("advance", { ms: 299999 }),
    info(P.api.id),
    S("advance", { ms: 1 }),
    S("files", { files: gfile({ oauthAccount: { emailAddress: "changed@example.com" } }) }),
    info(P.api.id),
    S("advance", { ms: 30000 }),
    info(P.api.id, { skipCache: true }),
    S("invalidate", { id: P.api.id }),
    info(P.api.id),
    S("invalidate"),
    info("acc_meta"),
    info(P.api.id),
    S("files", { files: gfile({ oauthAccount: { displayName: "Renamed" } }) }),
    S("advance", { ms: 30000 }),
    S("invalidate", { id: P.api.id }),
    info("acc_meta"),
    info(P.api.id),
    S("files", { files: gfile({ oauthAccount: { displayName: "Renamed again" } }) }),
    S("advance", { ms: 30000 }),
    S("invalidate"),
    info("acc_meta"),
  ],
});
add({
  name: "info: global config matching",
  files: {
    ...accFile(
      store2([
        { ...P.api, id: "match", accountUuid: "u-global" },
        { ...P.api, id: "other", accountUuid: "u-other", emailAddress: "mine@example.com" },
        { ...P.api, id: "legacy", organizationUuid: null },
        { ...P.api, id: "oddUuid", accountUuid: 5 },
      ]),
    ),
    ...gfile(GLOBAL),
  },
  steps: [info("match"), info("other"), info("legacy"), info("oddUuid")],
});
add({
  name: "info: global config without an account uuid",
  files: { ...accFile(store2([{ ...P.api, id: "withUuid", accountUuid: "u-1" }, P.api])), ...gfile({ oauthAccount: { emailAddress: "g@example.com" } }) },
  steps: [info("withUuid"), info(P.api.id)],
});
const GLOBAL_VARIANTS = [
  ["missing", null],
  ["not JSON", "{"],
  ["null", "null"],
  ["oauthAccount null", { oauthAccount: null }],
  ["oauthAccount an array", { oauthAccount: [] }],
  ["oauthAccount a string", { oauthAccount: "x" }],
  ["odd field types", { oauthAccount: { accountUuid: 1, emailAddress: null, displayName: ["d"], hasExtraUsageEnabled: "yes", billingType: "b" } }],
  ["field order", { oauthAccount: { subscriptionCreatedAt: "s", hasExtraUsageEnabled: true, displayName: "D", accountUuid: "A" } }],
  ["no oauthAccount", { other: 1 }],
];
for (const [name, v] of GLOBAL_VARIANTS) {
  add({
    name: `info: global config ${name}`,
    files: { ...accFile(store2([P.api])), ...(v === null ? {} : gfile(v)) },
    steps: [S("global"), info(P.api.id)],
  });
}
add({
  name: "info: global config cache and override path",
  env: { ...E, CLAUDIUS_CLAUDE_CONFIG_PATH: "$W/custom/claude.json" },
  files: { ...accFile(store2([P.api])), "custom/claude.json": { text: JSON.stringify(GLOBAL) }, ...gfile({ oauthAccount: { emailAddress: "home@example.com" } }) },
  steps: [
    S("global"),
    S("files", { files: { "custom/claude.json": { text: "{}" } } }),
    S("advance", { ms: 29999 }),
    S("global"),
    S("global", { skipCache: true }),
    S("files", { files: { "custom/claude.json": { text: JSON.stringify(GLOBAL) } } }),
    S("advance", { ms: 29999 }),
    S("global"),
    S("advance", { ms: 1 }),
    S("global"),
    info(P.api.id),
  ],
});
add({
  name: "info: global config empty override path",
  env: { ...E, CLAUDIUS_CLAUDE_CONFIG_PATH: "" },
  files: { ...accFile(store2([P.api])), ...gfile(GLOBAL) },
  steps: [S("global"), info(P.api.id)],
});
add({
  name: "info: bedrock profiles",
  files: {
    ...accFile(
      store2([
        P.bProfile,
        P.bKeys,
        P.bAmbient,
        { ...P.bKeys, id: "throws", bedrock: { auth: "access-keys", accessKeyId: 99 } },
        { ...P.bProfile, id: "arr", bedrock: { auth: "aws-profile", awsProfile: [], region: "eu-west-1" } },
      ]),
    ),
    ...gfile(GLOBAL),
  },
  steps: [
    info(P.bProfile.id),
    info(P.bKeys.id),
    info(P.bAmbient.id),
    info("throws"),
    info("arr"),
    info(P.bKeys.id),
    S("files", { files: accFile(store2([{ ...P.bKeys, bedrock: { ...P.bKeys.bedrock, region: "ap-south-1" } }])) }),
    info(P.bKeys.id),
    info(P.bKeys.id, { skipCache: true }),
  ],
});
add({
  name: "info: oauth lookups",
  files: compact({
    profiles: [P.oauth, { ...P.oauth2, accountUuid: "u-live", emailAddress: "live@example.com", organizationUuid: "org-live", subscriptionType: "Claude Max" }],
    activeProfileId: P.oauth.id,
  }),
  steps: [
    info(P.oauth.id, { fetch: [ok(FULL)] }),
    info(P.oauth.id),
    S("read"),
    info(P.oauth.id, { skipCache: true, fetch: [ok(FULL)] }),
    info(P.oauth2.id, { fetch: [ok(FULL)] }),
    info(P.oauth2.id, { skipCache: true, fetch: [ok({ ...FULL, organization: { ...FULL.organization, organization_type: "claude_pro" } })] }),
    S("read"),
  ],
});
const ORG_TYPES = ["claude_max", "claude_pro", "claude_team", "claude_enterprise", "claude_free", "", null, 5];
add({
  name: "info: organization types",
  files: accFile(store2([{ ...P.oauth, subscriptionType: "stored" }])),
  steps: ORG_TYPES.map((t) => info(P.oauth.id, { skipCache: true, fetch: [ok({ organization: { organization_type: t } })] })),
});
const STATUSES = [401, 403, 404, 429, 499, 500, 503, 529, 299, 300, 302, 199];
add({
  name: "info: error statuses without cached metadata",
  files: accFile(store2([P.oauth])),
  steps: [
    ...STATUSES.filter((s) => s >= 200).map((s) => info(P.oauth.id, { fetch: [{ status: s, body: "nope" }] })),
    info(P.oauth.id, { fetch: [{ throws: "fetch failed" }] }),
    S("files", { files: gfile(GLOBAL) }),
    info(P.oauth.id, { fetch: [{ status: 500, body: "" }] }),
    info(P.oauth.id, { fetch: [{ status: 204 }] }),
  ],
});
add({
  name: "info: error statuses with cached metadata",
  files: accFile(
    store2([
      { ...P.oauth, emailAddress: "e@example.com" },
      { ...P.oauth2, subscriptionType: "Claude Pro" },
      { ...P.oauth, id: "falsy", emailAddress: "", subscriptionType: 0 },
    ]),
  ),
  steps: [
    info(P.oauth.id, { fetch: [{ status: 401, body: "" }] }),
    info(P.oauth2.id, { fetch: [{ status: 529, body: "" }] }),
    info("falsy", { fetch: [{ status: 403, body: "" }] }),
    info(P.oauth.id, { fetch: [{ throws: "fetch failed" }] }),
  ],
});
// CC 2.1.309: a certificate-verification failure reports the hint instead
// of undici's bare "fetch failed", with or without cached metadata.
const CERT = { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", message: "unable to verify the first certificate" };
add({
  name: "info: the profile endpoint's certificate is not trusted",
  files: accFile(
    store2([
      P.oauth,
      { ...P.oauth, id: "cached", emailAddress: "e@example.com", subscriptionType: "Claude Pro" },
    ]),
  ),
  steps: [
    info(P.oauth.id, { fetch: [{ throwCert: CERT }] }),
    info("cached", { fetch: [{ throwCert: CERT }] }),
    // By message alone (no `code`), and nested one level down.
    info(P.oauth.id, { skipCache: true, fetch: [{ throwCert: { message: "self signed certificate in certificate chain" } }] }),
    // A TLS failure a CA bundle can't fix keeps undici's message.
    info(P.oauth.id, { skipCache: true, fetch: [{ throwCert: { code: "CERT_HAS_EXPIRED", message: "certificate has expired" } }] }),
    // A successful lookup after one still caches and backfills.
    info(P.oauth.id, { skipCache: true, fetch: [ok(FULL)] }),
    S("read"),
  ],
});
const BODIES = [
  ["HTML", { status: 200, body: "<html>" }],
  ["empty", { status: 200, body: "" }],
  ["null", { status: 200, body: "null" }],
  ["a number", { status: 200, body: "5" }],
  ["an array", { status: 200, body: "[1]" }],
  ["a string", { status: 200, body: '"x"' }],
  ["BOM", { status: 200, hex: `efbbbf${Buffer.from(JSON.stringify(FULL)).toString("hex")}` }],
  ["two BOMs", { status: 200, hex: `efbbbfefbbbf${Buffer.from("{}").toString("hex")}` }],
  ["invalid UTF-8", { status: 200, hex: Buffer.concat([Buffer.from('{"account":{"email":"a'), Buffer.from([0xff]), Buffer.from('"}}')]).toString("hex") }],
  ["odd types", { status: 200, body: JSON.stringify({ account: { uuid: 5, email: ["x"], display_name: null }, organization: "org" }) }],
  ["organization null", { status: 200, body: JSON.stringify({ account: null, organization: null }) }],
  ["account a string", { status: 200, body: JSON.stringify({ account: "a", organization: { uuid: "", rate_limit_tier: 0 } }) }],
  ["empty object", { status: 200, body: "{}" }],
  ["a huge number", { status: 200, body: '{"account":{"email":1e400}}' }],
];
for (const [name, r] of BODIES) {
  add({
    name: `info: a 200 body that is ${name}`,
    files: compact({ profiles: [{ ...P.oauth, emailAddress: "stored@example.com", subscriptionType: "Claude Pro" }] }),
    steps: [info(P.oauth.id, { fetch: [r] }), info(P.oauth.id, { fetch: [ok(FULL)] }), S("read")],
  });
}
add({
  name: "info: guessed global identity with errors",
  files: { ...accFile(store2([P.oauth])), ...gfile(GLOBAL) },
  steps: [
    info(P.oauth.id, { fetch: [{ status: 500, body: "" }] }),
    info(P.oauth.id, { fetch: [{ throws: "fetch failed" }] }),
    info(P.oauth.id, { fetch: [ok({ account: { uuid: "u-global" } })] }),
    S("read"),
  ],
});
add({
  name: "info: the backfill is a no-op when nothing changed",
  files: compact({
    profiles: [{ ...P.oauth, accountUuid: "u-live", emailAddress: "live@example.com", organizationUuid: "org-live", subscriptionType: "Claude Max" }],
  }),
  steps: [info(P.oauth.id, { fetch: [ok(FULL)] }), info(P.oauth.id, { skipCache: true, fetch: [ok({})] })],
});
add({
  name: "info: the backfill fails quietly",
  files: { "acc/accounts.json": { text: store2([P.oauth]) }, acc: { dir: true, mode: "555" } },
  steps: [info(P.oauth.id, { fetch: [ok(FULL)] }), S("read")],
});
add({
  name: "info: the store does not load",
  files: { "acc/accounts.json": { text: "{" } },
  steps: [info(P.oauth.id)],
});

// ---- pure cases -------------------------------------------------------------

const normalize = [
  [undefined, ""],
  [null, ""],
  ["aws-profile", ""],
  [5, ""],
  [[], ""],
  [{}, ""],
  [{ auth: "AWS-PROFILE" }, ""],
  [{ auth: " ambient" }, ""],
  [{ auth: "ambient" }, ""],
  [{ auth: "ambient" }, "secret-ignored"],
  [{ auth: "ambient", region: "us-east-1" }, ""],
  [{ auth: "ambient", region: "  us-gov-west-1\n" }, ""],
  [{ auth: "ambient", region: "eu-central-1" }, ""],
  [{ auth: "ambient", region: "US-EAST-1" }, ""],
  [{ auth: "ambient", region: "us-east" }, ""],
  [{ auth: "ambient", region: "useast-1" }, ""],
  [{ auth: "ambient", region: "u-east-1" }, ""],
  [{ auth: "ambient", region: "us-east-1a" }, ""],
  [{ auth: "ambient", region: "us--east-1" }, ""],
  [{ auth: "ambient", region: "us-east-\u0661" }, ""],
  [{ auth: "ambient", region: "us-east-1\n" }, ""],
  [{ auth: "ambient", region: "  " }, ""],
  [{ auth: "ambient", region: 5 }, ""],
  [{ auth: "ambient", region: "ap-south-east-12" }, ""],
  [{ auth: "aws-profile" }, ""],
  [{ auth: "aws-profile", awsProfile: "  " }, ""],
  [{ auth: "aws-profile", awsProfile: 5 }, ""],
  [{ auth: "aws-profile", awsProfile: " dev ", region: "bad" }, ""],
  [{ auth: "aws-profile", awsProfile: " dev ", accessKeyId: "AKIA", sessionToken: "t" }, "s"],
  [{ auth: "access-keys" }, "s"],
  [{ auth: "access-keys", accessKeyId: " AKIA " }, ""],
  [{ auth: "access-keys", accessKeyId: "AKIA" }, "s"],
  [{ auth: "access-keys", accessKeyId: "AKIA", sessionToken: "  " }, "s"],
  [{ auth: "access-keys", accessKeyId: "AKIA", sessionToken: " tok " }, "s"],
  [{ auth: "access-keys", accessKeyId: "AKIA", awsProfile: "dropped" }, "s"],
  [{ auth: "bearer-token" }, ""],
  [{ auth: "bearer-token" }, "key"],
  [{ auth: "bearer-token", model: "  us.anthropic.claude-sonnet-4-6  " }, "key"],
  [{ auth: "bearer-token", model: "" }, "key"],
  [{ auth: "bearer-token", model: 5 }, "key"],
  [{ auth: "ambient", regionPrefix: "us" }, ""],
  [{ auth: "ambient", regionPrefix: "global" }, ""],
  [{ auth: "ambient", regionPrefix: "" }, ""],
  [{ auth: "ambient", regionPrefix: null }, ""],
  [{ auth: "ambient", regionPrefix: "US" }, ""],
  [{ auth: "ambient", regionPrefix: " us" }, ""],
  [{ auth: "ambient", regionPrefix: 0 }, ""],
  [{ auth: "ambient", regionPrefix: false }, ""],
  [{ auth: "ambient", regionPrefix: ["us"] }, ""],
  [{ auth: "ambient", baseUrl: "https://gw.example.com" }, ""],
  [{ auth: "ambient", baseUrl: " http://localhost:8080/path?q=1#f " }, ""],
  [{ auth: "ambient", baseUrl: "HTTPS://EXAMPLE.COM" }, ""],
  [{ auth: "ambient", baseUrl: "https:example.com" }, ""],
  [{ auth: "ambient", baseUrl: "https:///example.com" }, ""],
  [{ auth: "ambient", baseUrl: "https://\\example.com" }, ""],
  [{ auth: "ambient", baseUrl: "https://" }, ""],
  [{ auth: "ambient", baseUrl: "http://" }, ""],
  [{ auth: "ambient", baseUrl: "https://user:pw@host" }, ""],
  [{ auth: "ambient", baseUrl: "https://user@" }, ""],
  [{ auth: "ambient", baseUrl: "https://:443" }, ""],
  [{ auth: "ambient", baseUrl: "https://host:" }, ""],
  [{ auth: "ambient", baseUrl: "https://host:65535" }, ""],
  [{ auth: "ambient", baseUrl: "https://host:65536" }, ""],
  [{ auth: "ambient", baseUrl: "https://host:8a" }, ""],
  [{ auth: "ambient", baseUrl: "https://ex ample.com" }, ""],
  [{ auth: "ambient", baseUrl: "https://ex%20ample.com" }, ""],
  [{ auth: "ambient", baseUrl: "https://exa\tmple.com" }, ""],
  [{ auth: "ambient", baseUrl: "https://ex\u00e4mple.com" }, ""],
  [{ auth: "ambient", baseUrl: "https://xn--" }, ""],
  [{ auth: "ambient", baseUrl: "https://xn--nxasmq6b.com" }, ""],
  [{ auth: "ambient", baseUrl: "https://[::1]:8443" }, ""],
  [{ auth: "ambient", baseUrl: "https://[::1" }, ""],
  [{ auth: "ambient", baseUrl: "https://[zz]" }, ""],
  [{ auth: "ambient", baseUrl: "https://1.2.3.4" }, ""],
  [{ auth: "ambient", baseUrl: "https://1.2.3.256" }, ""],
  [{ auth: "ambient", baseUrl: "https://0x7f.1" }, ""],
  [{ auth: "ambient", baseUrl: "https://example.com.1" }, ""],
  [{ auth: "ambient", baseUrl: "https://a<b" }, ""],
  [{ auth: "ambient", baseUrl: "https://a^b" }, ""],
  [{ auth: "ambient", baseUrl: "https://a_b" }, ""],
  [{ auth: "ambient", baseUrl: "https://%zz" }, ""],
  [{ auth: "ambient", baseUrl: "https://\u2163.com" }, ""],
  [{ auth: "ambient", baseUrl: "https://\u00ad" }, ""],
  [{ auth: "ambient", baseUrl: "ftp://example.com" }, ""],
  [{ auth: "ambient", baseUrl: "file:///etc/passwd" }, ""],
  [{ auth: "ambient", baseUrl: "javascript:alert(1)" }, ""],
  [{ auth: "ambient", baseUrl: "example.com" }, ""],
  [{ auth: "ambient", baseUrl: "//example.com" }, ""],
  [{ auth: "ambient", baseUrl: "http:/example.com" }, ""],
  [{ auth: "ambient", baseUrl: "h ttp://example.com" }, ""],
  [{ auth: "ambient", baseUrl: "http+x://example.com" }, ""],
  [{ auth: "ambient", baseUrl: 5 }, ""],
  [{ auth: "ambient", baseUrl: "   " }, ""],
  [
    {
      auth: "access-keys",
      baseUrl: "https://e.example",
      regionPrefix: "jp",
      model: "m",
      sessionToken: "t",
      accessKeyId: "k",
      region: "ap-northeast-1",
      awsProfile: "p",
    },
    "s",
  ],
  [{ auth: "access-keys", accessKeyId: "k", region: "bad region" }, ""],
  [{ auth: "access-keys", accessKeyId: "k", regionPrefix: "xx" }, ""],
  [{ auth: "access-keys", accessKeyId: "k", baseUrl: "nope" }, "s"],
  [{ auth: "bearer-token", regionPrefix: "xx", baseUrl: "nope" }, "k"],
];
const describe = [
  { auth: "ambient" },
  { auth: "ambient", region: "us-east-1", model: "m" },
  { auth: "aws-profile", awsProfile: "work" },
  { auth: "aws-profile" },
  { auth: "aws-profile", awsProfile: null },
  { auth: "aws-profile", awsProfile: "" },
  { auth: "aws-profile", awsProfile: 0 },
  { auth: "aws-profile", awsProfile: { a: 1 } },
  { auth: "aws-profile", awsProfile: [1, [2, null], "x"] },
  { auth: "access-keys", accessKeyId: "AKIAFAKE0000WXYZ" },
  { auth: "access-keys", accessKeyId: "AB" },
  { auth: "access-keys", accessKeyId: "" },
  { auth: "access-keys", accessKeyId: null },
  { auth: "access-keys" },
  { auth: "access-keys", accessKeyId: "x\ud83d\ude00yz" },
  { auth: "access-keys", accessKeyId: [1, 2, 3, 4, 5, 6] },
  { auth: "access-keys", accessKeyId: [] },
  { auth: "access-keys", accessKeyId: 1234 },
  { auth: "access-keys", accessKeyId: { k: 1 } },
  { auth: "access-keys", accessKeyId: true },
  { auth: "bearer-token", region: "eu-west-1" },
  { auth: "weird", region: "r", model: "m" },
  { region: 5, model: [1, 2] },
  { auth: "ambient", region: { r: 1 }, model: true },
  { auth: "ambient", region: "", model: "" },
  { auth: "ambient", region: 0, model: 0 },
];
const toPublic = [
  P.oauth,
  P.api,
  P.bProfile,
  P.bKeys,
  P.bBearer,
  P.bAmbient,
  { ...P.api, secret: "" },
  { ...P.api, secret: "abc" },
  { ...P.api, secret: "abcd" },
  { ...P.api, secret: "abcde" },
  { ...P.api, secret: "\ud83d\ude00\ud83d\ude00" },
  { ...P.api, secret: "x\ud83d\ude00" },
  { ...P.api, secret: "abc\ud83d\ude00" },
  { ...P.api, secret: "abcd\ud83d\ude00" },
  { ...P.api, extra: "dropped", emailAddress: "dropped@example.com" },
  { ...P.bKeys, bedrock: { sessionToken: "s", 1: "one", auth: "access-keys", accessKeyId: "AKIA1234", z: null } },
  { ...P.bKeys, bedrock: { auth: "access-keys", accessKeyId: 5 } },
  { ...P.bProfile, bedrock: { auth: "aws-profile", awsProfile: ["a", "b"], region: 7 } },
  { ...P.oauth, kind: "oauth-token", bedrock: { auth: "ambient" } },
];
const kinds = ["oauth-token", "api-key", "bedrock", "Bedrock", "oauth", "", null, 5, ["api-key"], { kind: "api-key" }, true];
const regions = [
  "us-east-1",
  "eu-central-1",
  "us-gov-west-1",
  "ap-southeast-2",
  "cn-north-1",
  "us-east-12",
  "us-east-",
  "us-east",
  "us-1",
  "u-east-1",
  "usa-east-1",
  "US-east-1",
  "us-East-1",
  "us-east-1 ",
  " us-east-1",
  "us-east-1\n",
  "us_east-1",
  "us-east-1-2",
  "us--1",
  "us-a-b-c-1",
  "",
  "us-\u00e9ast-1",
  "us-east-\uff11",
];
const bedrockEnv = [
  [P.api, { A: "1" }],
  [P.oauth, {}],
  [P.bAmbient, { AWS_PROFILE: "p", AWS_REGION: "r", CLAUDE_CODE_USE_MANTLE: "1", ANTHROPIC_MODEL: "m" }],
  [P.bKeys, { AWS_PROFILE: "p", AWS_DEFAULT_REGION: "d", ANTHROPIC_BEDROCK_BASE_URL: "u" }],
  [{ ...P.bBearer, bedrock: { auth: "bearer-token", region: "", model: "", regionPrefix: "", baseUrl: "" } }, { ANTHROPIC_MODEL: "m", AWS_DEFAULT_REGION: "d" }],
];
const accountsDirs = [
  [undefined, "/home/u"],
  ["", "/home/u"],
  ["/custom/dir", "/home/u"],
  ["/custom//dir/../x/", "/home/u"],
  ["relative/dir", "/home/u"],
  [undefined, "/home/u/"],
  [undefined, "/home//u/./v/.."],
  [undefined, "/"],
  [undefined, ""],
];
const expiries = [
  [null, T0],
  [undefined, T0],
  [T0, T0],
  [T0 + 1, T0],
  [T0 - 1, T0],
  [T0 + 259200000, T0],
  [T0 + 259200001, T0],
  [T0 + 259199999.5, T0],
  [{ $num: "NaN" }, T0],
  [{ $num: "Infinity" }, T0],
  [{ $num: "-Infinity" }, T0],
  ["1790000000124", T0],
  [0, -1],
  [0, 0],
  [1, 0],
  [-1, -2],
  [259200000, 0],
  [1e300, 1e300 - 1],
  [true, 0],
];

async function pure() {
  const res = { normalize: [], describe: [], toPublic: [], kind: [], region: [], bedrockEnv: [], accountsDir: [], expiry: [] };
  const run = (f) => {
    try {
      return { out: json(f()) };
    } catch (e) {
      return { throws: e instanceof Error ? e.message : String(e) };
    }
  };
  for (const [input, secret] of normalize) {
    res.normalize.push({ input: input === undefined ? { $undefined: true } : input, secret, ...run(() => shared.normalizeBedrockConfig(input, secret)) });
  }
  for (const cfg of describe) res.describe.push({ cfg, ...run(() => shared.describeBedrockConfig(cfg)) });
  for (const p of toPublic) res.toPublic.push({ profile: p, ...run(() => store.toPublic(p)) });
  for (const k of kinds) res.kind.push({ value: k, out: shared.isAccountKind(k) });
  for (const r of regions) res.region.push({ value: r, out: shared.isValidAwsRegion(r) });
  for (const [p, env] of bedrockEnv) {
    res.bedrockEnv.push({
      profile: p,
      env,
      ...run(() => {
        const e = { ...env };
        store.applyBedrockEnv(e, p);
        return effectiveEnv(e);
      }),
    });
  }
  for (const [override, home] of accountsDirs) {
    const env = { HOME: home };
    if (override !== undefined) env.CLAUDIUS_ACCOUNTS_DIR = override;
    setEnv(env);
    res.accountsDir.push({ override: override ?? null, home, out: store.accountsDir() });
  }
  for (const [e, now] of expiries) {
    res.expiry.push({ expiresAt: e === undefined ? { $undefined: true } : e, now, out: expiry.shouldWarnTokenExpiring(num(e), num(now)) });
  }
  return res;
}

const fixture = { t0: T0, store: [], pure: null };
for (const [i, c] of store_cases.entries()) fixture.store.push(await runStoreCase(c, i));
fixture.pure = await pure();
writeFileSync(join(ROOT, "out.json"), JSON.stringify(fixture));

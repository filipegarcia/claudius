#!/usr/bin/env node
// Golden fixture for the managed settings source (the file tier and the
// macOS MDM plist tier), as read by the SDK's `resolveSettings()`.
//
//   node rust/scripts/managed-settings-golden.mjs     (macOS: needs plutil)
//
// The SDK's paths can't be redirected. `k0e()` (the managed dir) asks a hook
// that is compiled out (`function P0e(){return}`), and `tq()` hardcodes
// "/Library/Managed Preferences/". This script copies the installed sdk.mjs
// to a temp dir and patches both: the hook returns
// $CLAUDIUS_GOLDEN_MANAGED_DIR and the plist root becomes
// $CLAUDIUS_GOLDEN_MDM_DIR.
//
// Each case runs in a fresh node process, because the SDK caches the managed
// path, the parsed files and the plist read per process. The process gets a
// temp managed dir, a temp plist root (with the per-user `<user>/` dir) and
// a temp CLAUDE_CONFIG_DIR, then runs
// `resolveSettings({cwd, settingSources: []})`. The managed source's
// settings are projected to the three keys Claudius reads (`deniedModels`,
// `availableModelsMatch`, `modelPricing`) and written with `policyOrigin` and
// the TS consumers' outputs to
// rust/crates/claudius-core/tests/fixtures/managed_settings_golden.json.
// `crates/claudius-core/tests/managed_settings_golden.rs` replays it.
//
// Plists are stored in the fixture as XML text (or base64 for binary
// plists), so the replay writes the same bytes.
//
// Windows registry cases run the SDK's win32 branch on macOS: a third patch
// makes `gw()` call `Qq($CLAUDIUS_GOLDEN_REG)` (a fake reg.exe script that
// prints the case's captured `reg query` output and exit code, and logs its
// argv), and `ra()` name the tier "hklm". Everything after the two
// `reg query` results is the SDK's own code.
//
// WSL cases (`wsl: true`) also make `Yd()` and `vq()`'s platform check
// report WSL, and point `Jn` (the Windows managed folder, normally
// "/mnt/c/Program Files/ClaudeCode") at a temp dir staged from the case's
// `win` tree. With the fake reg.exe that's the SDK's whole WSL chain: the
// `wslInheritsWindowsSettings` walk, HKLM/HKCU, and the file tier choice.
//
// Nothing outside the temp dirs is written, and the real system dirs are
// never touched. The recorder fails if any `policyOrigin` other than
// "file" / "plist" shows up (e.g. a remote tier leaking in).
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const KEYS = ["availableModelsMatch", "deniedModels", "modelPricing"];
const self = fileURLToPath(import.meta.url);

/** A file spec that isn't plain text: `{base64}` bytes, or `{text, padTo}`
 * (ASCII text padded with spaces to `padTo` bytes). */
function fileBytes(spec) {
  if (spec.base64 !== undefined) return Buffer.from(spec.base64, "base64");
  return spec.text + " ".repeat(spec.padTo - spec.text.length);
}

/** Stage a managed folder from a tree spec: `dirs`, `files`, `symlinks`. */
function stageTree(dir, tree) {
  mkdirSync(dir);
  for (const d of tree?.dirs ?? []) mkdirSync(join(dir, d), { recursive: true });
  for (const [rel, spec] of Object.entries(tree?.files ?? {})) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), typeof spec === "string" ? spec : fileBytes(spec));
  }
  for (const [rel, target] of Object.entries(tree?.symlinks ?? {})) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    symlinkSync(target, join(dir, rel));
  }
}

/** Stage one case under `root`, run resolveSettings, print the managed source. */
async function worker(sdkFile, caseJson) {
  const c = JSON.parse(caseJson);
  const root = mkdtempSync(join(tmpdir(), "claudius-managed-golden-"));
  try {
    const managed = join(root, "managed");
    const mdm = join(root, "mdm");
    const cfg = join(root, "cfg");
    const cwd = join(root, "proj");
    for (const d of [managed, mdm, cfg, cwd]) mkdirSync(d);
    for (const [rel, spec] of Object.entries(c.files ?? {})) {
      if (typeof spec === "string") continue;
      mkdirSync(dirname(join(managed, rel)), { recursive: true });
      writeFileSync(join(managed, rel), fileBytes(spec));
    }
    const plistPaths = {
      user: join(mdm, userInfo().username, "com.anthropic.claudecode.plist"),
      device: join(mdm, "com.anthropic.claudecode.plist"),
    };
    mkdirSync(dirname(plistPaths.user));
    for (const [role, p] of Object.entries(c.plists ?? {})) {
      const path = plistPaths[role];
      if (p.dir) mkdirSync(path);
      else writeFileSync(path, p.base64 !== undefined ? Buffer.from(p.base64, "base64") : p.xml);
      if (p.mode !== undefined) chmodSync(path, p.mode);
    }
    for (const d of c.dirs ?? []) mkdirSync(join(managed, d), { recursive: true });
    for (const [rel, text] of Object.entries(c.files ?? {})) {
      if (typeof text !== "string") continue;
      mkdirSync(dirname(join(managed, rel)), { recursive: true });
      writeFileSync(join(managed, rel), text);
    }
    for (const [rel, target] of Object.entries(c.symlinks ?? {})) {
      mkdirSync(dirname(join(managed, rel)), { recursive: true });
      symlinkSync(target, join(managed, rel));
    }
    if (c.remote !== undefined) writeFileSync(join(cfg, "remote-settings.json"), c.remote);
    const win = join(root, "win");
    stageTree(win, c.win);
    if (c.wsl) {
      process.env.CLAUDIUS_GOLDEN_WSL = "1";
      process.env.CLAUDIUS_GOLDEN_WIN_DIR = win;
    }
    const reg = join(root, "reg");
    if (c.registry) {
      mkdirSync(reg);
      for (const [hive, spec] of Object.entries(c.registry)) {
        writeFileSync(join(reg, `${hive}.out`), spec.out + " ".repeat(spec.pad ?? 0));
        writeFileSync(join(reg, `${hive}.code`), String(spec.code ?? 0));
      }
      const fake = join(reg, "reg.sh");
      writeFileSync(
        fake,
        [
          "#!/bin/sh",
          `d='${reg}'`,
          // One write per call: HKLM and HKCU are queried in parallel.
          `line="$(printf '%s\\037' "$@")"; printf '%s\\n' "$line" >> "$d/calls"`,
          'case "$2" in HKLM*) f=hklm;; *) f=hkcu;; esac',
          '[ -f "$d/$f.out" ] && cat "$d/$f.out"',
          'if [ -f "$d/$f.code" ]; then exit "$(cat "$d/$f.code")"; else exit 1; fi',
          "",
        ].join("\n"),
      );
      chmodSync(fake, 0o755);
      process.env.CLAUDIUS_GOLDEN_REG = fake;
    }
    process.env.CLAUDIUS_GOLDEN_MANAGED_DIR = managed;
    process.env.CLAUDIUS_GOLDEN_MDM_DIR = mdm;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    const { resolveSettings } = await import(pathToFileURL(sdkFile).href);
    const r = await resolveSettings({ cwd, settingSources: [] });
    const src = r.sources.find((s) => s.source === "managed");
    let calls = null;
    if (c.registry) {
      calls = readFileSync(join(reg, "calls"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\x1f").slice(0, -1))
        .sort();
    }
    process.stdout.write(JSON.stringify({ src: src ?? null, calls }));
  } finally {
    for (const p of [join(root, "mdm", userInfo().username), join(root, "mdm")]) {
      try {
        chmodSync(join(p, "com.anthropic.claudecode.plist"), 0o644);
      } catch {
        // not there
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--worker") {
  await worker(process.argv[3], process.argv[4]);
  process.exit(0);
}

const here = dirname(self);
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const sdkPath = join(repo, "node_modules/@anthropic-ai/claude-agent-sdk");
const sdkVersion = JSON.parse(readFileSync(join(sdkPath, "package.json"), "utf8")).version;
const bundle = readFileSync(join(sdkPath, "sdk.mjs"), "utf8");

// Find the override hook by its caller's shape, not by its minified name.
const hookCall = bundle.match(
  /function \w+\(\)\{let e=(\w+)\(\);if\(e!==void 0\)return e;switch\(\w+\(\)\)\{case"macos":return"\/Library\/Application Support\/ClaudeCode"/,
);
if (!hookCall) throw new Error(`managed-dir function not found in sdk.mjs ${sdkVersion}`);
const stub = `function ${hookCall[1]}(){return}`;
if (bundle.split(stub).length !== 2) {
  throw new Error(`override hook ${stub} not found exactly once in sdk.mjs ${sdkVersion}`);
}
const plistRoot = "`/Library/Managed Preferences/";
if (bundle.split(plistRoot).length !== 3) {
  throw new Error(`expected the two tq() plist paths in sdk.mjs ${sdkVersion}`);
}
const darwinBranch = 'if(process.platform==="darwin"){let e=tq()';
const tierName = 'function ra(){return wt()==="macos"?"plist":"hklm"}';
const wslWindowsDir = ',Jn="/mnt/c/Program Files/ClaudeCode"';
for (const anchor of [darwinBranch, tierName, wslWindowsDir]) {
  if (bundle.split(anchor).length !== 2) {
    throw new Error(`anchor ${anchor} not found exactly once in sdk.mjs ${sdkVersion}; re-derive gw()/ra()`);
  }
}
// `Yd()` (WSL detection for the registry read and the flag walk) and
// `vq()`'s platform check (the file tier choice), found by shape.
const wslDetect = /function \w+\(\)\{if\(process\.platform!=="linux"\)return!1;if\(process\.env\.WSL_DISTRO_NAME\)return!0;/g;
const fileTierWsl = /(function \w+\(e\)\{if\()(\w+\(\)==="wsl"\)\{let t=\w+\(\w+\(e\)\);if\(e\.wslInherits\?\.\(\)\))/g;
for (const re of [wslDetect, fileTierWsl]) {
  if ((bundle.match(re) ?? []).length !== 1) {
    throw new Error(`${re} not found exactly once in sdk.mjs ${sdkVersion}; re-derive Yd()/vq()`);
  }
}
const work = mkdtempSync(join(tmpdir(), "claudius-managed-sdk-"));
const sdkFile = join(work, "sdk.mjs");
writeFileSync(
  sdkFile,
  bundle
    .replace(stub, `function ${hookCall[1]}(){return process.env.CLAUDIUS_GOLDEN_MANAGED_DIR}`)
    .replaceAll(plistRoot, "`${process.env.CLAUDIUS_GOLDEN_MDM_DIR}/")
    .replace(darwinBranch, `if(process.env.CLAUDIUS_GOLDEN_REG)return Qq(process.env.CLAUDIUS_GOLDEN_REG);${darwinBranch}`)
    .replace(tierName, 'function ra(){return process.env.CLAUDIUS_GOLDEN_REG?"hklm":wt()==="macos"?"plist":"hklm"}')
    .replace(wslDetect, (m) => `${m.slice(0, m.indexOf("{") + 1)}if(process.env.CLAUDIUS_GOLDEN_WSL)return!0;${m.slice(m.indexOf("{") + 1)}`)
    .replace(fileTierWsl, "$1process.env.CLAUDIUS_GOLDEN_WSL||$2")
    .replace(wslWindowsDir, ',Jn=process.env.CLAUDIUS_GOLDEN_WIN_DIR??"/mnt/c/Program Files/ClaudeCode"'),
);

// Control copy for the remote cases: the same patches, with the remote
// cache's eligibility gate (`D2`) removed. The recorder runs one control
// case on it and expects the seeded cache to become the managed source,
// which proves the "ignored" cases seed the right file and only the gate
// keeps it out.
const eligibilityGate = /if\(!\w+\(\)&&e\.eligible!==!0\)return null;/g;
const patched = readFileSync(sdkFile, "utf8");
if ((patched.match(eligibilityGate) ?? []).length !== 1) {
  throw new Error(`remote-cache eligibility gate not found exactly once in sdk.mjs ${sdkVersion}; re-derive D2()`);
}
const sdkEligibleFile = join(work, "sdk-eligible.mjs");
writeFileSync(sdkEligibleFile, patched.replace(eligibilityGate, ""));

// Plist specs: {json} → XML via plutil, {binary} → binary1 (base64),
// {xml}/{raw} → as written; `mode` chmods it, `dir` makes a directory.
function plistFile(spec) {
  const { json, binary, xml, raw, ...rest } = spec;
  if (xml !== undefined || raw !== undefined) return { xml: xml ?? raw, ...rest };
  if (json === undefined && binary === undefined) return rest;
  const src = join(work, "plist-src.json");
  writeFileSync(src, JSON.stringify(json ?? binary));
  const format = binary !== undefined ? "binary1" : "xml1";
  const out = execFileSync("/usr/bin/plutil", ["-convert", format, "-o", "-", "--", src]);
  return binary !== undefined ? { base64: out.toString("base64"), ...rest } : { xml: out.toString("utf8"), ...rest };
}

const J = (o) => JSON.stringify(o);
const M = "managed-settings.json";
const D = (n) => `managed-settings.d/${n}`;
const row = (n) => ({ input: n, output: n, cacheRead: n, cacheWrite: n });
const cases = [
  ["no_files", {}],
  ["empty_object", { files: { [M]: "{}" } }],
  ["unrelated_keys_only", { files: { [M]: J({ model: "x", env: { A: "1" } }) } }],
  ["denied_basic", { files: { [M]: J({ deniedModels: ["opus", "claude-sonnet-5"] }) } }],
  ["denied_filters_non_strings_keeps_dupes", { files: { [M]: J({ deniedModels: ["a", "a", 3, null, {}, "b"] }) } }],
  ["denied_all_invalid_is_empty", { files: { [M]: J({ deniedModels: [1, 2] }) } }],
  ["denied_empty_array", { files: { [M]: J({ deniedModels: [] }) } }],
  ["denied_string_dropped", { files: { [M]: J({ deniedModels: "opus" }) } }],
  ["denied_null_dropped", { files: { [M]: J({ deniedModels: null }) } }],
  ["denied_object_dropped", { files: { [M]: J({ deniedModels: { 0: "a" } }) } }],
  ["denied_union_across_docs", { files: { [M]: J({ deniedModels: ["a", "a", "b"] }), [D("10.json")]: J({ deniedModels: ["b", "c", 7] }) } }],
  ["denied_later_invalid_keeps_earlier", { files: { [M]: J({ deniedModels: ["a"] }), [D("a.json")]: J({ deniedModels: "x" }), [D("b.json")]: J({ deniedModels: null }) } }],
  ["denied_only_in_drop_in", { files: { [D("x.json")]: J({ deniedModels: ["z", "z"] }) } }],
  ["denied_dedupe_is_exact_string", { files: { [M]: J({ deniedModels: ["Opus"] }), [D("a.json")]: J({ deniedModels: ["opus", " Opus"] }) } }],
  ["match_prefix", { files: { [M]: J({ availableModelsMatch: "prefix" }) } }],
  ["match_exact", { files: { [M]: J({ availableModelsMatch: "exact" }) } }],
  ["match_bogus_fails_closed", { files: { [M]: J({ availableModelsMatch: "bogus" }) } }],
  ["match_uppercase_fails_closed", { files: { [M]: J({ availableModelsMatch: "PREFIX" }) } }],
  ["match_number_fails_closed", { files: { [M]: J({ availableModelsMatch: 5 }) } }],
  ["match_false_fails_closed", { files: { [M]: J({ availableModelsMatch: false }) } }],
  ["match_array_fails_closed", { files: { [M]: J({ availableModelsMatch: ["prefix"] }) } }],
  ["match_null_dropped", { files: { [M]: J({ availableModelsMatch: null }) } }],
  ["match_later_doc_wins", { files: { [M]: J({ availableModelsMatch: "exact" }), [D("a.json")]: J({ availableModelsMatch: "prefix" }) } }],
  ["match_later_bogus_wins", { files: { [M]: J({ availableModelsMatch: "prefix" }), [D("a.json")]: J({ availableModelsMatch: "bogus" }) } }],
  ["match_later_null_keeps_earlier", { files: { [M]: J({ availableModelsMatch: "exact" }), [D("a.json")]: J({ availableModelsMatch: null }) } }],
  ["pricing_empty_object_kept", { files: { [M]: J({ modelPricing: {} }) } }],
  ["pricing_string_dropped", { files: { [M]: J({ modelPricing: "x" }) } }],
  ["pricing_null_dropped", { files: { [M]: J({ modelPricing: null }) } }],
  ["pricing_array_dropped", { files: { [M]: J({ modelPricing: [1] }) } }],
  ["pricing_multiplier_bounds", { files: { [M]: J({ modelPricing: { multiplier: 10 } }), [D("1.json")]: J({ modelPricing: { multiplier: 10.5 } }) } }],
  ["pricing_multiplier_zero_dropped", { files: { [M]: J({ modelPricing: { multiplier: 0 } }) } }],
  ["pricing_multiplier_negative_dropped", { files: { [M]: J({ modelPricing: { multiplier: -1 } }) } }],
  ["pricing_multiplier_string_dropped", { files: { [M]: J({ modelPricing: { multiplier: "0.8" } }) } }],
  ["pricing_multiplier_tiny_kept", { files: { [M]: J({ modelPricing: { multiplier: 1e-9 } }) } }],
  ["pricing_multiplier_later_invalid_keeps_earlier", { files: { [M]: J({ modelPricing: { multiplier: 0.5 } }), [D("a.json")]: J({ modelPricing: { multiplier: -3 } }) } }],
  ["pricing_overrides_rows", {
    files: {
      [M]: J({
        modelPricing: {
          extra: 1,
          overrides: {
            ok: { cacheWrite: 4, cacheRead: 3, output: 2, input: 1, note: "x" },
            zero: row(0),
            max: row(10000),
            over: row(10001),
            neg: { ...row(1), input: -1 },
            missing: { input: 1, output: 1, cacheRead: 1 },
            str: { ...row(1), output: "2" },
            notobj: 5,
          },
          multiplier: 2,
        },
      }),
    },
  }],
  ["pricing_overrides_array_dropped", { files: { [M]: J({ modelPricing: { multiplier: 1, overrides: [row(1)] } }) } }],
  ["pricing_overrides_null_dropped", { files: { [M]: J({ modelPricing: { overrides: null } }) } }],
  ["pricing_overrides_empty_object", { files: { [M]: J({ modelPricing: { overrides: {} } }) } }],
  ["pricing_deep_merge_across_docs", {
    files: {
      [M]: J({ modelPricing: { overrides: { a: row(1), b: row(2) } } }),
      [D("a.json")]: J({ modelPricing: { multiplier: 3, overrides: { b: row(5), c: row(6) } } }),
      [D("b.json")]: J({ modelPricing: { overrides: { a: { ...row(9), input: 20000 } } } }),
    },
  }],
  ["pricing_later_invalid_keeps_earlier", { files: { [M]: J({ modelPricing: { multiplier: 2 } }), [D("a.json")]: J({ modelPricing: "x" }) } }],
  ["all_three_keys", { files: { [M]: J({ modelPricing: { multiplier: 1.5 }, deniedModels: ["fable"], availableModelsMatch: "exact" }) } }],
  ["bad_sibling_keys_dont_drop_doc", { files: { [M]: J({ deniedModels: ["a"], permissions: 5, model: 3, hooks: "x", env: [1], apiKeyHelper: {} }) } }],
  ["drop_in_sort_order", {
    files: {
      // Code-unit order puts "Z" before "a" (locale order wouldn't). Names
      // differ by more than case so the case stays valid on case-insensitive
      // filesystems.
      [D("a.json")]: J({ availableModelsMatch: "prefix" }),
      [D("Z.json")]: J({ availableModelsMatch: "exact" }),
      [D("10.json")]: J({ deniedModels: ["ten"] }),
      [D("9.json")]: J({ deniedModels: ["nine"] }),
      [D("é.json")]: J({ deniedModels: ["accent"] }),
      [D("y.json")]: J({ deniedModels: ["y"] }),
    },
  }],
  ["drop_in_ignores_dotfiles_and_other_ext", {
    files: {
      [D(".hidden.json")]: J({ deniedModels: ["hidden"] }),
      [D("notes.txt")]: J({ deniedModels: ["txt"] }),
      [D("x.JSON")]: J({ deniedModels: ["upper"] }),
      [D("y.json")]: J({ deniedModels: ["y"] }),
    },
  }],
  ["drop_in_directory_named_json_skipped", { dirs: [D("dir.json")], files: { [D("a.json")]: J({ deniedModels: ["a"] }) } }],
  ["drop_in_symlink_followed", { files: { "target.txt": J({ deniedModels: ["linked"] }) }, symlinks: { [D("l.json")]: "../target.txt" } }],
  ["drop_in_dangling_symlink_skipped", { symlinks: { [D("l.json")]: "../missing.txt" }, files: { [D("m.json")]: J({ deniedModels: ["m"] }) } }],
  ["drop_in_dir_is_a_file", { files: { "managed-settings.d": J({ deniedModels: ["no"] }), [M]: J({ deniedModels: ["yes"] }) } }],
  ["main_file_is_a_directory", { dirs: [M], files: { [D("a.json")]: J({ deniedModels: ["a"] }) } }],
  ["bad_json_skipped", { files: { [M]: "{bad", [D("a.json")]: J({ deniedModels: ["a"] }) } }],
  ["comments_not_allowed", { files: { [M]: '{"deniedModels":["c"] // x\n}' } }],
  ["trailing_comma_not_allowed", { files: { [M]: '{"deniedModels":["c"],}' } }],
  ["non_object_roots_skipped", { files: { [M]: '["a"]', [D("a.json")]: '"x"', [D("b.json")]: "null", [D("c.json")]: "5", [D("d.json")]: J({ deniedModels: ["d"] }) } }],
  ["empty_and_blank_files", { files: { [M]: "", [D("a.json")]: " \n\t", [D("b.json")]: "﻿", [D("c.json")]: J({ deniedModels: ["c"] }) } }],
  ["bom_stripped", { files: { [M]: '﻿{"deniedModels":["bom"]}' } }],
  ["leading_whitespace_ok", { files: { [M]: '\n  {"deniedModels":["ws"]}  \n' } }],
  ["duplicate_keys_last_wins", { files: { [M]: '{"deniedModels":["first"],"deniedModels":["second"]}' } }],
  ["huge_number_is_infinity", { files: { [M]: '{"deniedModels":["x",1e400],"availableModelsMatch":-1e400,"modelPricing":{"multiplier":1e400,"overrides":{"r":{"input":1,"output":1,"cacheRead":1,"cacheWrite":1e999}}},"other":1e309}' } }],
  ["huge_number_elsewhere_keeps_doc", { files: { [M]: '{"deniedModels":["kept"],"cleanupPeriodDays":1e400}' } }],
  ["tiny_number_underflows_to_zero", { files: { [M]: '{"modelPricing":{"overrides":{"r":{"input":1e-400,"output":0,"cacheRead":0,"cacheWrite":0}}}}' } }],
  ["js_number_forms_and_integer_keys", { files: { [M]: '{"modelPricing":{"multiplier":2.0,"overrides":{"b":{"input":1e2,"output":1,"cacheRead":1,"cacheWrite":1},"10":{"input":1.0,"output":0.0,"cacheRead":-0,"cacheWrite":1.50},"2":{"input":1,"output":1,"cacheRead":1,"cacheWrite":1}}}}' } }],
  ["unicode_model_names", { files: { [M]: J({ deniedModels: ["clåude-ø", "\u0000", "😀"] }) } }],
  // MDM plist tier (macOS). `user` is <root>/<user>/…, `device` <root>/….
  ["mdm_device_only", { plists: { device: { json: { deniedModels: ["d"], availableModelsMatch: "exact" } } } }],
  ["mdm_binary_plist", { plists: { device: { binary: { deniedModels: ["bin"], modelPricing: { multiplier: 2.5 } } } } }],
  ["mdm_user_over_device", { plists: { user: { json: { deniedModels: ["u"] } }, device: { json: { deniedModels: ["d"] } } } }],
  ["mdm_user_empty_dict_hides_device", { plists: { user: { json: {} }, device: { json: { deniedModels: ["d"] } } } }],
  ["mdm_user_only_behavior_hides_device", { plists: { user: { json: { managedSourcesBehavior: "merge" } }, device: { json: { deniedModels: ["d"] } } } }],
  ["mdm_user_invalid_value_hides_device_file_used", { plists: { user: { json: { deniedModels: "x" } }, device: { json: { deniedModels: ["d"] } } }, files: { [M]: J({ deniedModels: ["f"] }) } }],
  ["mdm_user_garbage_hides_device_file_used", { plists: { user: { raw: "not a plist" }, device: { json: { deniedModels: ["d"] } } }, files: { [M]: J({ deniedModels: ["f"] }) } }],
  ["mdm_user_date_unreadable_device_used", { plists: { user: { xml: '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>deniedModels</key><array><string>u</string></array><key>when</key><date>2026-01-01T00:00:00Z</date></dict></plist>\n' }, device: { json: { deniedModels: ["d"] } } } }],
  ["mdm_user_no_permission_device_used", { plists: { user: { json: { deniedModels: ["u"] }, mode: 0o000 }, device: { json: { deniedModels: ["d"] } } } }],
  ["mdm_user_path_is_directory_device_used", { plists: { user: { dir: true }, device: { json: { deniedModels: ["d"] } } } }],
  ["mdm_device_data_value_file_used", { plists: { device: { xml: '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>deniedModels</key><array><string>d</string></array><key>blob</key><data>AAEC</data></dict></plist>\n' } }, files: { [M]: J({ deniedModels: ["f"] }) } }],
  ["mdm_numbers_and_nesting", { plists: { device: { json: { modelPricing: { multiplier: 10, overrides: { "claude-x": row(3), "10": row(1.25), bad: { ...row(1), input: 20000 } } }, availableModelsMatch: "PREFIX" } } } }],
  ["mdm_over_file_first_wins", { plists: { device: { json: { deniedModels: ["d"] } } }, files: { [M]: J({ deniedModels: ["f"], availableModelsMatch: "exact", modelPricing: { multiplier: 2 } }) } }],
  ["mdm_substitute_loses_but_binds_exact", { plists: { device: { json: { availableModelsMatch: "bogus" } } }, files: { [M]: J({ deniedModels: ["f"], availableModelsMatch: "prefix" }) } }],
  ["mdm_substitute_binds_when_file_lacks_key", { plists: { device: { json: { availableModelsMatch: "bogus" } } }, files: { [M]: J({ deniedModels: ["f"], modelPricing: { multiplier: 2 } }) } }],
  ["mdm_void_loses_binds_nothing", { plists: { device: { json: { modelPricing: { multiplier: -1 } } } }, files: { [M]: J({ deniedModels: ["f"] }) } }],
  ["mdm_authored_beats_file_substitute", { plists: { device: { json: { deniedModels: ["d"] } } }, files: { [M]: J({ availableModelsMatch: "bogus" }) } }],
  ["mdm_substitute_ties_file_substitute", { plists: { device: { json: { availableModelsMatch: "bogus" } } }, files: { [M]: J({ availableModelsMatch: "x2" }) } }],
  ["mdm_void_ties_file_void", { plists: { device: { json: { modelPricing: {} } } }, files: { [M]: J({ modelPricing: { overrides: {} } }) } }],
  ["mdm_void_loses_to_file_substitute_only", { plists: { device: { json: { modelPricing: {} } } }, files: { [M]: J({ availableModelsMatch: "x2" }) } }],
  ["mdm_substitute_plus_void_is_substitute_only", { plists: { device: { json: { availableModelsMatch: "bogus", modelPricing: {} } } }, files: { [M]: J({ deniedModels: ["f"] }) } }],
  ["mdm_substitute_plus_filtered_array_is_authored", { plists: { device: { json: { availableModelsMatch: "bogus", deniedModels: [1] } } }, files: { [M]: J({ deniedModels: ["f"] }) } }],
  ["mdm_substitute_plus_other_key_is_authored", { plists: { device: { json: { availableModelsMatch: "bogus", model: "x" } } }, files: { [M]: J({ deniedModels: ["f"] }) } }],
  ["mdm_other_key_only_wins_with_no_consumer_keys", { plists: { device: { json: { model: "x" } } }, files: { [M]: J({ deniedModels: ["f"] }) } }],
  ["file_other_key_beats_void_mdm", { plists: { device: { json: { modelPricing: {} } } }, files: { [M]: J({ model: "x" }) } }],
  ["file_substitute_docs_tie_mdm_substitute", { plists: { device: { json: { availableModelsMatch: "bogus" } } }, files: { [M]: J({ availableModelsMatch: "x" }), [D("a.json")]: J({ modelPricing: {} }) } }],
  ["file_authored_doc_beats_mdm_substitute", { plists: { device: { json: { availableModelsMatch: "bogus" } } }, files: { [M]: J({ availableModelsMatch: "x" }), [D("a.json")]: J({ deniedModels: ["late"] }) } }],
  ["mdm_merge", {
    plists: { device: { json: { managedSourcesBehavior: "merge", deniedModels: ["d", "x"], modelPricing: { overrides: { a: row(1) } } } } },
    files: { [M]: J({ deniedModels: ["x", "f"], availableModelsMatch: "exact", modelPricing: { multiplier: 2, overrides: { a: row(9), b: row(8) } } }) },
  }],
  ["mdm_merge_exact_from_either_side", { plists: { device: { json: { managedSourcesBehavior: "merge", availableModelsMatch: "prefix" } } }, files: { [M]: J({ availableModelsMatch: "exact" }) } }],
  ["mdm_merge_drops_prefix_only_lower_tiers_set", { plists: { device: { json: { managedSourcesBehavior: "merge", deniedModels: ["d"] } } }, files: { [M]: J({ availableModelsMatch: "prefix", deniedModels: ["f"] }) } }],
  ["mdm_merge_with_drop_ins", { plists: { device: { json: { managedSourcesBehavior: "merge", deniedModels: ["d"] } } }, files: { [M]: J({ deniedModels: ["a"] }), [D("x.json")]: J({ deniedModels: ["b", "d"] }) } }],
  ["mdm_merge_without_file_tier", { plists: { device: { json: { managedSourcesBehavior: "merge", deniedModels: ["d"] } } } }],
  ["file_merge_ignored_when_mdm_primary", { plists: { device: { json: { deniedModels: ["d"] } } }, files: { [M]: J({ managedSourcesBehavior: "merge", deniedModels: ["f"] }) } }],
  ["mdm_first_wins_explicit", { plists: { device: { json: { managedSourcesBehavior: "first-wins", deniedModels: ["d"] } } }, files: { [M]: J({ deniedModels: ["f"] }) } }],
  ["mdm_invalid_behavior_is_first_wins", { plists: { device: { json: { managedSourcesBehavior: "bogus", deniedModels: ["d"] } } }, files: { [M]: J({ deniedModels: ["f"] }) } }],
  ["losing_mdm_declares_merge", { plists: { device: { json: { availableModelsMatch: "bogus", modelPricing: {}, managedSourcesBehavior: "merge" } } }, files: { [M]: J({ deniedModels: ["f"] }) } }],
  ["losing_mdm_invalid_behavior_file_merge", { plists: { device: { json: { availableModelsMatch: "bogus", modelPricing: {}, managedSourcesBehavior: 5 } } }, files: { [M]: J({ managedSourcesBehavior: "merge", deniedModels: ["f"] }) } }],
  ["losing_mdm_invalid_string_behavior_file_merge", { plists: { device: { json: { availableModelsMatch: "bogus", modelPricing: {}, managedSourcesBehavior: "Merge" } } }, files: { [M]: J({ managedSourcesBehavior: "merge", deniedModels: ["f"] }) } }],
  ["losing_mdm_first_wins_overrides_file_merge", { plists: { device: { json: { availableModelsMatch: "bogus", modelPricing: {}, managedSourcesBehavior: "first-wins" } } }, files: { [M]: J({ managedSourcesBehavior: "merge", deniedModels: ["f"] }) } }],
  ["file_merge_with_losing_mdm", { plists: { device: { json: { availableModelsMatch: "bogus", modelPricing: {} } } }, files: { [M]: J({ managedSourcesBehavior: "merge", deniedModels: ["f"], modelPricing: { multiplier: 3 } }) } }],
  // The SDK's managed-file reader (`i0e`): encoding sniffing, lossy UTF-8,
  // the 2 MiB cap.
  ["file_utf16le_bom_decoded", { files: { [M]: { base64: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(J({ deniedModels: ["wide", "ü"] }), "utf16le")]).toString("base64") } } }],
  ["file_utf16le_odd_trailing_byte_dropped", { files: { [M]: { base64: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(J({ deniedModels: ["odd"] }), "utf16le"), Buffer.from([0x41])]).toString("base64") } } }],
  ["file_utf16be_bom_not_decoded", { files: { [M]: { base64: Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(J({ deniedModels: ["be"] }), "utf16le").swap16()]).toString("base64") }, [D("a.json")]: J({ deniedModels: ["fallback"] }) } }],
  ["file_invalid_utf8_read_lossily", { files: { [M]: { base64: Buffer.concat([Buffer.from('{"deniedModels":["a'), Buffer.from([0xff, 0xc3]), Buffer.from('","b"]}')]).toString("base64") } } }],
  ["file_exactly_2mib_read", { files: { [M]: { text: J({ deniedModels: ["max"] }), padTo: 2 * 1024 * 1024 } } }],
  ["file_over_2mib_skipped", { files: { [M]: { text: J({ deniedModels: ["big"] }), padTo: 2 * 1024 * 1024 + 1 }, [D("a.json")]: J({ deniedModels: ["small"] }) } }],
  // Windows registry (the SDK's win32 branch, emulated; see the header).
  ...registryCases(),
  // WSL: Windows policy read through /mnt/c (emulated; see the header).
  ...wslCases(),
  // Remote (server-managed) tier: the SDK reads <config>/remote-settings.json
  // only when `zo().eligible === true`, and nothing in the SDK library ever
  // sets it (only the CLI does). So a seeded, well-formed cache is ignored
  // by the resolveSettings call Claudius makes. Pinned here so an SDK bump
  // that changes this shows up as a fixture diff.
  ["remote_cache_ignored_alone", { remote: J({ deniedModels: ["r"], availableModelsMatch: "exact", modelPricing: { multiplier: 2 } }) }],
  ["remote_cache_ignored_over_file", { remote: J({ deniedModels: ["r"] }), files: { [M]: J({ deniedModels: ["f"] }) } }],
  ["remote_cache_substitute_does_not_bind", { remote: J({ availableModelsMatch: "bogus" }), files: { [M]: J({ deniedModels: ["f"] }) } }],
  ["remote_cache_ignored_over_mdm", { remote: J({ deniedModels: ["r"] }), plists: { device: { json: { deniedModels: ["d"] } } } }],
  ["remote_cache_merge_ignored", { remote: J({ managedSourcesBehavior: "merge", deniedModels: ["r"] }), plists: { device: { json: { deniedModels: ["d"] } } }, files: { [M]: J({ deniedModels: ["f"] }) } }],
];
/** Captured `reg query` outputs: a `Settings` value, or a missing key. */
function regHelpers() {
  const value = (data, type = "REG_SZ", name = "Settings") => ({
    out: `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\ClaudeCode\r\n    ${name}    ${type}    ${data}\r\n\r\n`,
  });
  const v = (o) => value(J(o));
  const missing = { out: "ERROR: The system was unable to find the specified registry key or value.\r\n", code: 1 };
  return { value, v, missing, big: 2 * 1024 * 1024 };
}

function registryCases() {
  const { value, v, missing, big } = regHelpers();
  return [
    ["reg_hklm_only", { registry: { hklm: v({ deniedModels: ["h"], availableModelsMatch: "exact" }) } }],
    ["reg_hkcu_only", { registry: { hklm: missing, hkcu: v({ deniedModels: ["u"], modelPricing: { multiplier: 3 } }) } }],
    ["reg_hklm_over_hkcu", { registry: { hklm: v({ deniedModels: ["h"] }), hkcu: v({ deniedModels: ["u"] }) } }],
    ["reg_hklm_beats_file", { registry: { hklm: v({ deniedModels: ["h"] }) }, files: { [M]: J({ deniedModels: ["f"] }) } }],
    ["reg_hklm_substitute_loses_to_file_but_binds", { registry: { hklm: v({ availableModelsMatch: "bogus" }) }, files: { [M]: J({ deniedModels: ["f"] }) } }],
    ["reg_hklm_merge_with_file", { registry: { hklm: v({ managedSourcesBehavior: "merge", deniedModels: ["h"] }) }, files: { [M]: J({ deniedModels: ["f"], modelPricing: { multiplier: 2 } }) } }],
    ["reg_file_beats_hkcu", { registry: { hklm: missing, hkcu: v({ deniedModels: ["u"] }) }, files: { [M]: J({ deniedModels: ["f"] }) } }],
    ["reg_hklm_empty_object_hkcu_used", { registry: { hklm: v({}), hkcu: v({ deniedModels: ["u"] }) } }],
    ["reg_hklm_behavior_only_hkcu_used", { registry: { hklm: v({ managedSourcesBehavior: "merge" }), hkcu: v({ deniedModels: ["u"] }) } }],
    ["reg_hklm_invalid_value_shuts_hkcu", { registry: { hklm: v({ deniedModels: "x" }), hkcu: v({ deniedModels: ["u"] }) } }],
    ["reg_hklm_bad_json_shuts_hkcu", { registry: { hklm: value("{bad"), hkcu: v({ deniedModels: ["u"] }) } }],
    ["reg_hklm_bad_json_file_still_used", { registry: { hklm: value("{bad") }, files: { [M]: J({ deniedModels: ["f"] }) } }],
    ["reg_hklm_non_object_shuts_hkcu", { registry: { hklm: value("[1]"), hkcu: v({ deniedModels: ["u"] }) } }],
    ["reg_hklm_overflow_shuts_hkcu", { registry: { hklm: { ...v({ deniedModels: ["h"] }), pad: big }, hkcu: v({ deniedModels: ["u"] }) } }],
    ["reg_hklm_overflow_file_still_used", { registry: { hklm: { ...v({ deniedModels: ["h"] }), pad: big } }, files: { [M]: J({ deniedModels: ["f"] }) } }],
    ["reg_hklm_just_under_buffer_read", { registry: { hklm: { ...v({ deniedModels: ["h"] }), pad: big - v({ deniedModels: ["h"] }).out.length } } }],
    ["reg_hklm_missing_hkcu_used", { registry: { hklm: missing, hkcu: v({ availableModelsMatch: "exact" }) } }],
    ["reg_hklm_dword_shuts_hkcu", { registry: { hklm: value("0x1", "REG_DWORD"), hkcu: v({ deniedModels: ["u"] }) } }],
    ["reg_hklm_multi_sz_shuts_hkcu", { registry: { hklm: value(J({ deniedModels: ["m"] }), "REG_MULTI_SZ"), hkcu: v({ deniedModels: ["u"] }) } }],
    ["reg_expand_sz_case_insensitive", { registry: { hklm: value(J({ deniedModels: ["e"] }), "reg_expand_sz", "settings") } }],
    ["reg_value_runs_to_end_of_output", { registry: { hklm: { out: `\r\nHKEY\r\n    Settings    REG_SZ    ${J({ deniedModels: ["h"] })}\r\nEnd of search\r\n` }, hkcu: v({ deniedModels: ["u"] }) } }],
    ["reg_value_after_other_values", { registry: { hklm: { out: `\r\nHKEY\r\n    Other    REG_SZ    x\r\n\tSettings\tREG_SZ\t${J({ deniedModels: ["t"] })}  \r\n` } } }],
    ["reg_long_s_not_case_folded", { registry: { hklm: value(J({ deniedModels: ["s"] }), "REG_SZ", "\u017fettings"), hkcu: v({ deniedModels: ["u"] }) } }],
    ["reg_hkcu_overflow_ignored", { registry: { hklm: missing, hkcu: { ...v({ deniedModels: ["u"] }), pad: big } } }],
    ["reg_hkcu_bad_json_ignored", { registry: { hklm: missing, hkcu: value("{bad") }, files: {} }],
    ["reg_hkcu_drops_composition_keys", { registry: { hklm: missing, hkcu: v({ managedSourcesBehavior: "merge", wslInheritsWindowsSettings: true, deniedModels: ["u"] }) } }],
    ["reg_hkcu_substitute", { registry: { hklm: missing, hkcu: v({ availableModelsMatch: "bogus" }) } }],
    ["reg_hkcu_admin_only_keys_dropped", { registry: { hklm: missing, hkcu: v({ managedMcpServers: { a: { command: "x" } }, isolation: {}, prependPlugins: ["p"], enabledPlugins: { "a@m": true, "b@builtin": false } }) } }],
    ["reg_hkcu_disabling_plugin_kept", { registry: { hklm: missing, hkcu: v({ enabledPlugins: { "c@m": false }, deniedModels: ["u"] }) } }],
    // VWe: a file tier that binds shuts HKCU out at load time.
    ["reg_file_bad_json_shuts_hkcu", { registry: { hklm: missing, hkcu: v({ deniedModels: ["u"] }) }, files: { [M]: "{bad" } }],
    ["reg_file_blank_keeps_hkcu", { registry: { hklm: missing, hkcu: v({ deniedModels: ["u"] }) }, files: { [M]: " \n" } }],
    ["reg_file_invalid_value_shuts_hkcu", { registry: { hklm: missing, hkcu: v({ deniedModels: ["u"] }) }, files: { [M]: J({ deniedModels: "x" }) } }],
    ["reg_file_behavior_only_keeps_hkcu", { registry: { hklm: missing, hkcu: v({ deniedModels: ["u"] }) }, files: { [M]: J({ managedSourcesBehavior: "merge" }) } }],
    ["reg_file_drop_in_bad_json_shuts_hkcu", { registry: { hklm: missing, hkcu: v({ deniedModels: ["u"] }) }, files: { [D("z.json")]: "nope" } }],
    ["reg_file_dot_drop_in_ignored", { registry: { hklm: missing, hkcu: v({ deniedModels: ["u"] }) }, files: { [D(".z.json")]: "nope", [D("z.txt")]: "nope" } }],
    ["reg_file_main_is_directory_shuts_hkcu", { registry: { hklm: missing, hkcu: v({ deniedModels: ["u"] }) }, dirs: [M] }],
    ["reg_file_dangling_drop_in_keeps_hkcu", { registry: { hklm: missing, hkcu: v({ deniedModels: ["u"] }) }, symlinks: { [D("l.json")]: "../missing.json" } }],
    // VWe reads with `tt` (ENOENT only): ENOTDIR on a file binds, but the
    // drop-in dir itself uses `_w`, so ENOTDIR there reads as missing.
    ["reg_file_enotdir_main_shuts_hkcu", { registry: { hklm: missing, hkcu: v({ deniedModels: ["u"] }) }, files: { f: "x" }, symlinks: { [M]: "f/x" } }],
    ["reg_file_enotdir_drop_in_dir_keeps_hkcu", { registry: { hklm: missing, hkcu: v({ deniedModels: ["u"] }) }, files: { f: "x" }, symlinks: { "managed-settings.d": "f/x" } }],
    ["reg_file_enotdir_drop_in_entry_shuts_hkcu", { registry: { hklm: missing, hkcu: v({ deniedModels: ["u"] }) }, files: { f: "x" }, symlinks: { [D("l.json")]: "../f/x" } }],
    // A drop-in folder that can't be listed (ELOOP, not ENOENT/ENOTDIR) binds.
    ["reg_file_drop_in_dir_loop_shuts_hkcu", { registry: { hklm: missing, hkcu: v({ deniedModels: ["u"] }) }, files: { [M]: J({ managedSourcesBehavior: "merge" }) }, symlinks: { "managed-settings.d": "managed-settings.d" } }],
    ["reg_file_too_big_shuts_hkcu", { registry: { hklm: missing, hkcu: v({ deniedModels: ["u"] }) }, files: { [M]: { text: J({ deniedModels: ["big"] }), padTo: big + 1 } } }],
    ["reg_file_utf16_counts", { registry: { hklm: missing, hkcu: v({ deniedModels: ["u"] }) }, files: { [M]: { base64: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(J({ deniedModels: ["w"] }), "utf16le")]).toString("base64") } } }],
  ];
}

// Under WSL the SDK reads the Windows policy only once an admin source arms
// `wslInheritsWindowsSettings`. `local` is /etc/claude-code (the managed
// dir); `win` is the Windows managed folder under /mnt/c.
function wslCases() {
  const { value, v, big } = regHelpers();
  const W = (spec) => ({ wsl: true, registry: {}, ...spec });
  const arm = { wslInheritsWindowsSettings: true };
  const local = { [M]: J({ deniedModels: ["l"] }) };
  const winDenied = (o = {}) => ({ files: { [M]: J({ deniedModels: ["w"], ...o }) } });
  const utf16 = (o) => ({ base64: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(J(o), "utf16le")]).toString("base64") });
  return [
    ["wsl_nothing", W({})],
    ["wsl_local_file_alone", W({ files: local })],
    // Unarmed: Windows sources don't count.
    ["wsl_unarmed_hklm_ignored", W({ registry: { hklm: v({ deniedModels: ["h"] }) } })],
    ["wsl_unarmed_hklm_keeps_local_file", W({ registry: { hklm: v({ deniedModels: ["h"] }) }, files: local })],
    ["wsl_unarmed_windows_file_ignored", W({ win: winDenied(), files: local })],
    ["wsl_unarmed_hkcu_ignored", W({ registry: { hkcu: v({ ...arm, deniedModels: ["u"] }) } })],
    // HKLM's flag (`BT`: true / "true" arm; false / "false" / null don't; others can't be read).
    ["wsl_hklm_armed", W({ registry: { hklm: v({ ...arm, deniedModels: ["h"] }) }, files: local })],
    ["wsl_hklm_armed_by_string_true", W({ registry: { hklm: v({ wslInheritsWindowsSettings: "true", deniedModels: ["h"] }) } })],
    ["wsl_hklm_flag_false", W({ registry: { hklm: v({ wslInheritsWindowsSettings: false, deniedModels: ["h"] }) }, files: local })],
    ["wsl_hklm_flag_string_false", W({ registry: { hklm: v({ wslInheritsWindowsSettings: "false", deniedModels: ["h"] }) }, files: local })],
    ["wsl_hklm_flag_null", W({ registry: { hklm: v({ wslInheritsWindowsSettings: null, deniedModels: ["h"] }) }, files: local })],
    ["wsl_hklm_flag_uppercase_unreadable_with_content", W({ registry: { hklm: v({ wslInheritsWindowsSettings: "TRUE", deniedModels: ["h"] }) }, files: local })],
    ["wsl_hklm_flag_unreadable_only_binds_empty", W({ registry: { hklm: v({ wslInheritsWindowsSettings: 1 }) }, files: local })],
    ["wsl_hklm_flag_only_reads_local_file", W({ registry: { hklm: v(arm) }, files: local })],
    ["wsl_hklm_flag_only_windows_file_wins", W({ registry: { hklm: v(arm) }, win: winDenied(), files: local })],
    ["wsl_hklm_armed_ties_windows_file", W({ registry: { hklm: v({ ...arm, deniedModels: ["h"] }) }, win: winDenied() })],
    ["wsl_hklm_armed_merges_windows_file", W({ registry: { hklm: v({ ...arm, managedSourcesBehavior: "merge", deniedModels: ["h"] }) }, win: winDenied() })],
    ["wsl_hklm_armed_substitute_binds_beside_windows_file", W({ registry: { hklm: v({ ...arm, availableModelsMatch: "bogus" }) }, win: winDenied() })],
    ["wsl_hklm_unreadable_windows_armed", W({ registry: { hklm: v({ wslInheritsWindowsSettings: 5 }) }, win: winDenied(arm) })],
    ["wsl_hklm_false_windows_armed", W({ registry: { hklm: v({ wslInheritsWindowsSettings: false }) }, win: winDenied(arm) })],
    // The Windows folder's flag (`qWe`).
    ["wsl_windows_file_arms", W({ win: winDenied(arm), files: local })],
    ["wsl_windows_file_flag_only_reads_local", W({ win: { files: { [M]: J(arm) } }, files: local })],
    ["wsl_windows_drop_in_arms", W({ win: { files: { [D("a.json")]: J(arm), [D("b.json")]: J({ deniedModels: ["b"] }) } } })],
    ["wsl_windows_unreadable_then_armed_drop_in", W({ win: { files: { [M]: J({ wslInheritsWindowsSettings: "x" }), [D("z.json")]: J({ ...arm, deniedModels: ["z"] }) } } })],
    ["wsl_windows_unreadable_flag_with_content", W({ win: winDenied({ wslInheritsWindowsSettings: "maybe" }), files: local })],
    ["wsl_windows_unreadable_flag_only", W({ win: { files: { [M]: J({ wslInheritsWindowsSettings: 2 }) } }, files: local })],
    ["wsl_windows_dot_and_txt_drop_ins_skipped", W({ win: { files: { [D(".a.json")]: J(arm), [D("a.txt")]: J(arm) } }, files: local })],
    ["wsl_windows_utf16_flag_arms", W({ win: { files: { [M]: utf16({ ...arm, deniedModels: ["w16"] }) } } })],
    // A Windows source that fails to load binds, even unarmed: /etc/claude-code is shut out.
    ["wsl_windows_bad_json_shuts_local", W({ win: { files: { [M]: "{bad" } }, files: local })],
    ["wsl_windows_blank_file_keeps_local", W({ win: { files: { [M]: " \n" } }, files: local })],
    ["wsl_windows_dangling_drop_in_keeps_local", W({ win: { symlinks: { [D("l.json")]: "../missing.json" } }, files: local })],
    ["wsl_windows_enotdir_main_keeps_local", W({ win: { files: { f: "x" }, symlinks: { [M]: "f/x" } }, files: local })],
    ["wsl_windows_drop_in_symlink_to_dir_shuts_local", W({ win: { dirs: ["sub"], symlinks: { [D("x.json")]: "../sub" } }, files: local })],
    ["wsl_windows_main_is_directory_shuts_local", W({ win: { dirs: [M] }, files: local })],
    ["wsl_hklm_overflow_shuts_local", W({ registry: { hklm: { ...v({ deniedModels: ["h"] }), pad: big } }, files: local })],
    ["wsl_hklm_bad_json_shuts_local", W({ registry: { hklm: value("{bad") }, files: local })],
    ["wsl_hklm_overflow_windows_armed", W({ registry: { hklm: { ...v({ deniedModels: ["h"] }), pad: big } }, win: winDenied(arm), files: local })],
    ["wsl_hklm_armed_windows_bad_json", W({ registry: { hklm: v(arm) }, win: { files: { [M]: "{bad" } }, files: local })],
    // HKCU must arm the flag itself, and is shut out by a binding file tier (`VWe`).
    ["wsl_hkcu_needs_its_own_flag", W({ registry: { hklm: v(arm), hkcu: v({ deniedModels: ["u"] }) } })],
    ["wsl_hkcu_armed_used", W({ registry: { hklm: v(arm), hkcu: v({ ...arm, deniedModels: ["u"] }) } })],
    ["wsl_hkcu_string_true_used", W({ registry: { hklm: v(arm), hkcu: v({ wslInheritsWindowsSettings: "true", deniedModels: ["u"] }) } })],
    ["wsl_hkcu_with_windows_flag_file", W({ win: { files: { [M]: J(arm) } }, registry: { hkcu: v({ ...arm, deniedModels: ["u"] }) } })],
    ["wsl_hkcu_shut_out_by_windows_file", W({ win: winDenied(arm), registry: { hkcu: v({ ...arm, deniedModels: ["u"] }) } })],
    ["wsl_hkcu_shut_out_by_local_file", W({ registry: { hklm: v(arm), hkcu: v({ ...arm, deniedModels: ["u"] }) }, files: local })],
    ["wsl_hkcu_shut_out_by_windows_bad_drop_in", W({ registry: { hklm: v(arm), hkcu: v({ ...arm, deniedModels: ["u"] }) }, win: { files: { [D("z.json")]: "nope" } } })],
    ["wsl_hklm_unreadable_windows_flag_arms_hkcu", W({ registry: { hklm: v({ wslInheritsWindowsSettings: 5 }), hkcu: v({ ...arm, deniedModels: ["u"] }) }, win: { files: { [M]: J(arm) } } })],
    ["wsl_windows_main_armed_beats_unreadable_drop_in", W({ registry: { hkcu: v({ ...arm, deniedModels: ["u"] }) }, win: { files: { [M]: J(arm), [D("a.json")]: J({ wslInheritsWindowsSettings: "x" }) } } })],
    ["wsl_windows_drop_in_unreadable_flag_only", W({ win: { files: { [D("a.json")]: J({ wslInheritsWindowsSettings: 2 }) } }, files: local })],
    ["wsl_windows_dot_drop_in_doesnt_arm_hkcu", W({ registry: { hkcu: v({ ...arm, deniedModels: ["u"] }) }, win: { files: { [D(".a.json")]: J(arm), [D("a.txt")]: J(arm) } } })],
    ["wsl_windows_drop_in_dir_loop_shuts_local", W({ win: { symlinks: { "managed-settings.d": "managed-settings.d" } }, files: local })],
    ["wsl_hkcu_drops_composition_keys", W({ registry: { hklm: v(arm), hkcu: v({ ...arm, managedSourcesBehavior: "merge", deniedModels: ["u"] }) } })],
  ];
}

for (const [, spec] of cases) {
  if (spec.plists) {
    spec.plists = Object.fromEntries(Object.entries(spec.plists).map(([role, p]) => [role, plistFile(p)]));
  }
}
if (process.platform !== "darwin" && cases.some(([, spec]) => spec.plists)) {
  throw new Error("the MDM plist cases need macOS (plutil, and the SDK only reads plists on darwin)");
}

// The TS consumers, over a sources list holding just this managed source.
function policyOf(settings) {
  const out = { deniedModels: null, availableModelsMatch: "prefix" };
  if (Array.isArray(settings?.deniedModels)) {
    out.deniedModels = settings.deniedModels.filter((m) => typeof m === "string");
  }
  if (settings?.availableModelsMatch === "exact") out.availableModelsMatch = "exact";
  return out;
}
const pricingOf = (settings) => (settings?.modelPricing ? settings.modelPricing : null);

const runWorker = (sdk, spec) => runWorkerFull(sdk, spec).src;
const runWorkerFull = (sdk, spec) =>
  JSON.parse(
    execFileSync(process.execPath, [self, "--worker", sdk, J(spec)], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
    }),
  );

const out = [];
let regCalls = null;
try {
  const control = runWorker(sdkEligibleFile, { remote: J({ deniedModels: ["r"] }), files: { [M]: J({ deniedModels: ["f"] }) } });
  if (control?.policyOrigin !== "remote" || J(control.settings.deniedModels) !== J(["r"])) {
    throw new Error(`remote control case didn't read the seeded cache: ${J(control)}`);
  }
  for (const [name, spec] of cases) {
    const { src, calls } = runWorkerFull(sdkFile, spec);
    if (calls) {
      const want = J([["query", "HKCU\\SOFTWARE\\Policies\\ClaudeCode", "/v", "Settings"], ["query", "HKLM\\SOFTWARE\\Policies\\ClaudeCode", "/v", "Settings"]]);
      regCalls ??= calls;
      if (J(calls) !== J(regCalls) || J(calls) !== want) throw new Error(`${name}: unexpected reg.exe calls ${J(calls)}`);
    }
    const origins = spec.registry ? ["file", "hklm", "hkcu"] : ["file", "plist"];
    if (src && !origins.includes(src.policyOrigin)) {
      throw new Error(`${name}: policyOrigin ${src.policyOrigin}; a tier outside the fixture leaked in`);
    }
    const settings = src?.settings;
    let managed = null;
    for (const k of KEYS) {
      if (settings && Object.hasOwn(settings, k)) (managed ??= {})[k] = settings[k];
    }
    out.push({
      name,
      ...spec,
      managed,
      origin: src?.policyOrigin ?? null,
      policy: policyOf(settings),
      pricing: pricingOf(settings),
    });
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const file = join(rustDir, "crates/claudius-core/tests/fixtures/managed_settings_golden.json");
writeFileSync(file, JSON.stringify({ sdkVersion, regCalls, cases: out }, null, 2) + "\n");
console.log(`wrote ${out.length} cases to ${file}`);

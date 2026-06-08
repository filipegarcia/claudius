#!/usr/bin/env node
/**
 * Make electron-builder's AppImage(s) FUSE-free by swapping the embedded
 * runtime for the statically-linked AppImage `type2-runtime`.
 *
 * Why: electron-builder / app-builder embeds the classic AppImage runtime,
 * which dynamically links libfuse2 (`libfuse.so.2`). Ubuntu 23.10+ and 24.04
 * ship libfuse3 and DROPPED libfuse2 from the default install, so a freshly
 * downloaded AppImage dies at launch with:
 *   dlopen(): error loading libfuse.so.2 — AppImages require FUSE to run.
 * The static `type2-runtime` bundles its own squashfuse, so it mounts without
 * any system FUSE2 library.
 *
 * An AppImage is just `[runtime ELF][squashfs payload]`, and the runtime finds
 * the payload at an offset equal to its OWN ELF image size. So we:
 *   1. compute the current payload offset = ELF image size of the AppImage
 *      (e_shoff + e_shentsize * e_shnum) — no need to execute the binary, so
 *      this works cross-platform (mac dev box or Linux CI),
 *   2. keep the squashfs payload (everything from that offset on),
 *   3. write `[static runtime][payload]` back.
 * The static runtime's file size equals its ELF size (no trailing padding —
 * asserted below), so the spliced payload lands exactly where the new runtime
 * looks for it.
 *
 * Usage:
 *   node scripts/appimage-fuseless.mjs [<dir-or-appimage> ...]
 * Defaults to scanning ./release for *.AppImage. Run ONCE per build (it reads
 * the current runtime's offset, so re-running would re-splice from the new
 * static runtime's offset).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RUNTIME = path.join(REPO_ROOT, "build", "appimage-runtime-x86_64");

/** Byte offset where the appended squashfs payload begins = the ELF image size. */
function payloadOffset(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.allocUnsafe(64);
    fs.readSync(fd, head, 0, 64, 0);
    // ELF64 little-endian. 0x7F 'E' 'L' 'F'.
    if (head.readUInt32BE(0) !== 0x7f454c46) {
      throw new Error(`${file}: not an ELF (not an AppImage runtime?)`);
    }
    const eShoff = Number(head.readBigUInt64LE(0x28)); // section header table offset
    const eShentsize = head.readUInt16LE(0x3a); // per-entry size
    const eShnum = head.readUInt16LE(0x3c); // entry count
    return eShoff + eShentsize * eShnum;
  } finally {
    fs.closeSync(fd);
  }
}

function collectAppImages(args) {
  const targets = args.length ? args : [path.join(REPO_ROOT, "release")];
  const out = [];
  for (const t of targets) {
    if (!fs.existsSync(t)) continue;
    if (fs.statSync(t).isDirectory()) {
      for (const f of fs.readdirSync(t)) {
        if (f.endsWith(".AppImage")) out.push(path.join(t, f));
      }
    } else if (t.endsWith(".AppImage")) {
      out.push(t);
    }
  }
  return out;
}

function swap(appimage, runtime) {
  const offset = payloadOffset(appimage);
  const total = fs.statSync(appimage).size;
  if (offset <= 0 || offset >= total) {
    throw new Error(
      `${appimage}: computed payload offset ${offset} out of range (size ${total}) — refusing to splice`,
    );
  }
  // Read the squashfs payload (everything after the OLD runtime).
  const payloadLen = total - offset;
  const payload = Buffer.allocUnsafe(payloadLen);
  const fd = fs.openSync(appimage, "r");
  try {
    fs.readSync(fd, payload, 0, payloadLen, offset);
  } finally {
    fs.closeSync(fd);
  }
  // Sanity: the payload must be a squashfs superblock ('hsqs').
  if (payload.subarray(0, 4).toString("latin1") !== "hsqs") {
    throw new Error(
      `${appimage}: payload at offset ${offset} is not a squashfs superblock — offset math is wrong, aborting`,
    );
  }
  // Write [static runtime][payload] atomically.
  const out = Buffer.concat([runtime, payload]);
  const tmp = `${appimage}.fuseless.tmp`;
  fs.writeFileSync(tmp, out);
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, appimage);
  console.log(
    `[appimage-fuseless] ${path.basename(appimage)}: ` +
      `runtime ${offset}B → ${runtime.length}B (static type2-runtime), payload ${payloadLen}B preserved`,
  );
  // Hash the exact bytes written (base64 sha512 — what electron-updater's
  // latest-linux.yml uses) so we can resync the update manifest without
  // re-reading the file.
  return {
    name: path.basename(appimage),
    dir: path.dirname(appimage),
    sha512: crypto.createHash("sha512").update(out).digest("base64"),
    size: out.length,
  };
}

/**
 * Resync electron-builder's `latest-linux.yml` to the FUSE-free AppImage(s).
 *
 * electron-builder computes the manifest's sha512/size from the ORIGINAL
 * AppImage, but the runtime swap above rewrites the file — so the manifest is
 * stale and electron-updater would reject the download as corrupt. Patch the
 * sha512/size (top-level + the matching files[] entry) to the bytes we wrote,
 * and drop any differential `blockMapSize` (no blockmap is shipped, so updates
 * are full, sha-verified downloads). Without this, Linux auto-update is broken.
 */
function resyncUpdateManifest(results) {
  for (const dir of new Set(results.map((r) => r.dir))) {
    const ymlPath = path.join(dir, "latest-linux.yml");
    if (!fs.existsSync(ymlPath)) {
      console.warn(
        `[appimage-fuseless] ${ymlPath} not found — skipping manifest resync; Linux auto-update won't work for this build`,
      );
      continue;
    }
    const doc = yamlParse(fs.readFileSync(ymlPath, "utf8")) ?? {};
    const files = Array.isArray(doc.files) ? doc.files : [];
    for (const r of results.filter((x) => x.dir === dir)) {
      let matched = false;
      for (const f of files) {
        if (f && f.url === r.name) {
          f.sha512 = r.sha512;
          f.size = r.size;
          delete f.blockMapSize;
          matched = true;
        }
      }
      if (!matched) files.push({ url: r.name, sha512: r.sha512, size: r.size });
      // Top-level path/sha512 describe the primary artifact (the AppImage).
      if (!doc.path || doc.path.endsWith(".AppImage")) {
        doc.path = r.name;
        doc.sha512 = r.sha512;
      }
      console.log(
        `[appimage-fuseless] ${path.basename(ymlPath)}: synced ${r.name} sha512+size (${r.size}B) to the FUSE-free AppImage`,
      );
    }
    doc.files = files;
    fs.writeFileSync(ymlPath, yamlStringify(doc));
  }
}

function main() {
  if (!fs.existsSync(RUNTIME)) {
    throw new Error(`static runtime not found at ${RUNTIME} — cannot make AppImage FUSE-free`);
  }
  const runtime = fs.readFileSync(RUNTIME);
  // The static runtime must have no trailing padding, or the spliced payload
  // won't land at the offset the new runtime computes from its ELF headers.
  const runtimeElfSize = payloadOffset(RUNTIME);
  if (runtimeElfSize !== runtime.length) {
    throw new Error(
      `static runtime ELF size ${runtimeElfSize} != file size ${runtime.length} — ` +
        `splicing would misplace the payload. Re-fetch a clean type2-runtime.`,
    );
  }
  const appimages = collectAppImages(process.argv.slice(2));
  if (appimages.length === 0) {
    throw new Error("no *.AppImage found to process (looked in ./release by default)");
  }
  const results = appimages.map((a) => swap(a, runtime));
  resyncUpdateManifest(results);
  console.log(`[appimage-fuseless] done — ${appimages.length} AppImage(s) made FUSE-free`);
}

main();

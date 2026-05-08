import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import imageSize from "image-size";
import { encodeProjectDir } from "./auto-memory";
import { openDb } from "./db";
import { writeIfAbsent } from "./asset-store";

export type IngestImage = {
  data: string; // base64
  mediaType: string;
  ordinal?: number;
};

export type IngestUseResult = {
  hash: string;
  ordinal: number;
  bytes: number;
  width?: number;
  height?: number;
  newOnDisk: boolean;
  newRow: boolean;
};

function safeImageSize(buf: Buffer): { width?: number; height?: number } {
  try {
    const r = imageSize(buf);
    return { width: r.width, height: r.height };
  } catch {
    return {};
  }
}

/**
 * Persist each image to the content-addressed store and record a use row.
 * Failures here log a warning but do not throw — the live send path must
 * remain unaffected by index hiccups.
 */
export async function recordSendUses(opts: {
  cwd: string;
  sessionId: string;
  messageUuid: string;
  occurredMs: number;
  images: IngestImage[];
}): Promise<IngestUseResult[]> {
  const out: IngestUseResult[] = [];
  if (opts.images.length === 0) return out;
  let db;
  try {
    db = await openDb(opts.cwd);
  } catch (err) {
    console.warn("[asset-ingest] openDb failed:", err);
    return out;
  }
  for (let i = 0; i < opts.images.length; i++) {
    const img = opts.images[i];
    try {
      const buf = Buffer.from(img.data, "base64");
      const { hash, created } = await writeIfAbsent(opts.cwd, buf, img.mediaType);
      const dim = img.mediaType.startsWith("image/") ? safeImageSize(buf) : {};
      const upsert = db.prepare(
        `INSERT INTO assets(hash, media_type, size_bytes, width, height, first_seen_ms, last_seen_ms)
         VALUES(?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET
           last_seen_ms = max(last_seen_ms, excluded.last_seen_ms),
           media_type   = COALESCE(media_type, excluded.media_type),
           width        = COALESCE(width, excluded.width),
           height       = COALESCE(height, excluded.height)`,
      );
      const upsertInfo = upsert.run(
        hash,
        img.mediaType,
        buf.byteLength,
        dim.width ?? null,
        dim.height ?? null,
        opts.occurredMs,
        opts.occurredMs,
      );
      const ordinal = typeof img.ordinal === "number" ? img.ordinal : i + 1;
      const useStmt = db.prepare(
        `INSERT OR IGNORE INTO asset_uses(asset_hash, session_id, message_uuid, ordinal, occurred_ms)
         VALUES(?, ?, ?, ?, ?)`,
      );
      const useInfo = useStmt.run(hash, opts.sessionId, opts.messageUuid, ordinal, opts.occurredMs);
      out.push({
        hash,
        ordinal,
        bytes: buf.byteLength,
        width: dim.width,
        height: dim.height,
        newOnDisk: created,
        newRow: upsertInfo.changes > 0 || useInfo.changes > 0,
      });
    } catch (err) {
      console.warn("[asset-ingest] failed:", err);
    }
  }
  return out;
}

// ─── Backfill scanner ─────────────────────────────────────────────────────
//
// First-time open of the Files page (per project) walks every JSONL transcript
// and ingests all `image` content blocks. Tracks per-file (mtime, size) in
// schema_meta so subsequent opens only re-scan changed files.

type Stat = { mtimeMs: number; size: number };
type Cursor = { mtimeMs: number; size: number };

function metaKey(sessionId: string): string {
  return `last_jsonl_scan_${sessionId}`;
}

async function readCursor(db: import("./db").DB, sessionId: string): Promise<Cursor | null> {
  const row = db
    .prepare<[string], { value: string } | undefined>("SELECT value FROM schema_meta WHERE key = ?")
    .get(metaKey(sessionId));
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Cursor;
    if (typeof parsed.mtimeMs !== "number" || typeof parsed.size !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCursor(db: import("./db").DB, sessionId: string, cur: Cursor): void {
  db.prepare(
    "INSERT INTO schema_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(metaKey(sessionId), JSON.stringify(cur));
}

export type BackfillProgress = {
  total: number;
  scanned: number;
  ingested: number;
  current?: string;
};

export async function backfillProject(
  cwd: string,
  onProgress?: (p: BackfillProgress) => void,
): Promise<BackfillProgress> {
  const dir = join(homedir(), ".claude", "projects", encodeProjectDir(cwd));
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    const empty = { total: 0, scanned: 0, ingested: 0 };
    onProgress?.(empty);
    return empty;
  }
  const jsonls = entries.filter((n) => n.endsWith(".jsonl"));
  const db = await openDb(cwd);
  let scanned = 0;
  let ingested = 0;
  for (const name of jsonls) {
    const path = join(dir, name);
    const sessionId = name.replace(/\.jsonl$/, "");
    onProgress?.({ total: jsonls.length, scanned, ingested, current: sessionId });
    let stat: Stat;
    try {
      const s = await fs.stat(path);
      stat = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      scanned += 1;
      continue;
    }
    const cur = await readCursor(db, sessionId);
    if (cur && cur.mtimeMs === stat.mtimeMs && cur.size === stat.size) {
      scanned += 1;
      continue;
    }
    try {
      ingested += await scanFile(cwd, sessionId, path);
    } catch (err) {
      console.warn("[asset-ingest] scanFile failed:", err);
    }
    writeCursor(db, sessionId, stat);
    scanned += 1;
    onProgress?.({ total: jsonls.length, scanned, ingested, current: sessionId });
  }
  const final = { total: jsonls.length, scanned, ingested };
  onProgress?.(final);
  return final;
}

async function scanFile(cwd: string, sessionId: string, path: string): Promise<number> {
  const buf = await fs.readFile(path, "utf8");
  let count = 0;
  for (const line of buf.split("\n")) {
    if (!line || line[0] !== "{") continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (r.type !== "user") continue;
    const message = r.message as { content?: unknown } | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    const ts = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : Date.now();
    const messageUuid = typeof r.uuid === "string" ? r.uuid : `${sessionId}-${count}`;
    type Block = { type?: string; source?: { type?: string; media_type?: string; data?: string } };
    const images: { data: string; mediaType: string; ordinal: number }[] = [];
    let ordinal = 0;
    for (const c of content as Block[]) {
      if (c?.type === "image" && c.source?.type === "base64" && typeof c.source.data === "string") {
        ordinal += 1;
        images.push({
          data: c.source.data,
          mediaType: c.source.media_type ?? "application/octet-stream",
          ordinal,
        });
      }
    }
    if (images.length === 0) continue;
    const recorded = await recordSendUses({
      cwd,
      sessionId,
      messageUuid,
      occurredMs: Number.isFinite(ts) ? ts : Date.now(),
      images,
    });
    count += recorded.length;
  }
  return count;
}

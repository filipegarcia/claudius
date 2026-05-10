import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Customizations are user-authored modifications to Claudius itself. Each
 * customization owns an editable mirror of the live source tree at
 * `<ROOT>/<id>/src/`. Editing happens there and never touches the live source
 * until the user hits Publish.
 *
 * Storage layout:
 *   ~/.claude/.claudius/customizations/
 *     index.json                      ← this store
 *     <id>/
 *       src/                          ← user's editable mirror (full tree)
 *       .publishes/<publishId>/
 *         snapshot/                   ← backups of base files this publish overwrote
 *         manifest.json
 *
 * The publish history is intentionally JSON-on-disk (not SQLite) so the
 * standalone `bin/claudius-revert` script can restore snapshots without
 * loading any Claudius runtime — see plan, Step 6.
 */

export type Customization = {
  id: string;
  name: string;
  /** Linked workspace id (the dev workspace pointing at <id>/src/). */
  workspaceId?: string;
  createdAt: number;
  updatedAt: number;
  /** LLM-generated feature description. See customization-description.ts. */
  description?: string;
  /** ms since epoch when `description` was last regenerated. */
  descriptionGeneratedAt?: number;
  /**
   * Hash of the diff state at the moment `description` was generated. The
   * /customize/[id] page compares this to the live diff hash and shows a
   * stale chip when they diverge. Cleared when the user edits the
   * description manually — manual text never goes stale on its own.
   */
  descriptionDiffHash?: string;
  /**
   * True when the user typed/edited the description by hand. Suppresses the
   * stale chip and labels the meta line "Edited" instead of "Generated" on
   * the customize detail page.
   */
  descriptionIsManual?: boolean;
};

export type PublishRecord = {
  id: string;
  customizationId: string;
  publishedAt: number;
  /** ms since epoch of revert; null when still active. */
  revertedAt: number | null;
  /** Reason for revert, when applicable (e.g. "user", "stale_at_upgrade"). */
  revertReason?: string;
  /** Hash of the live source tree at publish time, used for upgrade detection. */
  baseHash: string;
  /** Per-file before/after hashes; used to apply / restore. */
  files: PublishedFile[];
  /** Absolute path to the snapshot dir for this publish. */
  snapshotDir: string;
};

export type PublishedFile = {
  /** Path relative to the live source root, e.g. "components/nav/SideNav.tsx". */
  path: string;
  /** Hash of the base file before publish (null if file did not exist). */
  baseHash: string | null;
  /** Hash of the customization file written into base. */
  customHash: string;
};

type IndexShape = {
  version: 1;
  customizations: Customization[];
  publishes: PublishRecord[];
};

const ROOT = join(homedir(), ".claude", ".claudius", "customizations");
const INDEX_FILE = join(ROOT, "index.json");

export function customizationsRoot(): string {
  return ROOT;
}

export function customizationDir(id: string): string {
  return join(ROOT, id);
}

export function customizationSrcDir(id: string): string {
  return join(ROOT, id, "src");
}

export function customizationPublishesDir(id: string): string {
  return join(ROOT, id, ".publishes");
}

async function readShape(): Promise<IndexShape> {
  try {
    const buf = await fs.readFile(INDEX_FILE, "utf8");
    const parsed = JSON.parse(buf) as IndexShape;
    if (parsed.version === 1 && Array.isArray(parsed.customizations) && Array.isArray(parsed.publishes)) {
      return parsed;
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw err;
  }
  return { version: 1, customizations: [], publishes: [] };
}

async function writeShape(shape: IndexShape): Promise<void> {
  await fs.mkdir(ROOT, { recursive: true });
  const tmp = `${INDEX_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(shape, null, 2) + "\n", "utf8");
  await fs.rename(tmp, INDEX_FILE);
}

export async function listCustomizations(): Promise<Customization[]> {
  const shape = await readShape();
  return shape.customizations;
}

export async function getCustomization(id: string): Promise<Customization | null> {
  const shape = await readShape();
  return shape.customizations.find((c) => c.id === id) ?? null;
}

export async function createCustomizationRecord(input: {
  name: string;
  workspaceId?: string;
}): Promise<Customization> {
  const shape = await readShape();
  const id = "cust_" + randomUUID().replace(/-/g, "").slice(0, 12);
  const c: Customization = {
    id,
    name: input.name.trim() || "Untitled",
    workspaceId: input.workspaceId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  shape.customizations.push(c);
  await writeShape(shape);
  return c;
}

export async function updateCustomizationRecord(
  id: string,
  patch: Partial<Pick<Customization, "name" | "workspaceId">>,
): Promise<Customization | null> {
  const shape = await readShape();
  const idx = shape.customizations.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  shape.customizations[idx] = {
    ...shape.customizations[idx],
    ...patch,
    id,
    updatedAt: Date.now(),
  };
  await writeShape(shape);
  return shape.customizations[idx];
}

export async function setCustomizationDescription(
  id: string,
  description: string,
  diffHash: string,
): Promise<Customization | null> {
  const shape = await readShape();
  const idx = shape.customizations.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  shape.customizations[idx] = {
    ...shape.customizations[idx],
    description,
    descriptionGeneratedAt: Date.now(),
    descriptionDiffHash: diffHash,
    descriptionIsManual: false,
    updatedAt: Date.now(),
  };
  await writeShape(shape);
  return shape.customizations[idx];
}

/**
 * Set the description from a user-typed string. Clears the diff hash so the
 * stale chip stays hidden, and flags the entry so the UI labels it "Edited"
 * instead of "Generated".
 */
export async function setCustomizationDescriptionManual(
  id: string,
  description: string,
): Promise<Customization | null> {
  const shape = await readShape();
  const idx = shape.customizations.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const trimmed = description.trim();
  shape.customizations[idx] = {
    ...shape.customizations[idx],
    description: trimmed || undefined,
    descriptionGeneratedAt: trimmed ? Date.now() : undefined,
    descriptionDiffHash: undefined,
    descriptionIsManual: trimmed ? true : undefined,
    updatedAt: Date.now(),
  };
  await writeShape(shape);
  return shape.customizations[idx];
}

export async function deleteCustomizationRecord(id: string): Promise<boolean> {
  const shape = await readShape();
  const next = shape.customizations.filter((c) => c.id !== id);
  if (next.length === shape.customizations.length) return false;
  shape.customizations = next;
  // Keep publish records around for revert history; deleting the customization
  // doesn't auto-revert.
  await writeShape(shape);
  return true;
}

export async function listPublishes(customizationId?: string): Promise<PublishRecord[]> {
  const shape = await readShape();
  return customizationId
    ? shape.publishes.filter((p) => p.customizationId === customizationId)
    : shape.publishes;
}

export async function activePublishesOrdered(): Promise<PublishRecord[]> {
  const shape = await readShape();
  return shape.publishes
    .filter((p) => p.revertedAt == null)
    .sort((a, b) => a.publishedAt - b.publishedAt);
}

export async function recordPublish(rec: PublishRecord): Promise<void> {
  const shape = await readShape();
  shape.publishes.push(rec);
  await writeShape(shape);
}

export async function markPublishReverted(
  publishId: string,
  reason: string = "user",
): Promise<PublishRecord | null> {
  const shape = await readShape();
  const idx = shape.publishes.findIndex((p) => p.id === publishId);
  if (idx === -1) return null;
  if (shape.publishes[idx].revertedAt != null) return shape.publishes[idx];
  shape.publishes[idx] = {
    ...shape.publishes[idx],
    revertedAt: Date.now(),
    revertReason: reason,
  };
  await writeShape(shape);
  return shape.publishes[idx];
}

export function newPublishId(): string {
  return "pub_" + randomUUID().replace(/-/g, "").slice(0, 12);
}

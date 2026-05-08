"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, Trash2 } from "lucide-react";
import { Overlay } from "@/components/overlays/Overlay";
import { deleteAssetClient, fetchUses, type UseRow } from "@/lib/client/useAssets";
import type { AssetRow } from "@/lib/server/asset-list";

type Props = {
  asset: AssetRow;
  cwd: string;
  onClose: () => void;
  onDeleted: () => void;
};

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function FileDetail({ asset, cwd, onClose, onDeleted }: Props) {
  const effectiveCwd = asset.cwd ?? cwd;
  const src = `/api/assets/${asset.hash}?cwd=${encodeURIComponent(effectiveCwd)}`;
  const [uses, setUses] = useState<UseRow[] | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    void fetchUses(effectiveCwd, asset.hash).then(setUses);
  }, [asset.hash, effectiveCwd]);

  async function onDelete() {
    if (
      !confirm(
        "Removes from your file gallery. Conversations that included this file are unaffected.",
      )
    )
      return;
    setDeleting(true);
    try {
      const ok = await deleteAssetClient(effectiveCwd, asset.hash);
      if (ok) {
        onDeleted();
        onClose();
      }
    } finally {
      setDeleting(false);
    }
  }

  const isImage = asset.mediaType.startsWith("image/");

  return (
    <Overlay
      title={asset.hash.slice(0, 16) + "…"}
      subtitle={`${asset.mediaType} · ${fmtSize(asset.sizeBytes)}`}
      onClose={onClose}
      width={760}
    >
      <div className="grid grid-cols-1 gap-4 px-4 py-4 sm:grid-cols-[1fr_220px]">
        <div className="overflow-hidden rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40">
          {isImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt={asset.hash} className="max-h-[60vh] w-full object-contain" />
          ) : (
            <div className="p-6 text-center">
              <a
                href={src}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-xs hover:bg-[var(--panel-2)]"
              >
                Open <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
        </div>
        <dl className="space-y-2 text-[11px]">
          <Row label="Hash">
            <code className="block break-all font-mono">{asset.hash}</code>
          </Row>
          <Row label="Type">{asset.mediaType}</Row>
          <Row label="Size">{fmtSize(asset.sizeBytes)}</Row>
          {(asset.width || asset.height) && (
            <Row label="Dimensions">
              {asset.width ?? "?"} × {asset.height ?? "?"}
            </Row>
          )}
          <Row label="First seen">{fmtTime(asset.firstSeenMs)}</Row>
          <Row label="Last seen">{fmtTime(asset.lastSeenMs)}</Row>
          <Row label="Uses">{asset.uses}</Row>
        </dl>
      </div>
      <div className="border-t border-[var(--border)] bg-[var(--panel-2)]/30 px-4 py-3">
        <div className="mb-2 text-[10px] uppercase tracking-wide text-[var(--muted)]">
          Appears in {uses?.length ?? 0} message{uses?.length === 1 ? "" : "s"}
        </div>
        {uses == null ? (
          <div className="text-[11px] text-[var(--muted)]">Loading…</div>
        ) : uses.length === 0 ? (
          <div className="text-[11px] italic text-[var(--muted)]">
            No usage records (may have been ingested without a session reference).
          </div>
        ) : (
          <ul className="max-h-48 overflow-y-auto scroll-thin">
            {uses.map((u) => (
              <li key={`${u.sessionId}-${u.messageUuid}-${u.ordinal}`}>
                <Link
                  href={`/?session=${u.sessionId}&at=${u.messageUuid}`}
                  className="flex items-baseline justify-between gap-2 px-1 py-0.5 text-[11px] hover:bg-[var(--panel-2)]"
                  onClick={onClose}
                >
                  <span className="font-mono">{u.sessionId.slice(0, 8)}…</span>
                  <span className="text-[var(--muted)]">
                    #{u.ordinal} · {fmtTime(u.occurredMs)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-[var(--border)] bg-[var(--panel-2)]/50 px-4 py-3">
        <button
          onClick={onDelete}
          disabled={deleting}
          className="flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/20 disabled:opacity-40"
        >
          <Trash2 className="h-3 w-3" /> {deleting ? "Deleting…" : "Delete from gallery"}
        </button>
        <span className="text-[11px] text-[var(--muted)]">
          Conversations that included this file are unaffected — only the gallery entry and the
          local dedup blob are removed.
        </span>
      </div>
    </Overlay>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[80px_1fr] gap-2">
      <dt className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

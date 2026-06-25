import { SystemPill } from "claudius";

const entry = (kind: string, label: string, detail?: string) => ({
  uuid: `ds-${kind}`,
  afterMessageUuid: "",
  kind,
  label,
  detail,
});

export const Info = () => <SystemPill entry={entry("info", "Session resumed from checkpoint")} />;

export const Status = () => (
  <SystemPill entry={entry("status", "Compacting conversation", "Summarized 42 earlier messages")} />
);

export const ModelFallback = () => (
  <SystemPill entry={entry("model_fallback", "Fell back to Sonnet", "Opus was overloaded")} />
);

export const PermissionDenied = () => (
  <SystemPill entry={entry("permission_denied", "Permission denied: write to /etc/hosts")} />
);

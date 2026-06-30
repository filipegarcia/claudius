"use client";

import { useState } from "react";
import { Scale } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { Overlay } from "@/components/overlays/Overlay";
import {
  useCrossCheckConfig,
  type CrossCheckConfig,
  type CrossCheckProvider,
} from "@/lib/client/useCrossCheckConfig";

/**
 * "Check with another LLM" — a chat-toolbar button that gets a second opinion
 * from a different model. The first time it's clicked (before anything is
 * configured) it opens a config dialog asking for the provider / model /
 * credentials. The actual cross-check call is intentionally NOT wired up yet —
 * for now this only captures and persists the configuration.
 */

const PROVIDERS: { id: CrossCheckProvider; label: string; modelPlaceholder: string }[] = [
  { id: "openai", label: "OpenAI", modelPlaceholder: "gpt-4o" },
  { id: "anthropic", label: "Anthropic", modelPlaceholder: "claude-opus-4-8" },
  { id: "google", label: "Google Gemini", modelPlaceholder: "gemini-1.5-pro" },
  { id: "custom", label: "OpenAI-compatible (custom)", modelPlaceholder: "model-id" },
];

const fieldCls =
  "w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-1.5 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)]/60 focus:border-[var(--accent)]/60 focus:outline-none";
const labelCls = "mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]";

export function CrossCheckButton({ testIdPrefix = "prompt" }: { testIdPrefix?: string }) {
  const { config, configured, save } = useCrossCheckConfig();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        data-testid={`${testIdPrefix}-crosscheck`}
        onClick={() => setOpen(true)}
        title={
          configured
            ? `Check with another LLM (${config?.model})`
            : "Check with another LLM — click to configure"
        }
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition",
          configured
            ? "text-[var(--accent)] hover:bg-[var(--accent)]/15"
            : "text-[var(--muted)] hover:bg-[var(--panel)]",
        )}
      >
        <Scale className="h-4 w-4" />
      </button>
      {open && (
        <CrossCheckConfigDialog
          initial={config}
          onClose={() => setOpen(false)}
          onSave={(next) => {
            save(next);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function CrossCheckConfigDialog({
  initial,
  onClose,
  onSave,
}: {
  initial: CrossCheckConfig | null;
  onClose: () => void;
  onSave: (config: CrossCheckConfig) => void;
}) {
  const [provider, setProvider] = useState<CrossCheckProvider>(initial?.provider ?? "openai");
  const [model, setModel] = useState(initial?.model ?? "");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");

  // The dialog is conditionally mounted (only while open), so these
  // initializers capture the latest saved config every time it opens — no
  // sync effect needed.
  const activeProvider = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];
  const canSave = model.trim().length > 0 && apiKey.trim().length > 0;

  function handleSave() {
    if (!canSave) return;
    onSave({
      provider,
      model: model.trim(),
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim() || undefined,
    });
  }

  return (
    <Overlay
      title="Check with another LLM"
      subtitle="Second opinion"
      width={520}
      onClose={onClose}
    >
      <div className="space-y-4 px-4 py-4">
        <p className="text-xs text-[var(--muted)]">
          Configure the model Claudius should consult for a second opinion. Your key is stored
          locally in this browser only. (The cross-check action isn&apos;t wired up yet — this just
          saves the configuration.)
        </p>

        <div>
          <label className={labelCls} htmlFor="crosscheck-provider">
            Provider
          </label>
          <select
            id="crosscheck-provider"
            data-testid="crosscheck-provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as CrossCheckProvider)}
            className={fieldCls}
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelCls} htmlFor="crosscheck-model">
            Model
          </label>
          <input
            id="crosscheck-model"
            data-testid="crosscheck-model"
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={activeProvider.modelPlaceholder}
            className={fieldCls}
            autoComplete="off"
          />
        </div>

        <div>
          <label className={labelCls} htmlFor="crosscheck-apikey">
            API key
          </label>
          <input
            id="crosscheck-apikey"
            data-testid="crosscheck-apikey"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
            className={fieldCls}
            autoComplete="off"
          />
        </div>

        <div>
          <label className={labelCls} htmlFor="crosscheck-baseurl">
            Base URL {provider === "custom" ? "" : "(optional)"}
          </label>
          <input
            id="crosscheck-baseurl"
            data-testid="crosscheck-baseurl"
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            className={fieldCls}
            autoComplete="off"
          />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="crosscheck-save"
            onClick={handleSave}
            disabled={!canSave}
            className={cn(
              "rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white transition",
              "hover:opacity-90 active:scale-95",
              "disabled:cursor-not-allowed disabled:opacity-40",
            )}
          >
            Save
          </button>
        </div>
      </div>
    </Overlay>
  );
}

"use client";

/**
 * Windows / Linux variant of the window controls — three small buttons
 * (minimize, maximize, close) rendered on the right side of the
 * <TitleBar /> when the renderer is running inside Electron on a
 * non-mac platform.
 *
 * On macOS the OS draws traffic lights itself when BrowserWindow is
 * configured with `titleBarStyle: "hiddenInset"`, so this component
 * intentionally renders nothing on darwin.
 *
 * Phase 4 of docs/electron-conversion/PLAN.md.
 */
import { Minus, Square, X } from "lucide-react";
import { useCallback } from "react";

import { useClaudius } from "@/lib/client/useElectron";

export function TrafficLights() {
  const bridge = useClaudius();

  const onMinimize = useCallback(() => {
    bridge?.window.minimize();
  }, [bridge]);
  const onMaximize = useCallback(() => {
    bridge?.window.maximize();
  }, [bridge]);
  const onClose = useCallback(() => {
    bridge?.window.close();
  }, [bridge]);

  // Don't render on mac — the OS provides the buttons inside the
  // hiddenInset title bar — and don't render in the browser build.
  if (!bridge || bridge.platform === "darwin") return null;

  return (
    <div
      // The buttons need to receive clicks; the title bar wrapper is
      // draggable so we opt this region out explicitly via inline
      // style (Tailwind doesn't ship `-webkit-app-region` utilities).
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      className="flex h-full shrink-0 items-stretch"
      data-testid="traffic-lights"
    >
      <TitleBarButton onClick={onMinimize} aria-label="Minimize">
        <Minus className="h-3.5 w-3.5" strokeWidth={1.5} />
      </TitleBarButton>
      <TitleBarButton onClick={onMaximize} aria-label="Maximize">
        <Square className="h-3 w-3" strokeWidth={1.5} />
      </TitleBarButton>
      <TitleBarButton onClick={onClose} aria-label="Close" variant="danger">
        <X className="h-3.5 w-3.5" strokeWidth={1.5} />
      </TitleBarButton>
    </div>
  );
}

function TitleBarButton({
  children,
  onClick,
  variant,
  ...rest
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant?: "danger";
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex h-full w-11 items-center justify-center text-[var(--muted)] transition-colors " +
        (variant === "danger"
          ? "hover:bg-red-600 hover:text-white"
          : "hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]")
      }
      {...rest}
    >
      {children}
    </button>
  );
}

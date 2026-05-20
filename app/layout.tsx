import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import { Suspense } from "react";
import "./globals.css";
import { CommandPalette } from "@/components/overlays/CommandPalette";
import { PaneLabelsHost } from "@/components/overlays/PaneLabelsHost";
import { CustomizationBanner } from "@/components/customize/CustomizationBanner";
import { DeepLinksHandler } from "@/components/chrome/DeepLinksHandler";
import { ElectronGlobalActions } from "@/components/chrome/ElectronGlobalActions";
import { TitleBar } from "@/components/chrome/TitleBar";
import { UpdaterBanner } from "@/components/updater/UpdaterBanner";
import { NotificationsProvider } from "@/components/notifications/NotificationsProvider";
import { CommunityNotificationsProvider } from "@/components/community/CommunityNotificationsProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Claudius",
  description: "Claude Code in the browser",
};

// Inline bootstrap that reads the saved theme out of localStorage and applies
// it to the documentElement *before* React hydrates. Avoids a flash of the
// default theme on reload. The allowlist here MUST stay in sync with the
// `ThemeId` union in `lib/client/theme.ts`.
const themeBootstrap = `(() => {
  try {
    var t = localStorage.getItem('claudius.theme');
    var allowed = { dark:1, light:1, midnight:1, paper:1, tui:1, 'tui-light':1, synthwave:1 };
    document.documentElement.dataset.theme = (t && allowed[t]) ? t : 'dark';
  } catch (_) {
    document.documentElement.dataset.theme = 'dark';
  }
  // Electron detection — used by globals.css to add a 32px top padding to
  // the body so the workspace rail and chat shell never sit under the
  // OS-drawn traffic lights / our custom title bar. UA-sniffing the
  // "Electron" tag is the reliable signal — preload may or may not have
  // run by the time this script executes, so we can't depend on
  // window.claudius being present yet.
  try {
    if (navigator.userAgent.indexOf('Electron') !== -1) {
      document.documentElement.dataset.electron = '1';
    }
  } catch (_) {}
})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="h-full">
        {/* `beforeInteractive` ensures this runs before hydration so the saved
         * theme is applied without a flash. Per Next 16 docs this is the
         * supported way to inject inline scripts; raw `<script>` inside a
         * React-rendered tree triggers a hydration warning in React 19. */}
        <Script
          id="claudius-theme-bootstrap"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: themeBootstrap }}
        />
        {/* Notifications provider wraps the whole app so the workspace
            switcher (and per-tile badges) can read the unread counts before
            the chat surface mounts. Suspense boundary is required because
            the provider reads useSearchParams() — Next 16 will error a
            static-rendered child if any descendant unconditionally reads
            search params without a Suspense ancestor. */}
        <Suspense fallback={null}>
          <NotificationsProvider>
            <CommunityNotificationsProvider>
              <div className="flex h-full flex-col">
                {/* Electron-only frameless-window title bar. Returns
                  * null in the browser build so the existing web
                  * chrome (the user's OS browser frame) stays the
                  * default. Phase 4 of
                  * docs/electron-conversion/PLAN.md. */}
                <TitleBar />
                <UpdaterBanner />
                <CustomizationBanner />
                <div className="min-h-0 flex-1">{children}</div>
              </div>
              {/* Cross-cut Cmd+K palette — Phase 5 of
                * docs/electron-conversion/PLAN.md. Renders nothing
                * until the chord opens it; safe to mount globally.
                * (Iter-18 bisect confirmed this is NOT the cause of
                * the CI playwright e2e hang — see PLAN.md known-issue
                * section.) */}
              <CommandPalette />
              {/* Routes claudius:// deep links into the next/navigation
                * router. No-op in the browser build. Phase 8 of
                * docs/electron-conversion/PLAN.md. */}
              <DeepLinksHandler />
              {/* Subscribes to OS menu actions (app.openWorkspace) and
                * dock-folder-drop events. No-op in the browser build.
                * Phase 8 follow-up. */}
              <ElectronGlobalActions />
              <PaneLabelsHost />
            </CommunityNotificationsProvider>
          </NotificationsProvider>
        </Suspense>
      </body>
    </html>
  );
}

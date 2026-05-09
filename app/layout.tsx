import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { PaneLabelsHost } from "@/components/overlays/PaneLabelsHost";
import { CustomizationBanner } from "@/components/customize/CustomizationBanner";

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
    var allowed = { dark:1, light:1, midnight:1, paper:1, tui:1, 'tui-light':1 };
    document.documentElement.dataset.theme = (t && allowed[t]) ? t : 'dark';
  } catch (_) {
    document.documentElement.dataset.theme = 'dark';
  }
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
        <div className="flex h-full flex-col">
          <CustomizationBanner />
          <div className="min-h-0 flex-1">{children}</div>
        </div>
        <PaneLabelsHost />
      </body>
    </html>
  );
}

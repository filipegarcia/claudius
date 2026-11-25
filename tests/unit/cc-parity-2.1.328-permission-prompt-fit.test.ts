import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { PermissionPrompt } from "@/components/chat/PermissionPrompt";
import type { PermissionRequestEvent } from "@/lib/shared/events";

/**
 * CC 2.1.328 — "[VSCode] Fixed the permission prompt cutting off its No
 * button, reply field or title when the panel is low or a command, URL or
 * description is long".
 *
 * Claudius's permission card was a centered modal with no maximum height and
 * no inner scroll, so in a short window its title and its Allow/Deny row
 * (and the deny feedback field) were pushed off screen, and a long unbroken
 * path in the title was clipped sideways. The layout contract pinned here:
 * the card is capped to the window and lays out as a column, the answer
 * area (buttons and deny field) doesn't shrink, everything above it scrolls
 * (title included), and the title and description wrap anywhere. The
 * in-browser check (a 900×520 window) is
 * tests/e2e/cc-parity-2.1.328-permission-prompt-fit.spec.ts.
 */

const request: PermissionRequestEvent = {
  type: "permission_request",
  requestId: "req-fit",
  toolName: "Read",
  toolUseId: "tu-fit",
  input: { file_path: `/srv/${"very-long-directory-name/".repeat(12)}config.json` },
  title: `Claude wants to read /srv/${"very-long-directory-name/".repeat(12)}config.json`,
  description: "A long description. ".repeat(30),
  defaultToNo: true,
};

function render(): string {
  return renderToStaticMarkup(createElement(PermissionPrompt, { request, onResolve: () => {} }));
}

/** The class attribute of the element carrying `data-testid="<id>"`. */
function classOf(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  if (at < 0) return "";
  const tag = html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
  return tag.match(/class="([^"]*)"/)?.[1] ?? "";
}

describe("permission card fits a short window (CC 2.1.328)", () => {
  test("the card is capped to the window and lays out as a column", () => {
    const cls = classOf(render(), "permission-card");
    expect(cls).toContain("max-h-[calc(100dvh-2rem)]");
    expect(cls).toContain("flex-col");
  });

  test("everything above the answer area scrolls, starting at the title", () => {
    const html = render();
    const cls = classOf(html, "permission-scroll");
    expect(cls).toContain("min-h-0");
    expect(cls).toContain("flex-1");
    expect(cls).toContain("overflow-y-auto");
    const scrollAt = html.indexOf('data-testid="permission-scroll"');
    const titleAt = html.indexOf('data-testid="permission-title"');
    const footerAt = html.indexOf('class="shrink-0"');
    expect(scrollAt).toBeGreaterThan(-1);
    expect(titleAt).toBeGreaterThan(scrollAt);
    expect(footerAt).toBeGreaterThan(titleAt);
  });

  test("a long unbroken title wraps instead of being clipped sideways", () => {
    expect(classOf(render(), "permission-title")).toContain("[overflow-wrap:anywhere]");
  });

  test("defaultToNo still renders the deny field and its buttons in the fixed footer", () => {
    const html = render();
    const footer = html.slice(html.indexOf('class="shrink-0"'));
    expect(footer).toContain("Deny without feedback");
    expect(footer).toContain("<textarea");
  });
});

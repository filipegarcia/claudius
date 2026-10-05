import { describe, expect, test } from "vitest";
import { qrSvgTag } from "@/lib/client/qr";

/**
 * CC 2.1.271 (H12) — the `/mobile` QR renders as an inline SVG from a pure JS
 * encoder (no native binding, Electron-safe).
 */
describe("qrSvgTag (H12)", () => {
  test("encodes a URL as a non-trivial SVG", () => {
    const svg = qrSvgTag("https://claude.com/download");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("</svg>");
    expect(svg.length).toBeGreaterThan(500);
  });

  test("different inputs produce different QR matrices", () => {
    expect(qrSvgTag("https://a.example")).not.toBe(qrSvgTag("https://b.example/longer/path"));
  });

  test("is deterministic for the same input", () => {
    expect(qrSvgTag("https://claude.ai/mobile")).toBe(qrSvgTag("https://claude.ai/mobile"));
  });
});

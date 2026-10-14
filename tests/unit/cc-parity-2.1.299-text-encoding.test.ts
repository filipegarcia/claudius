import { describe, expect, test } from "vitest";
import { decodePreview, decodeText, detectTextEncoding, encodeText } from "@/lib/shared/text-encoding";

/**
 * CC 2.1.299 — "Fixed Read garbling UTF-16LE files with a byte-order mark,
 * and Write dropping byte-order marks or silently converting Windows-1252,
 * Shift-JIS, GBK or UTF-16BE files to UTF-8 (now refused)". The pure sniff /
 * decode / encode helpers behind Claudius's own Files + git editors.
 */
const bytes = (...xs: number[]) => new Uint8Array(xs);
const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};
const utf16le = (s: string) => new Uint8Array(Buffer.from(s, "utf16le"));

describe("detectTextEncoding", () => {
  test("plain ASCII / UTF-8 is editable utf-8", () => {
    expect(detectTextEncoding(new TextEncoder().encode("hello\n"))).toMatchObject({ encoding: "utf-8", editable: true });
    expect(detectTextEncoding(new TextEncoder().encode("café ✓ 日本"))).toMatchObject({ encoding: "utf-8", editable: true });
    expect(detectTextEncoding(new Uint8Array())).toMatchObject({ encoding: "utf-8", editable: true });
  });

  test("EF BB BF is utf-8-bom", () => {
    const b = concat(bytes(0xef, 0xbb, 0xbf), new TextEncoder().encode("x"));
    expect(detectTextEncoding(b)).toMatchObject({ encoding: "utf-8-bom", editable: true });
  });

  test("FF FE is utf-16le (despite the NUL bytes)", () => {
    const b = concat(bytes(0xff, 0xfe), utf16le("hi"));
    expect(detectTextEncoding(b)).toMatchObject({ encoding: "utf-16le", editable: true, label: "UTF-16LE" });
  });

  test("Windows-1252 é (lone 0xE9) is unsupported", () => {
    const d = detectTextEncoding(bytes(0x63, 0x61, 0x66, 0xe9));
    expect(d).toMatchObject({ encoding: "unsupported", editable: false, guess: "legacy" });
    if (!d.editable) expect(d.reason).toMatch(/Windows-1252/);
  });

  test("Shift-JIS / GBK bytes are unsupported", () => {
    // "日本" in Shift-JIS, "中文" in GBK — neither is valid UTF-8.
    expect(detectTextEncoding(bytes(0x93, 0xfa, 0x96, 0x7b))).toMatchObject({ encoding: "unsupported" });
    expect(detectTextEncoding(bytes(0xd6, 0xd0, 0xce, 0xc4))).toMatchObject({ encoding: "unsupported" });
  });

  test("FE FF (UTF-16BE) is unsupported", () => {
    const d = detectTextEncoding(bytes(0xfe, 0xff, 0x00, 0x68, 0x00, 0x69));
    expect(d).toMatchObject({ encoding: "unsupported", editable: false, guess: "utf-16be", label: "UTF-16BE" });
    if (!d.editable) expect(d.reason).toMatch(/UTF-16BE/);
  });

  test("UTF-32 BOMs and BOM-less NUL-bearing bytes are unsupported", () => {
    expect(detectTextEncoding(bytes(0xff, 0xfe, 0x00, 0x00, 0x68, 0, 0, 0))).toMatchObject({ guess: "utf-32" });
    expect(detectTextEncoding(bytes(0x89, 0x50, 0x4e, 0x47, 0x00, 0x00))).toMatchObject({ guess: "binary" });
    expect(detectTextEncoding(utf16le("no bom"))).toMatchObject({ encoding: "unsupported", guess: "binary" });
  });

  test("a UTF-16LE BOM over an odd byte count is not editable", () => {
    expect(detectTextEncoding(bytes(0xff, 0xfe, 0x68))).toMatchObject({ editable: false });
  });
});

describe("decodeText / encodeText round trips", () => {
  test("UTF-8 BOM: stripped from the string, restored on encode", () => {
    const original = concat(bytes(0xef, 0xbb, 0xbf), new TextEncoder().encode("é\n"));
    const text = decodeText(original, "utf-8-bom");
    expect(text).toBe("é\n");
    expect(Array.from(encodeText(text, "utf-8-bom"))).toEqual(Array.from(original));
  });

  test("UTF-8 BOM: a second U+FEFF that's part of the text survives", () => {
    const original = concat(bytes(0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf), new TextEncoder().encode("x"));
    const text = decodeText(original, "utf-8-bom");
    expect(text).toBe("﻿x");
    expect(Array.from(encodeText(text, "utf-8-bom"))).toEqual(Array.from(original));
  });

  test("UTF-16LE + BOM: decodes properly and re-encodes byte-identical", () => {
    const original = concat(bytes(0xff, 0xfe), utf16le("héllo wörld 😀\r\n"));
    const text = decodeText(original, "utf-16le");
    expect(text).toBe("héllo wörld 😀\r\n");
    expect(Array.from(encodeText(text, "utf-16le"))).toEqual(Array.from(original));
    // An edit stays UTF-16LE with its BOM.
    const edited = encodeText(text + "!", "utf-16le");
    expect(Array.from(edited.subarray(0, 2))).toEqual([0xff, 0xfe]);
    expect(decodeText(edited, "utf-16le")).toBe("héllo wörld 😀\r\n!");
  });

  test("plain UTF-8 encodes with no BOM", () => {
    expect(Array.from(encodeText("hi", "utf-8"))).toEqual([0x68, 0x69]);
    expect(decodeText(new TextEncoder().encode("hi"), "utf-8")).toBe("hi");
  });

  test("decodeText throws on bytes that aren't the claimed encoding", () => {
    expect(() => decodeText(bytes(0xe9), "utf-8")).toThrow();
  });
});

describe("decodePreview (read-only, lossy)", () => {
  test("Windows-1252 shows é", () => {
    expect(decodePreview(bytes(0x63, 0x61, 0x66, 0xe9), "legacy")).toBe("café");
  });

  test("UTF-16BE is byte-swapped into readable text", () => {
    expect(decodePreview(bytes(0xfe, 0xff, 0x00, 0x68, 0x00, 0x69), "utf-16be")).toBe("hi");
  });
});

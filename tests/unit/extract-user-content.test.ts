import { describe, expect, test } from "vitest";
import { extractUserContent } from "@/lib/client/use-session";

/**
 * Regression coverage for the user-content rehydration helper. The
 * user-visible symptom this guards against: after a page refresh the
 * image thumbnail chips on past user messages disappear, because the
 * server strips `[Image #N]` markers from the text blocks it ships to
 * the SDK and the replay path used to drop the resulting image blocks
 * on the floor.
 */

const PNG_DATA = "iVBORw0KGgoAAA==";
const JPG_DATA = "/9j/4AAQSkZJRg==";

describe("extractUserContent", () => {
  test("string content passes through unchanged", () => {
    const r = extractUserContent("hello world");
    expect(r).toEqual({ text: "hello world", images: [], reminderBodies: [] });
  });

  test("empty / non-array / non-string content returns empties", () => {
    expect(extractUserContent(undefined)).toEqual({
      text: "",
      images: [],
      reminderBodies: [],
    });
    expect(extractUserContent(null)).toEqual({
      text: "",
      images: [],
      reminderBodies: [],
    });
    expect(extractUserContent({})).toEqual({
      text: "",
      images: [],
      reminderBodies: [],
    });
    expect(extractUserContent([])).toEqual({
      text: "",
      images: [],
      reminderBodies: [],
    });
  });

  test("text-only content array concatenates", () => {
    const r = extractUserContent([
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ]);
    expect(r).toEqual({ text: "hello world", images: [], reminderBodies: [] });
  });

  test("image-only content rehydrates with [Image #1] token", () => {
    const r = extractUserContent([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: PNG_DATA },
      },
    ]);
    expect(r.text).toBe("[Image #1]");
    expect(r.images).toHaveLength(1);
    expect(r.images[0]).toMatchObject({
      ordinal: 1,
      data: PNG_DATA,
      mediaType: "image/png",
    });
  });

  test("mixed text + image inlines tokens at the image's document position", () => {
    const r = extractUserContent([
      { type: "text", text: "look at this " },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: PNG_DATA },
      },
      { type: "text", text: " and this " },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: JPG_DATA },
      },
      { type: "text", text: " please" },
    ]);
    expect(r.text).toBe("look at this [Image #1] and this [Image #2] please");
    expect(r.images.map((i) => i.ordinal)).toEqual([1, 2]);
    expect(r.images[0].mediaType).toBe("image/png");
    expect(r.images[1].mediaType).toBe("image/jpeg");
  });

  test("non-base64 image sources are skipped (no token, no entry)", () => {
    const r = extractUserContent([
      { type: "text", text: "before " },
      {
        type: "image",
        source: { type: "url", url: "https://example.com/img.png" },
      },
      { type: "text", text: "after" },
    ]);
    expect(r).toEqual({ text: "before after", images: [], reminderBodies: [] });
  });

  test("malformed blocks are silently ignored", () => {
    const r = extractUserContent([
      { type: "text", text: "keep" },
      null,
      { type: "tool_use", id: "t1", name: "Bash", input: {} },
      { type: "image" }, // no source
      { type: "image", source: { type: "base64" } }, // no data / media_type
      { type: "text", text: " me" },
    ]);
    expect(r).toEqual({ text: "keep me", images: [], reminderBodies: [] });
  });

  test("leading <system-reminder> blocks are peeled off into reminderBodies (string)", () => {
    // Matches the wrap shape from `lib/server/system-reminders.ts` →
    // `wrapReminder(body)`, which appends `\n\n` after the closing tag so
    // multiple reminders concatenate cleanly.
    const raw =
      "<system-reminder>\nThe current to-do list…\n</system-reminder>\n\n" +
      "real user prompt";
    const r = extractUserContent(raw);
    expect(r.text).toBe("real user prompt");
    expect(r.images).toEqual([]);
    expect(r.reminderBodies).toEqual(["The current to-do list…"]);
  });

  test("multiple stacked reminders are all peeled off in order (string)", () => {
    const raw =
      "<system-reminder>\ntodos body\n</system-reminder>\n\n" +
      "<system-reminder>\nstale task tools body\n</system-reminder>\n\n" +
      "actual prompt";
    const r = extractUserContent(raw);
    expect(r.text).toBe("actual prompt");
    expect(r.reminderBodies).toEqual(["todos body", "stale task tools body"]);
  });

  test("leading <system-reminder> in a content-block array is peeled off", () => {
    const raw =
      "<system-reminder>\ntodos body\n</system-reminder>\n\n" +
      "follow-up question";
    const r = extractUserContent([{ type: "text", text: raw }]);
    expect(r.text).toBe("follow-up question");
    expect(r.reminderBodies).toEqual(["todos body"]);
  });

  test("goal reminder + system reminders are stripped in order; both surface", () => {
    const goal =
      "<session-goal>\nThe user has set this goal for the session: ship it\n</session-goal>\n\n";
    const sys =
      "<system-reminder>\nThe current to-do list…\n</system-reminder>\n\n";
    const r = extractUserContent(goal + sys + "user text");
    expect(r.text).toBe("user text");
    expect(r.reminderBodies).toEqual(["The current to-do list…"]);
  });

  test("mid-text <system-reminder> is not stripped (only leading blocks are peeled)", () => {
    const raw = "look at <system-reminder>quoted</system-reminder> in my docs";
    const r = extractUserContent(raw);
    expect(r.text).toBe(raw);
    expect(r.reminderBodies).toEqual([]);
  });

  test("ordinals are freshly assigned per call (server stripped originals)", () => {
    // The composer might have skipped ordinals (paste #1, delete, paste #2 →
    // sender stamped #2 only). The wire form lost the original number, so
    // rehydration always restarts at 1. This is intentional and the test
    // pins it down — `UserMessage`'s `InlineUserText` only requires the
    // text token ordinal to match `images[].ordinal` within the same bubble.
    const r = extractUserContent([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: PNG_DATA },
      },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: PNG_DATA },
      },
    ]);
    expect(r.text).toBe("[Image #1][Image #2]");
    expect(r.images.map((i) => i.ordinal)).toEqual([1, 2]);
  });
});

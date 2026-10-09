import { describe, expect, test } from "vitest";
import { Readable } from "node:stream";
import { jsonlLines } from "@/lib/server/jsonl-lines";

/**
 * CC 2.1.296 — Claudius's own transcript readers split JSONL with
 * `node:readline`, which also breaks on U+2028/U+2029 and dropped any record
 * whose text held one. `jsonlLines` splits on `\n` only.
 */
async function collect(chunks: string[]): Promise<string[]> {
  const out: string[] = [];
  for await (const line of jsonlLines(Readable.from(chunks))) out.push(line);
  return out;
}

describe("jsonlLines", () => {
  test("keeps a record containing U+2028/U+2029 whole", async () => {
    const rec = JSON.stringify({ text: "a b c" });
    const lines = await collect([rec + "\n" + JSON.stringify({ n: 1 }) + "\n"]);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ text: "a b c" });
  });

  test("strips CRLF and joins lines split across chunks", async () => {
    expect(await collect(['{"a":', '1}\r\n{"b"', ":2}\n"])).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("yields a trailing unterminated line", async () => {
    expect(await collect(["x\ny"])).toEqual(["x", "y"]);
  });

  test("destroys the stream when the consumer stops early", async () => {
    const stream = Readable.from(["a\nb\nc\n"]);
    for await (const line of jsonlLines(stream)) {
      if (line === "a") break;
    }
    expect(stream.destroyed).toBe(true);
  });
});

import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

/**
 * Iterate the lines of a JSONL stream, splitting on `\n` only (one trailing
 * `\r` is stripped).
 *
 * Why not `node:readline`? readline also treats U+2028 / U+2029 (LINE /
 * PARAGRAPH SEPARATOR) as line breaks, and `JSON.stringify` writes those
 * characters unescaped — so a single transcript record whose text contains one
 * came back as two or three fragments, each failing `JSON.parse` and silently
 * skipped. CC 2.1.296 fixed the same class of bug in the engine's transcript
 * GC ("dropping a message from the saved transcript when its text held a
 * Unicode line or paragraph separator").
 *
 * Linear in input size: each chunk is scanned once, and a line spanning many
 * chunks is collected as parts and joined once (transcript records holding
 * base64 images run to megabytes). Buffer chunks go through a StringDecoder so
 * a multi-byte UTF-8 character split across chunks isn't mangled.
 *
 * The caller owns opening the stream (so path-safety checks stay inline at the
 * `createReadStream` sink); this generator destroys it when iteration ends —
 * including an early `break`/`return` by the consumer.
 */
export async function* jsonlLines(stream: Readable): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let pending: string[] = [];
  const finish = (tail: string): string => {
    pending.push(tail);
    const line = pending.length === 1 ? pending[0]! : pending.join("");
    pending = [];
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  };
  try {
    for await (const chunk of stream) {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk as Buffer);
      let start = 0;
      let nl = text.indexOf("\n");
      while (nl !== -1) {
        yield finish(text.slice(start, nl));
        start = nl + 1;
        nl = text.indexOf("\n", start);
      }
      if (start < text.length) pending.push(text.slice(start));
    }
    const rest = decoder.end();
    if (rest) pending.push(rest);
    if (pending.length > 0) yield finish("");
  } finally {
    stream.destroy();
  }
}

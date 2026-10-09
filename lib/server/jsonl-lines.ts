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
 * The caller owns opening the stream (so path-safety checks stay inline at the
 * `createReadStream` sink); this generator destroys it when iteration ends —
 * including an early `break`/`return` by the consumer.
 */
export async function* jsonlLines(stream: Readable): AsyncGenerator<string> {
  let buf = "";
  try {
    for await (const chunk of stream) {
      buf += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        yield line.endsWith("\r") ? line.slice(0, -1) : line;
        nl = buf.indexOf("\n");
      }
    }
    if (buf.length > 0) yield buf.endsWith("\r") ? buf.slice(0, -1) : buf;
  } finally {
    stream.destroy();
  }
}

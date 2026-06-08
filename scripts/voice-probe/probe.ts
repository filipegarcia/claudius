/**
 * Voice-stream protocol probe.
 *
 * Connects to the same private endpoint Claude Code uses for voice
 * dictation, streams a short burst of synthesized audio, then closes
 * the stream. Every WS frame and JSON message is logged so we can
 * confirm:
 *
 *  1) The endpoint accepts our stored Claude.ai OAuth token (we're
 *     not gated as non-CLI).
 *  2) The server→client envelopes match what we reconstructed from
 *     the CLI binary (`TranscriptEndpoint`, `TranscriptError`, …).
 *  3) The exact JSON shape of the transcript payload — the field
 *     name that carries the transcribed text, interim vs final flag,
 *     metadata, error envelopes.
 *
 * Run with:
 *   bun scripts/voice-probe/probe.ts                   # synthesized tone
 *   bun scripts/voice-probe/probe.ts path/to/test.wav  # real audio (16 kHz mono linear16 WAV)
 *
 * The token is read from ~/.claude/.claudius/accounts.json — the
 * active profile's `secret`. No copy is logged.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const ACCOUNTS_PATH = join(homedir(), ".claude", ".claudius", "accounts.json");
const BASE_WS = "wss://api.anthropic.com";
const PATH = "/api/ws/speech_to_text/voice_stream";

type Profile = {
  id: string;
  kind: string;
  label: string;
  secret: string;
};
type AccountsFile = { activeProfileId: string; profiles: Profile[] };

async function readActiveToken(): Promise<{ id: string; label: string; secret: string }> {
  const raw = await readFile(ACCOUNTS_PATH, "utf8");
  const data = JSON.parse(raw) as AccountsFile;
  const profile =
    data.profiles.find((p) => p.id === data.activeProfileId) ?? data.profiles[0];
  if (!profile) throw new Error("no profile in accounts.json");
  if (profile.kind !== "oauth-token") {
    throw new Error(`active profile is '${profile.kind}', not oauth-token`);
  }
  return { id: profile.id, label: profile.label, secret: profile.secret };
}

function buildUrl(language = "en"): string {
  const params = new URLSearchParams({
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    endpointing_ms: "300",
    utterance_end_ms: "1000",
    language,
    use_conversation_engine: "true",
    forward_interims: "typed",
    stt_provider: "deepgram-nova3",
  });
  return `${BASE_WS}${PATH}?${params}`;
}

/** Synthesize a brief 16 kHz mono linear16 buffer of a 440 Hz tone. Not
 * intelligible speech — we use it just to confirm the server accepts
 * frames and to elicit any "no speech detected" or interim envelopes. */
function syntheticTone(durationSec = 2): ArrayBuffer {
  const sampleRate = 16_000;
  const totalSamples = sampleRate * durationSec;
  const buffer = new ArrayBuffer(totalSamples * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < totalSamples; i++) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.3 * 32767;
    view.setInt16(i * 2, sample | 0, /* littleEndian */ true);
  }
  return buffer;
}

/** Strip a RIFF/WAVE header off a 16 kHz mono linear16 file. We do this
 * with a minimal parser rather than depending on any audio lib — the
 * probe only ever opens WAVs we control. */
async function loadWavSamples(path: string): Promise<ArrayBuffer> {
  const file = await readFile(path);
  // Minimal validation — fail loudly so we don't ship garbage upstream.
  if (file.toString("ascii", 0, 4) !== "RIFF" || file.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  // Locate the `data` sub-chunk.
  let offset = 12;
  while (offset < file.length - 8) {
    const tag = file.toString("ascii", offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    if (tag === "data") {
      const slice = file.subarray(offset + 8, offset + 8 + size);
      return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    }
    offset += 8 + size;
  }
  throw new Error("no `data` chunk in WAV");
}

async function main(): Promise<void> {
  const { id, label, secret } = await readActiveToken();
  console.log(`[probe] active profile: ${label} (${id})`);

  const audioArg = process.argv[2];
  const audio = audioArg
    ? await loadWavSamples(audioArg)
    : syntheticTone(/* seconds */ 2);
  console.log(`[probe] audio source: ${audioArg ?? "synthetic 440Hz tone"} (${audio.byteLength} bytes)`);

  const url = buildUrl();
  console.log(`[probe] connecting to ${url}`);

  // Bun's WebSocket supports the second-arg `headers` option (browser WS does not),
  // which is the cleanest way to pass the Bearer token through the upgrade.
  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${secret}`,
      "x-config-keyterms": "claudius,electron,typescript,nextjs",
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  const openedAt = Date.now();
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    console.log(`[probe] WS open in ${Date.now() - openedAt}ms`);

    // Initial KeepAlive — the CLI sends one right after upgrade.
    ws.send(JSON.stringify({ type: "KeepAlive" }));

    // Stream the audio in 1024-byte frames (32 ms each at 16 kHz mono).
    const CHUNK = 1024;
    const total = audio.byteLength;
    let sent = 0;
    const view = new Uint8Array(audio);
    const interval = setInterval(() => {
      if (sent >= total) {
        clearInterval(interval);
        console.log(`[probe] all ${total} bytes sent — sending CloseStream`);
        ws.send(JSON.stringify({ type: "CloseStream" }));
        return;
      }
      const end = Math.min(sent + CHUNK, total);
      ws.send(view.slice(sent, end));
      sent = end;
    }, 32);
  });

  ws.addEventListener("message", (ev) => {
    const data = ev.data;
    if (typeof data === "string") {
      try {
        const parsed = JSON.parse(data);
        console.log("[probe] <-", JSON.stringify(parsed, null, 2));
      } catch {
        console.log("[probe] <- text:", data);
      }
    } else if (data instanceof ArrayBuffer) {
      console.log(`[probe] <- binary ${data.byteLength} bytes`);
    } else {
      console.log(`[probe] <- other:`, data);
    }
  });

  ws.addEventListener("error", (ev) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    console.log("[probe] ERROR:", (ev as any).error?.message ?? ev);
  });

  ws.addEventListener("close", (ev) => {
    console.log(`[probe] WS close code=${ev.code} reason=${ev.reason}`);
    process.exit(0);
  });

  // Safety timeout — if the server never closes, end after 10s.
  setTimeout(() => {
    console.log("[probe] timeout — forcing exit");
    process.exit(0);
  }, 10_000);
}

main().catch((err) => {
  console.error("[probe] fatal:", err);
  process.exit(1);
});

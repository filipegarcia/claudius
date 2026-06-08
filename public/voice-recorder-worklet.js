/**
 * AudioWorklet processor for voice dictation.
 *
 * Receives Float32 PCM audio at the AudioContext's native sample rate
 * (usually 44.1 kHz or 48 kHz on macOS), downsamples to 16 kHz, and
 * emits Int16 PCM bytes back to the main thread for upload.
 *
 * Strategy: linear-interpolation resampling with a running fractional
 * read pointer. Quality is fine for speech-to-text (we're not the
 * recognizer — Deepgram Nova-3 is, and it's robust to mild aliasing).
 * The processor batches output samples into ~50 ms chunks (~800
 * samples) before posting; smaller messages create needless main-
 * thread thrash with no transcription benefit.
 *
 * The processor stays silent (alive but emitting nothing) when no
 * input track is connected — the main thread controls capture via
 * `audioContext.suspend()` / `resume()`.
 */
const TARGET_SAMPLE_RATE = 16_000;
// 50 ms at 16 kHz = 800 samples = 1600 bytes (Int16). Big enough that
// the postMessage overhead is amortised, small enough that the user
// sees interim transcripts within ~100 ms of speaking.
const TARGET_CHUNK_SAMPLES = 800;

class VoiceRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Ratio of input samples consumed per output sample. With
    // `sampleRate = 48000`, this is 3 (i.e. read every 3rd sample);
    // with non-integer ratios it's the linear-interp step.
    this._step = sampleRate / TARGET_SAMPLE_RATE;
    // Carried-over fractional read position between `process()` calls.
    // Without this, every render quantum would re-anchor at zero and
    // we'd lose / dupe samples on the boundary.
    this._inputCursor = 0;
    // Output buffer that we flush when it crosses TARGET_CHUNK_SAMPLES.
    this._outBuffer = new Int16Array(TARGET_CHUNK_SAMPLES);
    this._outFill = 0;
  }

  /**
   * Float32 in [-1, 1] → Int16 in [-32768, 32767]. `Math.max/Math.min`
   * clamps the rare value that creeps just past 1 after resampling.
   */
  _toInt16(sample) {
    const s = Math.max(-1, Math.min(1, sample));
    return s < 0 ? s * 32768 : s * 32767;
  }

  process(inputs) {
    // The first input has one channel array per channel. Mono mic →
    // inputs[0][0]. When no track is connected, inputs[0] is `[]` and
    // the input array is empty — return true to keep the processor
    // alive without emitting.
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) return true;

    const inLen = channel.length;
    // The cursor's integer part is the index of the *next* unread
    // input sample; the fractional part is the interpolation phase.
    // We translate the cursor relative to this quantum's start: a
    // negative value means "the previous quantum ended mid-read, so
    // start a fraction in".
    let cursor = this._inputCursor;

    while (cursor < inLen) {
      const i0 = Math.floor(cursor);
      const i1 = i0 + 1;
      const frac = cursor - i0;
      const s0 = channel[i0];
      // When `i1` is past this quantum, we'd need the FIRST sample of
      // the next quantum to interpolate. The cheap trade-off is to
      // hold-last instead of cross-quantum lookahead, which would
      // require buffering one quantum of input. The audible difference
      // at speech rates is nil and the math stays local.
      const s1 = i1 < inLen ? channel[i1] : channel[i0];
      const sample = s0 + (s1 - s0) * frac;

      this._outBuffer[this._outFill++] = this._toInt16(sample);
      if (this._outFill >= TARGET_CHUNK_SAMPLES) {
        // Post a fresh ArrayBuffer copy each time. We can't transfer
        // the underlying buffer because we reuse it for the next chunk
        // — transferring would null it out on this side.
        const out = new Int16Array(this._outFill);
        out.set(this._outBuffer.subarray(0, this._outFill));
        this.port.postMessage(out.buffer, [out.buffer]);
        this._outFill = 0;
      }

      cursor += this._step;
    }

    // Carry the cursor's remainder over to the next quantum, so the
    // resampler stays seamless across the boundary.
    this._inputCursor = cursor - inLen;
    return true;
  }
}

registerProcessor("voice-recorder", VoiceRecorderProcessor);

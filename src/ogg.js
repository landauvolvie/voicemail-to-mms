import { createEncoder } from "wasm-media-encoders";

export const OGG_MIME_TYPE = "audio/ogg";

// Vorbis VBR quality. 0 is roughly 26 kbps at 8 kHz mono — about a fifth the
// size of the equivalent WAV, with speech quality that is indistinguishable
// over a phone line.
export const OGG_VBR_QUALITY = 0;

const ENCODE_BLOCK = 4096;

let wasmSource = null;

/**
 * Supply the encoder's WebAssembly.
 *
 * Production leaves this unset and the bundled module is imported lazily.
 * Node passes the raw bytes, which it is allowed to compile at runtime and
 * the Workers runtime is not.
 */
export function setOggWasm(source) {
  wasmSource = source;
}

async function resolveOggWasm() {
  if (!wasmSource) {
    const module = await import("./ogg-wasm.js");
    wasmSource = module.default;
  }
  return wasmSource;
}

/** Encode mono 16-bit PCM as Ogg Vorbis. */
export async function encodeOggVorbis(samples, sampleRate, vbrQuality = OGG_VBR_QUALITY) {
  const encoder = await createEncoder(OGG_MIME_TYPE, await resolveOggWasm());
  encoder.configure({ channels: 1, sampleRate, vbrQuality });

  const chunks = [];
  let total = 0;
  const collect = (chunk) => {
    if (!chunk?.length) return;
    // The encoder reuses its output buffer, so each chunk must be copied out.
    chunks.push(chunk.slice());
    total += chunk.length;
  };

  const float = new Float32Array(Math.min(ENCODE_BLOCK, samples.length || 1));
  for (let i = 0; i < samples.length; i += ENCODE_BLOCK) {
    const size = Math.min(ENCODE_BLOCK, samples.length - i);
    for (let j = 0; j < size; j++) float[j] = samples[i + j] / 32768;
    collect(encoder.encode([float.subarray(0, size)]));
  }
  collect(encoder.finalize());

  if (!total) throw new Error("Ogg encoder produced no output.");

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function isOgg(bytes) {
  return bytes?.length >= 4
    && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53; // "OggS"
}

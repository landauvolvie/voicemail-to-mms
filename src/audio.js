import lamejs from "@breezystack/lamejs";

// Two constraints pull in opposite directions and, so far, admit no overlap:
//
//   - `sendMMS` refuses WAV with `invalid_media`. Confirmed across a media
//     URL, base64, multipart, a data: URL, and a canonical mono 16-bit PCM
//     file served from a clean extension-terminated URL with a content length.
//   - The receiving carrier drops MP3. Confirmed both through this Worker and
//     by sending the same file by hand from the VoIP.ms portal.
//
// So MP3 is accepted by the API and then vanishes, which is worse than a
// refusal: sendMMS reports success, no fallback fires, and nothing arrives.
// The default therefore offers WAV only — if VoIP.ms refuses it the Worker
// falls back to an SMS carrying a link that actually plays. Add "mp3" to
// `MMS_MEDIA_FORMATS` if the carrier ever starts accepting it.
export const DEFAULT_MMS_FORMATS = ["wav"];
export const MP3_BITRATE_KBPS = 32;
export const MP3_MIME_TYPE = "audio/mpeg";
export const WAV_MIME_TYPE = "audio/wav";

// 16-bit 8 kHz PCM runs 16 KB per second, so a long voicemail outgrows what
// carriers carry as MMS. Past this the WAV candidate is dropped and MP3 ships.
export const MAX_WAV_MMS_BYTES = 700_000;

// MPEG-2.5 MP3 (8/11.025/12 kHz) is decoded inconsistently by handset MMS
// players, so anything recorded below 16 kHz is upsampled to an MPEG-2 rate.
const MIN_MP3_SAMPLE_RATE = 16000;
const LAME_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
const MP3_ENCODE_BLOCK = 1152;

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_ALAW = 0x0006;
const WAVE_FORMAT_MULAW = 0x0007;
const WAVE_FORMAT_GSM610 = 0x0031;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

const FORMAT_NAMES = {
  [WAVE_FORMAT_PCM]: "PCM",
  [WAVE_FORMAT_IEEE_FLOAT]: "IEEE float",
  [WAVE_FORMAT_ALAW]: "A-law",
  [WAVE_FORMAT_MULAW]: "mu-law",
  [WAVE_FORMAT_GSM610]: "GSM 6.10 (wav49)",
};

export function isMp3(bytes) {
  const data = asBytes(bytes);
  if (data.length < 3) return false;
  if (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) return true; // "ID3"
  return data[0] === 0xff && (data[1] & 0xe0) === 0xe0;
}

export function isRiffWave(bytes) {
  const data = asBytes(bytes);
  if (data.length < 12) return false;
  return readAscii(data, 0, 4) === "RIFF" && readAscii(data, 8, 4) === "WAVE";
}

export function parseWav(bytes) {
  const data = asBytes(bytes);
  if (!isRiffWave(data)) throw new Error("Attachment is not a RIFF/WAVE file.");

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let format = null;
  let audio = null;
  let offset = 12;

  while (offset + 8 <= data.length) {
    const id = readAscii(data, offset, 4);
    const declared = view.getUint32(offset + 4, true);
    const body = offset + 8;
    // Asterisk streams voicemail WAVs and can leave placeholder chunk sizes
    // behind, so never trust a declared size past the end of the buffer.
    const size = Math.min(declared, data.length - body);

    if (id === "fmt " && size >= 16) {
      let formatTag = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bitsPerSample = view.getUint16(body + 14, true);
      if (formatTag === WAVE_FORMAT_EXTENSIBLE && size >= 26) {
        formatTag = view.getUint16(body + 24, true);
      }
      format = { formatTag, channels, sampleRate, bitsPerSample };
    } else if (id === "data") {
      audio = data.subarray(body, body + size);
    }

    offset = body + size + (size % 2); // chunks are word aligned
  }

  if (!format) throw new Error("WAV file has no fmt chunk.");
  if (!audio || !audio.length) throw new Error("WAV file has no audio data.");
  if (!format.channels || !format.sampleRate) throw new Error("WAV file has an unusable fmt chunk.");

  return { ...format, data: audio };
}

export function decodeWavToMonoPcm16(bytes) {
  const wav = parseWav(bytes);
  const frames = decodeSamples(wav);
  const mono = downmixToMono(frames, wav.channels);
  if (!mono.length) throw new Error("WAV file decoded to zero audio samples.");
  return { samples: mono, sampleRate: wav.sampleRate, channels: wav.channels, formatTag: wav.formatTag };
}

export function chooseMp3SampleRate(sourceRate) {
  const wanted = Math.max(Number(sourceRate) || 0, MIN_MP3_SAMPLE_RATE);
  for (const rate of LAME_SAMPLE_RATES) {
    if (rate >= wanted) return rate;
  }
  return LAME_SAMPLE_RATES[LAME_SAMPLE_RATES.length - 1];
}

export function resamplePcm16(samples, inputRate, outputRate) {
  if (!samples.length || inputRate === outputRate) return samples;
  const ratio = outputRate / inputRate;
  const length = Math.max(1, Math.round(samples.length * ratio));
  const output = new Int16Array(length);

  for (let i = 0; i < length; i++) {
    const position = i / ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const weight = position - left;
    output[i] = clampPcm16(samples[left] * (1 - weight) + samples[right] * weight);
  }

  return output;
}

export function encodeMonoPcm16ToMp3(samples, sampleRate, bitrateKbps = MP3_BITRATE_KBPS) {
  const encoder = new lamejs.Mp3Encoder(1, sampleRate, bitrateKbps);
  const chunks = [];
  let total = 0;

  for (let i = 0; i < samples.length; i += MP3_ENCODE_BLOCK) {
    const block = samples.subarray(i, Math.min(i + MP3_ENCODE_BLOCK, samples.length));
    const encoded = encoder.encodeBuffer(block);
    if (encoded?.length) {
      chunks.push(encoded);
      total += encoded.length;
    }
  }

  const tail = encoder.flush();
  if (tail?.length) {
    chunks.push(tail);
    total += tail.length;
  }

  if (!total) throw new Error("MP3 encoder produced no output.");

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export function transcodeWavToMp3(bytes, bitrateKbps = MP3_BITRATE_KBPS) {
  const decoded = decodeWavToMonoPcm16(bytes);
  const sampleRate = chooseMp3SampleRate(decoded.sampleRate);
  const samples = resamplePcm16(decoded.samples, decoded.sampleRate, sampleRate);
  const mp3 = encodeMonoPcm16ToMp3(samples, sampleRate, bitrateKbps);

  return {
    bytes: mp3,
    sampleRate,
    bitrateKbps,
    sourceSampleRate: decoded.sampleRate,
    sourceChannels: decoded.channels,
    durationSeconds: Math.round((decoded.samples.length / decoded.sampleRate) * 100) / 100,
  };
}

/** Write mono samples as an 8-bit mu-law RIFF/WAVE file (telephony's own WAV). */
export function encodeWavMulaw(samples, sampleRate) {
  const out = new Uint8Array(58 + samples.length);
  const view = new DataView(out.buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };

  ascii(0, "RIFF");
  view.setUint32(4, 50 + samples.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 18, true); // mu-law needs the extended fmt chunk
  view.setUint16(20, WAVE_FORMAT_MULAW, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  view.setUint16(36, 0, true);
  ascii(38, "fact");
  view.setUint32(42, 4, true);
  view.setUint32(46, samples.length, true);
  ascii(50, "data");
  view.setUint32(54, samples.length, true);
  for (let i = 0; i < samples.length; i++) out[58 + i] = pcm16ToMuLaw(samples[i]);

  return out;
}

/** Write interleaved PCM samples as a canonical 44-byte-header RIFF/WAVE file. */
export function encodeWav(samples, sampleRate, channels = 1) {
  const dataBytes = samples.length * 2;
  const blockAlign = channels * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, WAVE_FORMAT_PCM, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);

  return out;
}

export function parseMmsFormats(value) {
  const requested = String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item === "wav" || item === "mp3");
  return requested.length ? [...new Set(requested)] : DEFAULT_MMS_FORMATS;
}

/**
 * Build the ordered list of media the Worker will offer VoIP.ms.
 *
 * An MP3 attachment can only ship as MP3 — the Worker has no MP3 decoder, so
 * there is nothing to re-encode a WAV candidate from. A WAV attachment yields
 * whichever of the requested formats it can.
 */
export function buildMmsCandidates(bytes, formats = DEFAULT_MMS_FORMATS) {
  const data = asBytes(bytes);

  if (isMp3(data)) {
    return {
      sourceBytes: data.byteLength,
      candidates: [{
        format: "mp3",
        bytes: data,
        mimeType: MP3_MIME_TYPE,
        extension: "mp3",
        transcoded: false,
      }],
    };
  }

  if (!isRiffWave(data)) {
    return { sourceBytes: data.byteLength, candidates: [], reason: "unrecognized_audio_container" };
  }

  const decoded = decodeWavToMonoPcm16(data);
  const durationSeconds = Math.round((decoded.samples.length / decoded.sampleRate) * 100) / 100;
  const candidates = [];

  for (const format of formats) {
    if (format === "wav") {
      // Re-encoded rather than forwarded so the header is canonical and the
      // audio is mono, whatever shape the mailbox wrote.
      const wav = encodeWav(decoded.samples, decoded.sampleRate);
      if (wav.byteLength > MAX_WAV_MMS_BYTES) continue;
      candidates.push({
        format: "wav",
        bytes: wav,
        mimeType: WAV_MIME_TYPE,
        extension: "wav",
        transcoded: true,
        sampleRate: decoded.sampleRate,
      });
    } else if (format === "mp3") {
      const sampleRate = chooseMp3SampleRate(decoded.sampleRate);
      const samples = resamplePcm16(decoded.samples, decoded.sampleRate, sampleRate);
      candidates.push({
        format: "mp3",
        bytes: encodeMonoPcm16ToMp3(samples, sampleRate, MP3_BITRATE_KBPS),
        mimeType: MP3_MIME_TYPE,
        extension: "mp3",
        transcoded: true,
        sampleRate,
        bitrateKbps: MP3_BITRATE_KBPS,
      });
    }
  }

  return {
    sourceBytes: data.byteLength,
    sourceSampleRate: decoded.sampleRate,
    durationSeconds,
    candidates,
    reason: candidates.length ? "" : "no_deliverable_format",
  };
}

function decodeSamples(wav) {
  const { formatTag, bitsPerSample, data } = wav;

  if (formatTag === WAVE_FORMAT_PCM && bitsPerSample === 16) {
    const count = data.length >> 1;
    // The data chunk is rarely 2-byte aligned inside the RIFF buffer, so read
    // through a DataView rather than casting to Int16Array.
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const out = new Int16Array(count);
    for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true);
    return out;
  }

  if (formatTag === WAVE_FORMAT_PCM && bitsPerSample === 8) {
    const out = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = (data[i] - 128) << 8;
    return out;
  }

  if (formatTag === WAVE_FORMAT_MULAW) {
    const out = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = muLawToPcm16(data[i]);
    return out;
  }

  if (formatTag === WAVE_FORMAT_ALAW) {
    const out = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = aLawToPcm16(data[i]);
    return out;
  }

  if (formatTag === WAVE_FORMAT_IEEE_FLOAT && bitsPerSample === 32) {
    const count = data.length >> 2;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const out = new Int16Array(count);
    for (let i = 0; i < count; i++) out[i] = clampPcm16(view.getFloat32(i * 4, true) * 32767);
    return out;
  }

  const name = FORMAT_NAMES[formatTag] || `format 0x${formatTag.toString(16)}`;
  const hint = formatTag === WAVE_FORMAT_GSM610
    ? " Set the VoIP.ms mailbox attachment format to MP3 or WAV instead of WAV49."
    : "";
  throw new Error(`Unsupported WAV encoding: ${name} at ${bitsPerSample} bits.${hint}`);
}

function downmixToMono(samples, channels) {
  if (channels <= 1) return samples;
  const frames = Math.floor(samples.length / channels);
  const out = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) sum += samples[frame * channels + channel];
    out[frame] = clampPcm16(sum / channels);
  }
  return out;
}

function pcm16ToMuLaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let value = Math.max(-CLIP, Math.min(CLIP, sample));
  const sign = value < 0 ? 0x80 : 0;
  if (value < 0) value = -value;
  value += BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (value >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function muLawToPcm16(value) {
  const u = ~value & 0xff;
  let t = ((u & 0x0f) << 3) + 0x84;
  t <<= (u & 0x70) >> 4;
  return clampPcm16((u & 0x80) ? 0x84 - t : t - 0x84);
}

function aLawToPcm16(value) {
  const a = value ^ 0x55;
  let t = (a & 0x0f) << 4;
  const segment = (a & 0x70) >> 4;
  if (segment === 0) t += 8;
  else if (segment === 1) t += 0x108;
  else t = (t + 0x108) << (segment - 1);
  return clampPcm16((a & 0x80) ? t : -t);
}

function clampPcm16(value) {
  const rounded = Math.round(value);
  if (rounded > 32767) return 32767;
  if (rounded < -32768) return -32768;
  return rounded;
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error("Expected binary audio data.");
}

function readAscii(bytes, offset, length) {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

import lamejs from "@breezystack/lamejs";

// VoIP.ms accepts MP3 as MMS media. WAV attachments (what Asterisk voicemail
// produces by default) are rejected by the sendMMS media validator with
// `invalid_media`, so every recording is transcoded to MP3 before delivery.
export const MP3_BITRATE_KBPS = 32;
export const MP3_MIME_TYPE = "audio/mpeg";

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

/**
 * Normalize a voicemail attachment into MMS-deliverable media.
 *
 * MP3 passes straight through. WAV (PCM, A-law or mu-law) is transcoded.
 * Anything else is returned untouched so the caller can fall back to SMS.
 */
export function prepareMmsAudio(bytes, bitrateKbps = MP3_BITRATE_KBPS) {
  const data = asBytes(bytes);

  if (isMp3(data)) {
    return {
      bytes: data,
      mimeType: MP3_MIME_TYPE,
      extension: "mp3",
      transcoded: false,
      deliverable: true,
      sourceBytes: data.byteLength,
    };
  }

  if (!isRiffWave(data)) {
    return {
      bytes: data,
      mimeType: "application/octet-stream",
      extension: "bin",
      transcoded: false,
      deliverable: false,
      sourceBytes: data.byteLength,
      reason: "unrecognized_audio_container",
    };
  }

  const result = transcodeWavToMp3(data, bitrateKbps);
  return {
    bytes: result.bytes,
    mimeType: MP3_MIME_TYPE,
    extension: "mp3",
    transcoded: true,
    deliverable: true,
    sourceBytes: data.byteLength,
    sampleRate: result.sampleRate,
    sourceSampleRate: result.sourceSampleRate,
    bitrateKbps: result.bitrateKbps,
    durationSeconds: result.durationSeconds,
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

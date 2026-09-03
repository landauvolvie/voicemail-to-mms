import {
  MP3_BITRATE_KBPS,
  MP3_MIME_TYPE,
  WAV_MIME_TYPE,
  encodeMonoPcm16ToMp3,
  encodeWav,
  encodeWavMulaw,
  resamplePcm16,
} from "./audio.js";

/**
 * Media variants for the sendMMS format probe.
 *
 * `sendMMS` refuses the 8 kHz mono PCM WAV that voicemail produces, but its
 * published list of permitted attachments does include WAV, so the refusal may
 * turn on the encoding rather than the container. These variants exist to find
 * out in one batch instead of one voicemail at a time. Each is sent as a real
 * MMS, so the probe is behind a key and never runs on its own.
 */
export const PROBE_VARIANTS = [
  "wav-8k-pcm16",
  "wav-16k-pcm16",
  "wav-22k-pcm16",
  "wav-44k-pcm16",
  "wav-44k-stereo",
  "wav-8k-mulaw",
  "mp3-16k",
];

export function parseProbeVariants(value) {
  const requested = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => PROBE_VARIANTS.includes(item));
  return requested.length ? [...new Set(requested)] : PROBE_VARIANTS;
}

/** A short two-tone chirp — recognisable on arrival, small in every encoding. */
export function probeTone(seconds = 2, sampleRate = 8000) {
  const samples = new Int16Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    const frequency = t < seconds / 2 ? 660 : 440;
    const envelope = Math.min(1, 8 * Math.min(t, seconds - t));
    samples[i] = Math.round(Math.sin(2 * Math.PI * frequency * t) * 11000 * envelope);
  }
  return samples;
}

export function buildProbeMedia(name, seconds = 2) {
  const base = probeTone(seconds, 8000);
  const at = (rate) => resamplePcm16(base, 8000, rate);

  switch (name) {
    case "wav-8k-pcm16":
      return wav(encodeWav(base, 8000));
    case "wav-16k-pcm16":
      return wav(encodeWav(at(16000), 16000));
    case "wav-22k-pcm16":
      return wav(encodeWav(at(22050), 22050));
    case "wav-44k-pcm16":
      return wav(encodeWav(at(44100), 44100));
    case "wav-44k-stereo":
      return wav(encodeWav(duplicateToStereo(at(44100)), 44100, 2));
    case "wav-8k-mulaw":
      return wav(encodeWavMulaw(base, 8000));
    case "mp3-16k":
      return {
        bytes: encodeMonoPcm16ToMp3(at(16000), 16000, MP3_BITRATE_KBPS),
        extension: "mp3",
        mimeType: MP3_MIME_TYPE,
      };
    default:
      throw new Error(`Unknown probe variant: ${name}`);
  }
}

function wav(bytes) {
  return { bytes, extension: "wav", mimeType: WAV_MIME_TYPE };
}

function duplicateToStereo(samples) {
  const out = new Int16Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    out[i * 2] = samples[i];
    out[i * 2 + 1] = samples[i];
  }
  return out;
}

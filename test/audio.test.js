import test from "node:test";
import assert from "node:assert/strict";
import {
  MP3_MIME_TYPE,
  chooseMp3SampleRate,
  decodeWavToMonoPcm16,
  isMp3,
  isRiffWave,
  parseWav,
  prepareMmsAudio,
  resamplePcm16,
  transcodeWavToMp3,
} from "../src/audio.js";

const MPEG_VERSIONS = { 0: 2.5, 2: 2, 3: 1 };
const SAMPLE_RATE_TABLE = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  2.5: [11025, 12000, 8000],
};

/** Build a RIFF/WAVE file the way Asterisk voicemail does: mono, 16-bit PCM. */
function buildWav(samples, { sampleRate = 8000, channels = 1, bitsPerSample = 16, formatTag = 1 } = {}) {
  const bytesPerSample = bitsPerSample / 8;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, formatTag, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, (sampleRate * channels * bitsPerSample) / 8, true);
  view.setUint16(32, (channels * bitsPerSample) / 8, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    if (bitsPerSample === 16) view.setInt16(44 + i * 2, samples[i], true);
    else bytes[44 + i] = samples[i];
  }

  return bytes;
}

function tone(seconds, sampleRate = 8000, frequency = 440) {
  const samples = new Int16Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 12000);
  }
  return samples;
}

/** Walk the MP3 frame headers so we assert on real decodable audio, not just bytes. */
function describeMp3(bytes) {
  let offset = 0;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    offset = 10 + size;
  }

  let frames = 0;
  let sampleRate = 0;
  let version = 0;
  let samples = 0;

  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) {
      offset += 1;
      continue;
    }

    const versionBits = (bytes[offset + 1] >> 3) & 0x03;
    const layerBits = (bytes[offset + 1] >> 1) & 0x03;
    const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
    const rateIndex = (bytes[offset + 2] >> 2) & 0x03;
    const padding = (bytes[offset + 2] >> 1) & 0x01;

    const mpeg = MPEG_VERSIONS[versionBits];
    if (!mpeg || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
      offset += 1;
      continue;
    }

    const rate = SAMPLE_RATE_TABLE[mpeg][rateIndex];
    const bitrate = mpegBitrate(mpeg, bitrateIndex);
    const samplesPerFrame = mpeg === 1 ? 1152 : 576;
    const frameLength = Math.floor((samplesPerFrame / 8) * bitrate * 1000 / rate) + padding;
    if (frameLength < 4) break;

    frames += 1;
    samples += samplesPerFrame;
    sampleRate = rate;
    version = mpeg;
    offset += frameLength;
  }

  return { frames, sampleRate, version, durationSeconds: sampleRate ? samples / sampleRate : 0 };
}

function mpegBitrate(version, index) {
  const v1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const v2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  return version === 1 ? v1[index] : v2[index];
}

test("recognizes WAV and MP3 containers", () => {
  assert.equal(isRiffWave(buildWav(tone(0.1))), true);
  assert.equal(isMp3(buildWav(tone(0.1))), false);
  assert.equal(isMp3(new Uint8Array([0xff, 0xfb, 0x90, 0x00])), true);
  assert.equal(isMp3(new Uint8Array([0x49, 0x44, 0x33, 0x03])), true);
});

test("parses an Asterisk-shaped mono 8 kHz WAV", () => {
  const wav = parseWav(buildWav(tone(0.5)));
  assert.equal(wav.formatTag, 1);
  assert.equal(wav.channels, 1);
  assert.equal(wav.sampleRate, 8000);
  assert.equal(wav.bitsPerSample, 16);
  assert.equal(wav.data.length, 8000);
});

test("tolerates a truncated data chunk size written by a streaming recorder", () => {
  const bytes = buildWav(tone(0.5));
  new DataView(bytes.buffer).setUint32(40, 0xffffffff, true); // placeholder data size
  const decoded = decodeWavToMonoPcm16(bytes);
  assert.equal(decoded.sampleRate, 8000);
  assert.equal(decoded.samples.length, 4000);
});

test("downmixes stereo to mono", () => {
  const interleaved = new Int16Array([100, 300, -200, -400]);
  const decoded = decodeWavToMonoPcm16(buildWav(interleaved, { channels: 2 }));
  assert.deepEqual([...decoded.samples], [200, -300]);
});

test("decodes mu-law voicemail audio", () => {
  const decoded = decodeWavToMonoPcm16(buildWav(new Uint8Array([0xff, 0x7f]), { formatTag: 7, bitsPerSample: 8 }));
  assert.equal(decoded.samples.length, 2);
  assert.equal(decoded.samples[0], 0);
  assert.equal(decoded.samples[1], 0);
});

test("rejects GSM 6.10 wav49 with an actionable message", () => {
  assert.throws(
    () => decodeWavToMonoPcm16(buildWav(new Uint8Array(66), { formatTag: 0x31, bitsPerSample: 8 })),
    /wav49[\s\S]*attachment format/i,
  );
});

test("keeps MP3 output above the MPEG-2.5 sample rates", () => {
  assert.equal(chooseMp3SampleRate(8000), 16000);
  assert.equal(chooseMp3SampleRate(11025), 16000);
  assert.equal(chooseMp3SampleRate(16000), 16000);
  assert.equal(chooseMp3SampleRate(44100), 44100);
  assert.equal(chooseMp3SampleRate(96000), 48000);
});

test("resamples without changing duration", () => {
  const samples = tone(1, 8000);
  const resampled = resamplePcm16(samples, 8000, 16000);
  assert.equal(resampled.length, 16000);
  assert.equal(resamplePcm16(samples, 8000, 8000), samples);
});

test("transcodes an 8 kHz WAV voicemail into a decodable MP3", () => {
  const result = transcodeWavToMp3(buildWav(tone(3)));

  assert.equal(result.sourceSampleRate, 8000);
  assert.equal(result.sampleRate, 16000);
  assert.equal(result.durationSeconds, 3);
  assert.ok(result.bytes.byteLength > 1000, "MP3 output should not be empty");
  assert.ok(isMp3(result.bytes), "output should start with an MP3 frame");

  const mp3 = describeMp3(result.bytes);
  assert.equal(mp3.sampleRate, 16000);
  assert.equal(mp3.version, 2, "16 kHz mono should encode as MPEG-2 Layer III");
  assert.ok(mp3.frames > 50, `expected many frames, got ${mp3.frames}`);
  assert.ok(Math.abs(mp3.durationSeconds - 3) < 0.2, `unexpected duration ${mp3.durationSeconds}`);
});

test("prepareMmsAudio converts WAV and passes MP3 through", () => {
  const wav = prepareMmsAudio(buildWav(tone(1)));
  assert.equal(wav.transcoded, true);
  assert.equal(wav.deliverable, true);
  assert.equal(wav.mimeType, MP3_MIME_TYPE);
  assert.equal(wav.extension, "mp3");
  assert.ok(wav.bytes.byteLength < wav.sourceBytes, "MP3 should be smaller than 16-bit PCM");

  const alreadyMp3 = prepareMmsAudio(wav.bytes);
  assert.equal(alreadyMp3.transcoded, false);
  assert.equal(alreadyMp3.deliverable, true);
  assert.equal(alreadyMp3.bytes, wav.bytes);
});

test("prepareMmsAudio flags containers it cannot deliver", () => {
  const result = prepareMmsAudio(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]));
  assert.equal(result.deliverable, false);
  assert.equal(result.reason, "unrecognized_audio_container");
});

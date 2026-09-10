import test from "node:test";
import assert from "node:assert/strict";
import { AMR_FRAME_SAMPLES, AMR_MODE_MR122, AMR_SAMPLE_RATE, encodeAmrFrames } from "../src/amr.js";
import { muxAmrToIsoBmff } from "../src/mp4.js";

function tone(seconds, sampleRate = AMR_SAMPLE_RATE, frequency = 440) {
  const samples = new Int16Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 11000);
  }
  return samples;
}

/** Walk the ISO base media box tree so assertions run against the real file. */
function parseBoxes(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = [];
  let offset = start;

  while (offset + 8 <= end) {
    const size = view.getUint32(offset, false);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (size < 8 || offset + size > end) break;
    boxes.push({ type, start: offset, size, body: offset + 8, bodyEnd: offset + size });
    offset += size;
  }
  return boxes;
}

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "dinf"]);

function findBox(bytes, path, start = 0, end = bytes.length) {
  const [head, ...rest] = path;
  const box = parseBoxes(bytes, start, end).find((b) => b.type === head);
  assert.ok(box, `missing box ${head}`);
  if (!rest.length) return box;
  return findBox(bytes, rest, box.body, box.bodyEnd);
}

function u32At(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

test("encodes AMR-NB frames of the expected size and count", () => {
  const amr = encodeAmrFrames(tone(2));

  assert.equal(amr.mode, AMR_MODE_MR122);
  assert.equal(amr.frameBytes, 32, "MR122 is 31 payload bytes plus a TOC byte");
  assert.equal(amr.frameCount, 100, "2 seconds is 100 frames of 20 ms");
  assert.equal(amr.frames.length, 3200);

  // The TOC byte carries the mode in bits 3..6, so a correct stream repeats it.
  for (let i = 0; i < amr.frameCount; i++) {
    assert.equal((amr.frames[i * amr.frameBytes] >> 3) & 0x0f, AMR_MODE_MR122, `frame ${i} mode`);
  }
});

test("pads rather than dropping the last partial frame", () => {
  // 2.5 frames of audio must not silently lose the trailing half frame.
  const amr = encodeAmrFrames(tone((AMR_FRAME_SAMPLES * 2.5) / AMR_SAMPLE_RATE));
  assert.equal(amr.frameCount, 3);
});

test("round-trips through a real AMR decoder without losing audio", async () => {
  const { default: AMR } = await import("../vendor/amrnb.cjs");
  const source = tone(2);
  const amr = encodeAmrFrames(source);

  // Rebuild a .amr file from the frames the muxer would store and decode it.
  const file = new Uint8Array(6 + amr.frames.length);
  file.set([0x23, 0x21, 0x41, 0x4d, 0x52, 0x0a]); // "#!AMR\n"
  file.set(amr.frames, 6);
  const wav = AMR.toWAV(file);
  assert.ok(wav, "the encoded frames must decode");

  const decoded = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) >> 1);
  assert.equal(decoded.length, source.length, "no audio may be dropped or padded away");

  // AMR is lossy and models speech rather than waveforms, so compare energy
  // rather than samples — garbage output would not hold the level.
  const rms = (data) => {
    let sum = 0;
    for (const value of data) sum += value * value;
    return Math.sqrt(sum / data.length);
  };
  const ratio = rms(decoded) / rms(source);
  assert.ok(ratio > 0.7 && ratio < 1.3, `decoded level should track the source, got ${ratio.toFixed(2)}`);
});

test("muxes AMR into a 3GP file whose sample table matches the audio", () => {
  const amr = encodeAmrFrames(tone(3));
  const { bytes, mimeType, extension, durationSeconds } = muxAmrToIsoBmff(amr, { brand: "3gp" });

  assert.equal(mimeType, "audio/3gpp");
  assert.equal(extension, "3gp");
  assert.equal(durationSeconds, 3);

  // Top level is exactly ftyp, moov, mdat and nothing trails off the end.
  const top = parseBoxes(bytes);
  assert.deepEqual(top.map((b) => b.type), ["ftyp", "moov", "mdat"]);
  assert.equal(top.at(-1).bodyEnd, bytes.length, "boxes must span the whole file");
  assert.equal(String.fromCharCode(...bytes.subarray(8, 12)), "3gp4", "major brand");

  // The media handler must be audio at the AMR sample rate.
  const mdhd = findBox(bytes, ["moov", "trak", "mdia", "mdhd"]);
  assert.equal(u32At(bytes, mdhd.body + 12), AMR_SAMPLE_RATE, "mdhd timescale");
  assert.equal(u32At(bytes, mdhd.body + 16), amr.frameCount * AMR_FRAME_SAMPLES, "mdhd duration");
  const hdlr = findBox(bytes, ["moov", "trak", "mdia", "hdlr"]);
  assert.equal(String.fromCharCode(...bytes.subarray(hdlr.body + 8, hdlr.body + 12)), "soun");

  // The sample description must declare AMR with a damr box.
  const stsd = findBox(bytes, ["moov", "trak", "mdia", "minf", "stbl", "stsd"]);
  const samr = parseBoxes(bytes, stsd.body + 8, stsd.bodyEnd)[0];
  assert.equal(samr.type, "samr");
  const damr = parseBoxes(bytes, samr.body + 28, samr.bodyEnd)[0];
  assert.equal(damr.type, "damr", "AMR needs its decoder-config box");
  assert.equal(bytes[damr.body + 5] << 8 | bytes[damr.body + 6], 1 << AMR_MODE_MR122, "mode_set");
  assert.equal(bytes[damr.body + 8], 1, "frames_per_sample");

  // Timing, sizing and offsets must all agree with the frames in mdat.
  const stts = findBox(bytes, ["moov", "trak", "mdia", "minf", "stbl", "stts"]);
  assert.equal(u32At(bytes, stts.body + 8), amr.frameCount, "stts sample count");
  assert.equal(u32At(bytes, stts.body + 12), AMR_FRAME_SAMPLES, "stts sample delta");

  const stsz = findBox(bytes, ["moov", "trak", "mdia", "minf", "stbl", "stsz"]);
  assert.equal(u32At(bytes, stsz.body + 4), amr.frameBytes, "stsz fixed sample size");
  assert.equal(u32At(bytes, stsz.body + 8), amr.frameCount, "stsz sample count");

  // The chunk offset must land exactly on the first byte of audio.
  const stco = findBox(bytes, ["moov", "trak", "mdia", "minf", "stbl", "stco"]);
  const mediaOffset = u32At(bytes, stco.body + 8);
  const mdat = top.at(-1);
  assert.equal(mediaOffset, mdat.body, "stco must point at the mdat payload");
  assert.deepEqual(bytes.subarray(mediaOffset, mediaOffset + amr.frames.length), amr.frames);
  assert.equal(mdat.bodyEnd - mdat.body, amr.frames.length, "mdat holds exactly the frames");
});

test("offers the same audio as .mp4 with an MP4 brand and type", () => {
  const amr = encodeAmrFrames(tone(1));
  const threegp = muxAmrToIsoBmff(amr, { brand: "3gp" });
  const mp4 = muxAmrToIsoBmff(amr, { brand: "mp4" });

  assert.equal(mp4.mimeType, "audio/mp4");
  assert.equal(mp4.extension, "mp4");
  assert.ok(
    String.fromCharCode(...mp4.bytes.subarray(16, 40)).includes("mp42"),
    "the .mp4 variant should advertise an MP4 compatible brand",
  );

  // Same audio either way: the mdat payloads must be byte-identical.
  const mdatOf = (bytes) => {
    const box = parseBoxes(bytes).at(-1);
    return bytes.subarray(box.body, box.bodyEnd);
  };
  assert.deepEqual(mdatOf(mp4.bytes), mdatOf(threegp.bytes));
});

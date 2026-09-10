import { AMR_FRAME_SAMPLES } from "./amr.js";

export const THREEGP_MIME_TYPE = "audio/3gpp";
export const MP4_MIME_TYPE = "audio/mp4";

const MOVIE_TIMESCALE = 1000;
const LANGUAGE_UND = 0x55c4; // "und", ISO-639-2/T packed as three 5-bit letters
const IDENTITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

/**
 * Wrap AMR-NB frames in an ISO base media container.
 *
 * `3gp` and `mp4` are both on the VoIP.ms attachment whitelist and the file
 * is the same either way — only the brand list, the extension and the MIME
 * type differ — so offering both probes the two whitelist entries for the
 * price of one encode.
 */
export function muxAmrToIsoBmff(amr, { brand = "3gp" } = {}) {
  const isMp4 = brand === "mp4";
  const compatible = isMp4 ? ["3gp4", "isom", "mp41", "mp42"] : ["3gp4", "3gp5", "isom"];
  const ftyp = box("ftyp", ascii("3gp4"), u32(0x200), ...compatible.map(ascii));

  const durationTicks = amr.frameCount * AMR_FRAME_SAMPLES; // in the media timescale
  const movieDuration = Math.round((durationTicks / amr.sampleRate) * MOVIE_TIMESCALE);

  // The sample table records where the audio starts, which depends on how big
  // the header is. The offset field is a fixed four bytes, so building the
  // header once with a placeholder measures it exactly.
  const measure = buildMoov(amr, durationTicks, movieDuration, 0);
  const mediaOffset = ftyp.length + measure.length + 8; // 8 = the mdat box header
  const moov = buildMoov(amr, durationTicks, movieDuration, mediaOffset);

  return {
    bytes: concat(ftyp, moov, box("mdat", amr.frames)),
    mimeType: isMp4 ? MP4_MIME_TYPE : THREEGP_MIME_TYPE,
    extension: isMp4 ? "mp4" : "3gp",
    durationSeconds: Math.round((durationTicks / amr.sampleRate) * 100) / 100,
  };
}

function buildMoov(amr, durationTicks, movieDuration, mediaOffset) {
  const mvhd = box("mvhd",
    u32(0), u32(0), u32(0), // version/flags, created, modified
    u32(MOVIE_TIMESCALE), u32(movieDuration),
    u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), // rate, volume, reserved
    ...IDENTITY_MATRIX.map(u32),
    ...Array.from({ length: 6 }, () => u32(0)), // pre_defined
    u32(2), // next_track_ID
  );

  const tkhd = box("tkhd",
    u32(0x00000007), u32(0), u32(0), // version 0, enabled | in movie | in preview
    u32(1), u32(0), u32(movieDuration), // track_ID, reserved, duration
    u32(0), u32(0), u16(0), u16(0), u16(0x0100), u16(0), // layer, alt group, volume
    ...IDENTITY_MATRIX.map(u32),
    u32(0), u32(0), // width and height, zero for audio
  );

  const mdhd = box("mdhd",
    u32(0), u32(0), u32(0),
    u32(amr.sampleRate), u32(durationTicks),
    u16(LANGUAGE_UND), u16(0),
  );

  const hdlr = box("hdlr",
    u32(0), u32(0), ascii("soun"),
    u32(0), u32(0), u32(0),
    new Uint8Array([...ascii("SoundHandler"), 0]),
  );

  const dref = box("dref", u32(0), u32(1), box("url ", u32(1))); // flag 1: media is in this file
  const minf = box("minf",
    box("smhd", u32(0), u16(0), u16(0)),
    box("dinf", dref),
    buildStbl(amr, mediaOffset),
  );

  return box("moov", mvhd, box("trak", tkhd, box("mdia", mdhd, hdlr, minf)));
}

function buildStbl(amr, mediaOffset) {
  const samr = box("samr",
    new Uint8Array(6), u16(1), // reserved, data_reference_index
    u32(0), u32(0), // reserved
    u16(1), u16(16), // channel count, sample size
    u16(0), u16(0), // pre_defined, reserved
    u32(amr.sampleRate << 16),
    box("damr",
      u32(0), // vendor
      new Uint8Array([0]), // decoder version
      u16(1 << amr.mode), // mode_set: only the mode actually used
      new Uint8Array([0, 1]), // mode_change_period, frames_per_sample
    ),
  );

  return box("stbl",
    box("stsd", u32(0), u32(1), samr),
    // Every AMR frame is exactly 20 ms, so one run describes the whole track.
    box("stts", u32(0), u32(1), u32(amr.frameCount), u32(AMR_FRAME_SAMPLES)),
    box("stsc", u32(0), u32(1), u32(1), u32(amr.frameCount), u32(1)),
    // Fixed mode means every frame is the same size, so no per-sample table.
    box("stsz", u32(0), u32(amr.frameBytes), u32(amr.frameCount)),
    box("stco", u32(0), u32(1), u32(mediaOffset)),
  );
}

function box(type, ...payload) {
  const body = concat(...payload);
  return concat(u32(body.length + 8), ascii(type), body);
}

function concat(...parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}

function u16(value) {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value & 0xffff, false);
  return out;
}

function ascii(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

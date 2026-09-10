import AMR from "../vendor/amrnb.cjs";

export const AMR_SAMPLE_RATE = 8000;
export const AMR_FRAME_SAMPLES = 160; // 20 ms
export const AMR_MODE_MR122 = 7; // 12.2 kbps, the best AMR-NB mode

const AMR_FILE_HEADER_BYTES = 6; // "#!AMR\n"

/**
 * Encode 8 kHz mono PCM as AMR-NB frames in storage format.
 *
 * AMR-NB is the codec MMS was specified around, so it is the audio most
 * likely to survive a carrier that drops MP3. Frames come back without the
 * "#!AMR\n" file header, which is what a 3GP sample table wants.
 */
export function encodeAmrFrames(samples, mode = AMR_MODE_MR122) {
  if (!samples.length) throw new Error("No audio to encode as AMR.");

  // The encoder stops before its final buffer, dropping the last frame even
  // when the input divides evenly. Padding with one extra frame of silence
  // costs nothing and means the frame it drops is the silent one, not the
  // last 20 ms of the caller's message.
  const frameCount = Math.ceil(samples.length / AMR_FRAME_SAMPLES);
  const padded = new Float32Array((frameCount + 1) * AMR_FRAME_SAMPLES);
  for (let i = 0; i < samples.length; i++) padded[i] = samples[i] / 32768;

  const file = AMR.encode(padded, AMR_SAMPLE_RATE, mode);
  if (!file || file.length <= AMR_FILE_HEADER_BYTES) throw new Error("AMR encoder produced no output.");

  const frames = file.subarray(AMR_FILE_HEADER_BYTES);
  const frameBytes = AMR.SIZES[mode] + 1; // payload plus the table-of-contents byte
  if (!frameBytes || frames.length % frameBytes !== 0) {
    throw new Error(`AMR output is not a whole number of ${frameBytes}-byte frames.`);
  }

  return {
    frames,
    frameBytes,
    frameCount: frames.length / frameBytes,
    mode,
    sampleRate: AMR_SAMPLE_RATE,
  };
}

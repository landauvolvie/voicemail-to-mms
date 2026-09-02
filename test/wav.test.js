import test from "node:test";
import assert from "node:assert/strict";
import { downmixToMono, encodePcm16Wav, resampleLinear } from "../src/wav.js";

test("encodePcm16Wav creates a valid mono 16-bit WAV header", () => {
  const wav = encodePcm16Wav(Float32Array.from([-1, 0, 1]), 8000);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const text = (offset, length) => String.fromCharCode(...wav.slice(offset, offset + length));

  assert.equal(text(0, 4), "RIFF");
  assert.equal(text(8, 4), "WAVE");
  assert.equal(text(12, 4), "fmt ");
  assert.equal(text(36, 4), "data");
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 8000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 6);
  assert.equal(wav.byteLength, 50);
});

test("downmixToMono averages channels", () => {
  const mono = downmixToMono([
    Float32Array.from([1, 0, -1]),
    Float32Array.from([-1, 0.5, 1]),
  ]);
  assert.deepEqual(Array.from(mono), [0, 0.25, 0]);
});

test("resampleLinear reduces sample count for telephony WAV", () => {
  const input = Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i / 10));
  const output = resampleLinear(input, 16000, 8000);
  assert.equal(output.length, 8000);
});

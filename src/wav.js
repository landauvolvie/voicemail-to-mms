import PostalMime from "postal-mime";
import { MPEGDecoder } from "mpg123-decoder";
import { bytesToBase64, findAudioAttachment, mimeFromAttachment, toUint8Array } from "./core.js";

const TARGET_SAMPLE_RATE = 8000;

export async function normalizeVoicemailEmailToWav(message) {
  const originalBytes = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const parsed = await PostalMime.parse(originalBytes);
  const audio = findAudioAttachment(parsed.attachments || []);

  if (!audio || isWavAttachment(audio)) {
    return {
      message: cloneEmailMessage(message, originalBytes),
      converted: false,
      sourceBytes: audio ? toUint8Array(audio.content).byteLength : 0,
      wavBytes: audio && isWavAttachment(audio) ? toUint8Array(audio.content).byteLength : 0,
      sampleRate: null,
    };
  }

  if (!isMp3Attachment(audio)) {
    return {
      message: cloneEmailMessage(message, originalBytes),
      converted: false,
      sourceBytes: toUint8Array(audio.content).byteLength,
      wavBytes: 0,
      sampleRate: null,
    };
  }

  const sourceBytes = toUint8Array(audio.content);
  const { bytes: wavBytes, sampleRate } = await transcodeMp3ToWav(sourceBytes);
  const filename = toWavFilename(audio.filename);
  const rebuilt = buildVoicemailMime(message, parsed, {
    filename,
    mimeType: "audio/wav",
    content: wavBytes,
  });

  return {
    message: cloneEmailMessage(message, rebuilt),
    converted: true,
    sourceBytes: sourceBytes.byteLength,
    wavBytes: wavBytes.byteLength,
    sampleRate,
  };
}

export async function transcodeMp3ToWav(mp3Bytes) {
  const decoder = new MPEGDecoder();
  await decoder.ready;

  let decoded;
  try {
    decoded = decoder.decode(mp3Bytes);
  } finally {
    decoder.free();
  }

  if (!decoded?.channelData?.length || !decoded.sampleRate) {
    throw new Error("MP3 decoder returned no audio samples");
  }

  const mono = downmixToMono(decoded.channelData);
  const resampled = resampleLinear(mono, decoded.sampleRate, TARGET_SAMPLE_RATE);
  if (!resampled.length) throw new Error("MP3 decoder returned an empty voicemail");

  return {
    bytes: encodePcm16Wav(resampled, TARGET_SAMPLE_RATE),
    sampleRate: TARGET_SAMPLE_RATE,
  };
}

export function downmixToMono(channelData) {
  const channels = (channelData || []).filter((channel) => channel?.length);
  if (!channels.length) return new Float32Array(0);
  if (channels.length === 1) return new Float32Array(channels[0]);

  const length = Math.min(...channels.map((channel) => channel.length));
  const mono = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i] || 0;
    mono[i] = sum / channels.length;
  }
  return mono;
}

export function resampleLinear(samples, sourceRate, targetRate = TARGET_SAMPLE_RATE) {
  if (!samples?.length) return new Float32Array(0);
  if (!Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isFinite(targetRate) || targetRate <= 0) {
    throw new Error("Invalid audio sample rate");
  }
  if (sourceRate === targetRate) return new Float32Array(samples);

  const outputLength = Math.max(1, Math.round(samples.length * targetRate / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / targetRate;

  for (let i = 0; i < outputLength; i++) {
    const position = i * ratio;
    const left = Math.min(samples.length - 1, Math.floor(position));
    const right = Math.min(samples.length - 1, left + 1);
    const mix = position - left;
    output[i] = samples[left] + (samples[right] - samples[left]) * mix;
  }
  return output;
}

export function encodePcm16Wav(samples, sampleRate = TARGET_SAMPLE_RATE) {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (const sample of samples) {
    const value = Math.max(-1, Math.min(1, Number(sample) || 0));
    const pcm = value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff);
    view.setInt16(offset, pcm, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

function buildVoicemailMime(message, parsed, audio) {
  const boundary = `voicemail-wav-${crypto.randomUUID()}`;
  const text = String(parsed.text || stripHtml(parsed.html || "") || "");
  const headers = [
    headerLine("From", message.headers?.get?.("from") || message.from),
    headerLine("To", message.headers?.get?.("to") || message.to),
    headerLine("Subject", message.headers?.get?.("subject") || parsed.subject || "Voicemail"),
    headerLine("Date", message.headers?.get?.("date") || parsed.date || new Date().toUTCString()),
    headerLine("Message-ID", message.headers?.get?.("message-id") || ""),
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].filter(Boolean);

  const encodedAudio = bytesToBase64(audio.content).match(/.{1,76}/g)?.join("\r\n") || "";
  const filename = escapeFilename(audio.filename || "voicemail.wav");

  const raw = [
    ...headers,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    normalizeCrlf(text),
    `--${boundary}`,
    `${headerLine("Content-Type", `${audio.mimeType || "audio/wav"}; name="${filename}"`)}`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${filename}"`,
    "",
    encodedAudio,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  return new TextEncoder().encode(raw);
}

function cloneEmailMessage(message, rawBytes) {
  return {
    from: message.from,
    to: message.to,
    headers: message.headers,
    rawSize: rawBytes.byteLength,
    raw: new Response(rawBytes).body,
    setReject: (reason) => message.setReject(reason),
  };
}

function isWavAttachment(attachment) {
  const type = mimeFromAttachment(attachment);
  const name = String(attachment?.filename || "").toLowerCase();
  return type === "audio/wav" || type === "audio/x-wav" || name.endsWith(".wav") || name.endsWith(".wav49");
}

function isMp3Attachment(attachment) {
  const type = mimeFromAttachment(attachment);
  const name = String(attachment?.filename || "").toLowerCase();
  return type === "audio/mpeg" || type === "audio/mp3" || name.endsWith(".mp3");
}

function toWavFilename(filename) {
  const name = String(filename || "voicemail.mp3").replace(/[\r\n]/g, "").trim() || "voicemail.mp3";
  return /\.[a-z0-9]+$/i.test(name) ? name.replace(/\.[a-z0-9]+$/i, ".wav") : `${name}.wav`;
}

function headerLine(name, value) {
  const clean = String(value || "").replace(/[\r\n]+/g, " ").trim();
  return clean ? `${name}: ${clean}` : "";
}

function escapeFilename(value) {
  return String(value || "voicemail.wav").replace(/["\\\r\n]/g, "_");
}

function normalizeCrlf(value) {
  return String(value || "").replace(/\r?\n/g, "\r\n");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function writeAscii(view, offset, value) {
  for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
}

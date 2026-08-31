import PostalMime from "postal-mime";

const VOIPMS_ENDPOINT = "https://voip.ms/api/v1/rest.php";
const MAX_AUDIO_BYTES = 1_150_000;

export default {
  async email(message, env) {
    try {
      requireEnv(env, [
        "VOIPMS_API_USERNAME",
        "VOIPMS_API_PASSWORD",
        "VOIPMS_DID",
        "MMS_DESTINATION",
      ]);

      const raw = await new Response(message.raw).arrayBuffer();
      const parsed = await PostalMime.parse(raw);

      const audio = (parsed.attachments || []).find((attachment) => {
        const type = (attachment.mimeType || "").toLowerCase();
        const name = (attachment.filename || "").toLowerCase();
        return (
          type.startsWith("audio/") ||
          name.endsWith(".mp3") ||
          name.endsWith(".wav") ||
          name.endsWith(".wav49")
        );
      });

      if (!audio) {
        console.log("No audio attachment found; email ignored.");
        return;
      }

      const audioBytes = toUint8Array(audio.content);
      const caller = extractCallerNumber(
        [parsed.subject, parsed.text, parsed.html].filter(Boolean).join("\n"),
        env.VOIPMS_DID,
        env.MMS_DESTINATION,
      );
      const receivedAt = formatDate(parsed.date);
      const text = caller
        ? `New voicemail from ${formatPhone(caller)} - ${receivedAt}`
        : `New voicemail - ${receivedAt}`;

      if (audioBytes.byteLength > MAX_AUDIO_BYTES) {
        console.log(`Voicemail audio is ${audioBytes.byteLength} bytes; sending SMS fallback.`);
        await callVoipMs(env, "sendSMS", {
          did: normalizePhone(env.VOIPMS_DID),
          dst: normalizePhone(env.MMS_DESTINATION),
          message: `${text}. Recording is too large for MMS.`,
        });
        return;
      }

      const mimeType = audio.mimeType || mimeFromFilename(audio.filename) || "audio/mpeg";
      const dataUrl = `data:${mimeType};base64,${bytesToBase64(audioBytes)}`;

      const result = await callVoipMs(env, "sendMMS", {
        did: normalizePhone(env.VOIPMS_DID),
        dst: normalizePhone(env.MMS_DESTINATION),
        message: text,
        media1: dataUrl,
      });

      console.log(`Voicemail MMS sent successfully. MMS ID: ${result.mms || "unknown"}`);
    } catch (error) {
      console.error("Voicemail processing failed:", error?.stack || error);
      throw error;
    }
  },

  async fetch() {
    return new Response("voicemail-to-mms worker is running", { status: 200 });
  },
};

async function callVoipMs(env, method, params = {}) {
  const body = new URLSearchParams({
    api_username: env.VOIPMS_API_USERNAME,
    api_password: env.VOIPMS_API_PASSWORD,
    method,
    content_type: "json",
    ...params,
  });

  const response = await fetch(VOIPMS_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body,
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`VoIP.ms returned a non-JSON response (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }

  if (data.status !== "success") {
    throw new Error(`VoIP.ms ${method} failed: ${data.status || "unknown_error"}`);
  }

  return data;
}

function requireEnv(env, names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(`Missing Worker secret/variable(s): ${missing.join(", ")}`);
  }
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

function extractCallerNumber(text, ownDid, destination) {
  const own = normalizePhone(ownDid);
  const dst = normalizePhone(destination);
  const matches = String(text || "").match(/(?:\+?1[ .()-]*)?(?:\d[ .()-]*){10}/g) || [];

  for (const match of matches) {
    const number = normalizePhone(match);
    if (number.length === 10 && number !== own && number !== dst) return number;
  }
  return "";
}

function formatPhone(number) {
  const n = normalizePhone(number);
  if (n.length !== 10) return number;
  return `${n.slice(0, 3)}-${n.slice(3, 6)}-${n.slice(6)}`;
}

function formatDate(dateValue) {
  const date = dateValue ? new Date(dateValue) : new Date();
  if (Number.isNaN(date.getTime())) return "time unavailable";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function toUint8Array(content) {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (ArrayBuffer.isView(content)) {
    return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  }
  throw new Error("Unsupported voicemail attachment format.");
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function mimeFromFilename(filename = "") {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav") || lower.endsWith(".wav49")) return "audio/wav";
  return "";
}

import PostalMime from "postal-mime";
import {
  MAX_MMS_AUDIO_BYTES,
  buildFallbackText,
  buildNotificationText,
  bytesToBase64,
  extensionForAttachment,
  extractCallerIdentity,
  extractVoicemailDate,
  findAudioAttachment,
  isAllowedSender,
  mimeFromAttachment,
  normalizePhone,
  safeFilenamePart,
  toUint8Array,
} from "./core.js";

const VOIPMS_ENDPOINT = "https://voip.ms/api/v1/rest.php";
const MAX_EMAIL_BYTES = 12 * 1024 * 1024;

export default {
  async email(message, env) {
    requireEnv(env, ["VOIPMS_API_USERNAME", "VOIPMS_API_PASSWORD", "VOIPMS_DID", "MMS_DESTINATION"]);

    if (!isAllowedSender(message.from, env.ALLOWED_SENDER_DOMAINS)) {
      console.warn("Rejected email from unauthorized sender domain.");
      message.setReject("Unauthorized voicemail sender");
      return;
    }

    if (message.rawSize > MAX_EMAIL_BYTES) {
      console.warn(`Rejected oversized email (${message.rawSize} bytes).`);
      message.setReject("Voicemail email too large");
      return;
    }

    const raw = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(raw);
    const textSource = [parsed.subject, parsed.text, parsed.html].filter(Boolean).join("\n");
    const identity = extractCallerIdentity(textSource, env.VOIPMS_DID, env.MMS_DESTINATION);
    const voicemailDate = extractVoicemailDate(textSource, parsed.date || message.headers.get("date"));
    const notificationText = buildNotificationText(identity, voicemailDate, env.TIME_ZONE, env.CONTACTS_JSON);
    const audio = findAudioAttachment(parsed.attachments || []);
    const eventId = await makeEventId(message, raw);

    if (await isAlreadyProcessed(env, eventId)) {
      console.log(`Voicemail ${eventId}: duplicate email ignored.`);
      return;
    }

    if (!audio) {
      console.warn(`Voicemail ${eventId}: no audio attachment found.`);
      await sendFallbackSms(env, buildFallbackText(notificationText, "missing_audio"));
      await markProcessedIfConfigured(env, eventId, "sms_missing_audio");
      return;
    }

    const audioBytes = toUint8Array(audio.content);
    const archive = await archiveVoicemailIfConfigured(env, {
      eventId,
      audioBytes,
      audio,
      identity,
      voicemailDate,
    });

    if (audioBytes.byteLength > MAX_MMS_AUDIO_BYTES) {
      const link = archive?.url;
      const fallback = link
        ? truncateForSms(`${notificationText}. Listen: ${link}`, 160)
        : buildFallbackText(notificationText, "too_large");
      console.warn(`Voicemail ${eventId}: audio too large for MMS (${audioBytes.byteLength} bytes).`);
      await sendFallbackSms(env, fallback);
      await markProcessedIfConfigured(env, eventId, "sms_too_large");
      return;
    }

    try {
      const result = await sendMms(env, notificationText, audioBytes, audio);
      console.log(`Voicemail ${eventId}: MMS sent successfully. ID: ${result.mms || result.sms || "unknown"}`);
      await markProcessedIfConfigured(env, eventId, "mms_sent");
    } catch (error) {
      console.error(`Voicemail ${eventId}: MMS failed:`, safeError(error));
      const link = archive?.url;
      const fallback = link
        ? truncateForSms(`${notificationText}. Listen: ${link}`, 160)
        : buildFallbackText(notificationText, "mms_failed");
      await sendFallbackSms(env, fallback);
      await markProcessedIfConfigured(env, eventId, "sms_fallback");
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "voicemail-to-mms",
        archiveConfigured: Boolean(env.VOICEMAIL_BUCKET),
        privateLinksConfigured: Boolean(env.VOICEMAIL_BUCKET && env.RECORDING_LINK_SECRET),
      });
    }

    if (url.pathname.startsWith("/recording/")) {
      return servePrivateRecording(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function sendMms(env, message, audioBytes, attachment) {
  const mimeType = mimeFromAttachment(attachment);
  const dataUrl = `data:${mimeType};base64,${bytesToBase64(audioBytes)}`;
  return callVoipMs(env, "sendMMS", {
    did: normalizePhone(env.VOIPMS_DID),
    dst: normalizePhone(env.MMS_DESTINATION),
    message,
    media1: dataUrl,
  });
}

async function sendFallbackSms(env, message) {
  try {
    const result = await callVoipMs(env, "sendSMS", {
      did: normalizePhone(env.VOIPMS_DID),
      dst: normalizePhone(env.MMS_DESTINATION),
      message: truncateForSms(message, 160),
    });
    console.log(`Fallback SMS sent. ID: ${result.sms || "unknown"}`);
  } catch (error) {
    console.error("Fallback SMS failed:", safeError(error));
    throw error;
  }
}

async function callVoipMs(env, method, params = {}) {
  const maxAttempts = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const form = new FormData();
      form.set("api_username", env.VOIPMS_API_USERNAME);
      form.set("api_password", env.VOIPMS_API_PASSWORD);
      form.set("method", method);
      form.set("content_type", "json");
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== "") form.set(key, String(value));
      }

      const response = await fetch(VOIPMS_ENDPOINT, { method: "POST", body: form });
      const responseText = await response.text();
      const data = parseVoipMsResponse(responseText, response.status);

      if (response.ok && data.status === "success") return data;

      const status = String(data.status || `http_${response.status}`);
      if (attempt < maxAttempts && isRetryableVoipStatus(status, response.status)) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new Error(`VoIP.ms ${method} failed: ${status}`);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableException(error)) break;
      await sleep(backoffMs(attempt));
    }
  }

  throw lastError || new Error(`VoIP.ms ${method} failed`);
}

function parseVoipMsResponse(text, httpStatus) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`VoIP.ms returned non-JSON (HTTP ${httpStatus}): ${String(text).slice(0, 200)}`);
  }
}

function isRetryableVoipStatus(status, httpStatus) {
  return httpStatus === 429 || httpStatus >= 500 || status === "api_limit_exceeded";
}

function isRetryableException(error) {
  const text = String(error?.message || error || "");
  return /network|fetch|timeout|temporar|api_limit_exceeded|http_5\d\d/i.test(text);
}

function backoffMs(attempt) {
  return Math.min(4_000, 500 * 2 ** (attempt - 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function archiveVoicemailIfConfigured(env, details) {
  if (!env.VOICEMAIL_BUCKET) return null;

  const ext = extensionForAttachment(details.audio);
  const date = details.voicemailDate instanceof Date ? details.voicemailDate : new Date(details.voicemailDate);
  const iso = Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  const [ymd] = iso.split("T");
  const [year, month, day] = ymd.split("-");
  const caller = safeFilenamePart(details.identity?.number || details.identity?.name || "unknown");
  const key = `voicemails/${year}/${month}/${day}/${details.eventId}-${caller}.${ext}`;

  await env.VOICEMAIL_BUCKET.put(key, details.audioBytes, {
    httpMetadata: { contentType: mimeFromAttachment(details.audio) },
    customMetadata: {
      callerNumber: details.identity?.number || "",
      callerName: details.identity?.name || "",
      receivedAt: iso,
    },
  });

  const url = env.RECORDING_LINK_SECRET
    ? await buildPrivateRecordingUrl(env, key)
    : "";

  console.log(`Archived voicemail ${details.eventId} to R2.`);
  return { key, url };
}

async function buildPrivateRecordingUrl(env, key) {
  const base = String(env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (!base || !env.RECORDING_LINK_SECRET) return "";
  const ttl = clampInt(env.RECORDING_LINK_TTL_SECONDS, 60, 30 * 24 * 60 * 60, 7 * 24 * 60 * 60);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload = `${key}|${exp}`;
  const sig = await hmacBase64Url(env.RECORDING_LINK_SECRET, payload);
  return `${base}/recording/${encodeURIComponent(key)}?exp=${exp}&sig=${encodeURIComponent(sig)}`;
}

async function servePrivateRecording(request, env) {
  if (!env.VOICEMAIL_BUCKET || !env.RECORDING_LINK_SECRET) {
    return new Response("Recording links are not configured", { status: 404 });
  }
  const url = new URL(request.url);
  const encodedKey = url.pathname.slice("/recording/".length);
  let key;
  try {
    key = decodeURIComponent(encodedKey);
  } catch {
    return new Response("Invalid recording link", { status: 400 });
  }

  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") || "";
  if (!key || !Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return new Response("Recording link expired", { status: 403 });
  }

  const expected = await hmacBase64Url(env.RECORDING_LINK_SECRET, `${key}|${exp}`);
  if (!timingSafeEqual(sig, expected)) return new Response("Invalid recording link", { status: 403 });

  const object = await env.VOICEMAIL_BUCKET.get(key);
  if (!object) return new Response("Recording not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("cache-control", "private, no-store");
  headers.set("content-disposition", `inline; filename="${key.split("/").pop()?.replace(/[^a-zA-Z0-9_.-]/g, "_") || "voicemail.mp3"}"`);
  return new Response(object.body, { headers });
}

async function isAlreadyProcessed(env, eventId) {
  if (!env.VOICEMAIL_BUCKET) return false;
  const existing = await env.VOICEMAIL_BUCKET.head(`events/${eventId}.json`);
  return Boolean(existing);
}

async function markProcessedIfConfigured(env, eventId, status) {
  if (!env.VOICEMAIL_BUCKET) return;
  const key = `events/${eventId}.json`;
  await env.VOICEMAIL_BUCKET.put(key, JSON.stringify({ status, processedAt: new Date().toISOString() }), {
    httpMetadata: { contentType: "application/json" },
  });
}

async function makeEventId(message, raw) {
  const messageId = message.headers.get("message-id");
  const source = messageId || `${message.from}|${message.to}|${message.headers.get("date") || ""}|${raw.byteLength}`;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(hash)].slice(0, 10).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacBase64Url(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function timingSafeEqual(a, b) {
  const left = new TextEncoder().encode(String(a));
  const right = new TextEncoder().encode(String(b));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function truncateForSms(value, max) {
  const text = String(value || "");
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function requireEnv(env, names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing Worker secret/variable(s): ${missing.join(", ")}`);
}

function safeError(error) {
  return String(error?.message || error || "unknown error").replace(/api_password=[^&\s]+/gi, "api_password=[redacted]");
}

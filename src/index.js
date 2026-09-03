import PostalMime from "postal-mime";
import { MP3_BITRATE_KBPS, prepareMmsAudio } from "./audio.js";
import {
  MAX_MMS_AUDIO_BYTES,
  buildFallbackText,
  buildLinkFallbackText,
  buildNotificationText,
  contentTypeForExtension,
  extensionForAttachment,
  extractCallerIdentity,
  extractVoicemailDate,
  formatDate,
  findAudioAttachment,
  isAllowedSender,
  mimeFromAttachment,
  normalizePhone,
  safeFilenamePart,
  toUint8Array,
} from "./core.js";

const VOIPMS_ENDPOINT = "https://voip.ms/api/v1/rest.php";
const VOIPMS_3CX_ENDPOINT = "https://voip.ms/api/3cx/msg";
const MAX_EMAIL_BYTES = 12 * 1024 * 1024;
const REQUIRED_BINDINGS = ["VOIPMS_API_USERNAME", "VOIPMS_API_PASSWORD", "VOIPMS_DID", "MMS_DESTINATION"];
const MEDIA_URL_BINDINGS = ["VOICEMAIL_BUCKET", "PUBLIC_BASE_URL"];
const MMS_TRANSPORT = "rest_get_media_url";
const RECORDING_PREFIX = "voicemails/";
const LINK_PREFIX = "links/";

export default {
  async email(message, env) {
    const eventId = await makeEventId(message);
    logEvent("email_received", eventId, {
      sender: safeSender(message.from),
      recipient: String(message.to || ""),
      rawSize: Number(message.rawSize || 0),
    });

    const missing = missingBindings(env);
    if (missing.length) {
      logEvent("configuration_error", eventId, { missingBindings: missing }, "error");
      throw new Error(`Missing Worker secret/variable(s): ${missing.join(", ")}`);
    }

    if (!isAllowedSender(message.from, env.ALLOWED_SENDER_DOMAINS)) {
      logEvent("email_rejected", eventId, { reason: "unauthorized_sender", sender: safeSender(message.from) }, "warn");
      message.setReject("Unauthorized voicemail sender");
      return;
    }

    if (message.rawSize > MAX_EMAIL_BYTES) {
      logEvent("email_rejected", eventId, { reason: "oversized_email", rawSize: message.rawSize }, "warn");
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

    logEvent("email_parsed", eventId, {
      subject: String(parsed.subject || "").slice(0, 240),
      callerNumber: identity.number || "",
      callerName: identity.name || "",
      voicemailTime: formatDate(voicemailDate, env.TIME_ZONE),
      voicemailTimeIso: voicemailDate.toISOString(),
      attachmentCount: (parsed.attachments || []).length,
      audioFound: Boolean(audio),
    });

    if (await isAlreadyProcessed(env, eventId)) {
      logEvent("duplicate_ignored", eventId);
      return;
    }

    if (!audio) {
      logEvent("fallback_attempt", eventId, { reason: "missing_audio", transport: "rest_get" }, "warn");
      const result = await sendFallbackSms(env, buildFallbackText(notificationText, "missing_audio"));
      logEvent("fallback_success", eventId, { reason: "missing_audio", messageId: result.sms || "" });
      await markProcessedIfConfigured(env, eventId, "sms_missing_audio");
      return;
    }

    const sourceBytes = toUint8Array(audio.content);
    logEvent("audio_found", eventId, {
      audioType: mimeFromAttachment(audio),
      audioSize: sourceBytes.byteLength,
      audioFilename: String(audio.filename || "").slice(0, 160),
    });

    // VoIP.ms rejects WAV media with `invalid_media`, so voicemail recordings
    // are transcoded to MP3 (the format that is delivered successfully).
    const media = transcodeForMms(eventId, audio, sourceBytes);
    const mediaDetails = {
      mediaType: media.mimeType,
      mediaSize: media.bytes.byteLength,
      sourceSize: media.sourceBytes,
      transcoded: media.transcoded,
      deliverable: media.deliverable,
    };

    const archive = await archiveVoicemailIfConfigured(env, {
      eventId,
      media,
      identity,
      voicemailDate,
    });

    const reason = undeliverableReason(env, media, archive);
    if (reason) {
      const fallback = archive?.url
        ? buildLinkFallbackText(notificationText, archive.url)
        : buildFallbackText(notificationText, reason);
      logEvent("fallback_attempt", eventId, { reason, transport: "rest_get", ...mediaDetails }, "warn");
      const result = await sendFallbackSms(env, fallback);
      logEvent("fallback_success", eventId, { reason, messageId: result.sms || "", transport: result.transport || "unknown" });
      await markProcessedIfConfigured(env, eventId, `sms_${reason}`);
      return;
    }

    try {
      logEvent("mms_attempt", eventId, { ...mediaDetails, transport: MMS_TRANSPORT });
      const result = await sendMms(env, notificationText, archive.url);
      logEvent("mms_success", eventId, {
        messageId: result.mms || result.sms || "",
        status: result.status || "success",
        transport: result.transport || MMS_TRANSPORT,
        ...mediaDetails,
      });
      await markProcessedIfConfigured(env, eventId, "mms_sent");
    } catch (error) {
      logEvent("mms_failure", eventId, { error: safeError(error), ...mediaDetails }, "error");
      const fallback = buildLinkFallbackText(notificationText, archive.url);
      logEvent("fallback_attempt", eventId, { reason: "mms_failed", transport: "rest_get" }, "warn");
      const result = await sendFallbackSms(env, fallback);
      logEvent("fallback_success", eventId, { reason: "mms_failed", messageId: result.sms || "", transport: result.transport || "unknown" });
      await markProcessedIfConfigured(env, eventId, "sms_fallback");
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      const mediaUrlMissing = missingBindings(env, MEDIA_URL_BINDINGS);
      return Response.json({
        ok: true,
        service: "voicemail-to-mms",
        archiveConfigured: Boolean(env.VOICEMAIL_BUCKET),
        privateLinksConfigured: Boolean(env.VOICEMAIL_BUCKET && env.RECORDING_LINK_SECRET),
        requiredBindings: Object.fromEntries(REQUIRED_BINDINGS.map((name) => [name, Boolean(env[name])])),
        maxMmsAudioBytes: MAX_MMS_AUDIO_BYTES,
        // MMS media must be a URL VoIP.ms can fetch; inline base64 media is
        // accepted by the API but delivered as a zero-byte attachment.
        mmsMediaReady: mediaUrlMissing.length === 0,
        mmsMediaMissingBindings: mediaUrlMissing,
        audioPipeline: `WAV/MP3 attachment -> mono MP3 @ ${MP3_BITRATE_KBPS} kbps -> R2 -> signed media URL`,
        outboundTransport: "VoIP.ms sendMMS GET with media1 = signed R2 recording URL",
      });
    }

    if (url.pathname.startsWith("/r/")) {
      return serveTokenRecording(request, env);
    }

    // Signed links issued before short tokens existed stay playable.
    if (url.pathname.startsWith("/recording/")) {
      return servePrivateRecording(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

function transcodeForMms(eventId, attachment, sourceBytes) {
  try {
    const media = prepareMmsAudio(sourceBytes, MP3_BITRATE_KBPS);
    if (media.transcoded) {
      logEvent("audio_transcoded", eventId, {
        sourceSize: media.sourceBytes,
        mediaSize: media.bytes.byteLength,
        sourceSampleRate: media.sourceSampleRate,
        sampleRate: media.sampleRate,
        bitrateKbps: media.bitrateKbps,
        durationSeconds: media.durationSeconds,
      });
    }
    return media;
  } catch (error) {
    logEvent("audio_transcode_failure", eventId, { error: safeError(error) }, "error");
    return {
      bytes: sourceBytes,
      mimeType: mimeFromAttachment(attachment),
      extension: extensionForAttachment(attachment),
      transcoded: false,
      deliverable: false,
      sourceBytes: sourceBytes.byteLength,
      reason: "transcode_failed",
    };
  }
}

function undeliverableReason(env, media, archive) {
  if (!media.deliverable) return media.reason || "unsupported_audio";
  // VoIP.ms only renders MMS media it can fetch for itself. Inline media
  // (base64 or a data: URL) is accepted by sendMMS and reports status
  // "success", but the delivered message carries a zero-byte attachment, so a
  // publicly reachable recording URL is required for a real MMS.
  if (!archive?.url) return missingBindings(env, MEDIA_URL_BINDINGS).length ? "media_url_unconfigured" : "media_url_unavailable";
  if (media.bytes.byteLength > MAX_MMS_AUDIO_BYTES) return "too_large";
  return "";
}

async function sendMms(env, message, mediaUrl) {
  const result = await callVoipMsGet(env, "sendMMS", {
    did: normalizePhone(env.VOIPMS_DID),
    dst: normalizePhone(env.MMS_DESTINATION),
    message,
    media1: mediaUrl,
  });
  return { ...result, transport: MMS_TRANSPORT };
}

async function sendFallbackSms(env, message) {
  const text = truncateForSms(message, 160);

  try {
    const result = await callVoipMsGet(env, "sendSMS", {
      did: normalizePhone(env.VOIPMS_DID),
      dst: normalizePhone(env.MMS_DESTINATION),
      message: text,
    });
    return { ...result, transport: "rest_get" };
  } catch (getError) {
    if (!env.VOIPMS_BEARER_TOKEN) throw getError;

    try {
      const result = await callVoipMsBearer(env, {
        from: toE164(env.VOIPMS_DID),
        to: toE164(env.MMS_DESTINATION),
        text,
      });
      return { ...result, transport: "bearer_post" };
    } catch (bearerError) {
      throw new Error(`VoIP.ms GET failed: ${safeError(getError)}; bearer fallback failed: ${safeError(bearerError)}`);
    }
  }
}

async function callVoipMsBearer(env, payload) {
  const response = await fetch(VOIPMS_3CX_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${env.VOIPMS_BEARER_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "3CXPhoneSystem",
      "x-client-name": "voicemail-to-mms",
    },
    body: JSON.stringify(payload),
  });
  const responseText = await response.text();
  let data = {};
  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    if (response.status === 403 && /<html|attention required/i.test(responseText)) {
      throw new Error(describeVoipMsEdgeRejection(response, responseText, "3CX message API"));
    }
    const status = String(data.status || data.error || data.message || `http_${response.status}`).slice(0, 240);
    throw new Error(`VoIP.ms bearer message API failed: ${status}`);
  }

  const messageId = data.id || data.message_id || data.messageId || data.sms || data.mms || data.data?.id || "";
  return { ...data, status: data.status || "success", sms: messageId };
}

function toE164(value) {
  const digits = normalizePhone(value);
  if (digits.length === 10) return `+1${digits}`;
  return digits.startsWith("1") ? `+${digits}` : `+${digits}`;
}

async function callVoipMsGet(env, method, params = {}) {
  const maxAttempts = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const query = buildVoipMsParams(env, method, params);
      const url = new URL(VOIPMS_ENDPOINT);
      url.search = query.toString();

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "en-US,en;q=0.9",
          "cache-control": "no-cache",
          pragma: "no-cache",
          "user-agent": "Mozilla/5.0 (compatible; voicemail-to-mms/1.0)",
        },
        cf: { cacheTtl: 0, cacheEverything: false },
      });
      const responseText = await response.text();
      if (response.status === 403) {
        throw new Error(describeVoipMsEdgeRejection(response, responseText, `${method} GET`));
      }
      const data = parseVoipMsResponse(responseText, response.status);

      if (response.ok && data.status === "success") return data;

      const status = String(data.status || `http_${response.status}`);
      if (attempt < maxAttempts && isRetryableVoipStatus(status, response.status)) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new Error(`VoIP.ms ${method} GET failed: ${status}`);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableException(error)) break;
      await sleep(backoffMs(attempt));
    }
  }

  throw lastError || new Error(`VoIP.ms ${method} GET failed`);
}


function buildVoipMsParams(env, method, params = {}) {
  const values = new URLSearchParams();
  values.set("api_username", env.VOIPMS_API_USERNAME);
  values.set("api_password", env.VOIPMS_API_PASSWORD);
  values.set("method", method);
  values.set("content_type", "json");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") values.set(key, String(value));
  }
  return values;
}

function describeVoipMsEdgeRejection(response, text, method) {
  const title = String(text).match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || "unknown";
  const rayId = response.headers.get("cf-ray") || "unavailable";
  const server = response.headers.get("server") || "unknown";
  return `VoIP.ms ${method} rejected at provider edge (HTTP 403; title=${title}; server=${server}; ray=${rayId})`;
}

function extractSoapReason(text) {
  const value = String(text || "");
  const match = value.match(/<(?:\w+:)?Text[^>]*>([\s\S]*?)<\/(?:\w+:)?Text>/i);
  return String(match?.[1] || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
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

  const { media } = details;
  const date = details.voicemailDate instanceof Date ? details.voicemailDate : new Date(details.voicemailDate);
  const iso = Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  const [ymd] = iso.split("T");
  const [year, month, day] = ymd.split("-");
  const caller = safeFilenamePart(details.identity?.number || details.identity?.name || "unknown");
  const key = `${RECORDING_PREFIX}${year}/${month}/${day}/${details.eventId}-${caller}.${media.extension}`;

  await env.VOICEMAIL_BUCKET.put(key, media.bytes, {
    httpMetadata: { contentType: contentTypeForExtension(media.extension, media.mimeType) },
    customMetadata: {
      callerNumber: details.identity?.number || "",
      callerName: details.identity?.name || "",
      receivedAt: iso,
    },
  });

  const url = await publishRecordingLink(env, key);

  console.log(`Archived voicemail ${details.eventId} to R2.`);
  return { key, url };
}

/**
 * Publish a short, unguessable URL for a recording.
 *
 * The URL has to survive inside a 160-character SMS fallback, so the link is a
 * 128-bit random token backed by a pointer object rather than a long signed
 * path. VoIP.ms fetches this same URL as the MMS media.
 */
async function publishRecordingLink(env, key) {
  const base = String(env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (!base) return "";

  const ttl = clampInt(env.RECORDING_LINK_TTL_SECONDS, 60, 30 * 24 * 60 * 60, 7 * 24 * 60 * 60);
  const token = randomToken();
  await env.VOICEMAIL_BUCKET.put(
    `${LINK_PREFIX}${token}`,
    JSON.stringify({ key, expiresAt: Date.now() + ttl * 1000 }),
    { httpMetadata: { contentType: "application/json" } },
  );

  const extension = key.split(".").pop();
  return `${base}/r/${token}.${extension}`;
}

async function serveTokenRecording(request, env) {
  if (!env.VOICEMAIL_BUCKET) return new Response("Recording links are not configured", { status: 404 });

  const url = new URL(request.url);
  const token = url.pathname.slice("/r/".length).split(".")[0];
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return new Response("Invalid recording link", { status: 400 });

  const pointer = await env.VOICEMAIL_BUCKET.get(`${LINK_PREFIX}${token}`);
  if (!pointer) return new Response("Recording not found", { status: 404 });

  let target;
  try {
    target = JSON.parse(await pointer.text());
  } catch {
    return new Response("Recording not found", { status: 404 });
  }

  if (!target?.key?.startsWith(RECORDING_PREFIX)) return new Response("Recording not found", { status: 404 });
  if (Number(target.expiresAt) < Date.now()) return new Response("Recording link expired", { status: 403 });

  return streamRecording(env, target.key, request.method === "HEAD");
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

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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

  return streamRecording(env, key, request.method === "HEAD");
}

/**
 * VoIP.ms probes the media URL with both GET and HEAD before accepting an MMS,
 * so serve an explicit content type and length for either method.
 */
async function streamRecording(env, key, isHead) {
  const object = isHead ? await env.VOICEMAIL_BUCKET.head(key) : await env.VOICEMAIL_BUCKET.get(key);
  if (!object) return new Response("Recording not found", { status: 404 });

  const filename = key.split("/").pop()?.replace(/[^a-zA-Z0-9_.-]/g, "_") || "voicemail.mp3";
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", contentTypeForExtension(filename.split(".").pop(), headers.get("content-type")));
  headers.set("content-length", String(object.size));
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, no-store");
  headers.set("content-disposition", `inline; filename="${filename}"`);
  return new Response(isHead ? null : object.body, { headers });
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

async function makeEventId(message) {
  const messageId = message.headers.get("message-id");
  const source = messageId || `${message.from}|${message.to}|${message.headers.get("date") || ""}|${message.rawSize || 0}`;
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

function missingBindings(env, names = REQUIRED_BINDINGS) {
  return names.filter((name) => !env[name]);
}

function safeSender(value) {
  const match = String(value || "").match(/<?([^<>\s]+@[^<>\s]+)>?/);
  return match?.[1] || String(value || "");
}

function logEvent(stage, eventId, details = {}, level = "log") {
  const payload = {
    service: "voicemail-to-mms",
    stage,
    eventId,
    timestamp: new Date().toISOString(),
    ...details,
  };
  const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
  console[method](JSON.stringify(payload));
}

function safeError(error) {
  return String(error?.message || error || "unknown error")
    .replace(/api_password=[^&\s]+/gi, "api_password=[redacted]")
    .replace(/api_username=[^&\s]+/gi, "api_username=[redacted]");
}

import PostalMime from "postal-mime";
import { DEFAULT_MMS_FORMATS, buildMmsCandidates, parseMmsFormats } from "./audio.js";
import { buildProbeMedia, parseProbeVariants } from "./probe.js";
import {
  MAX_MMS_AUDIO_BYTES,
  buildFallbackText,
  buildLinkFallbackText,
  buildNotificationText,
  contentTypeForExtension,
  extensionForAttachment,
  formatPhone,
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
// The portal uploads the recording as a file, so that transport goes first;
// the URL transport is what the API has been refusing for WAV.
const MMS_TRANSPORTS = ["multipart_file", "multipart_url", "post_url", "get_url"];
const DEFAULT_MMS_TRANSPORTS = ["multipart_file", "get_url"];
const RECORDING_PREFIX = "voicemails/";
const LINK_PREFIX = "links/";
const PROBE_PREFIX = "probes/";

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

    // The recording itself is known good — these exact bytes were uploaded by
    // hand through the VoIP.ms portal and arrived playable. Only the API path
    // refuses them, so each format is offered over each transport in turn.
    const prepared = prepareCandidates(eventId, audio, sourceBytes, env);
    const stored = await archiveCandidatesIfConfigured(env, {
      eventId,
      prepared,
      identity,
      voicemailDate,
    });

    const blocked = undeliverableReason(env, prepared, stored);
    if (blocked) {
      const fallback = stored[0]?.pageUrl
        ? buildLinkFallbackText(notificationText, stored[0].pageUrl)
        : buildFallbackText(notificationText, blocked);
      logEvent("fallback_attempt", eventId, { reason: blocked, transport: "rest_get" }, "warn");
      const result = await sendFallbackSms(env, fallback);
      logEvent("fallback_success", eventId, { reason: blocked, messageId: result.sms || "", transport: result.transport || "unknown" });
      await markProcessedIfConfigured(env, eventId, `sms_${blocked}`);
      return;
    }

    const transports = parseMmsTransports(env.MMS_TRANSPORTS);
    const failures = [];
    for (const candidate of stored) {
      const details = { format: candidate.format, mediaType: candidate.mimeType, mediaSize: candidate.bytes.byteLength };
      for (const transport of transports) {
        // A URL transport needs a published URL; a file transport does not.
        if (transport !== "multipart_file" && !candidate.url) continue;
        try {
          logEvent("mms_attempt", eventId, { ...details, transport });
          const result = await sendMmsVia(env, transport, notificationText, candidate);
          logEvent("mms_success", eventId, {
            ...details,
            transport,
            messageId: result.mms || result.sms || "",
            status: result.status || "success",
          });
          await markProcessedIfConfigured(env, eventId, `mms_sent_${candidate.format}_${transport}`);
          return;
        } catch (error) {
          failures.push(`${candidate.format}/${transport}: ${safeError(error)}`);
          logEvent("mms_candidate_rejected", eventId, { ...details, transport, error: safeError(error) }, "warn");
        }
      }
    }

    logEvent("mms_failure", eventId, { error: failures.join("; ") }, "error");
    const fallback = buildLinkFallbackText(notificationText, stored[0].pageUrl);
    logEvent("fallback_attempt", eventId, { reason: "mms_failed", transport: "rest_get" }, "warn");
    const result = await sendFallbackSms(env, fallback);
    logEvent("fallback_success", eventId, { reason: "mms_failed", messageId: result.sms || "", transport: result.transport || "unknown" });
    await markProcessedIfConfigured(env, eventId, "sms_fallback");
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
        mmsMediaReady: mediaUrlMissing.length === 0,
        mmsMediaMissingBindings: mediaUrlMissing,
        mmsMediaFormats: parseMmsFormats(env.MMS_MEDIA_FORMATS),
        defaultMmsMediaFormats: DEFAULT_MMS_FORMATS,
        mmsTransports: parseMmsTransports(env.MMS_TRANSPORTS),
        availableMmsTransports: MMS_TRANSPORTS,
        outboundTransport: "VoIP.ms sendMMS, first accepted format/transport pair wins",
      });
    }

    if (url.pathname === "/diagnostics/media-probe") {
      return runMediaProbe(request, env);
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

function prepareCandidates(eventId, attachment, sourceBytes, env) {
  const formats = parseMmsFormats(env.MMS_MEDIA_FORMATS);
  try {
    const prepared = buildMmsCandidates(sourceBytes, formats);
    const deliverable = prepared.candidates.filter((c) => c.bytes.byteLength <= MAX_MMS_AUDIO_BYTES);
    logEvent("audio_prepared", eventId, {
      sourceSize: prepared.sourceBytes,
      sourceSampleRate: prepared.sourceSampleRate,
      durationSeconds: prepared.durationSeconds,
      order: deliverable.map((c) => `${c.format}:${c.bytes.byteLength}`).join(","),
    });
    return { ...prepared, candidates: deliverable, reason: deliverable.length ? "" : prepared.reason || "too_large" };
  } catch (error) {
    logEvent("audio_transcode_failure", eventId, { error: safeError(error) }, "error");
    return {
      sourceBytes: sourceBytes.byteLength,
      candidates: [],
      reason: "transcode_failed",
      // Keep the untouched recording so the SMS fallback can still link to it.
      original: {
        format: extensionForAttachment(attachment),
        bytes: sourceBytes,
        mimeType: mimeFromAttachment(attachment),
        extension: extensionForAttachment(attachment),
      },
    };
  }
}

function undeliverableReason(env, prepared, stored) {
  if (!prepared.candidates.length) return prepared.reason || "unsupported_audio";
  // The URL transports need a published recording URL; the multipart file
  // transport carries the bytes itself, so it works without one.
  const transports = parseMmsTransports(env.MMS_TRANSPORTS);
  if (!transports.includes("multipart_file") && !stored.some((candidate) => candidate.url)) {
    return missingBindings(env, MEDIA_URL_BINDINGS).length ? "media_url_unconfigured" : "media_url_unavailable";
  }
  return "";
}

/**
 * Send one MMS over a named transport.
 *
 * The recording itself is not the problem: the exact bytes this Worker
 * produces were downloaded and uploaded by hand through the VoIP.ms portal,
 * and that message arrived and played. Only the API path refuses them, and it
 * refuses `media1` as a URL (`invalid_media`) or as a base64 string. What the
 * portal does and the API had never been asked to do is take the recording as
 * a real multipart file part, so that is tried first.
 */
async function sendMmsVia(env, transport, message, candidate) {
  const params = {
    did: normalizePhone(env.VOIPMS_DID),
    dst: normalizePhone(env.MMS_DESTINATION),
    message,
  };
  const filename = `voicemail.${candidate.extension}`;
  const file = { bytes: candidate.bytes, contentType: candidate.mimeType, filename };

  switch (transport) {
    case "multipart_file":
      return withTransport(await callVoipMsMultipart(env, "sendMMS", params, { media1: file }), transport);
    case "multipart_url":
      return withTransport(await callVoipMsMultipart(env, "sendMMS", { ...params, media1: candidate.url }), transport);
    case "post_url":
      return withTransport(await callVoipMsPost(env, "sendMMS", { ...params, media1: candidate.url }), transport);
    case "get_url":
      return withTransport(await callVoipMsGet(env, "sendMMS", { ...params, media1: candidate.url }), transport);
    default:
      throw new Error(`Unknown MMS transport: ${transport}`);
  }
}

function withTransport(result, transport) {
  return { ...result, transport };
}

function parseProbeTransports(value) {
  const requested = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => MMS_TRANSPORTS.includes(item));
  return requested.length ? [...new Set(requested)] : MMS_TRANSPORTS;
}

export function parseMmsTransports(value) {
  const requested = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => MMS_TRANSPORTS.includes(item));
  return requested.length ? [...new Set(requested)] : DEFAULT_MMS_TRANSPORTS;
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

/**
 * POST to the REST API as multipart/form-data.
 *
 * `files` entries become genuine file parts — Blob plus filename plus content
 * type — which is how a browser form uploads a recording. String fields alone
 * were all this Worker ever sent before, and the API refused those.
 */
async function callVoipMsMultipart(env, method, params = {}, files = {}) {
  return withVoipMsRetries(`${method} multipart POST`, async () => {
    const form = new FormData();
    form.set("api_username", env.VOIPMS_API_USERNAME);
    form.set("api_password", env.VOIPMS_API_PASSWORD);
    form.set("method", method);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") form.set(key, String(value));
    }
    for (const [key, file] of Object.entries(files)) {
      form.set(key, new Blob([file.bytes], { type: file.contentType }), file.filename);
    }

    // No content-type header: fetch has to set it so the multipart boundary matches.
    return fetch(VOIPMS_ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "cache-control": "no-cache",
        "user-agent": "Mozilla/5.0 (compatible; voicemail-to-mms/1.0)",
      },
      body: form,
    });
  });
}

async function callVoipMsPost(env, method, params = {}) {
  return withVoipMsRetries(`${method} POST`, async () => fetch(VOIPMS_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "cache-control": "no-cache",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "user-agent": "Mozilla/5.0 (compatible; voicemail-to-mms/1.0)",
    },
    body: buildVoipMsParams(env, method, params).toString(),
  }));
}

/** Shared retry/parse wrapper so every transport reports failures the same way. */
async function withVoipMsRetries(label, send) {
  const maxAttempts = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await send();
      const responseText = await response.text();
      if (response.status === 403) {
        throw new Error(describeVoipMsEdgeRejection(response, responseText, label));
      }

      let data;
      try {
        data = JSON.parse(responseText);
      } catch {
        const reason = extractSoapReason(responseText);
        throw new Error(`VoIP.ms ${label} returned non-JSON (HTTP ${response.status})${reason ? `: ${reason}` : ""}`);
      }

      if (response.ok && data.status === "success") return data;

      const status = String(data.status || `http_${response.status}`);
      if (attempt < maxAttempts && isRetryableVoipStatus(status, response.status)) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new Error(`VoIP.ms ${label} failed: ${status}`);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableException(error)) break;
      await sleep(backoffMs(attempt));
    }
  }

  throw lastError || new Error(`VoIP.ms ${label} failed`);
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

/**
 * Store every candidate and publish a fetchable URL for each, keeping the
 * order so the caller can offer them to VoIP.ms one at a time.
 */
async function archiveCandidatesIfConfigured(env, details) {
  const { prepared } = details;
  const media = prepared.candidates.length ? prepared.candidates : [prepared.original].filter(Boolean);
  if (!env.VOICEMAIL_BUCKET || !media.length) return media.map((candidate) => ({ ...candidate, url: "", pageUrl: "" }));

  const date = details.voicemailDate instanceof Date ? details.voicemailDate : new Date(details.voicemailDate);
  const iso = Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  const [ymd] = iso.split("T");
  const [year, month, day] = ymd.split("-");
  const caller = safeFilenamePart(details.identity?.number || details.identity?.name || "unknown");

  const stored = [];
  for (const candidate of media) {
    const key = `${RECORDING_PREFIX}${year}/${month}/${day}/${details.eventId}-${caller}.${candidate.extension}`;
    await env.VOICEMAIL_BUCKET.put(key, candidate.bytes, {
      httpMetadata: { contentType: contentTypeForExtension(candidate.extension, candidate.mimeType) },
      customMetadata: {
        callerNumber: details.identity?.number || "",
        callerName: details.identity?.name || "",
        receivedAt: iso,
      },
    });
    stored.push({ ...candidate, key, ...(await publishRecordingLink(env, key)) });
  }

  console.log(`Archived voicemail ${details.eventId} to R2 as ${stored.map((c) => c.extension).join(", ")}.`);
  return stored;
}

/**
 * Publish short, unguessable URLs for a recording.
 *
 * A URL has to survive inside a 160-character SMS fallback, so the link is a
 * 128-bit random token backed by a pointer object rather than a long signed
 * path. `url` carries the file extension and is what VoIP.ms fetches as MMS
 * media; `pageUrl` is the bare token, which renders a player page for people.
 */
async function publishRecordingLink(env, key) {
  const base = String(env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (!base) return { url: "", pageUrl: "" };

  const ttl = clampInt(env.RECORDING_LINK_TTL_SECONDS, 60, 30 * 24 * 60 * 60, 7 * 24 * 60 * 60);
  const token = randomToken();
  await env.VOICEMAIL_BUCKET.put(
    `${LINK_PREFIX}${token}`,
    JSON.stringify({ key, expiresAt: Date.now() + ttl * 1000 }),
    { httpMetadata: { contentType: "application/json" } },
  );

  return { url: `${base}/r/${token}.${key.split(".").pop()}`, pageUrl: `${base}/r/${token}` };
}

/**
 * Send one test MMS per media variant and report which ones sendMMS accepts.
 *
 * Voicemail-at-a-time testing costs a call and a wait per format. This sends
 * the whole set in one request, so the API's own verdict on each encoding is
 * known immediately and only the delivery question is left for the handset.
 * It sends real, billable messages, so it needs the key and never self-runs.
 */
async function runMediaProbe(request, env) {
  const secret = env.PROBE_KEY || env.RECORDING_LINK_SECRET || "";
  const supplied = new URL(request.url).searchParams.get("key") || "";
  if (!secret || !timingSafeEqual(supplied, secret)) {
    return new Response("Not found", { status: 404 });
  }
  if (missingBindings(env).length || missingBindings(env, MEDIA_URL_BINDINGS).length) {
    return Response.json({ ok: false, error: "Worker bindings for MMS media are incomplete" }, { status: 503 });
  }

  const url = new URL(request.url);
  // The format question is settled — the recording plays once it arrives — so
  // the probe defaults to one WAV across every transport instead.
  const variants = parseProbeVariants(url.searchParams.get("variants") || "wav-8k-pcm16");
  const transports = parseProbeTransports(url.searchParams.get("transports"));
  const seconds = clampInt(url.searchParams.get("seconds"), 1, 10, 2);
  const results = [];
  let index = 0;

  for (const name of variants) {
    const media = buildProbeMedia(name, seconds);
    const key = `${PROBE_PREFIX}${Date.now()}-${name}.${media.extension}`;
    await env.VOICEMAIL_BUCKET.put(key, media.bytes, {
      httpMetadata: { contentType: contentTypeForExtension(media.extension, media.mimeType) },
    });
    const published = await publishRecordingLink(env, key);
    const candidate = { ...media, ...published };

    for (const transport of transports) {
      index += 1;
      const label = `Probe ${index}: ${name} via ${transport}`;
      try {
        const result = await sendMmsVia(env, transport, label, candidate);
        results.push({ probe: index, variant: name, transport, bytes: media.bytes.byteLength, accepted: true, messageId: result.mms || "" });
        logEvent("probe_accepted", "media-probe", { variant: name, transport });
      } catch (error) {
        results.push({ probe: index, variant: name, transport, accepted: false, error: safeError(error) });
        logEvent("probe_rejected", "media-probe", { variant: name, transport, error: safeError(error) }, "warn");
      }
    }
  }

  return Response.json({
    ok: true,
    note: "Each accepted probe was sent as a real MMS. Check which numbered probes actually arrive and play on the handset.",
    accepted: results.filter((r) => r.accepted).map((r) => `${r.probe}: ${r.variant} via ${r.transport}`),
    rejected: results.filter((r) => !r.accepted).map((r) => `${r.probe}: ${r.variant} via ${r.transport}`),
    results,
  });
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

  if (!target?.key?.startsWith(RECORDING_PREFIX) && !target?.key?.startsWith(PROBE_PREFIX)) {
    return new Response("Recording not found", { status: 404 });
  }
  if (Number(target.expiresAt) < Date.now()) return new Response("Recording link expired", { status: 403 });

  // A bare token renders a player page; the same token plus the file extension
  // serves the audio itself, which is what VoIP.ms fetches as MMS media.
  if (!url.pathname.slice("/r/".length).includes(".")) {
    const object = await env.VOICEMAIL_BUCKET.head(target.key);
    if (!object) return new Response("Recording not found", { status: 404 });
    return recordingPlayerPage(`${url.origin}/r/${token}.${target.key.split(".").pop()}`, object.customMetadata || {});
  }

  return streamRecording(env, target.key, request.method === "HEAD");
}

function recordingPlayerPage(audioUrl, meta) {
  const caller = formatPhone(meta.callerNumber || "") || meta.callerName || "Unknown caller";
  const received = meta.receivedAt ? formatDate(meta.receivedAt) : "";
  const page = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Voicemail</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 16px/1.5 system-ui, -apple-system, sans-serif; background: #f4f5f7; color: #14161a; }
  @media (prefers-color-scheme: dark) { body { background: #16181d; color: #f2f3f5; } }
  .card { width: min(30rem, 92vw); padding: 1.75rem; border-radius: 1rem; background: #fff;
          box-shadow: 0 1px 3px rgba(0,0,0,.12), 0 8px 24px rgba(0,0,0,.08); }
  @media (prefers-color-scheme: dark) { .card { background: #22252c; box-shadow: none; } }
  h1 { margin: 0 0 .25rem; font-size: 1.35rem; }
  p { margin: 0 0 1.25rem; opacity: .7; font-size: .95rem; }
  audio { width: 100%; }
</style>
</head><body><div class="card">
<h1>${escapeHtml(caller)}</h1>
<p>${escapeHtml(received)}</p>
<audio controls autoplay preload="auto" src="${escapeHtml(audioUrl)}"></audio>
</div></body></html>`;

  return new Response(page, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" },
  });
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
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

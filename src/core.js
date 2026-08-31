export const DEFAULT_TIME_ZONE = "America/New_York";
export const DEFAULT_ALLOWED_SENDER_DOMAINS = ["voip.ms", "voipinterface.net"];
export const MAX_MMS_AUDIO_BYTES = 1_150_000;

export function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

export function formatPhone(value) {
  const n = normalizePhone(value);
  if (n.length !== 10) return String(value || "");
  return `${n.slice(0, 3)}-${n.slice(3, 6)}-${n.slice(6)}`;
}

export function isAllowedSender(sender, configuredDomains) {
  const email = extractEmailAddress(sender);
  const domain = email.split("@")[1]?.toLowerCase() || "";
  const domains = parseCsv(configuredDomains).length
    ? parseCsv(configuredDomains)
    : DEFAULT_ALLOWED_SENDER_DOMAINS;
  return domains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

export function extractCallerIdentity(text, ownDid, destination) {
  const clean = htmlToText(text);
  const own = normalizePhone(ownDid);
  const dst = normalizePhone(destination);
  const excluded = new Set([own, dst].filter(Boolean));

  // Real VoIP.ms subjects use: New voicemail ... from "Caller Name" <number>.
  const subjectIdentity = clean.match(/\bfrom\s+(?:"([^"]*)"\s*)?<\s*([^>]+)\s*>/i);
  if (subjectIdentity) {
    const number = normalizePhone(subjectIdentity[2]);
    if (number.length === 10 && !excluded.has(number)) {
      return { number, name: sanitizeName(subjectIdentity[1] || "") };
    }
  }

  const lines = clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  const labeled = lines.filter((line) => /\b(caller(?:\s*id)?|from|calling party|phone)\b\s*[:\-]/i.test(line));
  for (const line of labeled) {
    const parsed = parseIdentityLine(line, excluded);
    if (parsed.number) return parsed;
  }

  for (const line of lines) {
    if (!/voicemail|message|caller|from/i.test(line)) continue;
    const parsed = parseIdentityLine(line, excluded);
    if (parsed.number) return parsed;
  }

  const candidates = findPhoneNumbers(clean).filter((number) => !excluded.has(number));
  return { number: candidates[0] || "", name: "" };
}

export function extractVoicemailDate(text, fallbackDate) {
  const clean = htmlToText(text);
  const lines = clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const dateLabels = /\b(date(?:\/time)?|time|received(?:\s+at)?|message received|voicemail received|left at)\b\s*[:\-]\s*(.+)$/i;

  for (const line of lines) {
    const match = line.match(dateLabels);
    if (!match) continue;
    const parsed = parseDateCandidate(match[2]);
    if (parsed) return parsed;
  }

  const fallback = fallbackDate ? new Date(fallbackDate) : new Date();
  return Number.isNaN(fallback.getTime()) ? new Date() : fallback;
}

export function formatDate(dateValue, timeZone = DEFAULT_TIME_ZONE) {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(date.getTime())) return "time unavailable";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function lookupContactName(number, contactsJson) {
  if (!contactsJson || !number) return "";
  try {
    const contacts = JSON.parse(contactsJson);
    const normalized = normalizePhone(number);
    for (const [key, value] of Object.entries(contacts || {})) {
      if (normalizePhone(key) === normalized && typeof value === "string") {
        return sanitizeName(value);
      }
    }
  } catch {
    return "";
  }
  return "";
}

export function buildNotificationText(identity, date, timeZone, contactsJson) {
  const number = normalizePhone(identity?.number);
  const contactName = lookupContactName(number, contactsJson);
  const name = contactName || sanitizeName(identity?.name || "");
  const when = formatDate(date, timeZone);
  let who = "Unknown caller";
  if (name && number) who = `${name} (${formatPhone(number)})`;
  else if (number) who = formatPhone(number);
  else if (name) who = name;
  return `Voicemail from ${who} - ${when}`;
}

export function buildFallbackText(notificationText, reason) {
  const suffix = reason === "too_large"
    ? "Recording too large for MMS; call voicemail to listen."
    : reason === "missing_audio"
      ? "Audio attachment missing; call voicemail to listen."
      : "MMS delivery failed; call voicemail to listen.";
  return truncateSms(`${notificationText}. ${suffix}`, 160);
}

export function findAudioAttachment(attachments = []) {
  const scored = attachments
    .map((attachment, index) => ({ attachment, index, score: audioScore(attachment) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return scored[0]?.attachment || null;
}

export function toUint8Array(content) {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (ArrayBuffer.isView(content)) {
    return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  }
  if (typeof content === "string") {
    try {
      const binary = atob(content.replace(/\s/g, ""));
      return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    } catch {
      throw new Error("Unsupported string encoding for voicemail attachment.");
    }
  }
  throw new Error("Unsupported voicemail attachment format.");
}

export function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function mimeFromAttachment(attachment = {}) {
  const type = String(attachment.mimeType || "").toLowerCase();
  if (type.startsWith("audio/") && type !== "audio/x-wav49") return type;
  const lower = String(attachment.filename || "").toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav") || lower.endsWith(".wav49")) return "audio/wav";
  return type || "audio/mpeg";
}

export function extensionForAttachment(attachment = {}) {
  const lower = String(attachment.filename || "").toLowerCase();
  if (lower.endsWith(".wav49")) return "wav49";
  if (lower.endsWith(".wav")) return "wav";
  return "mp3";
}

export function safeFilenamePart(value) {
  return String(value || "unknown")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "unknown";
}

function parseIdentityLine(line, excluded) {
  const numbers = findPhoneNumbers(line).filter((number) => !excluded.has(number));
  if (!numbers.length) return { number: "", name: "" };
  const number = numbers[0];
  const phonePattern = /(?:\+?1[ .()\-]*)?(?:\d[ .()\-]*){10}/g;
  const withoutLabel = line.replace(/^.*?\b(caller(?:\s*id)?|from|calling party|phone)\b\s*[:\-]\s*/i, "");
  const name = sanitizeName(
    withoutLabel
      .replace(phonePattern, " ")
      .replace(/[<>()[\]"']/g, " ")
      .replace(/\b(voicemail|message|new|received|from|caller|caller id|phone)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  return { number, name };
}

function findPhoneNumbers(text) {
  const matches = String(text || "").match(/(?:\+?1[ .()\-]*)?(?:\d[ .()\-]*){10}/g) || [];
  const result = [];
  for (const match of matches) {
    const number = normalizePhone(match);
    if (number.length === 10 && !result.includes(number)) result.push(number);
  }
  return result;
}

function sanitizeName(value) {
  const clean = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:;,.\-]+|[\s:;,.\-]+$/g, "")
    .trim();
  if (!clean || /^(unknown|private|anonymous|unavailable|none|n\/a)$/i.test(clean)) return "";
  if (clean.length > 80 || /^\d+$/.test(clean)) return "";
  return clean;
}

function parseDateCandidate(value) {
  const text = String(value || "").trim();
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  const normalized = text.replace(/\bat\b/i, " ").replace(/\s+/g, " ");
  const retry = new Date(normalized);
  return Number.isNaN(retry.getTime()) ? null : retry;
}

function htmlToText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"');
}

function audioScore(attachment) {
  const type = String(attachment?.mimeType || "").toLowerCase();
  const name = String(attachment?.filename || "").toLowerCase();
  if (name.endsWith(".mp3")) return 100;
  if (name.endsWith(".wav49")) return 90;
  if (name.endsWith(".wav")) return 80;
  if (type === "audio/mpeg" || type === "audio/mp3") return 75;
  if (type.startsWith("audio/")) return 60;
  return 0;
}

function extractEmailAddress(value) {
  const match = String(value || "").match(/<?([^<>\s]+@[^<>\s]+)>?/);
  return (match?.[1] || String(value || "")).toLowerCase();
}

function parseCsv(value) {
  return String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function truncateSms(value, max) {
  const text = String(value || "");
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

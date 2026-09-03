import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { isMp3, isRiffWave } from "../src/audio.js";

const DID = "8605060971";
const DESTINATION = "2035550182";
const CALLER = "9145550100";

/** Minimal in-memory stand-in for the R2 bucket binding. */
function createBucket() {
  const store = new Map();
  return {
    store,
    async put(key, value, options = {}) {
      const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
      store.set(key, { bytes, httpMetadata: options.httpMetadata || {}, customMetadata: options.customMetadata || {} });
    },
    async head(key) {
      const entry = store.get(key);
      return entry ? makeObject(entry) : null;
    },
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        ...makeObject(entry),
        body: entry.bytes,
        async text() {
          return new TextDecoder().decode(entry.bytes);
        },
      };
    },
  };

  function makeObject(entry) {
    return {
      size: entry.bytes.byteLength,
      customMetadata: entry.customMetadata,
      writeHttpMetadata(headers) {
        if (entry.httpMetadata.contentType) headers.set("content-type", entry.httpMetadata.contentType);
      },
    };
  }
}

function makeEnv(overrides = {}) {
  return {
    VOIPMS_API_USERNAME: "api@example.com",
    VOIPMS_API_PASSWORD: "secret",
    VOIPMS_DID: DID,
    MMS_DESTINATION: DESTINATION,
    TIME_ZONE: "America/New_York",
    PUBLIC_BASE_URL: "https://voicemail-to-mms.example.workers.dev",
    RECORDING_LINK_SECRET: "test-signing-secret",
    VOICEMAIL_BUCKET: createBucket(),
    ...overrides,
  };
}

function buildWav(seconds, sampleRate = 8000) {
  const count = Math.round(seconds * sampleRate);
  const bytes = new Uint8Array(44 + count * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + count * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 9000), true);
  }
  return bytes;
}

function base64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Build the voicemail notification email VoIP.ms actually sends. */
function buildVoicemailEmail(attachment, { filename = "msg0018.wav", mimeType = "audio/x-wav" } = {}) {
  const boundary = "----voicemail-boundary";
  const body = [
    `From: "VoIP.ms" <noreply@voipinterface.net>`,
    `To: voicemail@example.com`,
    `Subject: New  voicemail in mailbox 60971 from "${CALLER}" <${CALLER}>`,
    `Date: Wed, 02 Sep 2026 21:06:57 -0400`,
    `Message-ID: <vm-test-1@voipinterface.net>`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=us-ascii`,
    ``,
    `You have a new voicemail message.`,
    ``,
    `--${boundary}`,
    `Content-Type: ${mimeType}; name="${filename}"`,
    `Content-Transfer-Encoding: base64`,
    `Content-Disposition: attachment; filename="${filename}"`,
    ``,
    base64(attachment).replace(/(.{76})/g, "$1\r\n"),
    ``,
    `--${boundary}--`,
    ``,
  ].join("\r\n");

  return new TextEncoder().encode(body);
}

function makeMessage(raw) {
  const headers = new Map([
    ["message-id", "<vm-test-1@voipinterface.net>"],
    ["date", "Wed, 02 Sep 2026 21:06:57 -0400"],
  ]);
  return {
    from: "noreply@voipinterface.net",
    to: "voicemail@example.com",
    rawSize: raw.byteLength,
    raw,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    setReject(reason) {
      this.rejected = reason;
    },
  };
}

/** Run the email handler with console noise suppressed and VoIP.ms stubbed out. */
async function runEmail(env, raw, respond) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    calls.push({ url, method: init?.method || "GET" });
    return respond(url, init, calls.length);
  };

  try {
    await worker.email(makeMessage(raw), env);
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(console, quiet);
  }

  return calls;
}

const okMms = () => new Response(JSON.stringify({ status: "success", mms: 10208872 }), { status: 200 });
const okSms = () => new Response(JSON.stringify({ status: "success", sms: 10208873 }), { status: 200 });

test("sends the voicemail as an MMS whose media1 is a fetchable WAV URL", async () => {
  const env = makeEnv();
  const raw = buildVoicemailEmail(buildWav(3));
  const calls = await runEmail(env, raw, okMms);

  assert.equal(calls.length, 1, "one VoIP.ms call, no SMS fallback");
  const params = calls[0].url.searchParams;
  assert.equal(params.get("method"), "sendMMS");
  assert.equal(params.get("did"), DID);
  assert.equal(params.get("dst"), DESTINATION);
  assert.match(params.get("message"), /^Voicemail from 914-555-0100 - Sep 2, 2026, 9:06 PM$/);

  // The media must be a URL VoIP.ms can fetch. Inline base64/data: media is
  // accepted by the API but delivered as a zero-byte attachment.
  const media = params.get("media1");
  assert.ok(media.startsWith("https://"), `media1 should be an https URL, got ${media.slice(0, 40)}`);
  assert.ok(!media.startsWith("data:"), "media1 must not be a data URL");
  assert.match(media, /\/r\/[A-Za-z0-9_-]{22}\.wav$/, "WAV is offered first, being what the handset plays");

  const [key] = [...env.VOICEMAIL_BUCKET.store.keys()].filter((name) => name.endsWith(".wav"));
  const stored = env.VOICEMAIL_BUCKET.store.get(key);
  assert.ok(isRiffWave(stored.bytes), "archived recording should be WAV");
  assert.ok(stored.bytes.byteLength > 1000, "archived recording should not be empty");
  assert.equal(stored.httpMetadata.contentType, "audio/wav");
});

test("falls back to the MP3 candidate when VoIP.ms rejects the WAV", async () => {
  const env = makeEnv({ MMS_MEDIA_FORMATS: "wav,mp3" });
  const calls = await runEmail(env, buildVoicemailEmail(buildWav(2)), (url) =>
    /\.wav$/.test(url.searchParams.get("media1") || "")
      ? new Response(JSON.stringify({ status: "invalid_media" }), { status: 200 })
      : okMms());

  assert.equal(calls.length, 2, "WAV attempted, then MP3");
  assert.match(calls[0].url.searchParams.get("media1"), /\.wav$/);
  assert.match(calls[1].url.searchParams.get("media1"), /\.mp3$/);
  assert.equal(calls[1].url.searchParams.get("method"), "sendMMS");

  const played = await worker.fetch(new Request(calls[1].url.searchParams.get("media1")), env);
  assert.equal(played.headers.get("content-type"), "audio/mpeg");
  assert.ok(isMp3(new Uint8Array(await played.arrayBuffer())));
});

test("honours MMS_MEDIA_FORMATS to force a single format", async () => {
  const env = makeEnv({ MMS_MEDIA_FORMATS: "mp3" });
  const calls = await runEmail(env, buildVoicemailEmail(buildWav(2)), okMms);

  assert.equal(calls.length, 1);
  assert.match(calls[0].url.searchParams.get("media1"), /\.mp3$/);
});

test("serves the signed recording URL with an audio content type and length", async () => {
  const env = makeEnv();
  const calls = await runEmail(env, buildVoicemailEmail(buildWav(2)), okMms);
  const mediaUrl = calls[0].url.searchParams.get("media1");

  const get = await worker.fetch(new Request(mediaUrl), env);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("content-type"), "audio/wav");
  const body = new Uint8Array(await get.arrayBuffer());
  assert.equal(get.headers.get("content-length"), String(body.byteLength));
  assert.ok(isRiffWave(body));

  const head = await worker.fetch(new Request(mediaUrl, { method: "HEAD" }), env);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "audio/wav");
  assert.equal(head.headers.get("content-length"), String(body.byteLength));

  // A token of the right shape that was never issued, rather than a mutation of
  // the real one — flipping a character can land back on the issued token.
  const unknown = mediaUrl.replace(/\/r\/[^.]+/, `/r/${"A".repeat(22)}`);
  assert.notEqual(unknown, mediaUrl);
  assert.equal(
    (await worker.fetch(new Request(unknown), env)).status,
    404,
    "an unknown token must not resolve to a recording",
  );
});

test("passes an MP3 attachment through without re-encoding", async () => {
  const env = makeEnv();
  const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00, ...new Uint8Array(4096)]);
  const raw = buildVoicemailEmail(mp3, { filename: "msg0009.MP3", mimeType: "audio/mpeg" });
  const calls = await runEmail(env, raw, okMms);

  assert.equal(calls.length, 1);
  assert.match(calls[0].url.searchParams.get("media1"), /\/r\/[A-Za-z0-9_-]{22}\.mp3$/);
  const [key] = [...env.VOICEMAIL_BUCKET.store.keys()].filter((name) => name.startsWith("voicemails/"));
  assert.deepEqual(env.VOICEMAIL_BUCKET.store.get(key).bytes, mp3);
});

test("falls back to SMS with a listening link when VoIP.ms rejects the MMS", async () => {
  const env = makeEnv();
  const raw = buildVoicemailEmail(buildWav(2));
  const calls = await runEmail(env, raw, (url) =>
    url.searchParams.get("method") === "sendMMS"
      ? new Response(JSON.stringify({ status: "invalid_media" }), { status: 200 })
      : okSms());

  assert.equal(calls.length, 2, "the WAV candidate, then SMS");
  assert.equal(calls[1].url.searchParams.get("method"), "sendSMS");
  const text = calls[1].url.searchParams.get("message");
  assert.ok(text.length <= 160, `SMS must fit one segment, got ${text.length}`);

  // A link cut short by the 160-character limit is useless, so assert the URL
  // in the SMS actually resolves.
  const [, link] = text.match(/Listen: (\S+)$/) || [];
  assert.ok(link, `expected an untruncated link in ${text}`);
  const page = await worker.fetch(new Request(link), env);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  const html = await page.text();
  assert.match(html, /914-555-0100/, "the player page names the caller");
  const [, audioSrc] = html.match(/<audio[^>]*src="([^"]+)"/) || [];
  assert.ok(audioSrc, "player page should embed an audio element");
  const audio = await worker.fetch(new Request(audioSrc), env);
  assert.ok(isRiffWave(new Uint8Array(await audio.arrayBuffer())));
});

test("falls back to SMS when no fetchable media URL can be produced", async () => {
  const env = makeEnv({ PUBLIC_BASE_URL: "" });
  const raw = buildVoicemailEmail(buildWav(2));
  const calls = await runEmail(env, raw, okSms);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.searchParams.get("method"), "sendSMS");
  assert.match(calls[0].url.searchParams.get("message"), /MMS media hosting is not configured/);
  assert.ok(calls[0].url.searchParams.get("message").length <= 160);
});

test("falls back to SMS when the attachment cannot be transcoded", async () => {
  const env = makeEnv();
  const gsm = buildWav(1);
  new DataView(gsm.buffer).setUint16(20, 0x31, true); // WAVE_FORMAT_GSM610
  const calls = await runEmail(env, buildVoicemailEmail(gsm), okSms);

  assert.equal(calls.length, 1, "no MMS attempt for media VoIP.ms would reject");
  assert.equal(calls[0].url.searchParams.get("method"), "sendSMS");

  // The original recording is still archived, so the SMS carries a link to it
  // rather than only telling the user to dial voicemail.
  const text = calls[0].url.searchParams.get("message");
  assert.ok(text.length <= 160, `SMS must fit one segment, got ${text.length}`);
  const [, link] = text.match(/Listen: (\S+)$/) || [];
  assert.ok(link, `expected an untruncated link in ${text}`);
  const page = await worker.fetch(new Request(link), env);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
});

test("ignores a duplicate delivery of the same voicemail email", async () => {
  const env = makeEnv();
  const raw = buildVoicemailEmail(buildWav(1));
  assert.equal((await runEmail(env, raw, okMms)).length, 1);
  assert.equal((await runEmail(env, raw, okMms)).length, 0, "second delivery should send nothing");
});

test("health endpoint reports the media-URL transport", async () => {
  const response = await worker.fetch(new Request("https://worker.example/health"), makeEnv());
  const body = await response.json();
  assert.equal(body.mmsMediaReady, true);
  assert.deepEqual(body.mmsMediaMissingBindings, []);
  assert.deepEqual(body.mmsMediaFormats, ["wav"]);
  assert.match(body.outboundTransport, /first accepted format wins/);
});

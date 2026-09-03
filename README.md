# voicemail-to-mms

Cloudflare Email Worker that receives VoIP.ms voicemail notification emails, extracts the voicemail audio, and sends the recording to a phone as an MMS through the VoIP.ms API.

## Flow

1. A missed cellular call is conditionally forwarded to the VoIP.ms DID.
2. The DID routes directly to a VoIP.ms voicemail mailbox.
3. VoIP.ms records the voicemail and emails the MP3/WAV attachment to the Cloudflare Email Routing address.
4. Cloudflare routes the email to this Worker.
5. The Worker validates that the sender is from `voip.ms` or `voipinterface.net`, parses the voicemail email, extracts caller information and time, and finds the audio attachment.
6. The Worker re-encodes the recording into the configured media formats, stores them in R2, and publishes a short unguessable URL for each.
7. The Worker sends an MMS through the VoIP.ms `sendMMS` API with a short message, uploading the recording as a multipart file part. If VoIP.ms refuses it, the next transport and format pair is offered.
8. If MMS cannot be sent, the Worker sends a normal SMS fallback carrying the same listening link so the voicemail is not silently missed.

## How the media is delivered

Three behaviours drive the delivery path, all observed against the live API and a real handset:

- **`media1` as a base64 string produces a zero-byte attachment.** Base64 in `media1`/`media2` and a `data:` URL are all accepted by the API and return `status: success` with a message ID, but the delivered message carries a **zero-byte, zero-second attachment**. A base64 string is never sent.
- **The recording is not the problem.** The exact WAV this Worker produces was downloaded from its own link and uploaded by hand through the VoIP.ms portal; that message arrived and played on the handset. Canonical mono 16-bit PCM at 8 kHz, 44-byte header.
- **The carrier drops MP3.** Confirmed both through this Worker and by sending an MP3 by hand from the portal to the same handset. MP3 is the worse failure of the two, because `sendMMS` reports success, no fallback fires, and nothing arrives.
- **`sendMMS` refuses those same WAV bytes when they are passed as a URL** (`invalid_media`) or as a base64 string. The URL shape is not the cause — a clean extension-terminated URL with a content length and HEAD support is refused identically.

The portal *uploads* the recording; every earlier attempt here only ever handed the API a string. So the Worker now sends `media1` as a genuine multipart file part — Blob, filename and content type, the way a browser form uploads — and falls back to the URL transport if that is refused.

Two knobs control the attempt order, and the Worker tries every format over every transport before giving up:

- `MMS_MEDIA_FORMATS` - `wav` (default), `mp3`, `wav,mp3`, `mp3,wav`
- `MMS_TRANSPORTS` - `multipart_file,get_url` (default), plus `multipart_url` and `post_url`

`mms_success` names the winning format and transport; each refusal is logged as `mms_candidate_rejected` with the API's own reason.

### Finding a format that works

`GET /diagnostics/media-probe?key=<PROBE_KEY or RECORDING_LINK_SECRET>` sends one short test MMS per format/transport pair and reports which ones `sendMMS` accepts, so the API's verdict on a whole set is known in one request instead of one voicemail at a time.

It defaults to one 8 kHz PCM WAV across every transport, since the format question is settled and the transport question is not. Widen it with `&variants=` (`wav-8k-pcm16`, `wav-16k-pcm16`, `wav-22k-pcm16`, `wav-44k-pcm16`, `wav-44k-stereo`, `wav-8k-mulaw`, `mp3-16k`), narrow it with `&transports=`, and set clip length with `&seconds=`.

These are real, billable messages to `MMS_DESTINATION`, so the endpoint 404s without the key and never runs on its own. Anything the API accepts still has to survive the carrier — check which numbered probes actually arrive.

WAV is re-encoded to canonical mono 16-bit PCM at the recorded sample rate. MP3 is mono at 32 kbps, upsampled to 16 kHz so it is MPEG-2 Layer III rather than the less widely supported MPEG-2.5. Because 8 kHz PCM runs 16 KB per second, the WAV candidate is dropped for recordings past roughly 43 seconds and MP3 ships alone.

## Required Cloudflare variables/secrets

Configure these in **Workers & Pages → voicemail-to-mms → Settings → Variables and Secrets**.

| Name | Type | Purpose |
| --- | --- | --- |
| `VOIPMS_API_USERNAME` | Secret | VoIP.ms API username/email |
| `VOIPMS_API_PASSWORD` | Secret | Dedicated VoIP.ms API password |
| `VOIPMS_DID` | Text | SMS/MMS-capable VoIP.ms DID used as sender |
| `MMS_DESTINATION` | Text | Phone number that receives the voicemail MMS |
| `PUBLIC_BASE_URL` | Text | Public URL of this Worker, no trailing slash. Backs the SMS listening link and the URL transport. |

An R2 bucket bound as `VOICEMAIL_BUCKET` stores the recordings and backs the listening links. The default file-upload transport carries the audio in the request itself, so MMS delivery does not depend on either.

No credentials or phone numbers are committed to GitHub.

## Optional variables

| Name | Purpose |
| --- | --- |
| `TIME_ZONE` | Notification time zone. Defaults to `America/New_York`. |
| `CONTACTS_JSON` | Optional JSON phone-to-name map, e.g. `{"8455551212":"John Smith"}`. A matching contact name overrides Caller ID name from the voicemail email. |
| `ALLOWED_SENDER_DOMAINS` | Comma-separated sender domains. Defaults to `voip.ms,voipinterface.net`. |
| `MMS_MEDIA_FORMATS` | Ordered media formats to offer VoIP.ms. Defaults to `wav`. |
| `MMS_TRANSPORTS` | Ordered `sendMMS` transports. Defaults to `multipart_file,get_url`. |
| `PROBE_KEY` | Key for `/diagnostics/media-probe`. Falls back to `RECORDING_LINK_SECRET`; the probe is disabled when neither is set. |

## Message format

When caller information is available, the MMS text is similar to:

`Voicemail from John Smith (845-555-1212) - Aug 31, 2026, 5:32 PM`

The recording is attached as the MMS media.

## Failure handling

- Missing audio attachment: send an SMS telling the user to call voicemail.
- Audio too large for MMS after transcoding: send an SMS with a listening link.
- Recording in a format the Worker cannot transcode (for example GSM 6.10 `wav49`): archive it as-is and send an SMS with a listening link.
- Every media format rejected by VoIP.ms: send an SMS with a listening link.
- No fetchable media URL configured and only URL transports enabled: send an SMS naming that as the reason. The file-upload transport needs no hosting and is still attempted.
- VoIP.ms MMS failure: send an SMS with a listening link.
- Temporary VoIP.ms/API rate errors: retry with short exponential backoff.
- Unexpected sender domains: reject the incoming email so the public voicemail address cannot easily be abused as an MMS relay.

Fallback texts always keep the link intact - the caller/time prefix is shortened to fit 160 characters rather than truncating the URL.

## R2 storage and listening links

The R2 bucket bound as `VOICEMAIL_BUCKET` holds three things:

- `voicemails/<yyyy>/<mm>/<dd>/...` - the prepared recording, also served to VoIP.ms when a URL transport is used.
- `probes/...` - test clips from `/diagnostics/media-probe`.
- `links/<token>` - a pointer that maps a 128-bit random token to a recording and an expiry.
- `events/<id>.json` - a processed-event marker so duplicate email delivery does not generate duplicate texts.

Recording URLs look like `https://<worker-host>/r/<token>`, which renders a small player page naming the caller and time. The same token plus the file extension (`/r/<token>.wav`) serves the audio itself, and that is what VoIP.ms fetches as MMS media. The token is the secret, which keeps the URL short enough to survive inside a 160-character SMS fallback; the previous long signed URL was cut off mid-link and unusable.

Optional:

- `RECORDING_LINK_TTL_SECONDS` - link lifetime; defaults to 7 days.
- `RECORDING_LINK_SECRET` - only needed to keep older `/recording/<signed>` links playable. New links do not use it.

## VoIP.ms requirements

- API enabled.
- API password configured separately from the portal password.
- API source-IP policy configured to permit the Worker.
- The chosen DID has SMS/MMS enabled and any required messaging/A2P verification completed.
- Voicemail mailbox has **Attach Message to Email = Yes**. Either **WAV** or **MP3** attachment format works; WAV is transcoded by the Worker, MP3 is passed through untouched. Avoid **WAV49** (GSM 6.10), which the Worker cannot decode.
- Voicemail notification email points to the Cloudflare Email Routing address connected to this Worker.
- Keep **Delete Voicemail Message = No** if telephone access to saved voicemails should remain available.

## Development

```bash
npm install
npm run check
npm test
npm run deploy
```

Cloudflare's Git integration deploys this Worker automatically on every push to `main`, so no deploy step runs in GitHub Actions. `npm run deploy` is only for deploying a local working copy, and needs `npx wrangler login` or a `CLOUDFLARE_API_TOKEN` environment variable.

Tests cover three layers:

- `test/core.test.js` - NANP normalization, caller-ID extraction, sender-domain validation, contact-name overrides.
- `test/audio.test.js` - WAV parsing (PCM, A-law, mu-law, stereo, bad chunk sizes), candidate ordering and size limits, and MP3 output verified by walking real MP3 frame headers for sample rate, version and duration.
- `test/worker.test.js` - the whole email handler against a stubbed VoIP.ms API and an in-memory R2, asserting that `media1` is a fetchable URL rather than inline data, that a WAV rejection falls through to the MP3 candidate, that recording URLs serve the right content type and length over GET and HEAD, and that every SMS fallback fits one segment with its link intact.

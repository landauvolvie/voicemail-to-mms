# voicemail-to-mms

Cloudflare Email Worker that receives VoIP.ms voicemail notification emails, extracts the voicemail audio, and sends the recording to a phone as an MMS through the VoIP.ms API.

## Flow

1. A missed cellular call is conditionally forwarded to the VoIP.ms DID.
2. The DID routes directly to a VoIP.ms voicemail mailbox.
3. VoIP.ms records the voicemail and emails the MP3/WAV attachment to the Cloudflare Email Routing address.
4. Cloudflare routes the email to this Worker.
5. The Worker validates that the sender is from `voip.ms` or `voipinterface.net`, parses the voicemail email, extracts caller information and time, and finds the audio attachment.
6. The Worker sends an MMS through the VoIP.ms `sendMMS` API containing a short message plus the voicemail recording.
7. If MMS cannot be sent, the Worker sends a normal SMS fallback so the voicemail is not silently missed.

## Required Cloudflare variables/secrets

Configure these in **Workers & Pages → voicemail-to-mms → Settings → Variables and Secrets**.

| Name | Type | Purpose |
| --- | --- | --- |
| `VOIPMS_API_USERNAME` | Secret | VoIP.ms API username/email |
| `VOIPMS_API_PASSWORD` | Secret | Dedicated VoIP.ms API password |
| `VOIPMS_DID` | Text | SMS/MMS-capable VoIP.ms DID used as sender |
| `MMS_DESTINATION` | Text | Phone number that receives the voicemail MMS |

No credentials or phone numbers are committed to GitHub.

## Optional variables

| Name | Purpose |
| --- | --- |
| `TIME_ZONE` | Notification time zone. Defaults to `America/New_York`. |
| `CONTACTS_JSON` | Optional JSON phone-to-name map, e.g. `{"8455551212":"John Smith"}`. A matching contact name overrides Caller ID name from the voicemail email. |
| `ALLOWED_SENDER_DOMAINS` | Comma-separated sender domains. Defaults to `voip.ms,voipinterface.net`. |

## Message format

When caller information is available, the MMS text is similar to:

`Voicemail from John Smith (845-555-1212) - Aug 31, 2026, 5:32 PM`

The recording is attached as the MMS media.

## Failure handling

- Missing audio attachment: send an SMS telling the user to call voicemail.
- Audio too large for the safe MMS/base64 threshold: send an SMS fallback.
- VoIP.ms MMS failure: send an SMS fallback.
- Temporary VoIP.ms/API rate errors: retry with short exponential backoff.
- Unexpected sender domains: reject the incoming email so the public voicemail address cannot easily be abused as an MMS relay.

## Optional R2 archive and private listening links

The Worker already supports R2, but R2 is not required for the normal voicemail-to-MMS flow.

If an R2 binding named `VOICEMAIL_BUCKET` is added, every voicemail recording is archived. It also stores a processed-event marker so duplicate email delivery does not generate duplicate texts.

For private listening links, additionally configure:

- `PUBLIC_BASE_URL` - public URL for this Worker, without a trailing slash.
- `RECORDING_LINK_SECRET` - Secret used to sign expiring links.
- `RECORDING_LINK_TTL_SECONDS` - optional; defaults to 7 days.

When R2 + private links are configured, an oversized recording is stored in R2 and the fallback SMS contains a signed listening link instead of only telling the user to call voicemail.

## VoIP.ms requirements

- API enabled.
- API password configured separately from the portal password.
- API source-IP policy configured to permit the Worker.
- The chosen DID has SMS/MMS enabled and any required messaging/A2P verification completed.
- Voicemail mailbox has **Attach Message to Email = Yes** and preferably **Attachment Format = MP3**.
- Voicemail notification email points to the Cloudflare Email Routing address connected to this Worker.
- Keep **Delete Voicemail Message = No** if telephone access to saved voicemails should remain available.

## Development

```bash
npm install
npm run check
npm test
npm run deploy
```

The parsing helpers have unit tests for NANP phone normalization, caller-name extraction, sender-domain validation, excluding the DID/destination from caller detection, and contact-name overrides.

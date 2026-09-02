import worker from "./index.js";

const VOIPMS_ENDPOINT = "https://voip.ms/api/v1/rest.php";
const DIAGNOSTIC_PATH = "/diagnostics/voipms-edge";

export default {
  async email(message, env, ctx) {
    return worker.email(message, env, ctx);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === DIAGNOSTIC_PATH) {
      return probeVoipMsEdge(request, env, ctx);
    }
    return worker.fetch(request, env, ctx);
  },
};

async function probeVoipMsEdge(request, env, ctx) {
  if (!env.VOIPMS_API_USERNAME || !env.VOIPMS_API_PASSWORD) {
    return json({
      ok: false,
      diagnostic: "voipms-edge",
      error: "Required VoIP.ms API bindings are missing",
    }, 503);
  }

  const cache = caches.default;
  const cacheKey = new Request(new URL(DIAGNOSTIC_PATH, request.url).toString(), { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const target = new URL(VOIPMS_ENDPOINT);
  target.searchParams.set("api_username", env.VOIPMS_API_USERNAME);
  target.searchParams.set("api_password", env.VOIPMS_API_PASSWORD);
  target.searchParams.set("method", "getIP");
  target.searchParams.set("content_type", "json");

  let payload;
  let status = 200;

  try {
    const response = await fetch(target.toString(), {
      method: "GET",
      headers: {
        accept: "application/json, text/plain, */*",
        "cache-control": "no-cache",
        pragma: "no-cache",
        "user-agent": "Mozilla/5.0 (compatible; voicemail-to-mms-diagnostic/1.0)",
      },
      cf: { cacheTtl: 0, cacheEverything: false },
    });

    const body = await response.text();
    const contentType = response.headers.get("content-type") || "";
    const title = body.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || "";
    const cfRay = response.headers.get("cf-ray") || "";
    const server = response.headers.get("server") || "";
    const htmlBlock = /<html|attention required|cloudflare/i.test(body) && response.status === 403;

    let providerStatus = "";
    let providerReachable = false;
    try {
      const parsed = JSON.parse(body);
      providerStatus = String(parsed.status || "");
      providerReachable = response.ok && providerStatus === "success";
    } catch {
    }

    payload = {
      ok: providerReachable,
      diagnostic: "voipms-edge",
      requestMethod: "GET",
      apiMethod: "getIP",
      httpStatus: response.status,
      providerStatus,
      providerReachable,
      blockedAtProviderEdge: htmlBlock,
      responseTitle: title,
      contentType,
      server,
      cfRay,
      checkedAt: new Date().toISOString(),
    };
    status = providerReachable ? 200 : 502;
  } catch (error) {
    payload = {
      ok: false,
      diagnostic: "voipms-edge",
      requestMethod: "GET",
      apiMethod: "getIP",
      networkError: String(error?.message || error || "unknown error").slice(0, 240),
      checkedAt: new Date().toISOString(),
    };
    status = 502;
  }

  const response = json(payload, status, {
    "cache-control": "public, max-age=60",
  });
  ctx?.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

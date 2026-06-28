/* =========================================================================
 *  Shared abuse-protection helpers, used by /api/scan and /api/contact.
 *  Both layers are env-gated: if a secret/URL isn't configured the layer is
 *  skipped, so endpoints keep working — but configure both in production.
 * ========================================================================= */

function clientIp(req) {
  const xff = (req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"])) || "";
  return String(xff).split(",")[0].trim() || "unknown";
}

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (_) { b = {}; } }
  return b || {};
}

// Verify a Cloudflare Turnstile token. Returns true on success; false when a
// token is missing/invalid. Network/Cloudflare errors fail OPEN so an outage
// can't take the form down entirely.
async function verifyTurnstile(secret, token, ip) {
  if (!token) return false;
  try {
    const form = new URLSearchParams();
    form.append("secret", secret);
    form.append("response", token);
    if (ip && ip !== "unknown") form.append("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    return !!j.success;
  } catch (_) {
    return true;
  }
}

// Per-IP daily cap + global daily cap via Upstash Redis REST. No-op (allows) if
// not configured. `bucket` namespaces the counters (e.g. "scan" vs "contact").
async function rateLimit(ip, bucket, perIpDefault, perDayDefault) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { ok: true };
  const b = bucket || "scan";
  const perIp = Number(process.env[`${b.toUpperCase()}_LIMIT_PER_IP`] || perIpDefault || 15);
  const perDay = Number(process.env[`${b.toUpperCase()}_LIMIT_GLOBAL`] || perDayDefault || 2000);
  const day = Math.floor(Date.now() / 86400000);
  async function incr(key) {
    try {
      const r = await fetch(`${url}/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify([["INCR", key], ["EXPIRE", key, 172800]]),
        signal: AbortSignal.timeout(5000),
      });
      const j = await r.json();
      return Number(j && j[0] && j[0].result) || 0;
    } catch (_) {
      return 0;
    }
  }
  if ((await incr(`${b}:ip:${day}:${ip}`)) > perIp) return { ok: false, reason: "ip" };
  if ((await incr(`${b}:all:${day}`)) > perDay) return { ok: false, reason: "global" };
  return { ok: true };
}

module.exports = { clientIp, parseBody, verifyTurnstile, rateLimit };

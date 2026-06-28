/* =========================================================================
 *  /api/contact  —  sends the contact form via Resend to contact@theaeoloop.com
 *  Server-side so submissions are delivered reliably (not dependent on the
 *  visitor having an email client). RESEND_API_KEY is read from the env only.
 * ========================================================================= */
const TO = "contact@theaeoloop.com";
const FROM = "The AEO Loop <contact@theaeoloop.com>";

function esc(s) {
  return String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};

  // Honeypot: bots fill the hidden "hp" field. Pretend success, send nothing.
  if (body.hp) { res.status(200).json({ ok: true }); return; }

  const name = String(body.name || "").slice(0, 120).trim();
  const email = String(body.email || "").slice(0, 160).trim();
  const company = String(body.company || "").slice(0, 160).trim();
  const message = String(body.message || "").slice(0, 4000).trim();

  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || message.length < 5) {
    res.status(400).json({ error: "Missing or invalid fields." });
    return;
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) { res.status(500).json({ error: "email not configured" }); return; }

  const html =
    `<p style="font:14px/1.5 system-ui,sans-serif"><strong>New website enquiry</strong></p>` +
    `<p style="font:14px/1.5 system-ui,sans-serif">From: ${esc(name)} &lt;${esc(email)}&gt;${company ? ` · ${esc(company)}` : ""}</p>` +
    `<hr><p style="font:15px/1.6 system-ui,sans-serif;white-space:pre-wrap">${esc(message)}</p>`;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        from: FROM,
        to: [TO],
        reply_to: email,
        subject: `Website enquiry — ${company || name}`,
        html,
      }),
    });
    if (!r.ok) {
      res.status(502).json({ error: "send failed", detail: (await r.text()).slice(0, 140) });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e).slice(0, 140) });
  }
};

/* =========================================================================
 *  /api/scan  —  The AEO Loop visibility scanner (server side)
 *
 *  SECURITY
 *  --------
 *  API keys are read ONLY from environment variables, never hard-coded.
 *  Set these in Vercel → Project → Settings → Environment Variables:
 *      OPENAI_API_KEY      (ChatGPT)
 *      GEMINI_API_KEY      (Gemini)
 *      XAI_API_KEY         (Grok)
 *      ANTHROPIC_API_KEY   (Claude)
 *  If a key is missing, that engine returns a clearly-labelled demo verdict,
 *  so the site works out of the box and becomes live the moment keys exist.
 *
 *  This runs as a Node serverless function on Vercel. No keys ever reach the
 *  browser. Do not import or expose process.env to the client.
 * ========================================================================= */

// Vercel's waitUntil keeps the function alive to finish background work (the
// Gap Report) after the scan response has already been sent. Fallback is a
// no-op-safe passthrough so the scanner never breaks if it's unavailable.
let waitUntil = function (p) { return p; };
try { ({ waitUntil } = require("@vercel/functions")); } catch (_) {}

const FOUNDER_EMAIL = "contact@theaeoloop.com";
const FROM_EMAIL = "The AEO Loop <contact@theaeoloop.com>";

const STATE_BANDS = {
  recommended: [75, 90],
  mentioned:   [45, 60],
  cited:       [38, 50],
  competitor:  [18, 30],
  excluded:    [5, 18],
};

const GAPS = {
  local:     { label: "Weak Local Relevance", fix: "LocalBusiness schema, location-specific content, Google Business Profile." },
  thin:      { label: "Thin Service Pages",   fix: "Dedicated service pages with FAQ blocks and clear entity language." },
  citations: { label: "Missing Citations",    fix: "Off-site authority placements, directory submissions, review generation." },
  reviews:   { label: "Low Review Density",   fix: "Structured review acquisition across Google, Trustpilot and niche platforms." },
  entity:    { label: "Weak Entity Clarity",  fix: "Organisation schema, consistent NAP, Wikipedia/Wikidata presence." },
  dominance: { label: "Competitor Dominance", fix: "Targeted content and citation strategy against the dominant player." },
};

const PROMPT_TEMPLATES = [
  (a, l) => `Best ${a} companies in ${l}`,
  (a, l) => `Who should I hire for ${a} services in ${l}?`,
  (a, l) => `Top recommended ${a} providers near ${l}`,
  (a, l) => `Most trusted ${a} firms in ${l}`,
  (a, l) => `${a} experts in ${l} — who stands out?`,
];

function systemPrompt(engineName, vendor, input, userPrompt) {
  return [
    `You are evaluating how the AI engine "${engineName}" (by ${vendor}) would respond to a real buying-intent query, and classifying the visibility of one specific business.`,
    ``,
    `BUSINESS UNDER TEST`,
    `- Company: ${input.company}`,
    `- Website: ${input.website}`,
    `- Area of operation: ${input.area}`,
    `- Location: ${input.city}`,
    ``,
    `QUERY: "${userPrompt}"`,
    ``,
    `Classify the business into EXACTLY ONE of these five states by strict rule:`,
    `- "recommended": named with a positive recommendation to hire / a specific strength / positioned as a good fit.`,
    `- "mentioned": name appears but with no endorsement (passing reference or list item).`,
    `- "cited": website/content referenced as a source, but not as a hiring recommendation.`,
    `- "competitor": a named competitor appears in a recommended/mentioned position where this business should logically appear.`,
    `- "excluded": not mentioned in any form despite the query being directly relevant.`,
    ``,
    `Then assign EXACTLY ONE gap category from: local, thin, citations, reviews, entity, dominance.`,
    ``,
    `Return ONLY a strict JSON object, no markdown, no commentary, in this shape:`,
    `{"classification":"<state>","reason":"<one plain sentence>","competitor":"<name or null>","gap":"<category>"}`,
  ].join("\n");
}

function clampScore(state) {
  const b = STATE_BANDS[state] || STATE_BANDS.excluded;
  return Math.round(b[0] + Math.random() * (b[1] - b[0]));
}

function normalise(raw, engine, input) {
  let parsed = null;
  try {
    const match = String(raw).match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch (_) { parsed = null; }

  if (!parsed || !STATE_BANDS[parsed.classification]) return null;
  const gapKey = GAPS[parsed.gap] ? parsed.gap : "thin";
  return {
    engine: engine.key,
    name: engine.name,
    vendor: engine.vendor,
    tag: engine.tag,
    classification: parsed.classification,
    score: clampScore(parsed.classification),
    reason: String(parsed.reason || "").slice(0, 220) || "Classified from the engine response.",
    competitor: parsed.competitor && parsed.competitor !== "null" ? String(parsed.competitor).slice(0, 60) : null,
    gap: gapKey,
    gapLabel: GAPS[gapKey].label,
    gapFix: GAPS[gapKey].fix,
    live: true,
  };
}

/* ---- demo fallback for a single engine (no key configured) ---- */
function demoEngine(engine, input, i) {
  const order = ["excluded", "competitor", "mentioned", "cited", "recommended"];
  const state = order[i % order.length];
  const comps = ["Meridian", "Brightpath", "Calderwood", "Northgate"];
  const comp = state === "competitor" ? comps[i % comps.length] : null;
  const gapKey = state === "competitor" ? "dominance" : state === "excluded" ? "citations" : state === "cited" ? "thin" : state === "mentioned" ? "reviews" : "entity";
  const reason = state === "recommended" ? "Named with a positive recommendation in direct response to the query."
    : state === "mentioned" ? `${input.company} appears as a passing list item, with no endorsement.`
    : state === "cited" ? "The website is referenced as a source, but not recommended to hire."
    : state === "competitor" ? `${comp} is recommended in the position ${input.company} should hold.`
    : `${input.company} is not mentioned in any form for this query.`;
  return {
    engine: engine.key, name: engine.name, vendor: engine.vendor, tag: engine.tag,
    classification: state, score: clampScore(state), reason,
    competitor: comp, gap: gapKey, gapLabel: GAPS[gapKey].label, gapFix: GAPS[gapKey].fix, live: false,
  };
}

/* ---- provider callers. Each returns the raw text content, or throws. ---- */
async function callOpenAI(key, sys, user) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      response_format: { type: "json_object" },
      max_tokens: 300, temperature: 0.2,
    }),
  });
  if (!r.ok) throw new Error("openai " + r.status);
  const j = await r.json();
  return j.choices?.[0]?.message?.content || "";
}

async function callAnthropic(key, sys, user) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: sys,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error("anthropic " + r.status);
  const j = await r.json();
  return (j.content || []).map((b) => b.text || "").join("");
}

async function callGemini(key, sys, user) {
  // Try current flash model names in order; a 404 means that name isn't
  // available on this key, so fall through to the next. Stop on any other
  // status (401/403/429) since another model name won't fix those.
  const models = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest"];
  let lastStatus = 0;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const generationConfig = {
      temperature: 0.2,
      maxOutputTokens: 700,
      responseMimeType: "application/json",
    };
    // 2.5 models "think" by default and can burn the token budget before
    // emitting the answer; disable thinking so the full budget is the JSON.
    if (model.indexOf("2.5") !== -1) generationConfig.thinkingConfig = { thinkingBudget: 0 };
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: sys }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig,
        }),
      }
    );
    if (r.ok) {
      const j = await r.json();
      return j.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    }
    lastStatus = r.status;
    if (r.status !== 404) break;
  }
  throw new Error("gemini " + lastStatus);
}

async function callGrok(key, sys, user) {
  const r = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "grok-3",
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      max_tokens: 300, temperature: 0.2,
    }),
  });
  if (!r.ok) throw new Error("grok " + r.status);
  const j = await r.json();
  return j.choices?.[0]?.message?.content || "";
}

const ENGINES = [
  { key: "chatgpt", name: "ChatGPT", vendor: "OpenAI",    tag: "GPT", env: "OPENAI_API_KEY",    call: callOpenAI },
  { key: "gemini",  name: "Gemini",  vendor: "Google",    tag: "GE",  env: "GEMINI_API_KEY",    call: callGemini },
  { key: "grok",    name: "Grok",    vendor: "xAI",       tag: "GR",  env: "XAI_API_KEY",       call: callGrok },
  { key: "claude",  name: "Claude",  vendor: "Anthropic", tag: "CL",  env: "ANTHROPIC_API_KEY", call: callAnthropic },
];

/* ---- lead capture: append one row to the Google Sheet via Apps Script ----
 * Reads the webhook URL + shared secret from environment variables. If the URL
 * is not set, this is a silent no-op so the scanner keeps working. Lead capture
 * never blocks or fails the scan response. ---------------------------------- */
const STATE_LABELS = {
  recommended: "Recommended",
  mentioned:   "Mentioned",
  cited:       "Cited",
  competitor:  "Competitor",
  excluded:    "Excluded",
};

async function saveLead(payload) {
  const url = process.env.SHEET_WEBHOOK_URL;
  if (!url) return; // not configured yet — skip cleanly
  const { input, results, summary } = payload;
  const byEngine = {};
  results.forEach((r) => {
    byEngine[r.engine] = `${STATE_LABELS[r.classification] || r.classification} · ${r.score}`;
  });
  const row = {
    secret: process.env.SHEET_WEBHOOK_SECRET || "",
    name: input.name,
    email: input.email,
    company: input.company,
    website: input.website,
    city: input.city,
    area: input.area,
    mode: payload.mode,
    overall: summary.overall,
    recommended: summary.recommended,
    excluded: summary.excluded,
    topCompetitor: summary.topCompetitor
      ? `${summary.topCompetitor} (${summary.topCompetitorCount})`
      : "",
    primaryGap: summary.primaryGap || "",
    chatgpt: byEngine.chatgpt || "",
    gemini: byEngine.gemini || "",
    grok: byEngine.grok || "",
    claude: byEngine.claude || "",
    prompt: payload.prompt || "",
  };
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(row),
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(t);
  } catch (_) {
    // never block the scan on lead capture
  }
}

function summarise(results, input) {
  const overall = Math.round(results.reduce((a, r) => a + r.score, 0) / results.length);
  const recommended = results.filter((r) => r.classification === "recommended").length;
  const excluded = results.filter((r) => r.classification === "excluded").length;
  const comps = {};
  results.forEach((r) => { if (r.competitor) comps[r.competitor] = (comps[r.competitor] || 0) + 1; });
  const topCompetitor = Object.keys(comps).sort((a, b) => comps[b] - comps[a])[0] || null;
  const gaps = {};
  results.forEach((r) => { gaps[r.gapLabel] = (gaps[r.gapLabel] || 0) + 1; });
  const primaryGap = Object.keys(gaps).sort((a, b) => gaps[b] - gaps[a])[0] || null;
  const anyLive = results.some((r) => r.live);
  return {
    input,
    results,
    summary: { overall, recommended, excluded, topCompetitor, topCompetitorCount: topCompetitor ? comps[topCompetitor] : 0, primaryGap },
    mode: anyLive ? "live" : "demo",
  };
}

/* ---- Gap Report: generate from scan data and email a draft to the founder.
 * Runs in the background (via waitUntil) so it never delays scan verdicts.
 * The report is a strategic diagnosis only — guardrails forbid implementation
 * detail — and is emailed to the founder to review before sending to a client.
 * No-op (with a clear log) if ANTHROPIC_API_KEY or RESEND_API_KEY is missing. */
function stripFence(s) {
  return String(s || "").replace(/^\s*```(?:html)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

function gapReportPrompt(payload) {
  const { input, results, summary } = payload;
  const lines = results
    .map((r) => `- ${r.name} (${r.vendor}): ${r.classification.toUpperCase()} — ${r.score}/100. ${r.reason}${r.competitor ? ` Competitor surfaced: ${r.competitor}.` : ""} Gap: ${r.gapLabel}.`)
    .join("\n");
  return [
    `You are an expert AI visibility strategist writing a client-facing "Gap Report" for ${input.company}.`,
    ``,
    `SCAN DATA — the factual foundation. Build every section on this; do not invent data:`,
    `Company: ${input.company} | Website: ${input.website} | Area: ${input.area} | Location: ${input.city}`,
    `Prompt used: "${payload.prompt}"`,
    `Overall visibility: ${summary.overall}/100. Recommended on ${summary.recommended} engine(s), Excluded on ${summary.excluded}.`,
    `Most surfaced competitor: ${summary.topCompetitor || "none"}. Primary gap: ${summary.primaryGap || "n/a"}.`,
    `Per-engine results:`,
    lines,
    ``,
    `Write a professional 11-section Gap Report in clean semantic HTML — use <h2>, <h3>, <p>, <ul>, <table>; NO <html>/<head>/<body> wrapper, NO markdown, NO inline styles, NO code fences.`,
    `Sections in order: 1) Executive Summary 2) Inputs Used 3) AI Recommendation Coverage 4) Citation Coverage 5) Competitor Coverage 6) Authority Gaps 7) Structure Gaps 8) Prompt Intent Matrix 9) Off-site Authority Snapshot 10) Priority Fixes 11) Final Recommendation.`,
    ``,
    `CONFIDENTIALITY (critical): this is a diagnostic and strategic summary, NOT an implementation guide. Do NOT include copy-ready page drafts, step-by-step instructions, schema or JSON-LD code, the scanning prompt library, tool names, or platform-specific settings. Keep everything at the strategic / categorical level.`,
    `PRIORITY FIXES guardrail: each fix names the CATEGORY of work and why it matters — never the method, tool, sequence, or output format. Correct example: "Your service pages lack the structured, extractable content engines need to cite you as a recommendation source. A paid implementation addresses this directly."`,
    `Final Recommendation must route the client toward the Implementation package or Growth retainer, and include this caveat verbatim: "AI visibility is measured through repeated prompt sampling and should be read directionally; month-to-month change can reflect optimisation work, competitor activity, or platform updates."`,
    `Tone: confident, senior, concise.`,
  ].join("\n");
}

async function callAnthropicReport(key, prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 3200,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) throw new Error("anthropic-report " + r.status);
  const j = await r.json();
  return (j.content || []).map((b) => b.text || "").join("");
}

async function emailGapReport(html, payload) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("no RESEND_API_KEY");
  const { input, summary } = payload;
  const intro =
    `<p style="font:14px/1.5 system-ui,sans-serif;color:#444">` +
    `<strong>Draft Gap Report — review before sending.</strong><br>` +
    `Lead: ${input.name} &lt;${input.email}&gt; · ${input.company} · ${input.area} · ${input.city}<br>` +
    `Overall ${summary.overall}/100 · Recommended ${summary.recommended} · Excluded ${summary.excluded} · ` +
    `Top competitor: ${summary.topCompetitor || "none"} · Primary gap: ${summary.primaryGap || "n/a"}` +
    `</p><hr>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [FOUNDER_EMAIL],
      reply_to: input.email,
      subject: `Gap Report draft — ${input.company} (${summary.overall}/100)`,
      html: intro + html,
    }),
  });
  if (!r.ok) throw new Error("resend " + r.status + " " + (await r.text()).slice(0, 160));
}

async function generateAndEmailGapReport(payload) {
  const akey = process.env.ANTHROPIC_API_KEY;
  if (!akey || !process.env.RESEND_API_KEY) return; // not configured yet — skip cleanly
  const html = stripFence(await callAnthropicReport(akey, gapReportPrompt(payload)));
  if (!html) return;
  await emailGapReport(html, payload);
}

module.exports = async function handler(req, res) {
  // ---- Diagnostics: GET /api/scan?debug=<SHEET_WEBHOOK_SECRET> returns
  // per-engine health (NO secrets in the output). Gated behind the secret so
  // the public can't trigger real API calls. Any other GET returns 404.
  if (req.method === "GET") {
    const debug = (req.query && req.query.debug) || "";
    if (!process.env.SHEET_WEBHOOK_SECRET || debug !== process.env.SHEET_WEBHOOK_SECRET) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // Lightweight gap-report self-test: ?debug=<secret>&report=1 generates +
    // emails ONE sample Gap Report and returns the outcome. Skips the engine
    // and webhook checks so it stays well within the function time limit.
    if (req.query && req.query.report === "1") {
      const samplePayload = {
        input: { company: "Diagnostic Co", website: "example.com", name: "Diag Founder", email: "diag@example.com", area: "plumbing", city: "Austin, TX" },
        results: ENGINES.map((e) => ({ engine: e.key, name: e.name, vendor: e.vendor, tag: e.tag, classification: "excluded", score: 10, reason: "Diagnostic sample.", competitor: null, gap: "citations", gapLabel: GAPS.citations.label, gapFix: GAPS.citations.fix, live: true })),
        summary: { overall: 10, recommended: 0, excluded: 4, topCompetitor: null, topCompetitorCount: 0, primaryGap: "Missing Citations" },
        prompt: "Best plumbing companies in Austin, TX",
      };
      const gapReportTest = {};
      try {
        if (!process.env.ANTHROPIC_API_KEY) gapReportTest.error = "no ANTHROPIC_API_KEY";
        else if (!process.env.RESEND_API_KEY) gapReportTest.error = "no RESEND_API_KEY";
        else {
          const html = stripFence(await callAnthropicReport(process.env.ANTHROPIC_API_KEY, gapReportPrompt(samplePayload)));
          gapReportTest.generated = !!html;
          gapReportTest.htmlChars = html.length;
          await emailGapReport(html, samplePayload);
          gapReportTest.emailed = true;
          gapReportTest.note = "sent to " + FOUNDER_EMAIL;
        }
      } catch (e) {
        gapReportTest.error = String((e && e.message) || e).slice(0, 220);
      }
      res.status(200).json({ ok: true, resendKeySet: !!process.env.RESEND_API_KEY, anthropicKeySet: !!process.env.ANTHROPIC_API_KEY, gapReportTest });
      return;
    }

    const sampleInput = { company: "Test Co", website: "test.com", area: "plumbing", city: "Austin" };
    const userPrompt = "Best plumbing companies in Austin";
    const diagnostics = await Promise.all(
      ENGINES.map(async (eng) => {
        const key = process.env[eng.env];
        if (!key) return { engine: eng.key, keyPresent: false, ok: false, note: "no key set in env" };
        try {
          const sys = systemPrompt(eng.name, eng.vendor, sampleInput, userPrompt);
          const raw = await eng.call(key, sys, userPrompt);
          const parsed = normalise(raw, eng, sampleInput);
          return { engine: eng.key, keyPresent: true, ok: !!parsed, parsedOk: !!parsed, sample: String(raw).slice(0, 90) };
        } catch (e) {
          return { engine: eng.key, keyPresent: true, ok: false, error: String((e && e.message) || e).slice(0, 140) };
        }
      })
    );
    // Live webhook test: POST a clearly-marked row and report the reply.
    const webhook = { urlSet: !!process.env.SHEET_WEBHOOK_URL, secretSet: !!process.env.SHEET_WEBHOOK_SECRET };
    if (process.env.SHEET_WEBHOOK_URL) {
      try {
        const wr = await fetch(process.env.SHEET_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          redirect: "follow",
          body: JSON.stringify({
            secret: process.env.SHEET_WEBHOOK_SECRET || "",
            name: "Diagnostic", email: "diag@example.com",
            company: "DIAGNOSTIC TEST — delete", website: "example.com",
            city: "Test", area: "test", mode: "diagnostic",
            overall: 0, recommended: 0, excluded: 0, topCompetitor: "", primaryGap: "",
            chatgpt: "", gemini: "", grok: "", claude: "", prompt: "diagnostic",
          }),
        });
        const text = await wr.text();
        webhook.status = wr.status;
        webhook.finalUrl = String(wr.url || "").slice(0, 80);
        webhook.bodySample = text.slice(0, 180);
        webhook.looksOk = /"ok"\s*:\s*true/.test(text);
        webhook.looksUnauthorized = /unauthorized/i.test(text);
        webhook.looksLikeLoginPage = /accounts\.google\.com|sign in|requires you to sign/i.test(text);
      } catch (e) {
        webhook.error = String((e && e.message) || e).slice(0, 180);
      }
    }

    res.status(200).json({
      ok: true,
      node: process.version,
      hasFetch: typeof fetch === "function",
      webhookUrlSet: !!process.env.SHEET_WEBHOOK_URL,
      webhookSecretSet: !!process.env.SHEET_WEBHOOK_SECRET,
      resendKeySet: !!process.env.RESEND_API_KEY,
      webhook,
      diagnostics,
    });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};

  const input = {
    company: String(body.company || "").slice(0, 120).trim(),
    website: String(body.website || "").slice(0, 200).trim(),
    name:    String(body.name || "").slice(0, 120).trim(),
    email:   String(body.email || "").slice(0, 160).trim(),
    city:    String(body.city || "").slice(0, 120).trim(),
    area:    String(body.area || "").slice(0, 160).trim(),
  };

  if (!input.company || !input.area || !input.city || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
    res.status(400).json({ error: "Missing or invalid fields." });
    return;
  }

  // Build the prompt (one chosen at random, per the spec).
  const tpl = PROMPT_TEMPLATES[Math.floor(Math.random() * PROMPT_TEMPLATES.length)];
  const userPrompt = tpl(input.area, input.city);

  // Query each engine; fall back to a demo verdict per engine on any failure.
  const results = await Promise.all(
    ENGINES.map(async (eng, i) => {
      const key = process.env[eng.env];
      if (!key) return demoEngine(eng, input, i);
      try {
        const sys = systemPrompt(eng.name, eng.vendor, input, userPrompt);
        const raw = await eng.call(key, sys, userPrompt);
        return normalise(raw, eng, input) || demoEngine(eng, input, i);
      } catch (_) {
        return demoEngine(eng, input, i);
      }
    })
  );

  const payload = summarise(results, input);
  payload.prompt = userPrompt;

  // Lead capture: append the lead + verdicts to the Google Sheet before
  // returning. Awaited so the row is written, but it can never fail the scan.
  await saveLead(payload);

  // Return verdicts immediately.
  res.status(200).json(payload);

  // Gap Report: generate + email the draft to the founder in the background,
  // so it never delays the scan response. Errors are swallowed (logged) and
  // never affect the user-facing result.
  waitUntil(
    generateAndEmailGapReport(payload).catch((e) => {
      console.error("gap-report failed:", (e && e.message) || e);
    })
  );
};

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
    res.status(200).json({
      ok: true,
      node: process.version,
      hasFetch: typeof fetch === "function",
      webhookUrlSet: !!process.env.SHEET_WEBHOOK_URL,
      webhookSecretSet: !!process.env.SHEET_WEBHOOK_SECRET,
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

  // NOTE: the 3-pass Gap Report generation is triggered separately (next build
  // step) so scan verdicts return fast. e.g. await queueGapReport(payload)

  res.status(200).json(payload);
};

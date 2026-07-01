# The AEO Loop — Website

Marketing site + free **AI Visibility Scanner** for The AEO Loop, a managed Answer Engine Optimization (AEO) service. Static multipage front end with one serverless function that queries four AI engines.

- **Live domain:** theaeoloop.com
- **Contact:** contact@theaeoloop.com
- **Stack:** Static HTML/CSS/JS + one Vercel serverless function (Node). Zero build step.

---

## Pages

| File | Route | Purpose |
|------|-------|---------|
| `index.html` | `/` | Home — the problem, the Loop, classification legend, pricing teaser |
| `method.html` | `/method` | How it works — scanner architecture, scoring, gap categories, Gap Report |
| `pricing.html` | `/pricing` | Foundation Build / Growth / Authority / Enterprise tiers |
| `scanner.html` | `/scanner` | Free live AI Visibility Scanner |
| `contact.html` | `/contact` | Contact form (mailto) |
| `api/scan.js` | `/api/scan` | Serverless scanner endpoint |

---

## How the scanner works

The form on `/scanner` POSTs to `/api/scan`. The function fires a buying-intent prompt at four engines — **OpenAI (ChatGPT), Google (Gemini), xAI (Grok), Anthropic (Claude)** — classifies each result into one of four states (Recommended / Mentioned / Cited / Excluded), scores 0–100, and assigns a gap category. The scanner returns **scores and verdicts only**; the full 11-section Gap Report is produced separately by the founder-reviewed 3-pass process and emailed in 24–48h.

**Demo mode:** if an engine's API key is not set, that engine falls back to a clearly-labelled deterministic demo result. The site works the moment it deploys and goes fully live once you add keys — no code changes required.

---

## Deployment (Vercel via GitHub)

Your GitHub repo is already connected to Vercel for auto-deploy, so once the files are on `main`, Vercel builds automatically.

1. Push these files to the repo root (see git commands below).
2. In **Vercel → Project → Settings → Environment Variables**, add the four keys (see next section).
3. Redeploy (or just push) so the function picks up the variables.

No build command or framework preset is needed — it's a static site with serverless functions. `vercel.json` handles clean URLs and cache/security headers.

---

## Environment variables (set in Vercel, never in code)

| Variable | Engine |
|----------|--------|
| `OPENAI_API_KEY` | OpenAI / ChatGPT |
| `GEMINI_API_KEY` | Google / Gemini |
| `XAI_API_KEY` | xAI / Grok |
| `ANTHROPIC_API_KEY` | Anthropic / Claude |

The function reads these **only** from `process.env` server-side. They are never sent to the browser. See `.env.example`. Any missing key simply puts that one engine in demo mode.

> ⚠️ **Security:** the four keys shared during the build of this site were exposed in plain text and must be treated as compromised. **Rotate/revoke all four in their respective dashboards and paste the new values into Vercel only.** Never commit a key to git — `.gitignore` already excludes `.env`.

---

## Pending integrations (marked in `api/scan.js`)

Two hooks are stubbed near the end of the function for you to wire up:

- **Lead capture** — save `{ input, results }` to your CRM or the Google Sheet on each scan.
- **Gap Report trigger** — queue the 3-pass Gap Report job when a lead requests the full report.

```js
// e.g. await saveLead(input, results)  /  await queueGapReport(input, results)
```

---

## Local development (optional)

```bash
npm i -g vercel
vercel dev          # serves the static site + /api/scan locally
```

Create a local `.env` (copied from `.env.example`) for local key testing. Do not commit it.

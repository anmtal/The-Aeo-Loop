/* =========================================================================
   The AEO Loop — site behaviour
   No API keys live here, ever. The scanner calls /api/scan (a serverless
   function that reads keys from environment variables). If that endpoint is
   not configured, the page falls back to a clearly-labelled demo.
   ========================================================================= */
(function () {
  "use strict";

  /* ---- mobile nav ---- */
  var nav = document.querySelector(".nav");
  var toggle = document.querySelector(".nav__toggle");
  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      var open = nav.getAttribute("data-open") === "true";
      nav.setAttribute("data-open", String(!open));
      toggle.setAttribute("aria-expanded", String(!open));
    });
  }

  /* ---- reveal on scroll ---- */
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var reveals = document.querySelectorAll(".reveal");
  if (reveals.length && !reduce && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { threshold: 0.14 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("in"); });
  }

  /* ---- engine metadata ---- */
  var ENGINES = [
    { key: "chatgpt", name: "ChatGPT", vendor: "OpenAI",   tag: "GPT" },
    { key: "gemini",  name: "Gemini",  vendor: "Google",   tag: "GE" },
    { key: "grok",    name: "Grok",    vendor: "xAI",      tag: "GR" },
    { key: "claude",  name: "Claude",  vendor: "Anthropic",tag: "CL" }
  ];

  var STATES = {
    recommended: { label: "Recommended", cls: "rec",  band: [75, 90] },
    mentioned:   { label: "Mentioned",   cls: "men",  band: [45, 60] },
    cited:       { label: "Cited",       cls: "cit",  band: [38, 50] },
    excluded:    { label: "Excluded",    cls: "exc",  band: [5, 18] }
  };

  /* ---- tiny deterministic PRNG so demo results are stable per business ---- */
  function seedFrom(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0);
  }
  function rng(seed) {
    var s = seed || 123456789;
    return function () { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1000) / 1000; };
  }

  var COMPETITORS = ["Brightpath", "Meridian", "Calderwood", "Northgate", "Vantage", "Holloway", "Sterling Park", "Avenue & Co"];
  var GAPS = {
    local:      { label: "Weak Local Relevance",  fix: "LocalBusiness schema, location-specific content, Google Business Profile." },
    thin:       { label: "Thin Service Pages",    fix: "Dedicated service pages with FAQ blocks and clear entity language." },
    citations:  { label: "Missing Citations",     fix: "Off-site authority placements, directory submissions, review generation." },
    reviews:    { label: "Low Review Density",     fix: "Structured review acquisition across Google, Trustpilot and niche platforms." },
    entity:     { label: "Weak Entity Clarity",    fix: "Organisation schema, consistent NAP, Wikipedia/Wikidata presence." },
    dominance:  { label: "Competitor Dominance",   fix: "Targeted content and citation strategy against the dominant player." }
  };

  function reasonFor(state, company, comp) {
    switch (state) {
      case "recommended": return "Named with a positive recommendation in direct response to the query.";
      case "mentioned":   return company + " appears as a passing list item, with no endorsement.";
      case "cited":       return "The website is referenced as a source, but not recommended to hire.";
      default:            return comp ? comp + " and other competitors are recommended; " + company + " does not appear."
                                      : company + " is not mentioned in any form for this query.";
    }
  }

  function bandScore(state, rand) {
    var b = STATES[state].band;
    return Math.round(b[0] + rand() * (b[1] - b[0]));
  }

  /* Build a realistic, deterministic demo result set for a business */
  function demoResults(input) {
    var rand = rng(seedFrom((input.company || "acme") + (input.area || "") + (input.city || "")));
    var picks = ["excluded", "mentioned", "cited", "recommended"];
    var results = ENGINES.map(function (eng) {
      // weight toward the painful states for a business with no AEO work yet
      var roll = rand();
      var state = roll < 0.6 ? "excluded" : roll < 0.78 ? "mentioned" : roll < 0.9 ? "cited" : "recommended";
      var comp = COMPETITORS[Math.floor(rand() * COMPETITORS.length)];
      var gapKey = state === "excluded" ? (rand() < .5 ? "citations" : "dominance") : state === "cited" ? "thin" : state === "mentioned" ? "reviews" : "entity";
      return {
        engine: eng.key, name: eng.name, vendor: eng.vendor, tag: eng.tag,
        classification: state,
        score: bandScore(state, rand),
        reason: reasonFor(state, input.company || "Your business", comp),
        competitor: (state === "excluded") ? comp : null,
        gap: gapKey,
        gapLabel: GAPS[gapKey].label,
        gapFix: GAPS[gapKey].fix,
        live: false
      };
    });
    return summarise(results, input);
  }

  function summarise(results, input) {
    var avg = Math.round(results.reduce(function (a, r) { return a + r.score; }, 0) / results.length);
    var rec = results.filter(function (r) { return r.classification === "recommended"; }).length;
    var exc = results.filter(function (r) { return r.classification === "excluded"; }).length;
    var comps = {};
    results.forEach(function (r) { if (r.competitor) comps[r.competitor] = (comps[r.competitor] || 0) + 1; });
    var topComp = Object.keys(comps).sort(function (a, b) { return comps[b] - comps[a]; })[0] || null;
    var gaps = {};
    results.forEach(function (r) { gaps[r.gapLabel] = (gaps[r.gapLabel] || 0) + 1; });
    var topGap = Object.keys(gaps).sort(function (a, b) { return gaps[b] - gaps[a]; })[0] || null;
    return {
      input: input, results: results,
      summary: { overall: avg, recommended: rec, excluded: exc, topCompetitor: topComp, topCompetitorCount: topComp ? comps[topComp] : 0, primaryGap: topGap },
      mode: "demo"
    };
  }

  function renderEngineCards(host, results, stagger) {
    if (!host) return;
    host.innerHTML = "";
    results.forEach(function (r, i) {
      var st = STATES[r.classification];
      var el = document.createElement("div");
      el.className = "enginecard";
      el.innerHTML =
        '<div class="enginecard__logo">' + r.tag + '</div>' +
        '<div><div class="enginecard__name">' + r.name + ' <span class="muted" style="font-weight:400;font-size:12px">· ' + r.vendor + '</span>' + (r.live === false ? ' <span class="enginecard__demo">demo</span>' : '') + '</div>' +
        '<div class="enginecard__reason">' + escapeHtml(r.reason) + '</div></div>' +
        '<div style="text-align:right"><span class="badge badge--' + st.cls + '">' + st.label + '</span>' +
        '<div style="font-family:var(--mono);font-size:13px;color:var(--on-ink-2);margin-top:6px">' + r.score + '/100</div></div>';
      host.appendChild(el);
      var delay = stagger && !reduce ? i * 700 : 0; // 700ms stagger mirrors the real scan cadence
      setTimeout(function () { el.classList.add("in"); }, delay);
    });
  }

  function animateCount(node, to, dur) {
    var start = performance.now();
    function tick(now) {
      var t = Math.min(1, (now - start) / dur);
      var eased = 1 - Math.pow(1 - t, 3);
      node.textContent = Math.round(eased * to);
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }

  /* recommend a next step from the scan summary (shown on the results gate) */
  function recommendFor(s) {
    var rec;
    if (s.overall < 30) rec = "Based on your results, we'd start with a one-time <b>Foundation Build</b> — your priority pages need the structural and entity fixes that get engines to cite and recommend you.";
    else if (s.overall < 58) rec = "Based on your results, the <b>Growth</b> retainer is the fit — you're showing up but not yet recommended, and the ongoing loop is what closes that gap.";
    else rec = "You're already surfacing across engines — the <b>Growth</b> retainer protects and compounds that as the models shift.";
    if (s.topCompetitor) rec = "<b>" + escapeHtml(s.topCompetitor) + "</b> is being recommended where you should be. " + rec;
    return rec;
  }

  /* ============================ SCANNER PAGE ============================ */
  var form = document.querySelector("[data-scan-form]");
  if (form) initScanner(form);

  function initScanner(form) {
    var resultsEl = document.querySelector("[data-results]");
    var cardsEl = resultsEl ? resultsEl.querySelector("[data-cards]") : null;
    var submitBtn = form.querySelector("[data-submit]");
    var demoFlag = document.querySelector("[data-demo-flag]");

    var rules = {
      company: function (v) { return v.trim().length >= 2 || "Enter your company name."; },
      website: function (v) { return /\./.test(v) || "Enter a valid website (e.g. yourfirm.com)."; },
      name:    function (v) { return v.trim().length >= 2 || "Enter your full name."; },
      email:   function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || "Enter a valid professional email."; },
      city:    function (v) { return v.trim().length >= 2 || "Enter your city and region."; },
      area:    function (v) { return v.trim().length >= 3 || "Describe what you do (e.g. family law)."; }
    };

    function validateField(input) {
      var rule = rules[input.name];
      if (!rule) return true;
      var res = rule(input.value);
      var err = input.closest(".field").querySelector(".err");
      if (res === true) { input.setAttribute("aria-invalid", "false"); if (err) err.textContent = ""; return true; }
      input.setAttribute("aria-invalid", "true"); if (err) err.textContent = res; return false;
    }

    form.querySelectorAll("input").forEach(function (inp) {
      inp.addEventListener("blur", function () { if (inp.value) validateField(inp); });
      inp.addEventListener("input", function () {
        if (inp.getAttribute("aria-invalid") === "true") validateField(inp);
      });
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var ok = true;
      form.querySelectorAll("input").forEach(function (inp) { if (!validateField(inp)) ok = false; });
      if (!ok) { form.querySelector('[aria-invalid="true"]').focus(); return; }

      var tsEl = form.querySelector('[name="cf-turnstile-response"]');
      var input = {
        company: form.company.value.trim(),
        website: form.website.value.trim(),
        name: form.name.value.trim(),
        email: form.email.value.trim(),
        city: form.city.value.trim(),
        area: form.area.value.trim(),
        turnstileToken: tsEl ? tsEl.value : ""
      };

      runScan(input);
    });

    function showScanError(msg) {
      var box = form.querySelector("[data-scan-error]");
      if (!box) {
        box = document.createElement("p");
        box.setAttribute("data-scan-error", "");
        box.setAttribute("role", "alert");
        box.className = "consent";
        box.style.color = "#ff9b95";
        form.appendChild(box);
      }
      box.textContent = msg;
    }
    function clearScanError() { var b = form.querySelector("[data-scan-error]"); if (b) b.textContent = ""; }
    function resetTurnstile() { if (window.turnstile) { try { window.turnstile.reset(); } catch (e) {} } }

    function setLoading(on) {
      submitBtn.disabled = on;
      submitBtn.querySelector("[data-label]").textContent = on ? "Querying four engines…" : "Run my free scan";
    }

    function runScan(input) {
      setLoading(true);
      clearScanError();
      if (resultsEl) { resultsEl.classList.remove("show"); }

      fetchScan(input).then(function (data) {
        setLoading(false);
        render(data, input);
      }).catch(function (err) {
        setLoading(false);
        // Blocked or rate-limited: be honest, don't swap in fabricated demo data.
        if (err && (err.status === 403 || err.status === 429)) {
          showScanError(err.status === 429
            ? "You've reached the scan limit for now — please try again later."
            : "We couldn't verify that request. Please complete the check and retry.");
          resetTurnstile();
          return;
        }
        // True connectivity failure (offline / endpoint down): fall back to the
        // clearly-labelled demo so the page still does something.
        render(demoResults(input), input);
      });
    }

    function fetchScan(input) {
      return new Promise(function (resolve, reject) {
        var controller = new AbortController();
        var t = setTimeout(function () { controller.abort(); }, 45000);
        fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal: controller.signal
        }).then(function (r) {
          clearTimeout(t);
          if (!r.ok) { var e = new Error("status " + r.status); e.status = r.status; return reject(e); }
          return r.json();
        }).then(function (j) {
          if (j && j.results && j.results.length) resolve(j); else reject(new Error("no results"));
        }).catch(reject);
      });
    }

    function render(data, input) {
      if (!resultsEl) return;
      // staggered reveal of the four engine verdicts
      renderEngineCards(cardsEl, data.results, true);

      // summary
      var s = data.summary;
      var ring = resultsEl.querySelector("[data-ring]");
      if (ring) drawRing(ring, s.overall);
      setText(resultsEl, "[data-overall]", s.overall + "/100");
      setText(resultsEl, "[data-rec]", s.recommended);
      setText(resultsEl, "[data-exc]", s.excluded);
      setText(resultsEl, "[data-comp]", s.topCompetitor ? (s.topCompetitor + " (" + s.topCompetitorCount + " engines)") : "None surfaced");
      setText(resultsEl, "[data-gap]", s.primaryGap || "—");
      var co = resultsEl.querySelector("[data-company-label]");
      if (co) co.textContent = input.company;

      // dynamic next-step recommendation
      var recoEl = resultsEl.querySelector("[data-reco]");
      if (recoEl) { recoEl.innerHTML = recommendFor(s); recoEl.style.display = "block"; }

      var pre = document.querySelector("[data-pre]");
      if (pre) pre.style.display = "none";

      resultsEl.classList.add("show");
      resultsEl.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    }

    function setText(root, sel, val) { var n = root.querySelector(sel); if (n) n.textContent = val; }

    function drawRing(svg, score) {
      var pct = Math.max(0, Math.min(100, score)) / 100;
      var R = 54, C = 2 * Math.PI * R;
      var color = score >= 70 ? "var(--v-rec)" : score >= 45 ? "var(--v-men)" : score >= 30 ? "var(--v-comp)" : "var(--v-exc)";
      svg.innerHTML =
        '<circle cx="66" cy="66" r="' + R + '" fill="none" stroke="var(--ink-line)" stroke-width="11"/>' +
        '<circle cx="66" cy="66" r="' + R + '" fill="none" stroke="' + color + '" stroke-width="11" stroke-linecap="round" ' +
        'stroke-dasharray="' + C + '" stroke-dashoffset="' + C + '" transform="rotate(-90 66 66)" data-arc/>' +
        '<text x="66" y="60" text-anchor="middle" font-family="var(--mono)" font-size="30" font-weight="700" fill="var(--on-ink)" data-ring-num>0</text>' +
        '<text x="66" y="84" text-anchor="middle" font-family="var(--mono)" font-size="11" fill="var(--on-ink-2)">/ 100</text>';
      var arc = svg.querySelector("[data-arc]");
      var num = svg.querySelector("[data-ring-num]");
      if (reduce) { arc.style.strokeDashoffset = C * (1 - pct); num.textContent = score; return; }
      requestAnimationFrame(function () {
        arc.style.transition = "stroke-dashoffset 1.2s cubic-bezier(.22,1,.36,1)";
        arc.style.strokeDashoffset = String(C * (1 - pct));
      });
      animateCount(num, score, 1200);
    }
  }
})();

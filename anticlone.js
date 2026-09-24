/*!
 * anticlone.js v0.1.0 — open-source website clone deterrence.
 * MIT License. https://github.com/ra-kesh/anticlone
 *
 * A copied website only hurts you when two things happen:
 *   1. CAPTURE  — a tool serializes your rendered page (Figma importers,
 *                 page savers, headless scrapers).
 *   2. REDEPLOY — the copy is served from somebody else's domain.
 *
 * This script works on both:
 *   - Capture: detect known capture-tool fingerprints and automation, then
 *     hide the page and feed serializers blank data ("shield").
 *   - Redeploy: if the page ever runs on a hostname you didn't allow (or from
 *     a saved file), report it — and optionally shield or redirect.
 *   - Attribution: every report carries your watermark id, so you can prove
 *     where a copy came from.
 *
 * It is a deterrent, not DRM. Anything a browser can display can be copied by
 * a determined person. See README "Limits".
 *
 * Usage (place early in <head>, without async/defer for the pre-paint gate):
 *   <script src="anticlone.min.js"
 *     data-origins="example.com,*.example.com"  allowed hostnames (enables foreign-origin check)
 *     data-foreign="report"                      report | shield | redirect
 *     data-canonical="https://example.com"       redirect target for data-foreign="redirect"
 *     data-report="https://example.com/api/ac"   beacon endpoint (optional)
 *     data-watermark="build-2026-09-24-a1"       your attribution id (optional)
 *     data-message="This page is protected."     shield text (optional)
 *     data-fingerprints="id-one,id-two"          extra capture-tool element ids (optional)
 *     data-safe-mode                             only hard (certain) detectors act
 *     data-allow-automation                      ignore webdriver/headless (your own E2E tests)
 *     data-nonce="..."                           CSP nonce for the injected <style>
 *     data-debug                                 console logging
 *   ></script>
 *
 * Or set window.AntiCloneConfig = { origins: [...], report: "...", ... } before the script.
 *
 * Events on document: "anticlone:shield" {detector, sticky},
 *                     "anticlone:heal" {via},
 *                     "anticlone:detect" {detector, action}
 * API: window.anticlone = { version, state, shield(detector, sticky), heal(via) }
 */
(function () {
  "use strict";
  if (window.anticlone && window.anticlone.version) return;

  var VERSION = "0.1.0";
  var script = document.currentScript;
  var G = window.AntiCloneConfig || {};
  var attr = function (n) { return script ? script.getAttribute(n) : null; };
  var flag = function (n, g) { return (!!script && script.hasAttribute(n)) || !!G[g]; };
  var list = function (v) {
    if (!v) return [];
    if (Object.prototype.toString.call(v) === "[object Array]") return v;
    return String(v).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  };

  var CFG = {
    origins: list(attr("data-origins") || G.origins),
    foreign: (attr("data-foreign") || G.foreign || "report").toLowerCase(),
    canonical: attr("data-canonical") || G.canonical || null,
    report: attr("data-report") || G.report || null,
    watermark: attr("data-watermark") || G.watermark || null,
    message: attr("data-message") || G.message || "This page is protected",
    fingerprints: list(attr("data-fingerprints") || G.fingerprints),
    safeMode: flag("data-safe-mode", "safeMode"),
    allowAutomation: flag("data-allow-automation", "allowAutomation"),
    nonce: attr("data-nonce") || G.nonce || null,
    debug: flag("data-debug", "debug"),
    // Tuning. Soft detectors only act when the page has been idle, and heal
    // on the next real input — false positives cost a user one click.
    armDelayMs: 2500,
    quietMs: 15000,
    scrollQuietMs: 2000,
    scrollVelocity: 60,   // px/ms
    scrollMinJump: 400,   // px
    stallMs: 700,
    stallCount: 3,
    longTaskMs: 500,
    longTaskCount: 3,
    longTaskWindowMs: 45000,
    watchWindowMs: 120000
  };

  var log = function () {
    if (!CFG.debug) return;
    try { console.log.apply(console, ["[anticlone]"].concat([].slice.call(arguments))); } catch (e) {}
  };

  // Search, social previews, SEO and uptime tools. UA strings are spoofable:
  // this list exists so we never break SEO, not as a security boundary.
  var GOOD_BOTS = /Googlebot|AdsBot-Google|Mediapartners-Google|Google-InspectionTool|GoogleOther|Chrome-Lighthouse|bingbot|BingPreview|DuckDuckBot|YandexBot|Baiduspider|Applebot|facebookexternalhit|Facebot|Twitterbot|LinkedInBot|Slackbot|Discordbot|TelegramBot|WhatsApp|Pinterestbot|GPTBot|OAI-SearchBot|ClaudeBot|PerplexityBot|CCBot|AhrefsBot|SemrushBot|UptimeRobot|Pingdom|GTmetrix/i;
  var isGoodBot = GOOD_BOTS.test(navigator.userAgent || "");

  var root = document.documentElement;
  var state = { shielded: false, sticky: false, detector: null, detections: [] };
  var reported = {};

  // ------------------------------------------------------------- events
  function emit(name, detail) {
    try { document.dispatchEvent(new CustomEvent("anticlone:" + name, { detail: detail })); } catch (e) {}
  }

  function report(detector, extra) {
    if (reported[detector]) return;
    reported[detector] = true;
    state.detections.push(detector);
    if (!CFG.report) return;
    var payload = {
      v: VERSION,
      detector: detector,
      host: location.hostname,
      protocol: location.protocol,
      path: (location.pathname || "").slice(0, 512),
      referrer: (document.referrer || "").slice(0, 512),
      watermark: CFG.watermark,
      ua: navigator.userAgent,
      t: Date.now()
    };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];
    var body = JSON.stringify(payload);
    try {
      var sent = navigator.sendBeacon && navigator.sendBeacon(CFG.report, new Blob([body], { type: "text/plain" }));
      if (!sent && window.fetch) fetch(CFG.report, { method: "POST", body: body, keepalive: true, mode: "no-cors" }).catch(function () {});
    } catch (e) {}
  }

  // ------------------------------------------------------------- styles
  var CSS = [
    "html.ac-gate body>*{visibility:hidden!important}",
    "html.ac-shield::after{content:'';position:fixed;inset:0;background:#0a0a0a;z-index:2147483646;pointer-events:none}",
    "html.ac-shield body,html.ac-shield body *{color:transparent!important;background:none!important;border-color:transparent!important;box-shadow:none!important;text-shadow:none!important;font-size:.001px!important;padding:0!important;margin:0!important;gap:0!important}",
    "html.ac-shield body img,html.ac-shield body svg,html.ac-shield body video,html.ac-shield body canvas,html.ac-shield body iframe,html.ac-shield body picture{opacity:0!important;visibility:hidden!important}",
    "html.ac-shield body *::before,html.ac-shield body *::after{content:none!important}",
    "html.ac-shield body>*{content-visibility:hidden!important;contain-intrinsic-size:auto 1px!important}",
    "#ac-msg{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;pointer-events:none;font:13px/1.4 system-ui,-apple-system,sans-serif;color:rgba(255,255,255,.85);text-align:center}",
    "#ac-msg p{margin:0}#ac-msg .ac-sub{font-size:12px;color:rgba(255,255,255,.5)}",
    "img{-webkit-user-drag:none}"
  ].join("");
  if (CFG.watermark) CSS += ":root{--ac-wm:'" + String(CFG.watermark).replace(/[^\w.:-]/g, "") + "'}";

  var styleEl = document.createElement("style");
  styleEl.setAttribute("data-anticlone", VERSION);
  if (CFG.nonce) styleEl.setAttribute("nonce", CFG.nonce);
  styleEl.textContent = CSS;
  (document.head || root).appendChild(styleEl);
  var ensureStyle = function () { if (!styleEl.isConnected) (document.head || root).appendChild(styleEl); };

  // Watermark: survives in any HTML copy (attribute + CSS var + comment).
  if (CFG.watermark) {
    try { root.setAttribute("data-ac-wm", CFG.watermark); } catch (e) {}
    document.addEventListener("DOMContentLoaded", function () {
      try { document.body.appendChild(document.createComment(" ac:" + CFG.watermark + " ")); } catch (e) {}
    }, { once: true });
  }

  // ------------------------------------------------------ API poisoning
  // While shielded, the read APIs a DOM serializer relies on return empty data.
  var originals = null;
  var overlay = null;
  function poisonReads() {
    if (originals) return;
    originals = {};
    try {
      var realGCS = window.getComputedStyle;
      var FAKE = { display: "none", visibility: "hidden", opacity: "0", color: "transparent", "background-color": "transparent", "background-image": "none", "font-size": "0px" };
      var inBody = function (el) {
        try {
          return !!el && el.nodeType === 1 && !!document.body && document.body.contains(el) && !(overlay && overlay.contains(el));
        } catch (e) { return false; }
      };
      originals.gcs = realGCS;
      window.getComputedStyle = function (el) {
        var cs = realGCS.apply(window, arguments);
        if (!inBody(el) || typeof Proxy === "undefined") return cs;
        return new Proxy(cs, {
          get: function (t, k) {
            if (k === "getPropertyValue") return function (p) { p = String(p).toLowerCase(); return FAKE.hasOwnProperty(p) ? FAKE[p] : ""; };
            var v = t[k];
            if (typeof v === "function") return v.bind(t);
            if (typeof k === "string" && k !== "length" && isNaN(+k)) {
              var kebab = k.replace(/[A-Z]/g, function (c) { return "-" + c.toLowerCase(); });
              return FAKE.hasOwnProperty(kebab) ? FAKE[kebab] : "";
            }
            return v;
          }
        });
      };
    } catch (e) {}
    try {
      var CP = HTMLCanvasElement.prototype, C2 = CanvasRenderingContext2D.prototype;
      originals.toDataURL = CP.toDataURL;
      originals.toBlob = CP.toBlob;
      originals.getImageData = C2.getImageData;
      CP.toDataURL = function () { return "data:,"; };
      CP.toBlob = function (cb) { if (typeof cb === "function") cb(new Blob([], { type: "image/png" })); };
      C2.getImageData = function (x, y, w, h) { return new ImageData(Math.max(1, w | 0), Math.max(1, h | 0)); };
    } catch (e) {}
    try {
      originals.cssRules = Object.getOwnPropertyDescriptor(CSSStyleSheet.prototype, "cssRules");
      Object.defineProperty(CSSStyleSheet.prototype, "cssRules", { configurable: true, get: function () { return []; } });
    } catch (e) {}
  }
  function restoreReads() {
    if (!originals) return;
    try { if (originals.gcs) window.getComputedStyle = originals.gcs; } catch (e) {}
    try {
      if (originals.toDataURL) HTMLCanvasElement.prototype.toDataURL = originals.toDataURL;
      if (originals.toBlob) HTMLCanvasElement.prototype.toBlob = originals.toBlob;
      if (originals.getImageData) CanvasRenderingContext2D.prototype.getImageData = originals.getImageData;
    } catch (e) {}
    try { if (originals.cssRules) Object.defineProperty(CSSStyleSheet.prototype, "cssRules", originals.cssRules); } catch (e) {}
    originals = null;
  }

  // -------------------------------------------------------------- shield
  function buildOverlay() {
    // Built with DOM APIs (no innerHTML) so it works under Trusted Types CSPs.
    var NS = "http://www.w3.org/2000/svg";
    var d = document.createElement("div");
    d.id = "ac-msg";
    d.setAttribute("role", "alert");
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "28"); svg.setAttribute("height", "28");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "1.5");
    var rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", "3"); rect.setAttribute("y", "11"); rect.setAttribute("width", "18"); rect.setAttribute("height", "11"); rect.setAttribute("rx", "2");
    var path = document.createElementNS(NS, "path");
    path.setAttribute("d", "M7 11V7a5 5 0 0110 0v4"); path.setAttribute("stroke-linecap", "round");
    svg.appendChild(rect); svg.appendChild(path);
    var p1 = document.createElement("p");
    p1.textContent = CFG.message;
    var p2 = document.createElement("p");
    p2.className = "ac-sub";
    p2.textContent = "Seeing this by mistake? Refresh the page.";
    d.appendChild(svg); d.appendChild(p1); d.appendChild(p2);
    return d;
  }

  var guard = null;
  function shield(detector, sticky) {
    if (sticky) state.sticky = true;
    report(detector);
    emit("detect", { detector: detector, action: "shield" });
    if (state.shielded) return;
    state.shielded = true;
    state.detector = detector;
    log("shield:", detector, sticky ? "(sticky)" : "(soft)");
    root.classList.add("ac-shield");
    ensureStyle();
    overlay = overlay || buildOverlay();
    root.appendChild(overlay);
    try {
      guard = new MutationObserver(function () {
        if (!root.classList.contains("ac-shield")) root.classList.add("ac-shield");
        if (!overlay.isConnected) root.appendChild(overlay);
        ensureStyle();
      });
      guard.observe(root, { attributes: true, attributeFilter: ["class"], childList: true });
      if (document.head) guard.observe(document.head, { childList: true });
    } catch (e) {}
    poisonReads();
    emit("shield", { detector: detector, sticky: !!state.sticky });
  }

  function heal(via) {
    if (!state.shielded || state.sticky) return;
    log("heal:", via);
    if (guard) { guard.disconnect(); guard = null; }
    root.classList.remove("ac-shield");
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    restoreReads();
    state.shielded = false;
    state.detector = null;
    emit("heal", { via: via || "api" });
  }

  try {
    window.anticlone = {
      version: VERSION,
      state: state,
      config: CFG,
      shield: function (d, s) { shield(d || "manual", !!s); },
      heal: function (v) { heal(v || "api"); }
    };
  } catch (e) {}

  if (isGoodBot) { log("good bot — detectors off"); return; }

  // ================================================== REDEPLOY DETECTION
  // Deterministic: a page running on a hostname you didn't allow IS a copy
  // (or a mirroring proxy). Works whenever the copy keeps this script.
  function hostAllowed(host) {
    host = String(host || "").toLowerCase();
    for (var i = 0; i < CFG.origins.length; i++) {
      var o = CFG.origins[i].toLowerCase();
      if (o === host) return true;
      if (o.indexOf("*.") === 0 && (host === o.slice(2) || host.slice(-(o.length - 1)) === o.slice(1))) return true;
    }
    return false;
  }
  function onForeign(detector, extra) {
    report(detector, extra);
    emit("detect", { detector: detector, action: CFG.foreign });
    log("redeploy signal:", detector, extra || "");
    if (CFG.foreign === "redirect" && CFG.canonical && /^https:\/\//i.test(CFG.canonical)) {
      try { location.replace(CFG.canonical.replace(/\/+$/, "") + location.pathname + location.search); } catch (e) {}
    } else if (CFG.foreign === "shield" || CFG.foreign === "redirect") {
      var go = function () { shield(detector, true); };
      if (document.body) go(); else document.addEventListener("DOMContentLoaded", go, { once: true });
    }
  }
  var isDev = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(location.hostname);
  if (CFG.origins.length) {
    if (location.protocol === "file:") onForeign("saved-copy");
    else if (!isDev && !hostAllowed(location.hostname)) onForeign("foreign-origin", { foreignHost: location.hostname });
  }
  // Embedded in someone else's frame (proxy viewers, "preview" cloners).
  try {
    if (window.top !== window.self && CFG.origins.length) {
      var anc = location.ancestorOrigins && location.ancestorOrigins.length ? location.ancestorOrigins[location.ancestorOrigins.length - 1] : document.referrer;
      var ancHost = "";
      try { ancHost = new URL(anc).hostname; } catch (e) {}
      if (ancHost && !hostAllowed(ancHost) && !/^(localhost|127\.0\.0\.1)$/.test(ancHost)) {
        report("framed", { frameHost: ancHost });
        emit("detect", { detector: "framed", action: "report" });
      }
    }
  } catch (e) {}

  // =================================================== CAPTURE DETECTION
  // Pre-paint gate: hide body until DOMContentLoaded so a tool that captures
  // on first paint gets nothing. Real users don't notice.
  root.classList.add("ac-gate");
  var ungate = function () { root.classList.remove("ac-gate"); };
  if (document.readyState !== "loading") ungate();
  else document.addEventListener("DOMContentLoaded", ungate, { once: true });

  // Human activity bookkeeping.
  var lastInput = Date.now(), lastWheel = 0, lastPointer = 0, armed = false;
  setTimeout(function () { armed = true; }, CFG.armDelayMs);
  var mark = function (e) { if (e.isTrusted) lastInput = Date.now(); };
  document.addEventListener("wheel", function (e) { if (e.isTrusted) lastInput = lastWheel = Date.now(); }, { passive: true, capture: true });
  document.addEventListener("pointerdown", function (e) { if (e.isTrusted) lastInput = lastPointer = Date.now(); }, { passive: true, capture: true });
  ["keydown", "touchmove", "mousemove"].forEach(function (t) { document.addEventListener(t, mark, { passive: true, capture: true }); });
  var quietFor = function (ms) { return Date.now() - lastInput > ms; };

  // A real interaction after a SOFT trigger means we guessed wrong: heal.
  ["pointerdown", "keydown", "wheel", "touchstart"].forEach(function (t) {
    document.addEventListener(t, function (e) { if (e.isTrusted) heal("input"); }, { passive: true, capture: true });
  });

  var hard = function (name) { shield(name, true); };
  var soft = function (name) { if (!CFG.safeMode && armed) shield(name, false); };

  // --- HARD: automation flags
  if (!CFG.allowAutomation) {
    if (navigator.webdriver === true) hard("webdriver");
    if (/HeadlessChrome/.test(navigator.userAgent || "")) hard("headless-ua");
  }

  // --- HARD: capture-tool fingerprints (html.to.design / Figma capture + your own)
  var FP_IDS = [
    "__figma_html_to_design_toolbar_host__",
    "__figma_h2d_chrome_extension_toolbar__",
    "__figma_capture_cursor_style__",
    "__h2d_anim_pause"
  ].concat(CFG.fingerprints);
  var FP_TAGS = ["figma-html-to-design-toolbar"];
  var isCaptureNode = function (n) {
    return !!n && n.nodeType === 1 && (FP_IDS.indexOf(n.id) >= 0 || FP_TAGS.indexOf(n.localName) >= 0);
  };
  var scanFingerprints = function () {
    for (var i = 0; i < FP_IDS.length; i++) if (document.getElementById(FP_IDS[i])) return true;
    for (var j = 0; j < FP_TAGS.length; j++) if (document.getElementsByTagName(FP_TAGS[j]).length) return true;
    return false;
  };
  try {
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++)
        for (var j = 0; j < muts[i].addedNodes.length; j++)
          if (isCaptureNode(muts[i].addedNodes[j])) return hard("capture-tool");
    }).observe(root, { childList: true, subtree: true });
  } catch (e) {}
  document.addEventListener("DOMContentLoaded", function () { if (scanFingerprints()) hard("capture-tool"); }, { once: true });
  // Global written by the html.to.design serializer — trap the assignment.
  try {
    var h2dVal;
    Object.defineProperty(window, "__h2d_serializeIframe", {
      configurable: false, enumerable: false,
      get: function () { return h2dVal; },
      set: function (v) { h2dVal = v; hard("capture-tool"); }
    });
  } catch (e) {}

  // --- SOFT: headless environment (needs 2 of 3 signals)
  if (!CFG.allowAutomation) {
    (function () {
      var score = 0;
      if (window.outerWidth === 0 && window.outerHeight === 0) score++;
      try {
        var gl = document.createElement("canvas").getContext("webgl");
        var ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
        if (ext && /swiftshader|llvmpipe/i.test(String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)))) score++;
      } catch (e) {}
      if (!navigator.languages || navigator.languages.length === 0) score++;
      if (score >= 2) setTimeout(function () { soft("headless-env"); }, CFG.armDelayMs + 10);
    })();
  }

  // --- SOFT: scripted scroll jumps with no human input behind them
  (function () {
    var lastY = window.scrollY, lastT = Date.now();
    window.addEventListener("scroll", function () {
      // dt is capped: after an idle stretch the first scripted jump would
      // otherwise look slow (15000px over 3000ms).
      var now = Date.now(), dy = Math.abs(window.scrollY - lastY), dt = Math.min(now - lastT, 100) || 1;
      lastY = window.scrollY; lastT = now;
      if (dy > CFG.scrollMinJump && dy / dt > CFG.scrollVelocity &&
          quietFor(CFG.scrollQuietMs) && now - lastWheel > CFG.scrollQuietMs && now - lastPointer > 3000)
        soft("scroll-velocity");
    }, { passive: true });
  })();

  // --- SOFT: repeated long tasks while nobody touches the page
  (function () {
    var hits = [], factor = (navigator.hardwareConcurrency || 8) <= 4 ? 1.5 : 1;
    try {
      new PerformanceObserver(function (entries) {
        if (!armed || !quietFor(CFG.quietMs)) return;
        entries.getEntries().forEach(function (e) {
          if (e.duration < CFG.longTaskMs * factor) return;
          var now = Date.now();
          hits = hits.filter(function (t) { return now - t < CFG.longTaskWindowMs; });
          hits.push(now);
          if (hits.length >= CFG.longTaskCount) soft("longtask");
        });
      }).observe({ entryTypes: ["longtask"] });
    } catch (e) {}
  })();

  // --- SOFT: frame stalls while visible (full-page capture freezes rendering)
  (function () {
    if (!window.requestAnimationFrame) return;
    var last = Date.now(), stalls = 0, until = Date.now() + CFG.watchWindowMs;
    var reset = function () { last = Date.now(); stalls = 0; };
    document.addEventListener("visibilitychange", reset);
    window.addEventListener("focus", reset);
    (function tick() {
      if (Date.now() > until) return;
      requestAnimationFrame(function () {
        var now = Date.now();
        if (armed && document.visibilityState === "visible" && now - last > CFG.stallMs && quietFor(CFG.quietMs)) {
          if (++stalls >= CFG.stallCount) soft("frame-stall");
        } else stalls = 0;
        last = now;
        tick();
      });
    })();
  })();

  // Back/forward cache restore starts clean.
  window.addEventListener("pageshow", function (e) {
    if (!e.persisted) return;
    state.sticky = false;
    heal("bfcache");
    if (scanFingerprints()) hard("capture-tool");
  });

  // Mild friction only; no right-click/keyboard blocking (hurts accessibility,
  // stops no real tool).
  document.addEventListener("dragstart", function (e) {
    var t = e.target;
    if (t && t.tagName === "IMG" && t.getAttribute("draggable") !== "true") e.preventDefault();
  }, true);
})();

/*!
 * anticlone.js v0.2.0 — open-source website clone deterrence.
 * MIT License. https://github.com/ra-kesh/anticlone
 *
 * A copied website only hurts you when two things happen:
 *   1. CAPTURE  — a tool serializes your rendered page (Figma importers,
 *                 page savers, headless scrapers).
 *   2. REDEPLOY — the copy is served from somebody else's domain.
 *
 * This script works on both:
 *   - Capture: detect known capture-tool fingerprints and automation, then
 *     hide the page and intercept common page-world read APIs ("shield").
 *   - Redeploy: if the page ever runs on a hostname you didn't allow (or from
 *     a saved file), report it — and optionally shield or redirect.
 *   - Leads: reports carry your watermark id to help you find copies.
 *
 * It is a deterrent, not DRM. Anything a browser can display can be copied by
 * a determined person. See README "Limits".
 *
 * Usage (place early in <head>, without async/defer for the pre-paint gate):
 *   <script src="anticlone.js"
 *     data-origins="example.com,*.example.com"  allowed hostnames (enables foreign-origin check)
 *     data-foreign="report"                      report | shield | redirect
 *     data-canonical="https://example.com"       redirect target for data-foreign="redirect"
 *     data-report="https://example.com/api/ac"   beacon endpoint (optional)
 *     data-watermark="build-2026-09-24-a1"       your attribution id (optional)
 *     data-message="This page is protected."     shield text (optional)
 *     data-fingerprints="id-one,id-two"          extra capture-tool element ids (optional)
 *     data-safe-mode                             only hard detectors act; no pre-paint gate
 *     data-no-gate                               disable the pre-paint gate
 *     data-gate-ms="800"                         max time the pre-paint gate may hide the page
 *     data-allow-automation                      ignore webdriver/headless (your own E2E tests)
 *     data-nonce="..."                           CSP nonce for the injected <style>
 *     data-debug                                 console logging
 *   ></script>
 *
 * Or set window.AntiCloneConfig = { origins: [...], report: "...", ... } before the script.
 *
 * Events on document: "anticlone:detect"  {detector, action}  action: shield|suspect|report|redirect
 *                     "anticlone:shield"  {detector, sticky}
 *                     "anticlone:heal"    {via}
 * API: window.anticlone = { version, state (read-only snapshot), shield(detector),
 *                           heal(), expectScroll(ms) }
 */
(function () {
  "use strict";
  if (window.anticlone && window.anticlone.version) return;

  var VERSION = "0.2.0";
  var script = document.currentScript;
  var G = window.AntiCloneConfig || {};
  var attr = function (n) { return script ? script.getAttribute(n) : null; };
  var flag = function (n, g) { return (!!script && script.hasAttribute(n)) || !!G[g]; };
  var list = function (v) {
    if (!v) return [];
    if (Object.prototype.toString.call(v) === "[object Array]") return v;
    return String(v).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  };
  var num = function (v, d) { var n = parseInt(v, 10); return isFinite(n) && n >= 0 ? n : d; };

  var CFG = {
    origins: list(attr("data-origins") || G.origins),
    foreign: (attr("data-foreign") || G.foreign || "report").toLowerCase(),
    canonical: attr("data-canonical") || G.canonical || null,
    report: attr("data-report") || G.report || null,
    watermark: attr("data-watermark") || G.watermark || null,
    message: attr("data-message") || G.message || "This page is protected",
    fingerprints: list(attr("data-fingerprints") || G.fingerprints),
    safeMode: flag("data-safe-mode", "safeMode"),
    noGate: flag("data-no-gate", "noGate"),
    gateMs: num(attr("data-gate-ms") || G.gateMs, 800),
    allowAutomation: flag("data-allow-automation", "allowAutomation"),
    nonce: attr("data-nonce") || G.nonce || null,
    debug: flag("data-debug", "debug"),
    // Tuning. Soft signals are only suspicions; the page is shielded when two
    // distinct ones agree, and heals on the next real input.
    armDelayMs: 2500,
    quietMs: 15000,
    scrollQuietMs: 2000,
    scrollVelocity: 60,     // px/ms
    scrollMinJump: 400,     // px
    stallMs: 700,
    stallCount: 3,
    longTaskMs: 500,
    longTaskCount: 3,
    longTaskWindowMs: 45000,
    corroborateMs: 60000,   // window in which two distinct soft signals must agree
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
  // Private enforcement state. The public API only exposes copies of it.
  var state = { shielded: false, sticky: false, detector: null, detections: [] };
  var reported = {};

  // ------------------------------------------------------------- events
  function emit(name, detail) {
    try { document.dispatchEvent(new CustomEvent("anticlone:" + name, { detail: detail })); } catch (e) {}
  }

  // Referrer is reduced to its origin: full referrer URLs can carry tokens or
  // personal data in their path/query. The current page is sent as pathname
  // only (no query or fragment).
  function referrerOrigin() {
    try { return document.referrer ? new URL(document.referrer).origin : ""; } catch (e) { return ""; }
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
      referrerOrigin: referrerOrigin(),
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
    "#ac-msg{position:fixed!important;inset:0!important;z-index:2147483647!important;display:flex!important;visibility:visible!important;opacity:1!important;flex-direction:column;align-items:center;justify-content:center;gap:8px;pointer-events:none;font:13px/1.4 system-ui,-apple-system,sans-serif;color:rgba(255,255,255,.85);text-align:center}",
    "#ac-msg p{margin:0}#ac-msg .ac-sub{font-size:12px;color:rgba(255,255,255,.5)}",
    "img{-webkit-user-drag:none}"
  ].join("");
  if (CFG.watermark) CSS += ":root{--ac-wm:'" + String(CFG.watermark).replace(/[^\w.:-]/g, "") + "'}";

  var styleEl = document.createElement("style");
  styleEl.setAttribute("data-anticlone", VERSION);
  if (CFG.nonce) styleEl.setAttribute("nonce", CFG.nonce);
  styleEl.textContent = CSS;
  (document.head || root).appendChild(styleEl);

  // Put the stylesheet back exactly as shipped (re-attached, text restored,
  // not disabled, no media query narrowing it).
  function ensureStyle() {
    try {
      if (!styleEl.isConnected) (document.head || root).appendChild(styleEl);
      if (styleEl.textContent !== CSS) styleEl.textContent = CSS;
      if (styleEl.hasAttribute("media")) styleEl.removeAttribute("media");
      if (styleEl.disabled) styleEl.disabled = false;
      if (styleEl.sheet && styleEl.sheet.disabled) styleEl.sheet.disabled = false;
    } catch (e) {}
  }

  // Watermark: survives in any HTML copy (attribute + CSS var + comment).
  if (CFG.watermark) {
    try { root.setAttribute("data-ac-wm", CFG.watermark); } catch (e) {}
    var stampComment = function () {
      try { document.body.appendChild(document.createComment(" ac:" + CFG.watermark + " ")); } catch (e) {}
    };
    if (document.body) stampComment();
    else document.addEventListener("DOMContentLoaded", stampComment, { once: true });
  }

  // ------------------------------------------------------ API interception
  // While shielded, common page-world read APIs used by DOM serializers return
  // empty data. This does NOT cover code that obtains native methods elsewhere
  // (a fresh iframe, an extension's isolated world) — see README "Limits".
  var originals = null;
  var overlay = null;
  function interceptReads() {
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

  // Re-assert every part of the shield. Runs on observed mutations and on a
  // timer (property changes such as sheet.disabled fire no mutation).
  function reassert() {
    if (!state.shielded) return;
    if (!root.classList.contains("ac-shield")) root.classList.add("ac-shield");
    ensureStyle();
    if (overlay) {
      if (!overlay.isConnected) root.appendChild(overlay);
      if (overlay.hasAttribute("style")) overlay.removeAttribute("style");
      if (overlay.hasAttribute("hidden")) overlay.removeAttribute("hidden");
      if (overlay.id !== "ac-msg") overlay.id = "ac-msg";
    }
  }

  var guard = null, guardTimer = 0;
  function shield(detector, sticky) {
    if (sticky) state.sticky = true;
    if (state.shielded) return;
    state.shielded = true;
    state.detector = detector;
    log("shield:", detector, sticky ? "(sticky)" : "(soft)");
    root.classList.add("ac-shield");
    ensureStyle();
    overlay = overlay || buildOverlay();
    root.appendChild(overlay);
    try {
      guard = new MutationObserver(reassert);
      guard.observe(root, { attributes: true, attributeFilter: ["class"], childList: true });
      guard.observe(styleEl, { attributes: true, childList: true, characterData: true, subtree: true });
      guard.observe(overlay, { attributes: true });
      if (document.head) guard.observe(document.head, { childList: true });
    } catch (e) {}
    guardTimer = setInterval(reassert, 500);
    interceptReads();
    emit("shield", { detector: detector, sticky: !!state.sticky });
  }

  function heal(via) {
    if (!state.shielded || state.sticky) return;
    log("heal:", via);
    if (guard) { guard.disconnect(); guard = null; }
    if (guardTimer) { clearInterval(guardTimer); guardTimer = 0; }
    root.classList.remove("ac-shield");
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    restoreReads();
    state.shielded = false;
    state.detector = null;
    emit("heal", { via: via || "api" });
  }

  function hard(detector, extra) {
    report(detector, extra);
    emit("detect", { detector: detector, action: "shield" });
    shield(detector, true);
  }

  // Programmatic scrolls the host app announces (anticlone.expectScroll).
  var scrollExpectedUntil = 0;

  try {
    var api = {
      version: VERSION,
      config: CFG,
      // Manual shields are always soft: the API can raise one, and heal()
      // only ever clears soft shields.
      shield: function (d) { shield(d || "manual", false); },
      heal: function () { heal("api"); },
      expectScroll: function (ms) { scrollExpectedUntil = Date.now() + (ms > 0 ? ms : 1000); }
    };
    Object.defineProperty(api, "state", {
      enumerable: true,
      get: function () {
        return { shielded: state.shielded, sticky: state.sticky, detector: state.detector, detections: state.detections.slice() };
      }
    });
    Object.defineProperty(window, "anticlone", { value: api, writable: false, configurable: false, enumerable: false });
  } catch (e) {}

  if (isGoodBot) { log("good bot — detectors off"); return; }

  // ================================================== REDEPLOY DETECTION
  // A page running on a hostname you didn't allow is a copy (or a mirroring
  // proxy). Works whenever the copy keeps this script.
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
    log("redeploy signal:", detector, extra || "");
    if (CFG.foreign === "redirect" && CFG.canonical && /^https:\/\//i.test(CFG.canonical)) {
      report(detector, extra);
      emit("detect", { detector: detector, action: "redirect" });
      try { location.replace(CFG.canonical.replace(/\/+$/, "") + location.pathname + location.search); } catch (e) {}
    } else if (CFG.foreign === "shield" || CFG.foreign === "redirect") {
      hard(detector, extra);
    } else {
      report(detector, extra);
      emit("detect", { detector: detector, action: "report" });
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
  // Pre-paint gate: hide body until DOMContentLoaded, but never longer than
  // gateMs, so a slow deferred script can't blank the page. Off in safe mode.
  if (!CFG.noGate && !CFG.safeMode && CFG.gateMs > 0 && document.readyState === "loading") {
    root.classList.add("ac-gate");
    var ungate = function () { root.classList.remove("ac-gate"); };
    document.addEventListener("DOMContentLoaded", ungate, { once: true });
    setTimeout(ungate, CFG.gateMs);
  }

  // Human activity bookkeeping.
  var lastInput = Date.now(), lastWheel = 0, lastPointer = 0, armed = false, armTimer = 0;
  var arm = function () { armed = false; clearTimeout(armTimer); armTimer = setTimeout(function () { armed = true; }, CFG.armDelayMs); };
  arm();
  var mark = function (e) { if (e.isTrusted) lastInput = Date.now(); };
  document.addEventListener("wheel", function (e) { if (e.isTrusted) lastInput = lastWheel = Date.now(); }, { passive: true, capture: true });
  document.addEventListener("pointerdown", function (e) { if (e.isTrusted) lastInput = lastPointer = Date.now(); }, { passive: true, capture: true });
  ["keydown", "touchmove", "mousemove"].forEach(function (t) { document.addEventListener(t, mark, { passive: true, capture: true }); });
  var quietFor = function (ms) { return Date.now() - lastInput > ms; };

  // A real interaction after a SOFT shield means we guessed wrong: heal.
  ["pointerdown", "keydown", "wheel", "touchstart"].forEach(function (t) {
    document.addEventListener(t, function (e) { if (e.isTrusted) heal("input"); }, { passive: true, capture: true });
  });

  // Soft signals are suspicions. Each is reported once; the page is only
  // shielded when two DISTINCT signals agree within corroborateMs (or when a
  // signal is already self-corroborating, like the 2-of-3 headless check).
  var suspects = {};
  function soft(name, selfCorroborated) {
    if (!armed) return;
    var now = Date.now();
    suspects[name] = now;
    report(name);
    var agreeing = [];
    for (var k in suspects) if (now - suspects[k] < CFG.corroborateMs) agreeing.push(k);
    var act = !CFG.safeMode && (selfCorroborated || agreeing.length >= 2);
    emit("detect", { detector: name, action: act ? "shield" : "suspect" });
    if (act) shield(selfCorroborated ? name : agreeing.sort().join("+"), false);
  }

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
  ].concat(CFG.fingerprints.filter(function (id) { return /^[\w-]+$/.test(id); }));
  var FP_TAGS = ["figma-html-to-design-toolbar"];
  var FP_SEL = FP_IDS.map(function (id) { return '[id="' + id + '"]'; }).concat(FP_TAGS).join(",");
  // Matches the node itself or anything inside it (a wrapper holding the toolbar).
  var isCaptureTree = function (n) {
    try { return !!n && n.nodeType === 1 && (n.matches(FP_SEL) || (!!n.firstElementChild && !!n.querySelector(FP_SEL))); }
    catch (e) { return false; }
  };
  var scanFingerprints = function () {
    try { return !!document.querySelector(FP_SEL); } catch (e) { return false; }
  };
  try {
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === "attributes") { if (isCaptureTree(m.target)) return hard("capture-tool"); continue; }
        for (var j = 0; j < m.addedNodes.length; j++)
          if (isCaptureTree(m.addedNodes[j])) return hard("capture-tool");
      }
    }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["id"] });
  } catch (e) {}
  // Scan now (covers late initialization) and again once parsing is done.
  if (scanFingerprints()) hard("capture-tool");
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", function () { if (scanFingerprints()) hard("capture-tool"); }, { once: true });

  // Global written by the html.to.design serializer. If it already exists the
  // serializer ran before us: detect, and leave its value untouched.
  try {
    var h2dKey = "__h2d_serializeIframe";
    var existing = Object.getOwnPropertyDescriptor(window, h2dKey);
    if (existing) {
      if (existing.get || existing.value !== undefined) hard("capture-tool");
    } else {
      var h2dVal;
      Object.defineProperty(window, h2dKey, {
        configurable: false, enumerable: false,
        get: function () { return h2dVal; },
        set: function (v) { h2dVal = v; hard("capture-tool"); }
      });
    }
  } catch (e) {}

  // --- SOFT: headless environment (self-corroborating: needs 2 of 3 signals)
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
      if (score >= 2) setTimeout(function () { soft("headless-env", true); }, CFG.armDelayMs + 10);
    })();
  }

  // --- SOFT: scripted scroll jumps with no human input behind them.
  // Browser scroll restoration (history navigation, hash links) is excused.
  window.addEventListener("popstate", function () { scrollExpectedUntil = Date.now() + 1500; });
  window.addEventListener("hashchange", function () { scrollExpectedUntil = Date.now() + 1500; });
  (function () {
    var lastY = window.scrollY, lastT = Date.now();
    window.addEventListener("scroll", function () {
      // dt is capped: after an idle stretch the first scripted jump would
      // otherwise look slow (15000px over 3000ms).
      var now = Date.now(), dy = Math.abs(window.scrollY - lastY), dt = Math.min(now - lastT, 100) || 1;
      lastY = window.scrollY; lastT = now;
      if (now < scrollExpectedUntil) return;
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

  // Back/forward cache restore: only SOFT state resets. Sticky shields stay,
  // because their causes (host, automation, a capture tool that was present)
  // don't change by going back in history. Then re-check fingerprints.
  window.addEventListener("pageshow", function (e) {
    if (!e.persisted) return;
    suspects = {};
    lastInput = Date.now();
    scrollExpectedUntil = Date.now() + 1500;
    arm();
    if (state.shielded && !state.sticky) heal("bfcache");
    if (scanFingerprints()) hard("capture-tool");
  });

  // Mild friction only; no right-click/keyboard blocking (hurts accessibility,
  // stops no real tool).
  document.addEventListener("dragstart", function (e) {
    var t = e.target;
    if (t && t.tagName === "IMG" && t.getAttribute("draggable") !== "true") e.preventDefault();
  }, true);
})();

# anticlone.js

**Open-source website clone deterrence. One script tag, no server required.**

Anyone can copy a website pixel-for-pixel in two clicks, using Figma importers
(html.to.design), page-saver extensions, or headless scrapers. Commercial tools
now sell protection against this. `anticlone.js` is a free, readable, MIT-licensed
alternative that anyone can drop into their site.

> **Honest disclaimer:** this is a deterrent, not DRM. Anything a browser can
> display, a determined person can copy, even if only by taking screenshots and
> rebuilding by hand. What you *can* do is make one-click copying fail, detect it
> when a copy goes live elsewhere, and prove where the copy came from. That's
> what this script does.

## How it thinks

A copied site only hurts you when two things happen:

| Step | What happens | What anticlone does |
|---|---|---|
| **1. Capture** | A tool serializes your rendered page | Detects known capture tools and automation, then hides the page and feeds serializers blank data |
| **2. Redeploy** | The copy goes live on someone else's domain | Detects that the page is running on a hostname you didn't allow, then reports it, and optionally hides the page or redirects to your site |
| **Attribution** | You need proof | Stamps a watermark id into the page and into every report |

Redeploy detection is the part you can rely on: if your page is running on
`copycat.com`, it's a copy. Capture detection is best-effort, because it's
heuristic by nature.

## Install

Put it early in `<head>`. Don't use `async` or `defer`, because the pre-paint gate needs to run before first paint.

```html
<script src="https://cdn.jsdelivr.net/gh/ra-kesh/anticlone@main/anticlone.js"
        data-origins="example.com,*.example.com"
        data-watermark="build-2026-09-24"
        data-report="https://example.com/api/clone-report"></script>
```

For production, self-host it or pin a commit hash instead of `@main`.

It works anywhere you can paste custom code into the header, including Webflow,
WordPress, Shopify, Framer, Wix, Squarespace and plain HTML.

## Configuration

Every option is a `data-*` attribute on the script tag. You can also set
`window.AntiCloneConfig = { origins: [...], report: "...", ... }` before the
script loads.

| Attribute | Default | What it does |
|---|---|---|
| `data-origins` | *(none)* | Comma-separated allowed hostnames, with `*.example.com` wildcards. **Setting this turns on redeploy detection.** `localhost` and `127.0.0.1` are always allowed. |
| `data-foreign` | `report` | What to do on an unknown host: `report`, `shield` (hide the page), or `redirect` |
| `data-canonical` | *(none)* | The `https://` URL to redirect to when `data-foreign="redirect"` is set |
| `data-report` | *(none)* | Endpoint that receives a JSON beacon for each detection |
| `data-watermark` | *(none)* | Your attribution id. It's added as `html[data-ac-wm]`, a `--ac-wm` CSS variable, and an HTML comment, and included in every report |
| `data-message` | `This page is protected` | Text shown on the shield screen |
| `data-fingerprints` | *(none)* | Extra element ids that identify a capture tool (community-extensible) |
| `data-safe-mode` | off | Only certain (hard) detectors act; the heuristic ones are off |
| `data-allow-automation` | off | Ignore webdriver and headless signals, so your own Playwright or Cypress tests keep working |
| `data-nonce` | *(none)* | CSP nonce for the injected `<style>` |
| `data-debug` | off | Log to the console |

## What it detects

**Hard detectors** act immediately and stay active; a click won't undo them:

| Detector | Signal |
|---|---|
| `capture-tool` | The html.to.design or Figma capture toolbar appears in the page, or the html.to.design serializer global is written |
| `webdriver` | `navigator.webdriver === true` |
| `headless-ua` | `HeadlessChrome` in the user agent |
| `foreign-origin` | The page is running on a hostname outside `data-origins` |
| `saved-copy` | The page is running from `file://` |
| `framed` | The page is embedded in a frame from a non-allowed site (report only) |

**Soft detectors** only act once the page has been idle, and the next real click or keypress heals them:

| Detector | Signal |
|---|---|
| `headless-env` | At least 2 of: zero outer window size, a software WebGL renderer (SwiftShader or llvmpipe), no languages |
| `scroll-velocity` | A scroll of more than 400 px at more than 60 px/ms with no wheel, touch or pointer input behind it |
| `longtask` | 3 main-thread tasks over 500 ms within 45 s, while nobody has touched the page for 15 s |
| `frame-stall` | 3 rendering stalls over 700 ms while the page is visible and idle (full-page captures freeze rendering) |

Search engines, social previews, AI crawlers and uptime monitors are recognized
by user agent and skipped entirely, so SEO and link previews are unaffected.

## What happens on detection ("shield")

1. `html.ac-shield` hides the page content behind a dark overlay with your message.
2. A MutationObserver adds the shield back if something removes it.
3. While the shield is up, the browser APIs that DOM serializers read from return empty data:
   - `getComputedStyle` reports everything in the page body as hidden and transparent.
   - Canvas `toDataURL`, `toBlob` and `getImageData` return blank images.
   - `CSSStyleSheet.cssRules` returns `[]`.

   The copy comes out empty. Everything is restored when the page heals.
4. A report is sent to `data-report`.

## Reports

Each detection sends one JSON `POST`, via `sendBeacon` as `text/plain`:

```json
{
  "v": "0.1.0",
  "detector": "foreign-origin",
  "host": "copycat.example",
  "foreignHost": "copycat.example",
  "protocol": "https:",
  "path": "/pricing",
  "referrer": "",
  "watermark": "build-2026-09-24",
  "ua": "Mozilla/5.0 …",
  "t": 1790224030552
}
```

Any endpoint that accepts a POST works: a serverless function, a Cloudflare
Worker, or a form backend. A `foreign-origin` report plus your watermark is
the evidence a hosting provider needs for a DMCA takedown.

## Events and API

```js
document.addEventListener("anticlone:detect", e => console.log(e.detail)); // {detector, action}
document.addEventListener("anticlone:shield", e => console.log(e.detail)); // {detector, sticky}
document.addEventListener("anticlone:heal",   e => console.log(e.detail)); // {via}

window.anticlone.version;          // "0.1.0"
window.anticlone.state;            // {shielded, sticky, detector, detections[]}
window.anticlone.shield("test");   // manual soft shield (handy for testing your styling)
window.anticlone.heal();
```

## Limits (read this before you rely on it)

- **It's all client-side.** Someone who downloads the raw HTML and CSS, blocks the script, or disables JavaScript never runs it. Redeploy detection only works if the copy keeps the script, and many naive copies do.
- **Screenshots can't be stopped.** Nothing prevents someone photographing their own screen. The goal is to make *faithful, editable* copies expensive.
- **Heuristics trade false positives for coverage.** That's why soft detectors wait for idle time and heal on real input. If you see complaints, use `data-safe-mode`.
- **User-agent allowlists are spoofable.** They exist so SEO never breaks, not as a security boundary.
- **Fingerprints go stale.** Capture tools change. Contributions of new fingerprints are welcome.

## Stronger protection comes from pairing it with the server

The script is one layer. For real assurance, add these server-side layers:

- **Signed, expiring URLs for images and fonts**, so copied pages break over time.
- **Hotlink protection:** check the `Referer` on assets, and log which foreign sites request them, since that also shows you where copies are.
- **Bot management** at your CDN (Cloudflare, Fastly and similar), with verified-bot checks based on reverse DNS rather than user agents.
- **Keep the valuable parts on the server:** pricing logic, forms, integrations. A copy of the HTML doesn't get them.

## License

MIT, see [LICENSE](LICENSE). Use it, fork it, ship it. No warranty.

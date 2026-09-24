# anticlone.js

**Open-source website clone deterrence. One script tag, no server required.**

Anyone can copy a website pixel-for-pixel in two clicks, using Figma importers
(html.to.design), page-saver extensions, or headless scrapers. Commercial tools
now sell protection against this. `anticlone.js` is a free, readable, MIT-licensed
alternative that anyone can drop into their site.

> **Honest disclaimer:** this is a deterrent and a detector, not DRM. A public
> web page can't be made uncopyable. What this script can do is disrupt
> specific capture paths, notice when a copy of your page runs somewhere else,
> and send you leads to investigate.

## How it thinks

A copied site only hurts you when two things happen:

| Step | What happens | What anticlone does |
|---|---|---|
| **1. Capture** | A tool serializes your rendered page | Detects known capture tools and automation, then hides the page and intercepts common read APIs |
| **2. Redeploy** | The copy goes live on someone else's domain | Detects that the page is running on a hostname you didn't allow, reports it, and optionally hides the page or redirects to your site |
| **Leads** | You need to find the copies | Stamps a watermark id into the page and into every report |

Redeploy detection is the most dependable part: if your page is running on
`copycat.com`, it's a copy, provided the copy kept the script. Capture detection
is best-effort, because it's heuristic by nature.

## Install

Put it early in `<head>`. Don't use `async` or `defer`, because the pre-paint gate needs to run before first paint.

```html
<script src="https://cdn.jsdelivr.net/gh/ra-kesh/anticlone@v0.2.0/anticlone.js"
        data-origins="example.com,*.example.com"
        data-watermark="build-2026-09-24"
        data-report="https://example.com/api/clone-report"></script>
```

The URL is pinned to a released version. Use `@main` for the latest, or self-host the file. See [SECURITY.md](SECURITY.md) to report issues.

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
| `data-watermark` | *(none)* | Your id. It's added as `html[data-ac-wm]`, a `--ac-wm` CSS variable, and an HTML comment, and included in every report |
| `data-message` | `This page is protected` | Text shown on the shield screen |
| `data-fingerprints` | *(none)* | Extra element ids that identify a capture tool (letters, digits, `_` and `-` only) |
| `data-safe-mode` | off | Only hard detectors act. Soft signals are reported but never hide the page, and the pre-paint gate is off |
| `data-no-gate` | off | Turn off the pre-paint gate |
| `data-gate-ms` | `800` | The longest the pre-paint gate may hide the page |
| `data-allow-automation` | off | Ignore webdriver and headless signals, so your own Playwright or Cypress tests keep working |
| `data-nonce` | *(none)* | CSP nonce for the injected `<style>` |
| `data-debug` | off | Log to the console |

## What it detects

**Hard detectors** act immediately and stay active. Clicks, the API, and back/forward navigation don't undo them:

| Detector | Signal |
|---|---|
| `capture-tool` | An html.to.design or Figma capture toolbar is in the page, whether added directly, inside a wrapper, through an id change, or before the script loaded. Also fires when the html.to.design serializer global exists or gets written |
| `webdriver` | `navigator.webdriver === true` |
| `headless-ua` | `HeadlessChrome` in the user agent |
| `foreign-origin` | The page is running on a hostname outside `data-origins` (reported, and it hides the page only with `data-foreign="shield"`) |
| `saved-copy` | The page is running from `file://` (same behavior as `foreign-origin`) |
| `framed` | The page is embedded in a frame from a site not in `data-origins` (report only) |

**Soft signals** are suspicions. Each one is reported, but the page is only
hidden when **two different signals agree within 60 s**, or when a signal is
already corroborated on its own (`headless-env` requires 2 of 3 checks). The
next real click, keypress, wheel or touch undoes a soft shield.

| Signal | What triggers it |
|---|---|
| `headless-env` | At least 2 of: zero outer window size, a software WebGL renderer (SwiftShader or llvmpipe), no languages |
| `scroll-velocity` | A jump of more than 400 px at more than 60 px/ms with no wheel, touch or pointer input behind it. Browser scroll restoration after back/forward and hash navigation is ignored |
| `longtask` | 3 main-thread tasks over 500 ms within 45 s, while nobody has touched the page for 15 s |
| `frame-stall` | 3 rendering stalls over 700 ms while the page is visible and idle |

If your own code scrolls the page programmatically, call
`anticlone.expectScroll(ms)` first so the jump isn't counted.

Search engines, social previews, AI crawlers and uptime monitors are recognized
by user agent and skipped entirely, so SEO and link previews are unaffected.

## The pre-paint gate

Until the page finishes parsing, the body is hidden, so a tool that captures on
first paint gets nothing. The gate is **released after 800 ms at most** (set with
`data-gate-ms`), even if slow scripts are still blocking `DOMContentLoaded`.
On a fast page it's a single frame. On a page with slow blocking scripts,
visitors may see up to `data-gate-ms` of blank page. If that trade-off doesn't
suit you, set `data-no-gate` or `data-safe-mode`.

## What happens on detection ("shield")

1. `html.ac-shield` hides the page content behind a dark overlay with your message.
2. The shield puts itself back if something interferes with it: a removed class,
   overlay or stylesheet, an emptied or disabled stylesheet, or an inline style
   on the overlay. It re-checks on every observed change and every 500 ms.
3. While the shield is up, common **page-world** read APIs return empty data:
   - `getComputedStyle` reports elements in the page body as hidden and transparent.
   - Canvas `toDataURL`, `toBlob` and `getImageData` return blank images.
   - `CSSStyleSheet.cssRules` returns `[]`.

   This disrupts tools that serialize through those APIs in the page's own
   JavaScript context. It does **not** stop code that gets untouched native
   methods elsewhere (see Limits), and the page text stays in the DOM.
   Everything is restored if a soft shield heals.
4. Detections are reported to `data-report`.

## Reports

Each detection is reported once per page view, as a JSON `POST` sent via
`sendBeacon` as `text/plain`:

```json
{
  "v": "0.2.0",
  "detector": "foreign-origin",
  "host": "copycat.example",
  "foreignHost": "copycat.example",
  "protocol": "https:",
  "path": "/pricing",
  "referrerOrigin": "https://search.example",
  "watermark": "build-2026-09-24",
  "ua": "Mozilla/5.0 …",
  "t": 1790224030552
}
```

**Privacy:**
- The referrer is reduced to its origin, with no path, query or fragment.
- The current page is sent as its pathname only, with no query string.
- Pathnames can still contain personal identifiers on some sites (for example `/users/jane`), so treat your collector as holding personal data.

Any endpoint that accepts a POST works: a serverless function, a Cloudflare
Worker, or a form backend.

**Reports are leads, not proof.** Every field is produced by client-side code,
and the watermark is visible to anyone, so a report can be forged. Use a
`foreign-origin` report to find a copy, then verify it independently, for
example by visiting the site and archiving it. That verified evidence is what
supports a takedown request.

## Events and API

```js
document.addEventListener("anticlone:detect", e => console.log(e.detail)); // {detector, action: shield|suspect|report|redirect}
document.addEventListener("anticlone:shield", e => console.log(e.detail)); // {detector, sticky}
document.addEventListener("anticlone:heal",   e => console.log(e.detail)); // {via}

window.anticlone.version;           // "0.2.0"
window.anticlone.state;             // read-only snapshot: {shielded, sticky, detector, detections[]}
window.anticlone.shield("test");    // manual soft shield (handy for testing your styling)
window.anticlone.heal();            // clears soft shields only; never a hard one
window.anticlone.expectScroll(1000); // ignore scroll jumps for the next N ms
```

## Limits (read this before you rely on it)

- **It's all client-side.** Someone who downloads the raw HTML and CSS, blocks the script, or disables JavaScript never runs it. Redeploy detection only works if the copy keeps the script.
- **API interception only covers the page's own context.** A tool running in a browser extension's isolated world, or taking native methods from a fresh iframe, reads the original styles, canvas pixels and CSS rules. The page text stays in the DOM while shielded.
- **Code in the page can remove it.** Any script that runs in the page, including browser devtools, can undo this script's effects. The shield puts itself back against common interference, but it can't enforce anything against code that has the same access it has.
- **Screenshots can't be stopped.** Nothing prevents someone photographing their own screen.
- **Heuristics trade false positives for coverage.** Soft signals need corroboration, wait for idle time, and heal on real input. If you still see complaints, use `data-safe-mode`.
- **User-agent allowlists are spoofable.** Pretending to be Googlebot skips the script entirely. The allowlist exists so SEO never breaks, not as a security boundary.
- **Fingerprints go stale.** Capture tools change. Contributions of new fingerprints are welcome.
- **Tested in Chromium only.** Firefox, Safari, mobile browsers, assistive technology and the real capture extensions haven't been systematically tested yet.

## Stronger protection comes from pairing it with the server

The script is one layer. For real assurance, add these server-side layers:

- **Signed, expiring URLs for images and fonts**, so copied pages break over time.
- **Hotlink protection:** check the `Referer` on assets, and log which foreign sites request them. This is server-side evidence that doesn't depend on client reports.
- **Bot management** at your CDN (Cloudflare, Fastly and similar), with verified-bot checks based on reverse DNS rather than user agents.
- **Keep the valuable parts on the server:** pricing logic, forms, integrations. A copy of the HTML doesn't get them.

## License

MIT, see [LICENSE](LICENSE). Use it, fork it, ship it. No warranty.

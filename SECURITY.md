# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.2.x | Yes |
| 0.1.x | No (upgrade to 0.2.x) |

## Reporting a vulnerability

**Please don't open a public issue for security problems.** Report them privately instead:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**. This uses GitHub's private vulnerability reporting.

Please include the browser and version, the configuration you used (the `data-*` attributes), steps to reproduce, and the impact.

You should get an acknowledgement within 7 days. Fixes are released as a new tagged version and credited to the reporter, unless you'd rather stay anonymous.

## What counts as a vulnerability

Report privately:

- The script breaks or harms the page it protects, for example XSS through a config value, a crash, or a real user getting permanently locked out.
- A way for a third party to **trigger the shield on real visitors** of a site they don't control.
- Report payloads leaking data beyond what's documented in the README.
- A hard detector firing for ordinary, unautomated browsers (false positives at scale).

Open a normal issue or pull request instead:

- **New capture-tool fingerprints**, or tools the script doesn't detect yet.
- **Ways around the heuristics.** The script is a client-side deterrent, and the README's "Limits" section already says a determined person can get past it. Suggestions for making it harder are welcome as regular issues.
- Tuning of soft-detector thresholds.

## Scope reminder

anticlone.js is a deterrent, not DRM. It can't stop someone who blocks JavaScript, downloads the raw HTML, or takes screenshots. See [README.md](README.md#limits-read-this-before-you-rely-on-it).

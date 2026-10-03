# Dashboard and Worker security review (Wave 11)

This is a review of the browser dashboard (`dashboard/`) and the `titan-runner-brain` Worker (`worker/`), with a focus on the provider key form and the Worker's write routes. It lists what was checked, what changed, and what stays open. This repository is public, so nothing here names a real token, key, or account.

## The short answer on provider keys

A provider key takes one path and no other.

1. The person pastes it into the Provider keys form. The field is a password input and the value lives only in component state until the request returns.
2. The browser sends it over HTTPS to the Worker's `POST /admin/keys` with the admin token in the `X-Titan-Auth` header.
3. The Worker checks the header with a timing-safe compare, checks the value (one printable token, 1024 characters at most), seals it with GitHub's repository public key (a sealed box), and writes the ciphertext to the Actions secrets API.
4. The response is `{ ok, provider, secretName }`. The key is not in it. The database keeps a `configured` flag and a timestamp, never the key.

`worker/test/admin-input.test.mjs` checks each step: no token or a wrong token gets a 401 before any network call, GitHub receives ciphertext that opens to the exact key, the response and the database rows never hold the key, and a GitHub failure puts the key in neither the response nor the log.

## Findings

| ID | Area | Finding | Severity | Status |
|---|---|---|---|---|
| R-1 | Dashboard | The admin token and the GitHub token sat in `localStorage`. A static site on GitHub Pages shares one origin, `<owner>.github.io`, with every other project page the owner publishes, so any script on any of them could read the tokens, and they never expired. | Medium | Fixed. Both go to `sessionStorage` by default (this tab only). A "Remember on this device" box opts in to `localStorage`, and the screen says what that means. A token is in one place at a time. |
| R-2 | Dashboard | The admin lock hides the page in the browser, but `state/*.json` is public in the repository. The old copy implied privacy. | Low | Fixed in the copy. The lock screen and Settings now say the data is public and the lock is not a privacy control. |
| R-3 | Dashboard | Pages sends no security headers, so the page had no Content Security Policy. | Medium | Fixed as far as a meta tag allows. `connect-src` lists only this origin, `raw.githubusercontent.com`, `api.github.com`, `api.open-meteo.com`, and the Worker. A script that got into the page could read a token but could not send it to another site. See the limits below. |
| R-4 | Dashboard | Outbound links and fetches sent the page URL as the referrer. | Low | Fixed with `referrer: no-referrer`. |
| R-5 | Dashboard | The install manifest and icons returned 404 on GitHub Pages because their paths missed the `/TITAN-Runner` prefix. The service worker also cached error responses. | Low | Fixed. Paths take the base path, the worker caches only successful responses, and it keeps the app shell so a second visit opens offline. It still never caches `state/*.json`. |
| R-6 | Dashboard | The Settings and New task dialogs had no dialog role, no Escape key, and no focus handling. Settings holds a token field. | Low | Fixed with a shared `useModal` hook and `role="dialog"`. |
| R-7 | Worker | `POST /tasks` accepted any string as `task_type`, including `osint` and `meta-lesson`, which other routes treat as trusted. The value also becomes a workflow input. | Low | Fixed. It must match `[a-z0-9][a-z0-9_-]{0,39}`, and the two reserved names are refused. |
| R-8 | Worker | `POST /admin/keys` accepted a value of any length or character set. | Low | Fixed. One token of printable ASCII, no spaces, 1024 characters at most. The error message does not repeat the value. |
| R-9 | Worker | The failure logger printed every response header. A proxy that echoed `Authorization` or `Set-Cookie` would reach the log. | Low | Fixed. Those headers print as `[redacted]`. |
| R-10 | Worker | One admin token guards every write route. Whoever holds it can queue work, write provider keys, and request VMs. | Medium | Accepted and documented. Rotate it with `wrangler secret put TITAN_ADMIN_TOKEN` if it leaks. A separate, narrower token for `/admin/keys` is the next step if the risk matters. |
| R-11 | Worker | CORS allows any origin (`*`). | Low | Accepted. The token travels in a header and not a cookie, so a foreign page cannot act for a signed-in visitor. It would need the token itself. Pinning CORS to the Pages origin would be tighter and needs a new setting. |
| R-12 | Worker | Nothing slows repeated wrong tokens. | Medium | Open, needs a person. A long random token makes online guessing impractical. A Cloudflare rate limiting rule on the Worker route closes it, and that is an account setting, not a code change. |

## Limits of the page policy

A meta tag cannot set `frame-ancestors` or a reporting endpoint, so framing the page is not blocked. A static export carries inline scripts and styles, so `script-src` and `style-src` keep `'unsafe-inline'`. The policy limits where data can go. It does not stop injected markup from running.

## What was not changed

- Workflows. No schedule, trigger, or cadence changed.
- The Worker's deploy. It deploys when a push to `main` touches `worker/**`, so the Worker changes in this review go live with that merge.
- Any stored secret or repository setting.

## Checks that ran

- Root tests: 342 passed.
- Worker tests: 46 passed (36 existing, 9 new for the routes above, 1 new for log redaction).
- Dashboard tests: new tests for token storage, the quota and pulse views, the policy builder, and theme handling.
- Built the site with the Pages base path, served it, and drove it in Chromium: axe found no violations on the three routes in four themes at desktop and 390 pixel widths, the console stayed clean with the policy active, and there was no horizontal scroll.
- Walked the sub-agent cluster and the VM fleet against a local stand-in for the Worker with labeled fixture rows. That covered queueing a task, requesting a VM, countdowns, a rejected token locking the page, and the install and offline paths.

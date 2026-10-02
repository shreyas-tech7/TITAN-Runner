# God's Eye View tab

The dashboard has a top level tab called **God's Eye View**. It embeds the real open source
[God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) app: a full 3D Earth with live flights,
military flights, earthquakes, satellites, street traffic, and CCTV, in the app's own HUD.

The app does not run on your machine. A gate in front of a free Render web service serves it. The host code
lives in a separate public repo, [TITAN-GEV](https://github.com/shreyas-tech7/TITAN-GEV). Hugging Face was the
first choice, but it now requires a paid PRO plan for Docker Spaces. TITAN-GEV's
[hosting notes](https://github.com/shreyas-tech7/TITAN-GEV/blob/main/docs/HOSTING.md) compare the free options.

The schematic globe card on the main dashboard still works. Its header now has a **Live 3D Earth tab**
link that opens this tab. The investigation log at `/ops/geospatial` is unchanged.

## How it works

1. You unlock the dashboard with your admin token, as always.
2. The tab asks the `titan-runner-brain` Worker for an access link with `GET /gev/token`. The Worker
   checks the admin token first, so only a logged in dashboard can get one.
3. The Worker signs a token with its Ed25519 private key (`GEV_SIGNING_KEY`). The token lives 5 minutes.
4. The tab loads the host in an iframe with the token in the URL.
5. The host checks the signature with the matching public key (`GEV_VERIFY_KEY`), sets a session cookie, and
   replaces the URL with a clean one. A token works once.
6. The status bar above the globe shows **Reachable** or **Waking up**. A free Render service sleeps after 15 idle
   minutes and wakes in about a minute. While it wakes, the tab says so and retries on its own.

The host holds only a public key, so it can check tokens but never make them. No secret sits on both sides.
The token format is `gev2.<iat>.<exp>.<jti>.<signature>`, where the signature covers the first four parts.
The full gate is documented in the
[TITAN-GEV README](https://github.com/shreyas-tech7/TITAN-GEV#security-model).

## Set it up

Nothing here needs a credit card. Do the steps in this order.

1. **Deploy the host on Render.** Follow "Deploy on Render" in the TITAN-GEV README. It uses a Blueprint, so Render
   asks for one value, the public key in step 3.
2. **Provision the signing key.** Run the **Provision GEV signing key** workflow (Actions tab, then Run
   workflow). It also runs on its own the first time it lands on `main`. A GitHub runner makes an Ed25519 key,
   masks it, and pipes it into the Worker secret `GEV_SIGNING_KEY`. Nobody pastes or sees the private key.
   This needs the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets that Worker deploys already use.
3. **Give the host the public key.** The workflow's job summary shows the public key, and
   `GET /gev/jwks` on the Worker serves it as a JWK. Set the `x` value on the Render service as `GEV_VERIFY_KEY`.
   It is public, so it is safe to paste into the service's environment settings.
4. **Tell the dashboard where the host is.** Add the repository variable `GEV_URL`
   (Settings, Secrets and variables, Actions, Variables) with the service URL from the Render page, for example
   `https://titan-gev.onrender.com`. Then run the **Deploy dashboard to Pages** workflow once. The URL is not secret.
5. **Optional: the free Cesium ion token.** Create a token at <https://ion.cesium.com> and restrict it under
   **Allowed URLs** to the host origin. Add it as the Render secret `CESIUM_ION_TOKEN`. Without it, the globe
   uses the keyless Esri basemap.
6. **Check it.** Run the **GEV live check** workflow (see "Live check" below). It needs no secret from you. Then open the tab.

| Name | Where | Secret |
| --- | --- | --- |
| `GEV_URL` | GitHub Actions variable on this repo | No |
| `GEV_SIGNING_KEY` | Worker secret, made by the provision workflow | Yes |
| `GEV_VERIFY_KEY` | Render environment variable, the public `x` value | No |
| `CESIUM_ION_TOKEN` | Render secret | Treat as quota guard |

## What you see in each state

| State | What the tab shows |
| --- | --- |
| No `GEV_URL` | "God's Eye View is not connected" with the variable name |
| Host asleep | "Waking up, this can take a minute" and automatic retries every 3 to 15 seconds |
| Worker has no `GEV_SIGNING_KEY` | "The access gate is not set up" |
| Worker URL missing | The same setup message, naming `NEXT_PUBLIC_TITAN_WORKER_URL` |
| Browser blocked the session cookie | A banner that points to **Open full screen** |
| Ready | The globe, with **Reachable** in the status bar |

**Open full screen** loads the globe as its own page in a new browser tab. Use it when your browser blocks
the embedded session cookie, or when you want the whole window.

## Rotate the key

1. Run the **Provision GEV signing key** workflow with **rotate** set to true. It replaces `GEV_SIGNING_KEY`.
2. Copy the new public key from the job summary and set it as `GEV_VERIFY_KEY` on the host. The host restarts.
3. Reload the tab. Tokens from the old key stop working at once, and the tab asks for a fresh one.

Rotate if you ever think the private key leaked. A restart of the host also ends every session, because the
host signs session cookies with a random key it makes at boot.

## Live check

Run the **GEV live check** workflow (manual) to test the whole path. It checks the host's gate, mints a token
from the Worker, runs TITAN-GEV's `verify:live` script, and opens the real tab in headless Chromium. It prints
PASS and FAIL lines and never prints a token.

## Security notes

- The Worker never returns the private key. `GET /gev/jwks` sends only `kty`, `crv`, and `x`, and the tests
  prove it never includes `d`.
- Do not derive the signing key from the admin token. The public key is public, so a derived key would let
  anyone test guesses of the admin token offline.
- The dashboard is on GitHub Pages and cannot send response headers, so it has no CSP of its own. When
  `GEV_URL` is set, the page carries one meta CSP with a single directive: `frame-src <the host origin>`.
  It allows no other frame source and changes nothing else.
- The iframe has a sandbox that allows scripts, same origin access, forms, popups, downloads, and pointer
  lock. It does not allow the frame to navigate the dashboard.
- Only messages from the host origin and from the iframe itself change the tab's state.
- The dashboard never stores an access link. It asks for a new one each time.
- While the tab is open, the dashboard checks the host every 30 seconds. That also keeps a free Render service awake.
- The private TITAN repo has its own strict nonce CSP in `dashboard/proxy.ts`. That is a different
  dashboard, and this tab does not touch it.

## Tests

```bash
cd dashboard && npm ci && npx tsc --noEmit && npm test
cd worker && node --test test/*.test.mjs
node scripts/check-workflows.mjs
```

The dashboard tests cover the host URL rules, the CSP, token minting through the Worker client, the health
check, Open full screen, the controller (with a fake clock for the retry), and every rendered state. The Worker
tests check the signing, the `/gev/jwks` shape, and a public token fixture that the TITAN-GEV tests also check.

## Attribution

God's Eye View is by Bilawal Sidhu and uses the MIT license. Its datasets and live feeds keep their own terms,
and two of them are non-commercial. This deployment is for personal use. The tab footer carries the credit.

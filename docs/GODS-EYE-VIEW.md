# God's Eye View tab

The dashboard has a top level tab called **God's Eye View**. It embeds the real open source
[God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) app: a full 3D Earth with live flights,
military flights, earthquakes, satellites, street traffic, and CCTV, in the app's own HUD.

The app does not run on your machine. A gate in front of a free Hugging Face Space serves it. The
Space code lives in a separate public repo, [TITAN-GEV](https://github.com/shreyas-tech7/TITAN-GEV).

The schematic globe card on the main dashboard still works. Its header now has a **Live 3D Earth tab**
link that opens this tab. The investigation log at `/ops/geospatial` is unchanged.

## How it works

1. You unlock the dashboard with your admin token, as always.
2. The tab asks the `titan-runner-brain` Worker for an access link with `GET /gev/token`. The Worker
   checks the admin token first, so only a logged in dashboard can get one.
3. The Worker signs a token with `GEV_SHARED_SECRET`. The token lives 5 minutes.
4. The tab loads the Space in an iframe with the token in the URL.
5. The Space checks the signature, sets a session cookie, and replaces the URL with a clean one.
6. The status bar above the globe shows **Reachable** or **Waking up**. A free Space sleeps when idle.
   While it wakes, the tab says so and retries on its own.

The token format and the full gate are documented in the
[TITAN-GEV README](https://github.com/shreyas-tech7/TITAN-GEV#security-model).

## Set it up

Nothing here needs a credit card. Do the steps in this order.

1. **Create the Space.** Follow "Deploy on Hugging Face" in the TITAN-GEV README.
2. **Pick the shared secret.** Generate 32 or more random characters. Keep them out of git and out of chat.
3. **Put the secret in two places.**
   - Worker: `wrangler secret put GEV_SHARED_SECRET` from the `worker/` folder, or the Cloudflare dashboard
     under the `titan-runner-brain` Worker, Settings, Variables and Secrets.
   - Space: add a secret named `GEV_SHARED_SECRET` in the Space settings.
4. **Tell the dashboard where the Space is.** Add the repository variable `GEV_URL`
   (Settings, Secrets and variables, Actions, Variables) with the Space URL, for example
   `https://cozmik7-titan-gev.hf.space`. A new Pages deploy picks it up. The URL is not secret.
5. **Optional: the free Cesium ion token.** Create a token at <https://ion.cesium.com> and restrict it under
   **Allowed URLs** to the Space origin. Add it as the Space secret `CESIUM_ION_TOKEN`. Without it, the globe
   uses the keyless Esri basemap.

| Name | Where | Secret |
| --- | --- | --- |
| `GEV_URL` | GitHub Actions variable on this repo | No |
| `GEV_SHARED_SECRET` | Worker secret and Space secret (the same value) | Yes |
| `CESIUM_ION_TOKEN` | Space secret | Treat as quota guard |
| `HF_TOKEN` | GitHub secret on TITAN-GEV | Yes |

## What you see in each state

| State | What the tab shows |
| --- | --- |
| No `GEV_URL` | "God's Eye View is not connected" with the variable name |
| Space asleep | "Waking up, this can take a minute" and automatic retries every 3 to 15 seconds |
| Worker has no `GEV_SHARED_SECRET` | "The access gate is not set up" |
| Worker URL missing | The same setup message, naming `NEXT_PUBLIC_TITAN_WORKER_URL` |
| Browser blocked the session cookie | A banner that points to **Open full screen** |
| Ready | The globe, with **Reachable** in the status bar |

**Open full screen** loads the globe as its own page in a new browser tab. Use it when your browser blocks
the embedded session cookie, or when you want the whole window.

## Security notes

- The dashboard is on GitHub Pages and cannot send response headers, so it has no CSP of its own. When
  `GEV_URL` is set, the page carries one meta CSP with a single directive: `frame-src <the Space origin>`.
  It allows no other frame source and changes nothing else.
- The iframe has a sandbox that allows scripts, same origin access, forms, popups, downloads, and pointer
  lock. It does not allow the frame to navigate the dashboard.
- Only messages from the Space origin and from the iframe itself change the tab's state.
- The dashboard never stores an access link. It asks for a new one each time.
- The private TITAN repo has its own strict nonce CSP in `dashboard/proxy.ts`. That is a different
  dashboard, and this tab does not touch it.

## Tests

```bash
cd dashboard && npm ci && npx tsc --noEmit && npm test
cd worker && node --test test/*.test.mjs
```

The dashboard tests cover the Space URL rules, the CSP, token minting through the Worker client, the health
check, Open full screen, the controller (with a fake clock for the retry), and every rendered state. The Worker
tests include a shared token fixture that the TITAN-GEV tests also check.

## Attribution

God's Eye View is by Bilawal Sidhu and uses the MIT license. Its datasets and live feeds keep their own terms,
and two of them are non-commercial. This deployment is for personal use. The tab footer carries the credit.

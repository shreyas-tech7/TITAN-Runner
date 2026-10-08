# Keys

A key is a provider API key. This page tells you how to add a key, what the states mean, and where each check comes from.

## Add your first key in about one minute

1. Open the Keys page of the dashboard.
2. Choose a provider. Start with one that needs no card: Groq, Google Gemini, or OpenRouter.
3. Click "Get a free key". The provider page opens in a new tab.
4. Copy the key. Paste it into the key field.
5. Click "Save and verify".

TITAN checks the key with the provider first. If the provider rejects the key, TITAN saves nothing. If the key is good, TITAN seals it and writes it as a secret in the repo. Then a GitHub runner uses the key once. When that works, the row shows "Proven".

## Where a key lives

- The secret in the GitHub repo is the only home of a key. The pulse and the sub-agents read it there.
- D1 keeps a fingerprint and the last four characters. The fingerprint is the first 12 characters of the SHA-256 of the key. It does not reveal the key.
- A key marked "also for chat" has one more copy. It is encrypted in the vault with AES-256-GCM. That copy is off by default.
- The browser never keeps a key. The key is not in the URL, in `localStorage`, or in `sessionStorage`.

## States

| State | Meaning |
|---|---|
| `missing` | No secret with this name exists in the repo. |
| `saved_unverified` | The secret exists. Nobody has proved that the key works. The label says "Saved, not verified". |
| `provider_ok` | The provider accepted the key. No runner has used it yet. |
| `proven` | A runner used the key with success. The pulse counts as a runner. |
| `invalid` | The provider rejects the key. Save a new key. |
| `rate_limited` | The provider limits requests. Wait, or use another provider. |
| `unverifiable` | TITAN cannot check this provider. The reason is on the row. |
| `error` | A check did not finish. The reason is on the row. |

A check or a proof that is older than the secret does not count. A new secret means a different key.

## What happens when you save

1. The Worker checks the admin token.
2. The Worker checks the provider id against the catalog.
3. The Worker checks the format of the key. A wrong prefix gives a warning only.
4. The Worker checks the base URL and the other fields. A base URL must use https and a public host.
5. The Worker asks the provider if the key is good. The limit is 8 seconds. The key goes in a header.
6. If the provider answers 401 or 403, the Worker returns 422 and saves nothing.
7. If the provider answers 429, does not answer, or has no check route, the Worker returns 202. The dashboard asks "Save anyway?". The Worker saves only if you confirm.
8. The Worker seals the key and writes the secret. It also writes the base URL and the model, if you gave them.
9. The Worker writes the metadata and an audit event.
10. The Worker starts the runner test with a `provider-selftest` dispatch.

The runner test lists the models and sends one completion of 8 tokens or less. It sends its result to the Worker with the callback token.

## The catalog

The file `config/providers.catalog.json` lists every provider. It is the one source of truth. The Worker, the dashboard, the pulse, `.env.example`, and the workflow env maps come from it. After you change it, run:

```bash
npm run sync:providers
npm run check:providers
```

The check fails in CI if any file drifts from the catalog.

## Check routes

Checked on 2026-10-08. Each check costs no tokens. A live probe with a fake key gave the status in the last column.

| Provider | Check | Source | Fake key gave |
|---|---|---|---|
| Groq | `GET https://api.groq.com/openai/v1/models` | https://console.groq.com/docs/api-reference | 401 |
| Together AI | `GET https://api.together.xyz/v1/models` | https://docs.together.ai/reference/models-1 | 401 |
| OpenRouter | `GET https://openrouter.ai/api/v1/key` | https://openrouter.ai/docs/api-reference/limits | 401 |
| Google Gemini | `GET https://generativelanguage.googleapis.com/v1beta/models` with the header `x-goog-api-key` | https://ai.google.dev/api/models | 400 (`API_KEY_INVALID`) |
| Hugging Face | `GET https://huggingface.co/api/whoami-v2` | https://huggingface.co/docs/hub/api | 401 |
| OpenCode Zen | None. The model list is public. | https://opencode.ai/docs/zen/ | 200 for any key |
| OmniRoute | `GET {base}/models` | https://github.com/diegosouzapw/OmniRoute | not probed |
| Hermes 1 to 3 | `GET {base}/v1/models`, health at `GET {base}/health` | https://raw.githubusercontent.com/NousResearch/hermes-agent/main/website/docs/user-guide/features/api-server.md | not probed |
| Freebuff | None. Freebuff has no public API. | https://freebuff.com | not applicable |
| Custom 1 to 3 | `GET {base}/models` | https://platform.openai.com/docs/api-reference/models/list | not probed |

Two routes need a note. The model list of OpenRouter, Hugging Face, and OpenCode answers 200 for any key, so it cannot check a key. Gemini answers 400 and not 401 for a bad key.

## Free tiers

Checked on 2026-10-08. Do not add a card. The rule of this project is to spend $0.

| Provider | Needs no card | Note |
|---|---|---|
| Groq | Yes | A free plan exists. The limits are in the Groq console. |
| Google Gemini | Yes | A free tier exists. The limits are in Google AI Studio. |
| OpenRouter | Yes | Free models allow 20 requests each minute. They allow 50 each day if you bought less than 10 credits. |
| Together AI | No | Together AI has no free trial now. A purchase of 5 dollars is required. |
| Hugging Face | No | Free accounts get no monthly credit for Inference Providers. |
| OpenCode Zen | No | Some models are free. Check the Zen console. |

## Troubleshooting

- **The row says `missing`, but you saved a key.** Look at the banner on the Keys page. TITAN flags a secret whose name is one letter away from a catalog name. The live repo had `GROK_API_KEY` where `GROQ_API_KEY` is right. Save the key again on the Keys page.
- **The page shows a PAT banner.** The token `GITHUB_PAT` of the Worker lacks a permission. The banner names it. Edit the token on GitHub and add the permission. Do not make a new token.
- **The runner test takes a long time.** The row stays `saved_unverified` until the proof comes back. Click "Test now" to start it again.
- **A proof never arrives.** Open Settings and click "Repair runner callbacks". It rotates the callback token and runs a round trip test.
- **Chat says no key is ready.** Mark the key "also for chat" and make sure that the vault is ready. Run the workflow "Provision vault key" if it is not.

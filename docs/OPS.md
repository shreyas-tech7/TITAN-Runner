# Ops services

TITAN-Runner runs five small services that both TITAN and Runner use. The contract is in `docs/CONTRACT.md`. This page says how each service works and which secrets it needs.

## Secrets and variables

| Name | Where | Used by |
|---|---|---|
| `OPS_TOKEN` | Worker secret and Actions secret. TITAN holds the same value. | Every `/ops` route. Workflows send it. |
| `TITAN_WORKER_URL` | Actions variable (already set) | Workflows that call the Worker |
| `DOORBELL_TOKEN` | Actions secret. TITAN holds the same value. | The doorbell workflow |
| `TITAN_BACKEND_URL` | Actions secret | The doorbell workflow |
| `HOST_URL_*` | Actions secrets, one for each host | The host probe |
| `DISCORD_WEBHOOK_URL` | Actions secret (optional) | The host alerts |

A secret that is not set means the service skips quietly. It does not fail.

## Usage ledger and free quota meter (RO1)

The router reports each provider call. At the end of a pulse it sends one batch to `POST /ops/usage`. A batch holds one record for each provider, model, and status. The record has counts, a status, and a time. It never has a prompt, an answer, or a key.

The Worker keeps the records in D1. `GET /ops/quota` turns them into the answer of the contract: the limit, the use, the share left, the reset time, and `exhausted`.

The limits are in `config/quotas.json`. Each entry names the official page and the day that someone read the limit. A limit that the page does not state is `null`, and the confidence is `unknown`. Runner never guesses a limit. The file holds these facts, read on 2026-10-11:

| Provider | Free limit that the docs state | Reset |
|---|---|---|
| OpenRouter, `:free` models | 20 requests a minute. 50 requests a day if the account bought fewer than 10 credits. 1000 a day if it bought 10 or more. | UTC day |
| Gemini | The docs send the reader to AI Studio. No number is on the page. | Midnight Pacific time |
| Groq | The page shows the Developer plan only. No free number. | Not stated, so UTC midnight |
| Together | No free tier is mentioned. | Not stated, so UTC midnight |
| Hugging Face | Free users get no monthly credits for Inference Providers. | Not stated, so UTC midnight |
| OpenCode Zen | A list of free models. No request limit. | Not stated, so UTC midnight |

Groq sends the header `x-ratelimit-remaining-requests`. The Groq docs say that it counts requests left in the day. So Runner reads the daily limit from it: the limit is the use of the day plus the requests left. That limit has the confidence `observed`.

`exhausted` turns true at 95% of a known limit. It also turns true after a `429`, until the next reset.

### The routing rules

The router follows the rules of the contract. The rules are in `src/ops/gate.js`:

- It skips a provider that is down, `not_configured`, or exhausted.
- It ranks degraded providers last.
- It opens a circuit breaker after 3 failures in a row. It lets one call through as a probe after 15 minutes.
- If nothing is left, the registry throws `ALL_PROVIDERS_FAILED` with the reason for each skip. The scheduler then parks the task. The reason shows in the task and in `titan explain`.

The router reads the mirrors `state/ops/health.json` and `state/ops/quota.json` from the checkout. An answer older than 36 hours is ignored. An exhausted flag whose reset time has passed is ignored. A caller that names a provider still gets one try at a `down` verdict. It never gets a try at an exhausted provider, because the call would fail.

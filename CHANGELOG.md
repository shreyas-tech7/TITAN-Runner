# Changelog

## Wave 12, release 1

- Add `config/providers.catalog.json`, the one source of truth for providers, with a CI gate for drift.
- Add the Keys page. It shows the true state of each key and checks a key with the provider before it saves it.
- Add `POST /admin/keys` with a provider check, a sealed box, an audit log, and a runner proof.
- Add custom OpenAI compatible providers, OmniRoute, and Hermes keys.
- Add the callback token. The Worker makes it and rotates it. Workflows use it and not the admin token.
- Add the stuck task reaper and the Retry button.
- Add the pulse keeper. The Worker starts a pulse when GitHub is late.
- Add one route table with a token group for each route, the wrong token lockout, and a CORS allowlist.
- Add `safeFetch()` for every outbound call of the Worker.
- Add D1 migrations, retention, export, and delete.
- Add OpenRouter model rotation and a Gemini preference.
- Add the daily light probe to the provider self-test.
- Add the vault key step to `worker-deploy.yml` and the workflow `vault-provision.yml`.
- Add the STE documentation standard and its check.
- Fix: the Worker entry module exported values that the current workerd refuses.

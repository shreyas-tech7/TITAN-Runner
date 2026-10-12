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

## Nightly provider canary (RO2)

The workflow `ops-canary.yml` runs around 03:00 in America/Chicago. GitHub cron uses UTC, so two crons fire each day, and a first step lets only the one at hour 03 in Chicago go on. A manual run always goes on.

The canary sends one fixed task to every provider of the catalog. The task is: add 17 and 25, and reply with only the JSON `{"sum": <the number>}`. The canary checks the JSON and the sum. It marks each provider:

| Status | Meaning |
|---|---|
| `healthy` | The answer is right, the JSON is valid, and the call took 8 seconds or less. |
| `degraded` | The call worked, but it was slow, or the answer or the format was wrong, or it failed once and then worked (`flaky`), or the provider answered `429`. |
| `down` | The call failed twice, or the key was rejected, or the quota is gone, or the model does not exist. |
| `not_configured` | No key. Freebuff has no public API, so it always shows this. |

A key that was rejected, a spent quota, and a rate limit are not tried a second time.

A Hermes agent can act on its own host. The canary sends it no prompt. It lists the models of the agent and marks it healthy if the list answers.

The result holds a provider name, a model name, a status, a latency, a time, and an error class. The canary posts it to `POST /ops/health` and writes the public mirror `state/ops/health.json`. Its calls count in the usage ledger like any other call. The router reads the mirror: see the routing rules above.

Run it by hand: `node scripts/ops-canary.mjs --only groq,gemini --no-post`.

The log of the workflow shows a short error text next to each provider that is down or degraded, for example "The model requires terms acceptance". The text is cut of secrets and line breaks, and it has at most 160 characters. It stays in the log. It never goes to the mirror or to the Worker.

## Golden task eval (RO3)

The workflow `ops-eval.yml` runs every Sunday, and by hand. It sends 15 small tasks to every configured model. The tasks cover all 12 categories of the shared taxonomy (`src/orchestrator/taxonomy.js`): architecture, code generation (2 tasks), refactoring, testing, debugging (2), documentation, security review, performance, data modeling, devops, UI implementation, and research (2).

Each task has a deterministic checker. No model judges another model:

| Checker | What it does |
|---|---|
| `exact` | The answer equals a fixed text after cleaning (fences, quotes, a final period, case). |
| `regex` | The answer matches a pattern. |
| `json` | The answer holds JSON that fits a schema and holds the required values. |
| `code` | The answer is JavaScript. A unit test calls its function with fixed inputs and compares the results. |

Each task in `src/ops/goldenTasks.js` has a `reference` answer that must pass and a `wrong` answer that must fail. The tests run both. A change to a task needs a new `EVAL_VERSION`. The tests pin a fingerprint of the list.

### Code from a model is untrusted

The unit test never runs model code in the process that holds the keys. It runs in a child process with an empty environment, a temporary working folder, a time limit, and Node's permission model. The permission model denies files, child processes, and workers. A test proves that the child sees no environment variable and cannot read a file or start a process. If the permission model is missing, no model code runs, and the task is left out of the score.

### The budget

The run is held to 280 calls a week. If the models times the tasks is more, the run uses fewer tasks. It goes around the categories, so each one stays covered as long as the budget allows. Every model gets the same tasks, so the scores compare.

A provider error is not a wrong answer. A rate limit, a rejected key, or a spent quota stops that model, and its tasks that did not run are left out of `tasks_run`. Hermes agents are not tested, because an agent can act on its own host.

### Where the scores go

- `POST /ops/eval` and `GET /ops/eval` (contract v1).
- The public mirror `state/ops/eval.json`.
- The capability cache `state/agents.json`, in the field `measured` of each record. The router reads it: a measured score beats an assumed strength. A score of 1.0 counts like a strength, 0.0 like a weakness, and 0.5 counts zero. If a category has no measured score, the assumed lists decide, as before.

The workflow has two jobs. The first job has the keys, runs the tasks, and uploads a small file of scores. It cannot write to the repo. The second job has no key. It writes the files under `state/` and commits them. So the long run never holds the shared state group.

## Post-mortems (RO4)

Every task that ends `failed` or `dead-lettered` gets a short post-mortem. It says what failed, the likely cause, and a suggested fix. The pulse writes it after the work of the pulse, at most 3 for each pulse. `TITAN_POSTMORTEM=0` turns it off.

A free model writes the cause and the fix when one is free. It gets facts only: the failure class, the code, the step category, the counts, and the providers tried. A template writes them when no model is free, or when the model text is not clean. The text is cleaned of secrets, email addresses, and links. gitleaks scans it when the binary is there. The pulse job installs it with a checked sum. A finding drops the model text.

This repo is public, so a post-mortem never holds the title, the prompt, an answer, or a login of the task. A test checks that with a marker in the task text.

The lessons go to `state/lessons.jsonl`. A repeat merges by error signature: the class, the code, and the shape of the message. The shape ignores numbers, ids, quoted text, and lists in parentheses. The second failure of one kind raises `count` and moves `last_seen`. It adds no line. The file holds 200 lessons at most and drops the rarest.

Before the decomposer plans, it reads the 5 most relevant lessons. Words that the task and the lesson share, how often the failure happened, and how recent it is decide the order. The lessons go into the planning prompt, before the task.

## Host status and alerts (RO5)

`ops-hosts.yml` checks the hosts that TITAN depends on every 3 hours. It writes `state/ops/hosts.json` (the public mirror), keeps 30 days of checks in `state/ops/hosts-history.json`, and posts the result to the Worker with `POST /ops/hosts`. The dashboard reads the mirror.

Each host gets one of three statuses.

| Status | Meaning |
| --- | --- |
| `up` | The host answers. |
| `asleep` | The host sleeps by design and wakes on a request. This is not an outage. |
| `down` | The host does not answer, or answers with an error. |

| Host name | How the probe checks it |
| --- | --- |
| `github_actions` | The time of the last successful run of `titan-pulse.yml`. A run older than 45 minutes is `down`. |
| `github_status` | The public GitHub status API. A major or critical incident is `down`. |
| `hf_space` | The Hugging Face API tells if the Space runs, sleeps, or is broken. The probe never calls the Space, so it never wakes it. |
| `render_1` to `render_3`, `titan_gev` | One request. It waits up to 75 seconds. An answer that took 15 seconds or more is `asleep`, because the service woke up. |
| `hermes_1` to `hermes_3` | A request for `/v1/models` with no key. 200, 401, and 403 mean `up`. |

A host whose URL is not set is skipped and has no entry. The URLs are Actions secrets: `HOST_URL_HF_SPACE` (`owner/name` or a huggingface.co/spaces URL), `HOST_URL_RENDER_1` to `3`, and `HOST_URL_HERMES_1` to `3`. A Hermes URL falls back to `HERMES_n_BASE_URL` when its own secret is not set. The God's Eye View host comes from the repository variable `GEV_URL`.

### Rules that protect the free plans

- A Render service is probed at most every 5.5 hours, so the probe does not keep it awake. The free plan shares 750 instance hours a month between all services.
- A probe that cannot reach its source (GitHub, the Hugging Face Hub) writes no entry. An outage of the checker is not an outage of the host.
- The probe refuses a URL that is not `https`, or that resolves to a private address, and it does not follow redirects. The refusal text does not hold the URL or its host name.
- Only host names go to the history, the mirror, the Worker, the Issues, and the logs. A test checks that no result holds the URL.

### Alerts

- A host that fails 2 checks in a row opens an Issue with the label `host-alert` and the title `Host down: <name>`. The pulse workflow alerts at once when its last success is older than 45 minutes.
- A second failure does not open a second Issue. The open one stays.
- The Issue closes with one comment when the host is `up` or `asleep` again.
- When the Actions secret `DISCORD_WEBHOOK_URL` is set, the workflow also sends one short Discord message when an alert opens and when it closes. It holds the host name and no link.

The workflow also copies the quota numbers of the Worker to `state/ops/quota.json` (`scripts/ops-sync.mjs`), so the dashboard can show the meter. It rewrites the file only when the numbers change, or when the file is 6 hours old.

To run it by hand: Actions, Host status, Run workflow. In the Codespace, `node scripts/ops-hosts.mjs --no-post --no-alerts` checks the hosts that have a URL and writes the two files.

## Doorbell (RO6)

TITAN runs on a free host that has no clock of its own. `doorbell.yml` rings it on a schedule. One ring is `POST {TITAN_BACKEND_URL}/api/scheduled/{job}` with the secret `DOORBELL_TOKEN` as a bearer token in the `Authorization` header, and no body.

| Job | When |
| --- | --- |
| `digest` | Every day at 06:30 in America/Chicago |
| `weekly-review` | Every Sunday at 18:00 in America/Chicago |
| `sweep` | Every 15 minutes |

GitHub cron uses UTC, and Chicago changes its offset twice a year. So each timed job has two crons, and `scripts/ops-doorbell.mjs` lets only the one that falls on the right Chicago time ring. A test checks that exactly one of the two rings on every day of the year. GitHub often starts a cron a few minutes late, so the digest rings in the whole hour 06, and the weekly review in the whole hour 18.

The secrets `TITAN_BACKEND_URL` and `DOORBELL_TOKEN` are Actions secrets. They must match the env of TITAN. When one of them is not set, the run stops before it checks out the code, and it prints one line. That is not an error.

What the doorbell keeps:

- It keeps the status code of each ring, and nothing else. The Worker stores `job`, `status_code`, and the time in `doorbell_log` (`POST /ops/doorbell`) when `OPS_TOKEN` is set. The table keeps 30 days.
- It never reads the answer. A digest or a note can not reach a log, the Worker, or this public repository.
- It does not print the backend URL or the token. A redirect is not followed, so the token goes only to the host that the secret names. The URL must be `https`, and the host must not resolve to a private address.

To ring by hand: Actions, Doorbell, Run workflow, and pick a job. In the Codespace: `TITAN_BACKEND_URL=... DOORBELL_TOKEN=... node scripts/ops-doorbell.mjs --job sweep`.

## The Ops page (RD1)

The dashboard tab "Ops" shows the five public mirrors and the lessons, and a Security panel after the sign-in. `docs/RUNTIME.md` ("The dashboard") lists each panel and its file. Three rules hold for every panel:

- A value that is unknown stays unknown. A limit that no official page states shows "limit unknown" and the count of calls. It never shows a guess.
- An eval category that ran no task is left out. It is never shown as a zero score.
- A provider that has no key is not an error. It is one line under the list.

The Security panel needs the Worker. It shows the sign-in log of the last 24 hours (who tried, from which address, and the result), and the result of the last gitleaks scan. The log never goes to the repository or to the public site.

# TITAN Runner — threat model

Written before any security change. Everything here is public: the repo, every
commit, every state file, every workflow log, every issue and comment, and the
dashboard. A push is a publication.

## Assets

1. Provider API keys and the Worker admin token (GitHub encrypted secrets, Worker
   secrets). Loss = paid abuse of free-tier accounts, account bans.
2. The `GITHUB_TOKEN` of the pulse job (contents/issues/pull-requests: write on this
   repo). Loss = arbitrary commits to `main`, spam issues/PRs.
3. Free-tier quota (the scarcest runtime resource) and Actions runner time.
4. Integrity of `state/` (the queue and the record) and of the code on `main`.
5. The owner's private repo and vault — never reachable from here; must stay that way.

## Actors and trust

| Actor | Can do | Trusted for |
|---|---|---|
| Repo owner / collaborators with write access | open issues, add labels, comment, push branches, run workflows, merge | submitting tasks, control commands, approvals |
| Any GitHub user | open issues via the template (auto-applies `titan-task`), comment on any issue, open fork PRs, react | nothing |
| The models (Groq, Together, OpenRouter, Gemini, HF, OpenCode) | return arbitrary text | nothing — output is data |
| Web content fetched by a tool | arbitrary bytes | nothing |
| GitHub Actions platform | runs workflows, holds secrets | the platform boundary itself |
| Cloudflare Worker (if deployed) | holds a PAT with Secrets write | the admin token gate |

## Trust boundaries and the rules that follow

- **Task intake is attacker-controlled.** A label is not authorization. Only issues
  whose author is verified through the API (login in the allowlist, or
  `author_association` ∈ OWNER/MEMBER/COLLABORATOR) become tasks. Everything else is
  ignored at zero model calls and zero comments (commenting back would be a
  spam-amplification channel).
- **Comments are attacker-controlled.** Retry / cancel / pause / approve commands are
  honored only from authorized authors, only via an explicit `/titan …` command or the
  dashboard's marker comment, never from a bare `updated_at` bump.
- **Task text, tool output, model output are untrusted data.** They never change
  policy, autonomy, permissions, gate verdicts, or reach a secret. The policy engine
  reads only committed config and env; the models see labeled untrusted blocks.
- **The job that holds provider keys never executes model output.** Runner has no
  code-execution tool. Self-improve writes files and pushes a branch; tests on that
  branch run in CI on the PR with no provider secrets. File writes are jailed:
  no `.git/`, no `.github/`, no `package*.json`, no path traversal, no symlink escape.
- **Every side-effecting path goes through the reviewer gate and the policy engine**,
  enumerated in one place and covered by a test that fails when a new path bypasses it.
- **Secrets**: env → memory → redaction layer → any sink. One `redactString` pattern
  set, used by `scrubForState`, the event log, comments, and CI's state scan; a CI diff
  scan is added for code paths.
- **Network egress from tools**: allowlist of hosts, DNS resolution checked against
  private / loopback / link-local / metadata ranges before connecting, redirects
  re-checked, byte and time caps.
- **Workflows**: untrusted text reaches a step only through `env:` and is quoted;
  actions pinned to full commit SHAs; least-privilege permissions per job; concurrency
  groups; no `pull_request_target`; fork PRs get no secrets.
- **Self-modification**: PR only, denylist in code (tested) + CI backstop that hard-fails
  for the bot's own PRs and annotates human PRs.
- **No private storage exists.** A task that needs private content is "not supported
  here"; nothing fakes privacy.

## Attack scenarios considered

| # | Scenario | Result before | Result after |
|---|---|---|---|
| 1 | Stranger opens 50 template issues to burn quota / make the bot spam | 50 tasks run, 50 comments | ignored, 0 calls, one `intake.ignored` event with counts |
| 2 | Stranger comments "retry" on an owner's finished task | task re-runs | ignored; only an authorized `/titan retry` re-queues |
| 3 | Prompt-injected task text tells the model to write `.git/hooks/post-checkout` | file written, hook executed in the key-holding job | path rejected before any write; test proves it |
| 4 | Prompt-injected text asks to "disable the reviewer gate" / "set autonomy=full" | no mechanism existed (gate is code) | still no mechanism; policy reads config only; test proves task text cannot alter policy |
| 5 | A model returns a key-shaped string in its output | scrubbed from state; comment text scrubbed via redactString | same, plus event log scrub, plus CI diff scan |
| 6 | Tool asked to fetch `http://169.254.169.254/` or `http://localhost:…` | no tools existed | blocked by SSRF guard before DNS/connect |
| 7 | Overlapping pulses (dispatch + cron) claim the same task | concurrency group serializes; nothing else | leases + reconciliation make the second claimant skip |
| 8 | Killed pulse mid-task → re-run posts duplicate comments | duplicates | side-effect keys checkpointed; marker check before re-posting |
| 9 | Fork PR tries to read secrets via CI | CI has no secrets | unchanged |
| 10 | Bot's own self-improve PR touches `.github/workflows/` | refused in code, CI gate red | unchanged (hard fail), human PRs get an annotation instead of permanent red |
| 11 | Rate-limited provider retried into a failed pulse | cooldown skip existed | breaker + quota ledger + per-class retry policy |
| 12 | A step's model asks a tool to read `.env`, `.git/config`, `../outside`, or a symlinked path | no tools existed | read jail + the gate's deterministic layer refuse it; the model sees an error, the loop detector stops a repeat (`test/tools.test.js`, `test/security-corpus.test.js`) |
| 13 | A step's model asks `http_fetch` for a host that resolves to a private address, an IP literal, `http:`, or a redirect to somewhere private | no tools existed | allowlist + DNS-resolved public-address check + `redirect: manual` refuse before any connection (`test/tools.test.js`) |
| 14 | A filer sets `autonomy: autonomous`, `status`, `approvals`, or `lease` in the YAML block to loosen policy | no policy existed | only whitelisted fields parse; `autonomy` is taken as the *stricter* of the task's and the control file's, so a filer can only lower autonomy |
| 15 | A stranger comments `/titan approve all` on someone's parked task, or hides a command in a fence | no approvals existed | commands only from authorized associations, only as the first non-blank line, exact bounded plain-token arguments |
| 16 | Someone dispatches the control workflow to flip the kill switch off or set `autonomy autonomous` | no control plane existed | only write-access users can dispatch; the actor is recorded and audited; inputs reach the script through env; the concurrency group serializes it with the pulse |
| 17 | A model returns a tool call that repeats forever, or a plan that never converges | no tools; retries unbounded per provider | tool loop detector (3 identical calls or 6 rounds), per-step attempt ceiling, per-task call/token/time budgets, park ceiling — each ends in `dead-lettered` with a reason |

## Residual risks (accepted, documented)

- The task prompt and the model's answer are public by design.
- `http_fetch` resolves DNS itself and refuses private addresses, but the
  connection is made by the platform's resolver: a host whose answer flips
  between the check and the connect (rebinding within one call) is not
  defended against beyond the allowlist. Keep the allowlist small.
- The two self-improve revisit notifications (`revisitSelfImprovePr`) post
  directly, not through the checkpointed ledger; a crash between the
  comment and the state save could repeat one comment. Low value, noted.
- Free-tier judge availability: with fewer than two configured providers
  every run is "unjudged" (recorded as such); `TITAN_VERIFY_STRICT=1` turns
  that into a failure if the operator prefers.
- The dashboard's admin token gates the Worker only; the page and `state/` are public.
- The Worker (if ever deployed) holds a PAT with Secrets write; its intake mirror gets
  the same author filter, but the Worker is denylisted for self-improve and cannot be
  deployed or verified from this run.
- Free-tier providers may ban an account for automated use regardless of anything here.

## Wave 12: keys, the vault, connectors, and the Worker

This section covers the parts that Wave 12 adds. It uses the STRIDE method: Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, and Elevation of privilege. The mark "built" means that the control exists in the code and a test covers it. The mark "release 2" means that the part ships in the second release of the wave.

### Assets that are new

1. The callback token. It opens the `internal` routes of the Worker.
2. `CONNECTOR_KEK`, the vault key. It protects every connector credential and every chat key.
3. Connector credentials: API tokens, webhook URLs, OAuth tokens, and bot tokens.
4. Personal data: mail, calendar, notes, and chat. Decision W12-D7 keeps it out of the repo.
5. MCP tokens and OAuth clients for MCP.

### Keys (provider keys)

| Threat | Control | Status |
|---|---|---|
| S: someone saves a key with a stolen admin token | The admin token is the only gate, so the lockout (10 wrong tokens in 10 minutes gives 429 for 15 minutes) and the audit log limit the damage. A save never reveals an old key. | built |
| T: a key is changed in transit or in the sealed box | The key goes over https. The Worker seals it for the GitHub public key. A test opens the box with libsodium. | built |
| R: nobody can say who changed a key | The `key_events` table records each save, replace, test, and remove with the fingerprint, the actor, and the request id. | built |
| I: the key leaks into a response, a log line, D1, or an error | The key is never written to any of them. A test searches for the key in every sink after a full flow. A provider error text is never repeated, because a provider can echo part of a key. | built |
| D: someone makes the Worker call a slow or hostile host | A provider check has an 8 second limit. A base URL must use https and a public host. `safeFetch` follows no redirect. | built |
| E: a custom base URL reaches a private network | The host name is checked, and a DNS over HTTPS lookup refuses a private address, both at save time and when the adapter runs. | built |

### The vault

| Threat | Control | Status |
|---|---|---|
| S: a record is copied to another row to read it under another identity | The additional data of each record is `connectionId|connectorId|kekVersion`. A copied record fails to open. | built |
| T: a stored record is changed | AES-256-GCM detects any change of the ciphertext. | built |
| I: the key encryption key leaks | The key is made inside a GitHub runner and goes over stdin into the Worker secret store. No person, no log, and no argument holds it. | built |
| D: the key is missing | Vault routes answer 503 `vault_not_ready` with the fix. | built |
| E: a rotation exposes old records | A new key cannot open old records. The workflow warns before it replaces a key. | built |

### The callback token and the route groups

| Threat | Control | Status |
|---|---|---|
| S: a workflow call is faked | The callback token is 32 random bytes. The Worker keeps only its hash. | built |
| E: one stolen token opens everything (finding R-10) | Each token type opens one route group. The callback token opens `internal` routes only. After legacy mode ends, the admin token no longer opens them. | built |
| I: the token leaks from the repo secrets | The Worker rotates the token every 30 days, and a button rotates it at once. The old token works for 30 minutes after a rotation. | built |
| D: wrong tokens fill the database | A lockout caps the writes: at most 10 for each client and group, and none while locked. | built |

### CORS (finding R-11) and lockout (finding R-12)

| Threat | Control | Status |
|---|---|---|
| E: a foreign page calls the Worker with a stolen token | CORS allows three origins. Any other origin gets 403 before a handler runs. | built |
| S: guessing the admin token | The lockout returns 429 after 10 wrong tokens in 10 minutes. The table stores a hash of the address and never the address. | built |

### The pulse keeper

| Threat | Control | Status |
|---|---|---|
| D: the keeper starts too many pulses | A dispatch needs a heartbeat older than 15 minutes and a last dispatch older than 14 minutes. The workflow keeps its concurrency group. | built |
| T: a forged heartbeat hides a dead pulse | The heartbeat route needs the callback token. The Worker uses its own clock. | built |
| R: nobody knows why a pulse started | The keeper records its last dispatch and its last error. | built |

### The connector broker (release 2)

| Threat | Control |
|---|---|
| S: a sub-agent acts as the owner | The callback token reads `public` and `internal` data only. A `write` action returns `pending_approval`. A `destructive` action is admin only, with a typed confirm. |
| T: a request template builds a hostile request | Templates use objects and not joined strings. Path values are URL encoded. Unknown fields are rejected. |
| I: a credential reaches a log or `state/` | The call log keeps metadata only. A result passes through `scrubForState` before any log line. A `personal` result never goes to a workflow. |
| D: a connector floods a service | Each action has a rate limit. |
| E: a connector reaches a private host | `safeFetch` checks every call against the manifest hosts. |

### Inbound webhooks (release 2)

| Threat | Control |
|---|---|
| S: a fake caller | Each hook has its own secret, checked with a timing safe compare. The `hmac` mode signs a timestamp and the body, with a 300 second window and a replay check. |
| T: a changed body | The signature covers the body. |
| D: a flood | The body limit is 64 KB. The limit for each hook is 30 calls each minute. |
| E: a hook creates a task with extra rights | A hook can only create a task of the type `auto` or an event. It never creates `osint` or `meta-lesson`. |

### OAuth (release 2)

| Threat | Control |
|---|---|
| S: a forged redirect | `state` is random and lives 10 minutes. PKCE binds the code to the Worker. |
| I: tokens leak in a URL | The redirect to the dashboard holds no token. Tokens are stored in the vault. |
| E: too wide a scope | Calendar asks for `calendar.readonly`. Gmail asks for `gmail.readonly` and `gmail.compose`. Gmail has no send action. |

### MCP (release 2)

| Threat | Control |
|---|---|
| S: a stolen MCP token | A token has scopes, and a person revokes it in the dashboard. Only the hash is stored. |
| E: a tool reaches personal data | The scope `personal:read` is separate. A `destructive` action is never reachable from MCP. |
| T: a hostile web page calls `/mcp` | The Worker checks the `Origin` header. |

### Telegram (release 2)

| Threat | Control |
|---|---|
| S: someone else commands the bot | The bot answers only the paired owner chat. The webhook checks the secret header. A pair code lives 10 minutes and works once. |
| T: a forged approval button | `callback_data` holds an HMAC. The Worker checks the HMAC and the owner chat id. |
| I: personal data in a message | A message holds personal data only if the rule permits it. |

### Chat (release 3)

| Threat | Control |
|---|---|
| I: the chat key leaks | The key is in the vault, encrypted, and off by default. |
| D: a long stream uses the CPU budget | The work for each chunk is small. A provider that goes over the limit falls back to a non stream call. |
| I: chat history stays forever | The history lives 30 days by default. A person deletes one thread or all history. |

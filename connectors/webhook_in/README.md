# Inbound webhook

Gives you a private address such as `https://titan-runner-brain.titan-runner.workers.dev/hooks/<hookId>`. A tool that can send a web hook posts a JSON body to it. TITAN turns each post into an event for your notify rules or into a sub-agent task.

## Check modes

| Mode | Header | Strength |
|---|---|---|
| `hmac` | `X-Titan-Signature: t=<unix>,v1=<hex>` | Strong. The signature covers `t.body`. The window is 300 seconds. TITAN refuses a replay. |
| `github` | `X-Hub-Signature-256: sha256=<hex>` | Strong. This is the GitHub form. |
| `static` | `X-Titan-Hook-Secret: <secret>` | Weak. Anyone who sees the request sees the secret. Use it only when the sender cannot sign. |

## Safety rules

- The hook id has 16 random bytes. The secret has 32 random bytes. TITAN stores a hash of the secret and the secret itself in the vault, so that it can check a signature. It shows the secret one time only.
- A body larger than 64 KB gets `413`.
- A hook that does not exist gets `404`.
- Each hook takes at most 30 calls for each minute. More get `429`.
- A bad signature, an old time, or a replay gets `401`.
- TITAN never runs code from a post. A post is data only.
- A post that makes a task goes through the same brief screen as any other task.

## Set up for common tools

Docs/CONNECTORS.md has the steps for Zapier, Make, n8n, IFTTT, and GitHub.

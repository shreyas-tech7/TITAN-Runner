# Inbound webhook

Gives you a private address such as `https://titan-runner-brain.titan-runner.workers.dev/hooks/<id>/<token>`. A tool that can send a web hook posts a JSON body to it. TITAN keeps the last 100 events for 7 days and can pass each event to your notify rules.

## Safety rules

- The address holds a random token with 192 bits. TITAN stores a hash of the token. It shows the full address once.
- A body larger than 64 KB is refused with `413`.
- A wrong token gets `404`, the same as an address that does not exist.
- The Worker keeps no more than 60 events for each hook for each minute. More get `429`.
- If you set a signing secret, TITAN checks `X-Hub-Signature-256` with HMAC-SHA256 in constant time. A bad signature gets `401`.
- TITAN never runs code from an event. An event is data only.

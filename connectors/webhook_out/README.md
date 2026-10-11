# Outbound webhook

Posts JSON to an address that you choose. Use it to reach an automation tool such as n8n, Make, or Zapier. TITAN sends no secrets in the body.

## Safety rules

- The address is a secret and stays in the vault.
- The host must use https. The broker refuses an address with an IP literal.
- The broker resolves the host through DNS over HTTPS and refuses a private or loopback answer.
- A redirect is refused.
- Each post needs approval unless you set the action to auto-approve.
- With a signing secret, TITAN adds `X-Titan-Signature: t=<unix>,v1=<hex>`. The signature is HMAC-SHA256 over `t.body`.

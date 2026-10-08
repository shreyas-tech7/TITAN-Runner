# Discord webhook

Posts a message to one channel. The webhook URL is the secret. Anyone with the URL can post.

## Set up

1. Open the channel settings in Discord. Choose Integrations, then Webhooks, then New Webhook.
2. Copy the webhook URL.
3. Paste it in the connect window. TITAN reads the webhook with one GET to check the URL.

The message never pings anyone: TITAN sends `allowed_mentions` with an empty `parse` list.

## Actions

| Action | Risk | Data |
|---|---|---|
| `send` | write | internal |

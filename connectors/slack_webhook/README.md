# Slack webhook

Posts a message to one channel. The webhook URL is the secret.

## Set up

1. Open https://api.slack.com/apps. Make an app. Turn on Incoming Webhooks.
2. Add a webhook to a channel. Copy the URL.
3. Paste it in the connect window. TITAN does not send a message when you connect. Click "Send test" to check it.

## Actions

| Action | Risk | Data |
|---|---|---|
| `send` | write | internal |

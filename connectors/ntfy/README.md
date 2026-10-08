# ntfy

Sends a push notification to the ntfy app on your phone.

## Set up

1. Pick a long random topic name. On the public server, the topic name is the secret.
2. Install the ntfy app and subscribe to that topic.
3. Paste `https://ntfy.sh/<topic>` in the connect window.

TITAN does not send a message when you connect. Click "Send test" to check it. Only `ntfy.sh` is allowed.

## Actions

| Action | Risk | Data |
|---|---|---|
| `publish` | write | internal |

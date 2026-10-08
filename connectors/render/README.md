# Render

Lists your services and deploys, and starts a deploy. The key has the power of your whole account on Render, so TITAN asks for approval before it starts a deploy.

## Set up

1. Open Render, then Account Settings, then API Keys.
2. Make a key. Paste it in the connect window.

## Actions

| Action | Risk | Data |
|---|---|---|
| `list_services`, `list_deploys` | read | internal |
| `trigger_deploy` | write | internal |

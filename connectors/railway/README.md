# Railway

Lists projects and deploys, and redeploys a service. TITAN already uses Railway for the optional VM agent. This connector gives you a view of it and a button.

## Set up

1. Open Railway, then Account Settings, then Tokens.
2. Make an account token. Paste it in the connect window. Railway shows the token once.

## Actions

| Action | Risk | Data |
|---|---|---|
| `list_projects`, `list_deploys` | read | internal |
| `redeploy` | write | internal |

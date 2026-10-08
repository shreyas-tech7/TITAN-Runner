# Linear

Lists recent issues and creates an issue through the GraphQL API.

## Set up

1. Open Linear, then Settings, then Account, then Security and access.
2. Make a personal API key. Copy it.
3. Paste it in the connect window. Linear wants the key in the `Authorization` header without the word Bearer.

## Actions

| Action | Risk | Data |
|---|---|---|
| `list_issues` | read | internal |
| `create_issue` | write | internal |

You need a team id for `create_issue`. Open the team in Linear, and copy its id from the URL of the API explorer.

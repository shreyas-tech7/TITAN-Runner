# Todoist

Lists your tasks and projects. Adds and closes tasks. Tasks are personal data, so a sub-agent cannot read them.

## Set up

1. Open Todoist, then Settings, then Integrations, then Developer.
2. Copy the API token. Paste it in the connect window.

## API

TITAN uses API v1 at `https://api.todoist.com/api/v1`. The old REST v2 path answers `410 Gone`, as a live probe showed on 2026-10-08. A list answer holds `results` and `next_cursor`.

## Actions

| Action | Risk | Data |
|---|---|---|
| `list_tasks` | read | personal |
| `add_task`, `close_task` | write | personal |

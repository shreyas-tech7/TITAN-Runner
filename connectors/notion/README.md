# Notion

Reads pages and databases that you share with the integration. Appends text to a page. Notion content is personal data, so a sub-agent cannot read it. Only you and a tool with the scope `personal:read` can.

## Set up

1. Open https://www.notion.so/profile/integrations. Make an internal integration.
2. Copy the integration secret.
3. Open each page or database that TITAN may use. Choose Connections and add the integration.

## API

TITAN sends `Notion-Version: 2022-06-28`. The latest version is 2026-03-11, and the docs say that older versions stay supported. Checked on 2026-10-08.

## Actions

| Action | Risk | Data |
|---|---|---|
| `search`, `get_page`, `query_database` | read | personal |
| `append_text` | write | personal |

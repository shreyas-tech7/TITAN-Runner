# GitHub

Reads issues, pull requests, and workflow runs of one repository. Creates an issue and a comment.

## Set up

1. Open https://github.com/settings/personal-access-tokens/new.
2. Choose "Only select repositories". Pick the one repository.
3. Give these permissions: Issues (Read and write), Pull requests (Read), Actions (Read).
4. Copy the token. Paste it in the connect window with the owner and the repository name.

## API

REST API with the header `X-GitHub-Api-Version: 2022-11-28`, checked against the GitHub docs on 2026-10-08.

## Actions

| Action | Risk | Data |
|---|---|---|
| `list_issues`, `list_prs`, `list_runs` | read | internal |
| `create_issue`, `comment` | write | internal |

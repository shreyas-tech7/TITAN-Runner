# Zapier / Make.com → TITAN-Runner

**What this does.** It lets a trigger in any app that Zapier or Make.com can
watch create a GitHub issue labeled `titan-task` in this repository. From
there it is an ordinary task: the next pulse picks it up, runs it, and
comments the result on the issue.

**What this is not.** There is no webhook endpoint, no server, and no
TITAN-Runner code that talks to Zapier or Make. Their built-in GitHub
integration creates the issue; TITAN-Runner already knows how to act on a
`titan-task` issue. The only code involved is a small normalizer
(`src/lib/issueBody.js`) that removes automation boilerplate from the issue
before it is read as a task. Whether the free plan of Zapier or Make is
enough for your volume is between you and them — check their current
pricing and limits; both change.

## Read this first: who the issue is "from"

TITAN-Runner only runs a task filed by an authorized author: the repository
owner, GitHub-verified collaborators, and the logins in the
`TITAN_TASK_AUTHORS` repository variable (see the README's Security
section). A Zap or scenario creates the issue **as the GitHub account you
connected to it**. So:

- Connect your own account, or a dedicated account that is a collaborator on
  this repo, or add that account's login to `TITAN_TASK_AUTHORS`. Otherwise
  the issue is ignored (logged by issue number only, never answered).
- **The consequence:** every task that arrives this way has *your*
  authority. If the trigger is something a stranger can write to — an inbound
  email, a form, a public channel — a stranger can steer TITAN-Runner
  through it. Only trigger from sources you control, or put a human step
  (Zapier "Filter"/"Approval", a Make filter) in front of the GitHub action.
- Do not add the `titan-self-improve` label from an automation. That turns
  the task into a pull request against this repo, which always waits for a
  human `/titan approve` (see `config/safety-rules.yml`) — and is not what
  an unattended trigger should be asking for.
- **The repository is public.** Everything the automation puts in the issue,
  and everything TITAN-Runner replies, is world-readable and indexed. Do not
  map customer data, emails, or secrets into the body. Redaction
  (`src/lib/redact.js`) is a backstop, not permission.

## The body template (works the same in both tools)

Wrap the task in two invisible markers. Everything outside them — any
header, footer or signature the tool adds — is dropped:

```
<!-- titan-intake:begin -->
{{ the text of the task, mapped from your trigger }}
<!-- titan-intake:end -->
```

GitHub does not render HTML comments, so the markers do not show on the
issue page. Map the **plain-text** version of a field if the source offers
both plain text and HTML; tags are not stripped.

Without the markers, a banner on the very first or last line — "Sent via
Zapier", "This issue was created by a Zap", "Powered by Make.com" — is still
removed, along with adjacent `Zap:`/`Scenario:` metadata lines. That is
best-effort. The markers are the reliable way.

Title: map a short description of the task. A leading `[Zapier]`, `[Zap]`,
`[Make]` or `(Make.com)` tag is stripped. If the title ends up empty, the
first line of the body is used.

### Optional: set priority and the rest

The same structured block the dashboard writes works inside the markers:

```
<!-- titan-intake:begin -->
<!-- titan-task-v1
title: "Triage the support inbox"
priority: high
routingHint: fast
description: |
  Triage the three oldest tickets and summarise the cause of each.
-->
<!-- titan-intake:end -->
```

Use this only for text you type once into the template. If you map a
variable into `description: |`, any line break in the mapped text will break
the two-space indentation the block needs; for mapped text use the plain
form above. Other keys it understands: `dependsOn`, `deadline`, `ttlHours`,
`autonomy` (a task can only ask for *less* autonomy than the repo's setting,
never more).

## Zapier

1. Create a Zap. Trigger: whatever app and event you want to react to.
2. Add an action: **GitHub → Create Issue**. Connect the GitHub account
   chosen in the section above.
3. Fill in the fields (names may differ slightly in the current Zapier
   interface):
   - **Repository**: `<owner>/TITAN-Runner`
   - **Title**: map a short description from the trigger (for example the
     subject or name field).
   - **Body**: the template above, with the task text mapped between the
     markers.
   - **Labels**: `titan-task` (exactly; it already exists in this repo).
   - Leave **Assignees** and **Milestone** empty.
4. Test the action. A real issue appears in this repo's Issues tab; delete
   it or let the next pulse run it.
5. Turn the Zap on.

## Make.com

1. Create a scenario. First module: the trigger you want.
2. Add **GitHub → Create an Issue**. Create a connection with the account
   chosen above.
3. Fill in the fields:
   - **Owner**: your GitHub login (or org); **Repository**: `TITAN-Runner`
   - **Title**: mapped from the trigger.
   - **Body**: the template above, with the mapped task text between the
     markers.
   - **Labels**: add `titan-task`.
4. Run the scenario once and check the issue, then schedule or enable it.

## What happens next

Within about 15 minutes (the pulse cadence) the issue becomes a task. The
result is commented on the issue. Depending on the repo's autonomy setting
(`state/control.json`, see `docs/RUNBOOK.md`), delivery may wait for an
authorized `/titan approve deliver:<runId>` comment first. Identical content
submitted again within 24 hours is cancelled as a duplicate — including when
one copy was typed by hand and the other came through a Zap.

## Checking what the normalizer will do

Paste a body into this (no network, no state touched):

```bash
node --input-type=module -e '
import { normalizeIssueBody } from "./src/lib/issueBody.js";
const body = process.argv[1];
console.log(JSON.stringify(normalizeIssueBody(body), null, 2));
' $'Triage the support inbox.\n\n---\nSent via Zapier'
```

`source` is `marked`, `banner-stripped`, `fence` (a `titan-task-v1` block was
present) or `plain` (nothing to remove). The same value is recorded as
`bodySource` on the `intake.accepted` event.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Issue exists, nothing happens | The label is not exactly `titan-task`, or the issue's author is not authorized. Unauthorized issues are ignored silently; the pulse log shows only a count and issue numbers. |
| Task text has `Sent via …` in it | The banner was not on the first or last line, or has more text after it. Use the markers. |
| Task is cancelled as a duplicate | The same title and text were already filed in the last 24 hours. |
| Title is the first line of the body | The mapped title was empty after removing a `[Zapier]`-style tag. |

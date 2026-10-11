# Security controls

This repository is public. Each commit, Issue, log, and file under `state/` is world readable. This page lists the controls that keep secrets and personal data out. Older reviews are in `docs/SECURITY-WAVE11.md` and `docs/runner-upgrade/THREAT_MODEL.md`.

## Secret scanning

Four layers work together:

1. The pre-commit hook scans the staged changes.
2. The workflow `gitleaks.yml` scans the full git history on every push and pull request.
3. The same workflow scans open Issues, pull requests, and comments each week.
4. GitHub secret scanning and push protection run on the repository.

### The workflow

`gitleaks.yml` downloads the gitleaks release and checks its SHA-256 sum. It runs the CLI directly, so it needs no license key. A finding fails the run. The log shows the rule, the file, and the line. It never shows the value.

To run the scan on your machine, install gitleaks and run this command:

```bash
gitleaks git . --config .gitleaks.toml --log-opts="--all" --redact=100 --no-banner
```

### The config

`.gitleaks.toml` extends the default rules. It adds rules for the providers of this repo. The allowlist at the end holds the exact fake values of tests and fixtures. Each entry matches the whole secret.

Do not add a `paths` key to an allowlist. gitleaks then skips the whole file, even with `condition = "AND"`. A real key in that file would pass.

To add a new fake value, add one anchored pattern to the allowlist in a pull request.

### The hook

Run this command once after a clone:

```bash
npm run hooks:install
```

The hook runs `scripts/check-secrets-in-diff.mjs --staged`. If gitleaks is on the path, the hook runs it too. `npm ci` installs the hook on your machine. It does nothing in CI.

### Issues and pull requests

`scripts/scan-issues.mjs` reads open Issues, pull requests, and their comments through the API. It runs gitleaks over the text. It prints the rule and the link. It never prints the value. Add `--all` to include closed items.

### If a real key is found

A key in a commit, an Issue, or a log counts as leaked. Do this:

1. Rotate the key at the provider. Do this first.
2. Update the secret in GitHub Actions, the Worker, or Codespaces.
3. Edit or delete the Issue or comment text.
4. Do not rewrite git history. Rotation is the fix.

## Who may file a task

Only the owner of the repository may file a task. This holds for Issues and for `/titan` comments. The owner can add more logins in the repository variable `TITAN_TASK_AUTHORS`. A bot never counts.

GitHub also reports an author association: `OWNER`, `MEMBER`, `COLLABORATOR`. Runner ignores it by default. Set `TITAN_TRUST_COLLABORATORS=1` to trust it.

Runner checks the author before it reads the task text, before it calls a model, and before it uses a key. For an Issue from anyone else, Runner does three things:

1. It adds the label `titan-ignored`.
2. It removes the label `titan-task`.
3. It does nothing else. It does not comment and it does not call a model.

The Worker mirror of Issues follows the same rule.

## The Reviewer Gate for GitHub writes

Every write to GitHub passes the gate. A write is a comment, a label, an Issue, a pull request, a dispatch, an Actions secret, a commit, or a push.

The runner side is `src/reviewer/githubGate.js`. The Worker side is `worker/src/lib/githubGate.js`. Both use the rules in `src/reviewer/githubGatePolicy.js`.

The gate does these things:

- It allows only the listed kinds of write. A request that fits no kind is blocked.
- It limits a write to this repository.
- It limits dispatch event types, label names, and secret names to fixed lists.
- It removes secret-shaped text and email addresses from comments, Issues, and pull requests.
- It blocks a force push, a branch delete, a push to another branch, and a commit outside `state/`.
- It scans the lines of a commit and a push for secrets.
- It requires that a pull request is a draft from a `self-improve/` branch into `main`.

The checks in the gate have no off switch. `TITAN_REVIEWER=0` turns off only the model layer.

The test `test/github-write-boundary.test.js` fails when a file outside the gate sends a write.

Connector writes to GitHub also pass the gate in `sendRequest`. A person approves them first. The gate then allows two shapes only: a new Issue and a comment.

## VM fleet

A railway.new VM is untrusted. Runner handles it with these rules:

- No key and no token goes to a VM. The `ssh` child process gets a bare environment: `PATH`, `LANG`, `TZ`, `TMPDIR`, and a temporary `HOME`.
- The command sent to the VM is fixed. It passes the gate first. A brief with a secret-shaped string is blocked.
- The preview URL must be `https` on `up.railway.app`. Runner removes the query, the path, and any user name.
- The claim URL must be `https://railway.com/ssh-signup?code=<code>`. Logs hide the code.
- A VM lives for 120 minutes at most. Set `TITAN_VM_MAX_LIFETIME_MINUTES` to change the cap (10 to 1440). The Worker applies the cap again and expires the row. Railway can keep an unclaimed box for 24 hours. Runner stops treating it as live after the cap.

## State hygiene

Every file under `state/` has a strict schema in `src/state/strict.js`. A schema lists each key that a file may hold. An extra key fails the check. A file with no schema fails the check too, so a new kind of state file needs a schema in the same change.

Run the check by hand:

```bash
node scripts/check-state.mjs
node scripts/check-state.mjs --gitleaks
```

The check also scans the text of each file for secret-shaped strings. It reads inside the compressed archives. The messages name the file and the field. They never show a value.

### Retention

Old files move into one compressed file for each month under `state/archive/`. The archive holds the whole record.

| Kind | Stays as a file | Archive |
|---|---|---|
| Run records | The newest 10, and any run newer than 14 days up to 60 files | `runs-YYYY-MM.jsonl.gz` |
| Finished tasks | Tasks that ended in the last 30 days | `tasks-YYYY-MM.jsonl.gz` |
| Event summaries | 90 days | `events-summary-YYYY-MM.jsonl.gz` |
| Research and weekly digests | 60 days | `digests-YYYY-MM.jsonl.gz` |
| Gate review logs | 60 days | `reviews-YYYY-MM.jsonl.gz` |

The daily workflow `state-maintenance.yml` does the archive work, checks the schemas, and writes `state/maintenance.json`. That file holds a time stamp, so the workflow makes one commit each day. GitHub turns off the scheduled workflows of a public repo after 60 days with no activity. The daily commit keeps them on.

### How a workflow publishes state

A workflow that writes to `state/` calls `node scripts/publish-state.mjs --message "..."`. The script checks the schemas, commits through the Reviewer Gate, pulls with rebase, and pushes. It tries three times and then fails. The workflow also joins the concurrency group `titan-state`, so two workflows never push at the same time.

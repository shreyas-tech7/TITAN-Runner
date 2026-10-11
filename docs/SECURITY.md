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
